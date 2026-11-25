// The contexts on this machine, as a small graph to search: one Context node
// per local context, with its name and description, a search vector and a
// full-text index, so find_context can rank them by hybrid search (meaning
// plus keywords) the same way a context's own search ranks claims.
//
// The catalogue is derived, never stored: it is built in memory from each
// context's change log (read straight from disk, no host needed) and kept in
// step by re-reading a log only when its file changes. So it is never synced,
// any number of processes can hold one, and each uses its own embedder, like
// the vectors inside a context.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentWords, makeEmbedder, type Embedder } from "./embed.js";
import { ChangeLog } from "./log.js";
import { Members } from "./members.js";
import { loadRelate, type Connection, type RelateModule } from "./relate.js";
import { toJson } from "./values.js";

/** What the catalogue knows about one context on this machine. */
export interface ContextCard {
  name: string;
  /** The context's id (the same on every member's machine); null before its log has a create. */
  id: string | null;
  description: string | null;
  /** Current members, from the membership changes. */
  members: number;
  created_at: string | null;
  /** When the latest change this machine has was made. */
  last_change_at: string | null;
}

export interface ContextHit extends ContextCard {
  score: number;
}

/** The text a context is searched by: its name as words, then its description. */
export function cardText(c: Pick<ContextCard, "name" | "description">): string {
  const name = c.name.replace(/-+/g, " ");
  return c.description ? `${name}. ${c.description}` : name;
}

/** Reads a context's card from its change log on disk, without starting its host. */
export function readCard(dataDir: string, name: string): ContextCard {
  const dir = join(dataDir, "hosts", name);
  const changes = existsSync(join(dir, "changes.jsonl")) ? new ChangeLog(dir).all() : [];
  const members = new Members(changes);
  let last: string | null = null;
  for (const c of changes) if (!last || c.at > last) last = c.at;
  return {
    name,
    id: members.graphId ?? null,
    description: members.description,
    members: members.current().length,
    created_at: members.createdAt ?? null,
    last_change_at: last,
  };
}

/** A log's size and time, to tell cheaply whether it changed since it was read. */
function stamp(dataDir: string, name: string): string {
  try {
    const s = statSync(join(dataDir, "hosts", name, "changes.jsonl"));
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "none";
  }
}

export class Catalogue {
  private stamps = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly dataDir: string,
    readonly embedder: Embedder,
    private conn: Connection,
    private R: RelateModule,
  ) {}

  /** A fresh in-memory catalogue for a data folder; find() fills it on first use. */
  static async open(dataDir: string, opts: { embedder?: Embedder; log?(msg: string): void } = {}): Promise<Catalogue> {
    const R = await loadRelate();
    const embedder = opts.embedder ?? makeEmbedder(undefined, opts.log);
    const conn = R.Database.open(":memory:").connect();
    conn.query("CREATE CONSTRAINT context_name_key IF NOT EXISTS FOR (n:Context) REQUIRE n.name IS UNIQUE");
    conn.query(
      "CREATE VECTOR INDEX context_embedding IF NOT EXISTS FOR (n:Context) ON (n.embedding) " +
        `OPTIONS {indexConfig: {\`vector.dimensions\`: ${embedder.dim}, \`vector.similarity_function\`: 'cosine'}}`,
    );
    conn.query("CREATE FULLTEXT INDEX context_text IF NOT EXISTS FOR (n:Context) ON EACH [n.text]");
    return new Catalogue(dataDir, embedder, conn, R);
  }

  /** Runs calls one at a time: a sync and a search never interleave. */
  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Brings the catalogue in step with the given contexts: adds new ones,
   * re-reads those whose log changed, and drops those no longer here.
   * Returns how many cards it (re)wrote.
   */
  sync(names: string[]): Promise<number> {
    return this.serial(() => {
      const want = new Set(names);
      let wrote = 0;
      for (const name of [...this.stamps.keys()])
        if (!want.has(name)) {
          this.conn.query("MATCH (n:Context {name: $name}) DETACH DELETE n", { name });
          this.stamps.delete(name);
        }
      for (const name of want) {
        const s = stamp(this.dataDir, name);
        if (this.stamps.get(name) === s) continue;
        const card = readCard(this.dataDir, name);
        const text = cardText(card);
        const embedding = contentWords(text).length ? this.embedder.embed(text) : null;
        this.conn.query(
          "MERGE (n:Context {name: $name}) SET n.id = $id, n.description = $description, n.text = $text, n.embedding = $embedding, " +
            "n.members = $members, n.created_at = $created_at, n.last_change_at = $last_change_at",
          { ...card, text, embedding },
        );
        this.stamps.set(name, s);
        wrote++;
      }
      return wrote;
    });
  }

  /** The contexts that best match a text, by hybrid search over name and description. */
  find(query: string, limit = 10): Promise<ContextHit[]> {
    const terms = contentWords(query);
    if (!terms.length) return Promise.reject(new Error("'query' needs at least one letter or digit."));
    return this.serial(async () => {
      const r = await this.conn.queryAsync(
        "MATCH (n:Context) SEARCH n IN (COMBINE (" +
          " VECTOR INDEX context_embedding FOR $vector LIMIT 100 WEIGHT 1," +
          " FULLTEXT INDEX context_text FOR $terms LIMIT 100 WEIGHT 1" +
          " ) USING WRRF WITH CONSTANT 60 LIMIT 100) SCORE AS score " +
          "RETURN n.name AS name, n.id AS id, n.description AS description, n.members AS members, " +
          "n.created_at AS created_at, n.last_change_at AS last_change_at, round(score, 4) AS score " +
          "ORDER BY score DESC, name LIMIT $limit",
        { vector: this.embedder.embed(query), terms: terms.join(" "), limit } as never,
      );
      return r.rows.map((row) => toJson(row, this.R) as unknown as ContextHit);
    });
  }
}
