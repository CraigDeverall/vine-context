// The graph on this machine: one Relate store, built from the graph's changes,
// with the Claims and Questions model's tools.
//
// Read tools run the model's Cypher in one transaction. Write tools only
// check their input here (prepare); the write itself is a change, applied by
// apply() in the same way on every member's machine. apply() is idempotent
// and order-independent: whatever order changes arrive in, the same set of
// changes gives the same graph.
//   - A claim or question is created once (by its node id).
//   - A link waits until both ends exist ("pending"), and of two equal links
//     the earlier is kept.
//   - Of two withdrawals of one item, the earlier is kept.
//   - Checks that depend on what this machine has seen so far ("that claim is
//     withdrawn", "that link already exists") run only in prepare, on the
//     author's machine, never in apply.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Change } from "./changes.js";
import { uuidv7 } from "./changes.js";
import { contentWords, makeEmbedder, type Embedder } from "./embed.js";
import { claimsPack, type InputSpecT, type Model, type Pack, type ToolSpec } from "./pack.js";
import { loadRelate, type Connection, type Database, type RelateModule } from "./relate.js";
import { defaultDataDir } from "./paths.js";
import { toJson } from "./values.js";
import type { GraphDescription } from "../p2p/protocol.js";

export type { Role } from "./changes.js";
import { RANK, type Role } from "./changes.js";

export interface Caller {
  /** The caller's name: recorded as $by. */
  id: string;
  /** The caller's public key: recorded as `author`. */
  key?: string;
  role: Role;
}

/** A failure the agent should see and can act on. */
export class ToolError extends Error {}

/** Relate refused a tool's Cypher: a bug in the model, not in the caller's input. */
export class QueryError extends ToolError {}

export { defaultDataDir } from "./paths.js";

/** A node id: the kind's letter and a time-ordered UUID, e.g. c_0193…. Two machines never make the same one. */
export function newId(prefix: string): string {
  return `${prefix}_${uuidv7()}`;
}

/** What a write tool will do, once checked: a change's kind and body. */
export interface Prepared {
  kind: "claim" | "question" | "reply" | "link" | "withdraw";
  body: Record<string, unknown>;
}

/** Applying a change: done, waiting for something it refers to, or never (with why). */
export type Applied = { status: "applied"; result: Record<string, unknown> } | { status: "pending"; waiting: string[] } | { status: "refused"; reason: string };

/** What apply needs to know about the change's author, from the membership. */
export interface ApplyContext {
  /** The name to record for a key. */
  name(key: string): string;
  /** Was this key an admin at that moment? */
  isAdmin(key: string, at: string): boolean;
}

/** A calendar day, checked strictly (a real date, YYYY-MM-DD). */
export const isoDay = () => z.iso.date({ error: "must be a real calendar date as YYYY-MM-DD, for example 2026-03-01" });
/** A moment, checked strictly (ISO 8601 with seconds and a time zone). */
export const isoMoment = () => z.iso.datetime({ offset: true, error: "must be an ISO 8601 date-time with a time zone, for example 2026-03-01T09:00:00Z" });

/**
 * `listing` is the shape a tool listing shows: dates are a plain string with a
 * JSON Schema `format`, not zod's long validation pattern. The strict check is
 * made where the call is handled, with the full shape.
 */
function scalar(type: string, spec: Pick<InputSpecT, "max_length" | "min" | "max">, listing = false): z.ZodType {
  switch (type) {
    case "string":
      return z.string().max(spec.max_length ?? 20_000);
    case "id":
      return listing ? z.string() : z.string().min(1).max(64);
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
      return listing ? z.string().meta({ format: "date" }) : isoDay();
    case "datetime":
      return listing ? z.string().meta({ format: "date-time" }) : isoMoment();
    default:
      throw new Error(`unknown type ${type}`);
  }
}

