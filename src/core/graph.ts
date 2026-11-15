// The model runtime: one Relate store, one model pack, and the pack's tools.
//
// Every tool call runs in one transaction. Inputs are validated against the
// tool's schema, then the server adds its own parameters ($now, $by and the
// derived ones), which callers can never set. Any row with a non-null
// `_error` column, in any step, rolls the call back and becomes the error.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { contentWords, makeEmbedder, type Embedder } from "./embed.js";
import { resolvePack, type InputSpecT, type Model, type Pack, type ToolSpec } from "./pack.js";
import { loadRelate, type Connection, type Database, type RelateModule } from "./relate.js";
import { toJson } from "./values.js";
import type { GraphDescription } from "../p2p/protocol.js";

export type Role = "reader" | "contributor" | "admin";
const RANK: Record<Role, number> = { reader: 0, contributor: 1, admin: 2 };

export interface Caller {
  /** Who is calling: recorded as $by on writes. */
  id: string;
  role: Role;
}

/** A failure the agent should see and can act on. */
export class ToolError extends Error {}

export function defaultDataDir(): string {
  return process.env.P2PCG_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "p2p-context-graph");
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function newId(prefix: string): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `${prefix}_${s}`;
}

function scalar(type: string, spec: Pick<InputSpecT, "max_length" | "min" | "max">): z.ZodType {
  switch (type) {
    case "string":
      return z.string().max(spec.max_length ?? 20_000);
    case "id":
      return z.string().min(1).max(64);
    case "integer": {
      let s = z.number().int();
      if (spec.min !== undefined) s = s.min(spec.min);
      if (spec.max !== undefined) s = s.max(spec.max);
      return s;
    }
    case "number": {
      let s = z.number();
      if (spec.min !== undefined) s = s.min(spec.min);
      if (spec.max !== undefined) s = s.max(spec.max);
      return s;
    }
    case "boolean":
      return z.boolean();
    case "date":
      return z.iso.date();
    case "datetime":
      return z.iso.datetime({ offset: true });
    default:
      throw new Error(`unknown type ${type}`);
  }
}

/** The zod shape of a tool's input, for MCP tool listings and for validation. */
export function inputShape(input: Record<string, InputSpecT>): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(input)) {
    let s: z.ZodType =
      spec.type === "enum"
        ? z.enum(spec.values as [string, ...string[]])
        : spec.type === "array"
          ? z.array(scalar(spec.items!, spec)).max(100)
          : scalar(spec.type, spec);
    s = s.describe(spec.description);
    if (spec.default !== undefined) s = (s as z.ZodType & { default(v: unknown): z.ZodType }).default(spec.default);
    else if (!spec.required) s = s.optional();
    shape[name] = s;
  }
  return shape;
}

interface Meta {
  model: string;
  model_version: number;
  embedder: string;
  embedding_dim: number;
  migrations: string[];
}

// @relate/relate 1.0.1 cannot close a store, and opening one twice in a
// process fails, so each store stays open for the life of the process.
interface Store {
  db: Database;
  conn: Connection;
  /** Calls on one store run one at a time, whichever Graph makes them. */
  queue: Promise<unknown>;
}
const openStores = new Map<string, Store>();

export class Graph {
  private validators = new Map<string, z.ZodType>();

  private constructor(
    readonly name: string,
    readonly dir: string,
    readonly pack: Pack,
    readonly embedder: Embedder,
    private db: Database,
    private conn: Connection,
    private R: RelateModule,
    private store: Store,
  ) {
    for (const t of pack.tools) this.validators.set(t.name, z.object(inputShape(t.input)).strict());
  }

  get model(): Model {
    return this.pack.model;
  }

  get tools(): ToolSpec[] {
    return this.pack.tools;
  }

