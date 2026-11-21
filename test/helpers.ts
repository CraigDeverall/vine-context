import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "../src/core/changes.js";
import { Graph, ToolError, type ApplyContext, type Caller } from "../src/core/graph.js";

export const tempDir = (prefix = "p2pcg-test-") => mkdtempSync(join(tmpdir(), prefix));

/** A fake 43-character public key for a test caller. */
const fakeKey = (name: string) => Buffer.from(name.padEnd(32, "_")).toString("base64url").slice(0, 43);

export const alice: Caller = { id: "alice", key: fakeKey("alice"), role: "contributor" };
export const bob: Caller = { id: "bob", key: fakeKey("bob"), role: "contributor" };
export const admin: Caller = { id: "root", key: fakeKey("root"), role: "admin" };
export const reader: Caller = { id: "rita", key: fakeKey("rita"), role: "reader" };
const callers = [alice, bob, admin, reader];

/** Names and admin rights for apply, from the test callers. */
export const ctx: ApplyContext = {
  name: (key) => callers.find((c) => c.key === key)?.id ?? key,
  isAdmin: (key) => callers.find((c) => c.key === key)?.role === "admin",
};

let n = 0;
/** A fresh graph in its own data folder. */
export function openGraph(opts: { dataDir?: string; name?: string } = {}) {
  return Graph.open({ dataDir: opts.dataDir ?? tempDir(), name: opts.name ?? `g${++n}` });
}

/** Calls a tool as a host would: reads run, writes are prepared, then applied as a change. */
export async function act(g: Graph, tool: string, args: Record<string, unknown>, caller: Caller, at = new Date().toISOString()): Promise<unknown> {
  const spec = g.tools.find((t) => t.name === tool);
  if (spec?.kind !== "write") return g.call(tool, args, caller);
  const p = await g.prepare(tool, args, caller, at);
  const r = await g.apply({ id: uuidv7(), kind: p.kind, author: caller.key!, at, body: p.body }, ctx);
  if (r.status === "refused") throw new ToolError(r.reason);
  if (r.status === "pending") return { waiting: r.waiting };
  return r.result;
}

export const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