/** The zod shape of a tool's input: for validation, or with `listing` for MCP tool listings (see scalar). */
export function inputShape(input: Record<string, InputSpecT>, listing = false): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(input)) {
    let s: z.ZodType =
      spec.type === "enum"
        ? z.enum(spec.values as [string, ...string[]])
        : spec.type === "array"
          ? z.array(scalar(spec.items!, spec, listing)).max(100)
          : scalar(spec.type, spec, listing);
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
  /** A digest of the changes applied to this store, in order: tells the host whether the store matches its log. */
  applied?: string;
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

const CLAIM_RELS = new Set(["SUPPORTS", "CONTRADICTS", "REPLACES"]);
const REL_TYPES = new Set(["SUPPORTS", "CONTRADICTS", "REPLACES", "ANSWERS", "ABOUT", "REPLIES_TO"]);
const isArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 64) : []);
const str = (v: unknown, max = 20_000): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export interface SnapshotSchema {
  nodes: {
    label: string;
    description: string;
    key: string | null;
    title: string | null;
    properties: { name: string; type: string; required: boolean; description: string | null }[];
  }[];
  relationships: { type: string; description: string; from: string[]; to: string[] }[];
  time: { recorded: string; ended?: string } | null;
}
export interface SnapshotNode {
  /** Label:key, unique across labels. */
  id: string;
  key: string;
  label: string;
  title: string;
  /** Ended (for example withdrawn) at or before the snapshot's time. */
  ended: boolean;
  props: Record<string, unknown>;
}
export interface SnapshotEdge {
  type: string;
  source: string;
  target: string;
  props: Record<string, unknown>;
}
export interface Snapshot {
  graph: string;
  model: string;
  at: string;
  schema: SnapshotSchema;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  truncated: boolean;
}