  /**
   * Opens (or creates) a graph. A new graph takes `model`; an existing one
   * keeps the model it was created with, and `model` must match it if given.
   */
  static async open(opts: { name?: string; dataDir?: string; model?: string; embedder?: Embedder } = {}): Promise<Graph> {
    const name = opts.name ?? process.env.P2PCG_GRAPH ?? "default";
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new ToolError(`Graph names are lower-case letters, digits and dashes: '${name}'.`);
    const dir = join(opts.dataDir ?? defaultDataDir(), "graphs", name);
    mkdirSync(dir, { recursive: true });
    const R = await loadRelate();
    let store = openStores.get(dir);
    if (!store) {
      const db = R.Database.open(dir);
      store = { db, conn: db.connect(), queue: Promise.resolve() };
      openStores.set(dir, store);
    }
    const { db, conn } = store;
    const shared = store;
    const embedder = opts.embedder ?? makeEmbedder();

    const found = conn.query("MATCH (m:_P2pcgMeta {key: 'meta'}) RETURN m {.*} AS m").rows[0]?.m as Meta | undefined;
    const modelRef = opts.model ?? found?.model ?? process.env.P2PCG_MODEL ?? "temporal-claims";
    const pack = resolvePack(modelRef);
    if (found && found.model !== pack.model.name)
      throw new ToolError(`Graph '${name}' uses the model '${found.model}', not '${pack.model.name}'.`);
    if (found && found.embedder !== embedder.name)
      throw new ToolError(`Graph '${name}' was embedded with '${found.embedder}', not '${embedder.name}'. Re-embedding is not supported yet.`);

    const graph = new Graph(name, dir, pack, embedder, db, conn, R, shared);
    graph.applyModel(found);
    return graph;
  }

  private applyModel(found: Meta | undefined): void {
    const { model } = this.pack;
    const q = (s: string) => this.conn.query(s);
    for (const [label, node] of Object.entries(model.nodes))
      if (node.key) q(`CREATE CONSTRAINT ${label.toLowerCase()}_${node.key}_key IF NOT EXISTS FOR (n:${label}) REQUIRE n.${node.key} IS UNIQUE`);
    if (model.search) {
      const labels = model.search.labels.join("|");
      q(
        `CREATE VECTOR INDEX search_embedding IF NOT EXISTS FOR (n:${labels}) ON (n.embedding) ` +
          `OPTIONS {indexConfig: {\`vector.dimensions\`: ${this.embedder.dim}, \`vector.similarity_function\`: 'cosine'}}`,
      );
      q(`CREATE FULLTEXT INDEX search_text IF NOT EXISTS FOR (n:${labels}) ON EACH [n.${model.search.text}]`);
    }
    const applied = new Set(found?.migrations ?? []);
    for (const m of this.pack.migrations) {
      if (applied.has(m.name)) continue;
      this.conn.begin();
      try {
        for (const stmt of m.cypher.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) q(stmt);
        this.conn.commit();
      } catch (e) {
        this.conn.rollback();
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
      }
      applied.add(m.name);
    }
    this.conn.query(
      "MERGE (m:_P2pcgMeta {key: 'meta'}) SET m.model = $model, m.model_version = $version, " +
        "m.embedder = $embedder, m.embedding_dim = $dim, m.migrations = $migrations",
      {
        model: model.name,
        version: model.version,
        embedder: this.embedder.name,
        dim: this.embedder.dim,
        migrations: [...applied].sort(),
      },
    );
    this.db.checkpoint();
  }

