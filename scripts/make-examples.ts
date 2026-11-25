// Builds the example graph in examples/data from one scenario: three people
// (alice, bob, carol) investigating a checkout slowdown. Every change is
// backdated, so the explorer's time slider and the `at` reads show the story
// unfold: a contradiction appears and is settled, a mistaken claim is
// withdrawn, and a question is answered.
//
// The graph is a replicated graph like any other: alice created it, bob and
// carol are members, and every write is a change signed by its author. The
// example ships alice's (throwaway) key, so the demo runs as her, the admin.
//
//   npm run examples        (rewrites examples/data)

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { signChange, uuidv7, type Change } from "../src/core/changes.ts";
import { Graph, type Caller } from "../src/core/graph.ts";
import { fingerprint, loadIdentity, type Identity } from "../src/core/identity.ts";
import { packageRoot } from "../src/core/package-root.ts";
import { b64u } from "../src/p2p/link.ts";
import { GRAPH_DESCRIPTION, playScenario, storyTime } from "../src/demo/scenario.ts";

type Row = Record<string, any>;
const out = join(packageRoot(), "examples", "data");
const keys = join(out, ".keys-not-shipped");
const [, , mode] = process.argv;

// 10 Nov 2026, times in UTC.
const at = (day: number, hhmm: string) => `2026-11-${String(day).padStart(2, "0")}T${hhmm}:00.000Z`;

/** Makes signed changes the way a host does: checked against a scratch copy, then applied to it. */
class Writer {
  changes: Change[] = [];
  private seq = new Map<string, number>();
  constructor(
    readonly graphId: string,
    private g: Graph,
    private ids: Map<string, Identity>,
  ) {}
  private sign(who: Identity, kind: Change["kind"], when: string, body: Record<string, unknown>, id = uuidv7(Date.parse(when))): Change {
    const seq = (this.seq.get(who.publicKey) ?? 0) + 1;
    this.seq.set(who.publicKey, seq);
    const c = signChange({ id, graph: this.graphId, kind, author: who.publicKey, seq, at: when, body }, who);
    this.changes.push(c);
    return c;
  }
  member(who: Identity, kind: Change["kind"], when: string, body: Record<string, unknown>, id?: string) {
    return this.sign(who, kind, when, body, id);
  }
  async call(who: Caller, when: string, tool: string, args: Row): Promise<Row> {
    const p = await this.g.prepare(tool, args, who, when);
    const c = this.sign(this.ids.get(who.id)!, p.kind, when, p.body);
    const r = await this.g.apply(c, { name: (k) => [...this.ids.values()].find((i) => i.publicKey === k)?.name ?? k, isAdmin: () => who.role === "admin" });
    if (r.status !== "applied") throw new Error(`${tool}: ${JSON.stringify(r)}`);
    return r.result;
  }
}

/** Plays the story through the writer, backdated to when each step happened. */
async function incident(w: Writer, callers: Record<string, Caller>) {
  await playScenario((step, args) => w.call(callers[step.who]!, storyTime(step), step.tool, args));
}

async function build() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const scratch = join(keys, "scratch");
  const ids = new Map<string, Identity>();
  for (const name of ["alice", "bob", "carol"]) ids.set(name, loadIdentity(name === "alice" ? out : join(keys, name), name));
  const callers = Object.fromEntries(
    [...ids].map(([name, i]) => [name, { id: name, key: i.publicKey, role: name === "alice" ? "admin" : "contributor" } as Caller]),
  );
  const graphId = uuidv7(Date.parse(at(10, "14:00")));
  const g = await Graph.open({ dataDir: scratch, name: "incident" });
  const w = new Writer(graphId, g, ids);
  const alice = ids.get("alice")!;
  w.member(alice, "create", at(10, "14:00"), { name: "incident", creator_name: "alice", description: GRAPH_DESCRIPTION }, graphId);
  for (const name of ["bob", "carol"])
    w.member(alice, "add_member", at(10, "14:01"), { key: ids.get(name)!.publicKey, name, role: "contributor", invite: { id: `inv_${name}`, label: `for ${name}` }, about: { agent: "claude-code", platform: "macOS arm64" } });
  await incident(w, callers);

  const hostDir = join(out, "hosts", "incident");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "group.json"), JSON.stringify({ id: graphId, name: "incident", secret: b64u(randomBytes(32)) }, null, 1) + "\n");
  writeFileSync(join(hostDir, "changes.jsonl"), w.changes.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(hostDir, "sharing.json"), JSON.stringify({ on: false }) + "\n");
  rmSync(keys, { recursive: true, force: true });
  console.log(`examples: incident -> examples/data: ${w.changes.length} changes by alice (${fingerprint(alice.publicKey)}), bob and carol`);
}

/** Builds the store from the log in a process of its own: a Relate store is only complete on disk once the process that wrote it exits. */
async function buildStore() {
  const { Host } = await import("../src/host/host.ts");
  const h = await Host.start({ dataDir: out, graph: "incident", user: "alice" });
  const info = await h.info();
  h.stop();
  console.log(`examples: store built: ${JSON.stringify(info.nodes)}`);
}

if (mode === "--store") {
  await buildStore();
  process.exit(0);
}
await build();
const { execFileSync } = await import("node:child_process");
execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, "--store"], { stdio: "inherit", env: { ...process.env, VINE_AUTO_SHARE: "off" } });