function recordedOf(n: SnapshotNode, time: Model["time"]): number {
  const v = time ? n.props[time.recorded] : undefined;
  return typeof v === "string" ? Date.parse(v) : 0;
}

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

  /** Opens (or creates) a graph's store on this machine. Every graph uses the Claims and Questions model. */
  static async open(opts: { name?: string; dataDir?: string; embedder?: Embedder; log?(msg: string): void } = {}): Promise<Graph> {
    const name = opts.name ?? process.env.VINE_GRAPH ?? "default";
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
    const embedder = opts.embedder ?? makeEmbedder(undefined, opts.log);
    const found = conn.query("MATCH (m:_VineMeta {key: 'meta'}) RETURN m {.*} AS m").rows[0]?.m as Meta | undefined;
    const pack = claimsPack();
    if (found && found.model !== pack.model.name)
      throw new ToolError(`Graph '${name}' uses the model '${found.model}', which this version of vine-context no longer supports (only '${pack.model.name}').`);
    const graph = new Graph(name, dir, pack, embedder, db, conn, R, store);
    if (found && found.embedder !== embedder.name) {
      opts.log?.(`graph '${name}': its vectors were made by ${found.embedder}; making them again with ${embedder.name}`);
      graph.reembed();
    }
    graph.applyModel(found);
    return graph;
  }

  /**
   * Replaces every search vector with this graph's embedder's, after the graph
   * was last written with another. Vectors are made from the text and are never
   * sent to peers, so this changes nothing a peer can see. The index is dropped
   * first because the new vectors may have another length; applyModel makes it again.
   */
  private reembed(): void {
    const { search, nodes } = this.pack.model;
    if (!search) return;
    this.conn.query("DROP INDEX search_embedding IF EXISTS");
    this.conn.begin();
    try {
      for (const label of search.labels) {
        const key = nodes[label]?.key;
        if (!key) throw new Error(`'${label}' is searched but has no key to re-embed it by`);
        const rows = this.conn.query(`MATCH (n:${label}) RETURN n.${key} AS key, n.${search.text} AS text`).rows;
        for (const row of rows) {
          const text = typeof row.text === "string" ? row.text : "";
          const embedding = contentWords(text).length ? this.embedder.embed(text) : null;
          this.conn.query(`MATCH (n:${label} {${key}: $key}) SET n.embedding = $embedding`, { key: String(row.key), embedding });
        }
      }
      this.conn.commit();
    } catch (e) {
      this.conn.rollback();
      throw new Error(`re-embedding graph '${this.name}' with '${this.embedder.name}' failed: ${(e as Error).message}`);
    }
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
      "MERGE (m:_VineMeta {key: 'meta'}) SET m.model = $model, m.model_version = $version, " +
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

  private async rows(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    try {
      const r = await this.conn.queryAsync(cypher, params as never);
      return r.rows.map((row) => toJson(row, this.R) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof this.R.RelateError) throw new QueryError(`The graph refused the query: ${e.message}`);
      throw e;
    }
  }

  private tool(toolName: string, caller: Caller): { tool: ToolSpec; input: Record<string, unknown> } & { parse(args: unknown): Record<string, unknown> } {
    const tool = this.pack.tools.find((t) => t.name === toolName);
    if (!tool) throw new ToolError(`No tool '${toolName}' in the model '${this.model.name}'.`);
    if (RANK[caller.role] < RANK[tool.role]) throw new ToolError(`'${toolName}' needs the ${tool.role} role; you are a ${caller.role}.`);
    const validator = this.validators.get(tool.name)!;
    return {
      tool,
      input: {},
      parse(args: unknown) {
        const parsed = validator.safeParse(args ?? {});
        if (!parsed.success)
          throw new ToolError("Invalid input:\n" + parsed.error.issues.map((i) => `- ${i.path.join(".") || "(input)"}: ${i.message}`).join("\n"));
        return parsed.data as Record<string, unknown>;
      },
    };
  }

  /** The parameters a tool's Cypher sees: its input, the server's own, and the derived ones. */
  private params(tool: ToolSpec, input: Record<string, unknown>, caller: Caller, now: string, embed: boolean): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const name of Object.keys(tool.input)) params[name] = input[name] ?? null;
    params.now = now;
    params.by = caller.id;
    params.key = caller.key ?? null;
    params.role = caller.role;
    for (const [name, d] of Object.entries(tool.derive)) {
      if ("new_id" in d) params[name] = newId(d.new_id);
      else if ("embed" in d) {
        const text = input[d.embed];
        if (typeof text !== "string") params[name] = null;
        else if (!contentWords(text).length) throw new ToolError(`'${d.embed}' needs at least one letter or digit.`);
        else params[name] = embed ? this.embedder.embed(text) : null;
      } else if ("terms" in d) {
        const text = input[d.terms];
        params[name] = typeof text === "string" ? contentWords(text).join(" ") || null : null;
      }
    }
    return params;
  }

  /** Runs a tool's steps; a row with `_error` fails the call. Read tools only change nothing; checks are rolled back. */
  private async runSteps(tool: ToolSpec, params: Record<string, unknown>, commit: boolean): Promise<unknown> {
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
      if (commit) this.conn.commit();
      else this.conn.rollback();
      return Object.keys(out).length ? out : last;
    } catch (e) {
      this.conn.rollback();
      if (e instanceof ToolError) throw e;
      if (e instanceof this.R.RelateError) throw new QueryError(`The graph refused the query: ${e.message}`);
      throw e;
    }
  }

  /** Runs one of the model's read tools. */
  async call(toolName: string, args: unknown, caller: Caller): Promise<unknown> {
    const t = this.tool(toolName, caller);
    if (t.tool.kind === "write") throw new ToolError(`'${toolName}' is a write: it goes through the change log (prepare, then apply).`);
    const input = t.parse(args);
    const params = this.params(t.tool, input, caller, new Date().toISOString(), true);
    return this.serial(() => this.runSteps(t.tool, params, false));
  }

  /** Checks a write tool's input against the graph as this machine has it, and says what change it makes. */
  async prepare(toolName: string, args: unknown, caller: Caller, now = new Date().toISOString()): Promise<Prepared> {
    const t = this.tool(toolName, caller);
    if (t.tool.kind !== "write" || !t.tool.apply) throw new ToolError(`'${toolName}' is not a write.`);
    const input = t.parse(args);
    const params = this.params(t.tool, input, caller, now, false);
    await this.serial(() => this.runSteps(t.tool, params, false));
    switch (t.tool.apply) {
      case "claim":
        return {
          kind: "claim",
          body: {
            node: params.id,
            text: input.text,
            source: input.source ?? null,
            about_from: input.about_from ?? null,
            about_to: input.about_to ?? null,
            supports: input.supports ?? [],
            contradicts: input.contradicts ?? [],
            replaces: input.replaces ?? [],
            answers: input.answers ?? [],
          },
        };
      case "question":
        return { kind: "question", body: { node: params.id, text: input.text, about: input.about ?? [] } };
      case "reply":
        return { kind: "reply", body: { node: params.id, text: input.text, question: input.question } };
      case "link":
        return { kind: "link", body: { from: input.from, relation: input.relation, to: input.to } };
      case "withdraw":
        return { kind: "withdraw", body: { node: input.id, reason: input.reason ?? null } };
    }
  }

  // ---- Applying changes -------------------------------------------------

  /**
   * Applies one data change to the store. Membership has already been
   * checked by the caller (the author could make this change at that time).
   */
  async apply(c: Pick<Change, "id" | "kind" | "author" | "at" | "body">, ctx: ApplyContext): Promise<Applied> {
    return this.serial(async () => {
      this.conn.begin();
      try {
        const out = await this.applyOne(c, ctx);
        if (out.status === "applied" && (c.kind === "claim" || c.kind === "question" || c.kind === "reply")) await this.retryPending(ctx);
        this.conn.commit();
        return out;
      } catch (e) {
        this.conn.rollback();
        if (e instanceof this.R.RelateError) throw new QueryError(`The graph refused a change: ${e.message}`);
        throw e;
      }
    });
  }

  private async applyOne(c: Pick<Change, "id" | "kind" | "author" | "at" | "body">, ctx: ApplyContext): Promise<Applied> {
    const b = c.body;
    const by = ctx.name(c.author);
    switch (c.kind) {
      case "claim":
      case "question": {
        const label = c.kind === "claim" ? "Claim" : "Question";
        const node = str(b.node, 64);
        const text = str(b.text, c.kind === "claim" ? 2000 : 1000);
        if (!node || !text || !node.startsWith(c.kind === "claim" ? "c_" : "q_")) return { status: "refused", reason: "bad node or text" };
        const exists = await this.rows(`OPTIONAL MATCH (n:Claim|Question {id: $node}) RETURN n.change AS change`, { node });
        if (exists[0]?.change !== null && exists[0]?.change !== undefined)
          return exists[0].change === c.id ? { status: "applied", result: { id: node, recorded_at: c.at } } : { status: "refused", reason: `${node} already exists` };
        const embedding = contentWords(text).length ? this.embedder.embed(text) : null;
        await this.rows(
          `CREATE (n:${label} {id: $node, text: $text, embedding: $embedding, recorded_at: datetime($at), recorded_by: $by, author: $author, change: $change})` +
            (c.kind === "claim"
              ? ` SET n.source = $source, n.about_from = CASE WHEN $about_from IS NULL THEN null ELSE date($about_from) END, n.about_to = CASE WHEN $about_to IS NULL THEN null ELSE date($about_to) END`
              : ""),
          { node, text, embedding, at: c.at, by, author: c.author, change: c.id, ...(c.kind === "claim" ? { source: str(b.source, 500), about_from: day(b.about_from), about_to: day(b.about_to) } : {}) },
        );
        const links: [string, string[]][] =
          c.kind === "claim"
            ? [
                ["SUPPORTS", isArray(b.supports)],
                ["CONTRADICTS", isArray(b.contradicts)],
                ["REPLACES", isArray(b.replaces)],
                ["ANSWERS", isArray(b.answers)],
              ]
            : [["ABOUT", isArray(b.about)]];
        const counts: Record<string, number> = {};
        for (const [rel, targets] of links) {
          counts[rel.toLowerCase()] = 0;
          for (const to of targets) {
            const r = await this.link({ change: c.id, author: c.author, at: c.at, from: node, relation: rel, to }, ctx);
            if (r.status === "applied") counts[rel.toLowerCase()]!++;
            else if (r.status === "pending") await this.addPending(c.id, "edge", { change: c.id, author: c.author, at: c.at, from: node, relation: rel, to });
          }
        }
        return { status: "applied", result: { id: node, recorded_at: c.at, ...counts } };
      }
      case "reply": {
        const node = str(b.node, 64);
        const text = str(b.text, 2000);
        const question = str(b.question, 64);
        if (!node || !text || !question || !node.startsWith("r_")) return { status: "refused", reason: "bad reply" };
        const exists = await this.rows(`OPTIONAL MATCH (n:Reply {id: $node}) RETURN n.change AS change`, { node });
        if (exists[0]?.change !== null && exists[0]?.change !== undefined)
          return exists[0].change === c.id ? { status: "applied", result: { id: node, recorded_at: c.at } } : { status: "refused", reason: `${node} already exists` };
        await this.rows(`CREATE (n:Reply {id: $node, text: $text, recorded_at: datetime($at), recorded_by: $by, author: $author, change: $change})`, { node, text, at: c.at, by, author: c.author, change: c.id });
        const e = { change: c.id, author: c.author, at: c.at, from: node, relation: "REPLIES_TO", to: question };
        const r = await this.link(e, ctx);
        if (r.status === "pending") await this.addPending(c.id, "edge", e);
        return { status: "applied", result: { id: node, question, recorded_at: c.at } };
      }
      case "link": {
        const from = str(b.from, 64);
        const to = str(b.to, 64);
        const relation = str(b.relation, 20);
        if (!from || !to || !relation || !REL_TYPES.has(relation) || relation === "ABOUT" || relation === "REPLIES_TO") return { status: "refused", reason: "bad link" };
        const r = await this.link({ change: c.id, author: c.author, at: c.at, from, relation, to }, ctx);
        if (r.status === "pending") await this.addPending(c.id, "edge", { change: c.id, author: c.author, at: c.at, from, relation, to });
        return r.status === "applied" ? { status: "applied", result: { from, relation, to } } : r;
      }
      case "withdraw": {
        const node = str(b.node, 64);
        if (!node) return { status: "refused", reason: "bad withdraw" };
        const r = await this.withdraw({ change: c.id, author: c.author, at: c.at, node, reason: str(b.reason, 500) }, ctx);
        if (r.status === "pending") await this.addPending(c.id, "withdraw", { change: c.id, author: c.author, at: c.at, node, reason: str(b.reason, 500) });
        return r;
      }
    }
    return { status: "refused", reason: `not a data change: ${c.kind}` };
  }

  /** Creates a link between two existing items, keeping the earlier of two equal links. */
  private async link(e: { change: string; author: string; at: string; from: string; relation: string; to: string }, ctx: ApplyContext): Promise<Applied> {
    if (e.from === e.to) return { status: "refused", reason: "an item can't link to itself" };
    const ends = await this.rows(
      `OPTIONAL MATCH (a:Claim|Question|Reply {id: $from}) OPTIONAL MATCH (b:Claim|Question {id: $to}) ` +
        `RETURN a IS NOT NULL AS a, b IS NOT NULL AS b, a:Claim AS a_claim, a:Reply AS a_reply, b:Claim AS b_claim, b:Question AS b_question`,
      { from: e.from, to: e.to },
    );
    const x = ends[0] ?? {};
    const waiting = [...(x.a ? [] : [e.from]), ...(x.b ? [] : [e.to])];
    if (waiting.length) return { status: "pending", waiting };
    const fromLabel = x.a_claim ? "Claim" : x.a_reply ? "Reply" : "Question";
    const toLabel = x.b_claim ? "Claim" : "Question";
    const ok =
      e.relation === "REPLIES_TO"
        ? fromLabel === "Reply" && toLabel === "Question"
        : fromLabel === "Reply"
          ? false
          : e.relation === "ABOUT"
        ? fromLabel === "Question"
        : fromLabel === "Claim" && (CLAIM_RELS.has(e.relation) ? toLabel === "Claim" : e.relation === "ANSWERS" && toLabel === "Question");
    if (!ok) return { status: "refused", reason: `${e.relation} can't link a ${fromLabel} to a ${toLabel}` };
    const existing = await this.rows(`MATCH (a:${fromLabel} {id: $from})-[r:${e.relation}]->(b:${toLabel} {id: $to}) RETURN r.recorded_at AS at, r.change AS change`, e);
    const by = ctx.name(e.author);
    if (!existing.length) {
      await this.rows(
        `MATCH (a:${fromLabel} {id: $from}), (b:${toLabel} {id: $to}) CREATE (a)-[:${e.relation} {recorded_at: datetime($at), recorded_by: $by, author: $author, change: $change}]->(b)`,
        { ...e, by },
      );
    } else if (existing[0]!.change !== e.change && Date.parse(e.at) < Date.parse(String(existing[0]!.at))) {
      await this.rows(
        `MATCH (a:${fromLabel} {id: $from})-[r:${e.relation}]->(b:${toLabel} {id: $to}) SET r.recorded_at = datetime($at), r.recorded_by = $by, r.author = $author, r.change = $change`,
        { ...e, by },
      );
    }
    return { status: "applied", result: { from: e.from, relation: e.relation, to: e.to } };
  }

  private async withdraw(w: { change: string; author: string; at: string; node: string; reason: string | null }, ctx: ApplyContext): Promise<Applied> {
    const found = await this.rows(`OPTIONAL MATCH (n:Claim|Question|Reply {id: $node}) RETURN n IS NOT NULL AS found, n.author AS author, n.recorded_by AS by, n.withdrawn_at AS w`, { node: w.node });
    const n = found[0] ?? {};
    if (!n.found) return { status: "pending", waiting: [w.node] };
    const own = n.author ? n.author === w.author : n.by === ctx.name(w.author);
    if (!own && !ctx.isAdmin(w.author, w.at)) return { status: "refused", reason: "only its author or an admin can withdraw it" };
    if (n.w === null || n.w === undefined || Date.parse(w.at) < Date.parse(String(n.w)))
      await this.rows(
        `MATCH (n:Claim|Question|Reply {id: $node}) SET n.withdrawn_at = datetime($at), n.withdrawn_by = $by, n.withdrawn_author = $author, n.withdraw_reason = $reason, n.withdraw_change = $change`,
        { ...w, by: ctx.name(w.author) },
      );
    return { status: "applied", result: { id: w.node, withdrawn_at: w.at } };
  }

  private async addPending(change: string, kind: "edge" | "withdraw", data: Record<string, unknown>) {
    await this.rows(`CREATE (:_VinePending {change: $change, kind: $kind, data: $data})`, { change, kind, data: JSON.stringify(data) });
  }

  /** Retries links and withdrawals that were waiting for an item that may now exist. */
  private async retryPending(ctx: ApplyContext) {
    for (let round = 0; round < 3; round++) {
      const pending = await this.rows(`MATCH (p:_VinePending) RETURN p.change AS change, p.kind AS kind, p.data AS data`);
      if (!pending.length) return;
      let progress = false;
      for (const p of pending) {
        const d = JSON.parse(String(p.data));
        const r = p.kind === "edge" ? await this.link(d, ctx) : await this.withdraw(d, ctx);
        if (r.status !== "pending") {
          await this.rows(`MATCH (p:_VinePending {change: $change, kind: $kind, data: $data}) DELETE p`, { change: p.change, kind: p.kind, data: p.data });
          progress = true;
        }
      }
      if (!progress) return;
    }
  }

  /** Takes back a claim or question this machine just made and hasn't sent: it was never shared. */
  async discard(changeId: string): Promise<boolean> {
    return this.serial(async () => {
      const found = await this.rows(`MATCH (n:Claim|Question|Reply {change: $change}) RETURN count(n) AS n`, { change: changeId });
      await this.rows(`MATCH (n:Claim|Question|Reply {change: $change}) DETACH DELETE n`, { change: changeId });
      await this.rows(`MATCH (p:_VinePending {change: $change}) DELETE p`, { change: changeId });
      return Number(found[0]?.n ?? 0) > 0;
    });
  }

  /** Empties the store (keeping the model's indexes), to build it again from the log. */
  async reset(): Promise<void> {
    await this.serial(async () => {
      await this.rows(`MATCH (n) WHERE NOT n:_VineMeta DETACH DELETE n`);
      await this.rows(`MATCH (m:_VineMeta {key: 'meta'}) SET m.applied = null`);
    });
  }

  /** Records which changes the store holds (a digest of their ids, in the order applied). */
  async setApplied(digest: string): Promise<void> {
    await this.serial(() => this.rows(`MATCH (m:_VineMeta {key: 'meta'}) SET m.applied = $digest`, { digest }));
  }

  async getApplied(): Promise<string | null> {
    const r = await this.serial(() => this.rows(`MATCH (m:_VineMeta {key: 'meta'}) RETURN m.applied AS applied`));
    return (r[0]?.applied as string | null) ?? null;
  }

  /** Puts each member's current name on what they recorded (after a rename). */
  async refreshNames(names: Map<string, string>): Promise<void> {
    await this.serial(async () => {
      for (const [key, name] of names) {
        await this.rows(`MATCH (n:Claim|Question|Reply) WHERE n.author = $key AND n.recorded_by <> $name SET n.recorded_by = $name`, { key, name });
        await this.rows(`MATCH (n:Claim|Question|Reply) WHERE n.withdrawn_author = $key AND n.withdrawn_by <> $name SET n.withdrawn_by = $name`, { key, name });
        await this.rows(`MATCH ()-[r]->() WHERE r.author = $key AND r.recorded_by <> $name SET r.recorded_by = $name`, { key, name });
      }
    });
  }

  /**
   * Items by id, with what the sync digest needs: kind, text, author, and
   * whether each is current (not withdrawn, and for a claim not replaced by a
   * current claim).
   */
  async items(ids: string[]): Promise<Map<string, { id: string; label: "Claim" | "Question"; text: string; author: string | null; by: string; current: boolean }>> {
    const out = new Map<string, { id: string; label: "Claim" | "Question"; text: string; author: string | null; by: string; current: boolean }>();
    const unique = [...new Set(ids)].filter((x) => typeof x === "string").slice(0, 500);
    if (!unique.length) return out;
    const rows = await this.serial(() =>
      this.rows(
        `MATCH (n:Claim|Question) WHERE n.id IN $ids ` +
          `RETURN n.id AS id, labels(n) AS labels, n.text AS text, n.author AS author, n.recorded_by AS by, ` +
          `n.withdrawn_at IS NULL AND NOT EXISTS { MATCH (r:Claim)-[:REPLACES]->(n) WHERE r.withdrawn_at IS NULL } AS current`,
        { ids: unique },
      ),
    );
    for (const r of rows)
      out.set(String(r.id), {
        id: String(r.id),
        label: (r.labels as string[]).includes("Claim") ? "Claim" : "Question",
        text: String(r.text ?? ""),
        author: (r.author as string | null) ?? null,
        by: String(r.by ?? ""),
        current: Boolean(r.current),
      });
    return out;
  }

  /** The claims that replace this one and are themselves current: two or more means a conflict nobody settled. */
  async currentReplacers(id: string): Promise<{ id: string; text: string; by: string }[]> {
    const rows = await this.serial(() =>
      this.rows(
        `MATCH (r:Claim)-[:REPLACES]->(:Claim {id: $id}) WHERE r.withdrawn_at IS NULL ` +
          `AND NOT EXISTS { MATCH (newer:Claim)-[:REPLACES]->(r) WHERE newer.withdrawn_at IS NULL } ` +
          `RETURN r.id AS id, r.text AS text, r.recorded_by AS by ORDER BY r.recorded_at`,
        { id },
      ),
    );
    return rows.map((r) => ({ id: String(r.id), text: String(r.text ?? ""), by: String(r.by ?? "") }));
  }

  /** The ids of items linked to or from this one, either way. */
  async linkedIds(id: string): Promise<Set<string>> {
    const rows = await this.serial(() => this.rows(`MATCH (n:Claim|Question {id: $id})-[]-(m:Claim|Question) RETURN m.id AS id`, { id }));
    return new Set(rows.map((r) => String(r.id)));
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
      schema: this.schema(),
      tools: this.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        kind: t.kind,
        role: t.role,
        input: t.input,
        ...(t.view ? { view: t.view } : {}),
        ...(t.undo ? { undo: t.undo } : {}),
      })),
      you,
    };
  }

  /** The model's shape, for views: labels with their title property, and relationship types. */
  schema(): SnapshotSchema {
    const { model } = this;
    return {
      nodes: Object.entries(model.nodes).map(([label, n]) => ({
        label,
        description: n.description,
        key: n.key ?? null,
        title: n.title ?? (model.search && n.properties[model.search.text] ? model.search.text : (n.key ?? null)),
        properties: Object.entries(n.properties).map(([name, p]) => ({ name, type: p.type, required: p.required, description: p.description ?? null })),
      })),
      relationships: Object.entries(model.relationships).map(([type, r]) => ({ type, description: r.description, from: r.from, to: r.to })),
      time: model.time ?? null,
    };
  }

  /**
   * The graph as it stood at `at` (default now): its nodes, newest first, and
   * the relationships between them. Works for any model: it reads the labels
   * and relationship types from model.yaml, and the time properties from its
   * `time` section if it has one.
   */
  async snapshot(o: { at?: string; limit?: number } = {}): Promise<Snapshot> {
    const at = o.at ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) throw new ToolError(`'at' must be an ISO 8601 date-time: '${at}'.`);
    const limit = Math.min(Math.max(Math.trunc(o.limit ?? 200), 1), 1000);
    const schema = this.schema();
    const time = this.model.time;
    return this.serial(async () => {
      const nodes: SnapshotNode[] = [];
      for (const n of schema.nodes) {
        if (!n.key) continue; // nodes without a key can't be linked to in a view
        const when = time ? `WHERE n.${time.recorded} IS NULL OR n.${time.recorded} <= datetime($at)` : "";
        const order = time ? `ORDER BY n.${time.recorded} DESC` : "";
        const r = await this.conn.queryAsync(`MATCH (n:${n.label}) ${when} RETURN n {.*} AS n ${order} LIMIT $limit`, { at, limit } as never);
        for (const row of r.rows) {
          const props = toJson(row.n, this.R) as Record<string, unknown>;
          const ended = time?.ended ? (props[time.ended] as string | undefined) : undefined;
          nodes.push({
            id: `${n.label}:${String(props[n.key])}`,
            key: String(props[n.key]),
            label: n.label,
            title: String(props[n.title ?? n.key] ?? props[n.key]),
            ended: Boolean(ended && Date.parse(ended) <= Date.parse(at)),
            props,
          });
        }
      }
      nodes.sort((a, b) => recordedOf(b, time) - recordedOf(a, time));
      const kept = nodes.slice(0, limit);
      const ids = new Set(kept.map((n) => n.id));
      const edges: SnapshotEdge[] = [];
      const keyOf = new Map(schema.nodes.map((n) => [n.label, n.key]));
      for (const rel of schema.relationships)
        for (const from of rel.from)
          for (const to of rel.to) {
            const fk = keyOf.get(from);
            const tk = keyOf.get(to);
            if (!fk || !tk) continue;
            const when = time ? `WHERE r.${time.recorded} IS NULL OR r.${time.recorded} <= datetime($at)` : "";
            const r = await this.conn.queryAsync(
              `MATCH (a:${from})-[r:${rel.type}]->(b:${to}) ${when} RETURN a.${fk} AS a, b.${tk} AS b, r {.*} AS r`,
              { at } as never,
            );
            for (const row of r.rows) {
              const source = `${from}:${String(row.a)}`;
              const target = `${to}:${String(row.b)}`;
              if (ids.has(source) && ids.has(target))
                edges.push({ type: rel.type, source, target, props: toJson(row.r, this.R) as Record<string, unknown> });
            }
          }
      return { graph: this.name, model: this.model.name, at, schema, nodes: kept, edges, truncated: nodes.length > kept.length };
    });
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