  /** Runs calls one at a time, in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.store.queue.then(fn, fn);
    this.store.queue = run.catch(() => undefined);
    return run;
  }

  async call(toolName: string, args: unknown, caller: Caller): Promise<unknown> {
    const tool = this.pack.tools.find((t) => t.name === toolName);
    if (!tool) throw new ToolError(`No tool '${toolName}' in the model '${this.model.name}'.`);
    if (RANK[caller.role] < RANK[tool.role]) throw new ToolError(`'${toolName}' needs the ${tool.role} role; you are a ${caller.role}.`);
    const parsed = this.validators.get(tool.name)!.safeParse(args ?? {});
    if (!parsed.success)
      throw new ToolError("Invalid input:\n" + parsed.error.issues.map((i) => `- ${i.path.join(".") || "(input)"}: ${i.message}`).join("\n"));
    const input = parsed.data as Record<string, unknown>;

    const params: Record<string, unknown> = {};
    for (const name of Object.keys(tool.input)) params[name] = input[name] ?? null;
    params.now = new Date().toISOString();
    params.by = caller.id;
    params.role = caller.role;
    for (const [name, d] of Object.entries(tool.derive)) {
      if ("new_id" in d) params[name] = newId(d.new_id);
      else if ("embed" in d) {
        const text = input[d.embed];
        if (typeof text !== "string") params[name] = null;
        else {
          const v = this.embedder.embed(text);
          if (!v) throw new ToolError(`'${d.embed}' needs at least one letter or digit.`);
          params[name] = v;
        }
      } else if ("terms" in d) {
        const text = input[d.terms];
        params[name] = typeof text === "string" ? contentWords(text).join(" ") || null : null;
      }
    }

    return this.serial(async () => {
      this.conn.begin();
      try {
        const out: Record<string, unknown> = {};
        let last: unknown = null;
        for (const [i, step] of tool.steps.entries()) {
          const used = Object.fromEntries(Object.entries(params).filter(([k]) => new RegExp(`\\$${k}\\b`).test(step.cypher)));
          const result = await this.conn.queryAsync(step.cypher, used as never);
          const failed = result.rows.find((r) => r._error !== null && r._error !== undefined);
          if (failed) throw new ToolError(String(failed._error));
          const rows = result.rows.map((r) => {
            const { _error, ...rest } = r;
            return toJson(rest, this.R) as Record<string, unknown>;
          });
          const value = step.single ? (rows[0] ?? null) : rows;
          if (step.name) out[step.name] = value;
          if (i === tool.steps.length - 1) last = value;
        }
        this.conn.commit();
        return Object.keys(out).length ? out : last;
      } catch (e) {
        this.conn.rollback();
        if (e instanceof ToolError) throw e;
        if (e instanceof this.R.RelateError) throw new ToolError(`The graph refused the query: ${e.message}`);
        throw e;
      }
    });
  }

  /** The model summary and its instructions, for agents (the model_guide tool). */
  guide(): string {
    const { model } = this;
    const shape = [
      `# Model: ${model.title} (${model.name} v${model.version})`,
      "",
      model.description,
      "",
      "## Nodes",
      ...Object.entries(model.nodes).map(([l, n]) => `- **${l}**: ${n.description}`),
      "",
      "## Relationships",
      ...Object.entries(model.relationships).map(([t, r]) => `- **${t}** (${r.from.join("|")} → ${r.to.join("|")}): ${r.description}`),
    ].join("\n");
    return `${shape}\n\n${this.pack.instructions}`.trim();
  }

  /** Everything a client needs to offer this graph's tools, for one caller. */
  describe(host: string, you: Caller): GraphDescription {
    const { model } = this;
    return {
      graph: this.name,
      host,
      model: { name: model.name, version: model.version, title: model.title, description: model.description },
      guide: this.guide(),
      tools: this.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, kind: t.kind, role: t.role, input: t.input })),
      you,
    };
  }

  /** The model, its tools and the size of the graph. */
  async info(): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const counts: Record<string, number> = {};
      for (const label of Object.keys(this.model.nodes)) {
        const r = await this.conn.queryAsync(`MATCH (n:${label}) RETURN count(n) AS n`);
        counts[label] = Number(r.rows[0]?.n ?? 0);
      }
      return {
        graph: this.name,
        model: { name: this.model.name, version: this.model.version, title: this.model.title, description: this.model.description },
        nodes: counts,
        tools: this.tools.map((t) => ({ name: t.name, kind: t.kind, role: t.role })),
        embedder: this.embedder.name,
      };
    });
  }
}
