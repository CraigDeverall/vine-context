// Measures the claim the project rests on: members who come and go, and write
// while they are apart, all end up holding the same graph.
//
// Each run is a process of its own, which starts MEMBERS hosts (joined with real join codes,
// linked over real WebRTC data channels, found through an in-process
// signalling bus so no network is needed). Then, for ROUNDS rounds, each
// member may go offline or come back, and each writes to its own copy from
// what it can see there: claims that support, contradict or replace others,
// questions, replies, links and withdrawals. At the end everyone comes back,
// and the run passes if every member's change log and every member's Relate
// graph are identical.
//
//   npm run bench:churn                          (20 runs, 5 members, 12 rounds)
//   npm run bench:churn -- --runs 100 --seed 7 --json out.json

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadIdentity } from "../src/core/identity.ts";
import { LocalHost } from "../src/host/client.ts";
import { Host, placeReplica } from "../src/host/host.ts";
import { hostDir } from "../src/host/state.ts";
import { joinWithCode } from "../src/p2p/join.ts";
import { parseCode } from "../src/p2p/link.ts";
import { memorySignaller } from "../src/p2p/signal.ts";

type Row = Record<string, any>;
const { values } = parseArgs({ options: { one: { type: "string" }, runs: { type: "string" }, members: { type: "string" }, rounds: { type: "string" }, seed: { type: "string" }, json: { type: "string" }, verbose: { type: "boolean" } } });
const RUNS = Number(values.runs ?? 20);
const MEMBERS = Number(values.members ?? 5);
const ROUNDS = Number(values.rounds ?? 12);
const SEED = Number(values.seed ?? 1);
const HOLD_MS = 40;
const GRAPH = "churn";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A small seeded generator, so a run's choices can be repeated. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]): T | undefined => xs[Math.floor(next() * xs.length)] };
}

/** JSON with every object's keys and every array's items in a fixed order, so two equal graphs give equal text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).sort().join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v as Row)
      .filter(([k]) => k !== "embedding")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

interface Member {
  name: string;
  dataDir: string;
  host: Host;
  local: LocalHost;
  online: boolean;
  call(tool: string, args?: Row): Promise<any>;
}

interface RunResult {
  run: number;
  ok: boolean;
  changes: number;
  writes: number;
  refused: number;
  offline_writes: number;
  presence_flips: number;
  catch_up_ms: number;
  log_hashes: string[];
  graph_hashes: string[];
  error?: string;
}

async function run(n: number): Promise<RunResult> {
  const r = rng(SEED * 100_003 + n);
  const root = mkdtempSync(join(tmpdir(), "vine-churn-"));
  roots.push(root);
  const signal = memorySignaller(new EventEmitter());
  const hosts: Host[] = [];
  const members: Member[] = [];
  const res: RunResult = { run: n, ok: false, changes: 0, writes: 0, refused: 0, offline_writes: 0, presence_flips: 0, catch_up_ms: 0, log_hashes: [], graph_hashes: [] };

  const start = async (name: string, dataDir: string): Promise<Member> => {
    const host = await Host.start({ dataDir, graph: GRAPH, user: name, signal, ice: [], holdMs: HOLD_MS });
    hosts.push(host);
    host.startSharing();
    const local = await LocalHost.connect(host.socket);
    return { name, dataDir, host, local, online: true, call: (tool, args = {}) => local.request("call", { tool, args }) };
  };

  try {
    const first = await start("m0", join(root, "m0"));
    members.push(first);
    for (let i = 1; i < MEMBERS; i++) {
      const name = `m${i}`;
      const { code } = await first.local.request<{ code: string }>("share", { label: `for ${name}`, role: "contributor" });
      const dataDir = join(root, name);
      const welcome = await joinWithCode(parseCode(code), loadIdentity(dataDir, name), { signal, ice: [], about: { agent: "bench", platform: process.platform } });
      if (!placeReplica(dataDir, welcome.graph.name, welcome.graph, welcome.changes)) throw new Error(`${name} could not place its copy`);
      members.push(await start(name, dataDir));
    }

    const active = (m: Member) => m.host.status().links.filter((l) => l.state === "active").length;
    const linked = () => {
      const on = members.filter((m) => m.online).length;
      return members.every((m) => active(m) === (m.online ? on - 1 : 0));
    };
    const same = () => members.every((m) => m.host.status().log.changes === members[0]!.host.status().log.changes && m.host.status().log.held === 0);
    await waitFor("the members to link up", linked, 30_000);

    /** One write by one member, chosen from what its own copy holds now. */
    const write = async (m: Member, round: number, k: number) => {
      const claims: Row[] = await m.call("beliefs", { limit: 200 });
      const questions: Row[] = await m.call("open_questions", { limit: 200 });
      const mine = claims.filter((c) => c.recorded_by === m.name);
      const tag = `r${round} ${m.name} #${k}`;
      const roll = r.int(100);
      const other = r.pick(claims);
      if (roll < 30 || !other) return m.call("add_claim", { text: `Finding ${tag}: the value is ${r.int(1000)}` });
      if (roll < 42) return m.call("add_claim", { text: `Evidence ${tag}`, supports: [other.id] });
      if (roll < 54) return m.call("add_claim", { text: `Objection ${tag}`, contradicts: [other.id] });
      if (roll < 66) return m.call("add_claim", { text: `Revision ${tag}`, replaces: [other.id] });
      if (roll < 74) return m.call("ask_question", { text: `Question ${tag}?`, about: [other.id] });
      if (roll < 82 && questions.length) return m.call("reply", { question: r.pick(questions)!.id, text: `Reply ${tag}` });
      if (roll < 88 && questions.length) return m.call("add_claim", { text: `Answer ${tag}`, answers: [r.pick(questions)!.id] });
      if (roll < 94 && mine.length) return m.call("withdraw", { id: r.pick(mine)!.id, reason: `withdrawn ${tag}` });
      const a = r.pick(claims)!;
      if (a.id !== other.id) return m.call("link", { from: a.id, relation: "SUPPORTS", to: other.id });
      return m.call("ask_question", { text: `Question ${tag}?` });
    };

    for (let round = 0; round < ROUNDS; round++) {
      // Some members go offline, some come back. Nobody waits for anybody.
      for (const m of members) {
        if (r.next() < 0.3) {
          await m.local.request(m.online ? "unshare" : "start_sharing");
          m.online = !m.online;
          res.presence_flips++;
        }
      }
      // Everyone writes, online or not, at the same time.
      await Promise.all(
        members.map(async (m) => {
          for (let k = 0, count = 1 + r.int(3); k < count; k++) {
            try {
              await write(m, round, k);
              res.writes++;
              if (!m.online) res.offline_writes++;
            } catch {
              res.refused++; // for example a claim that was withdrawn on this copy a moment ago
            }
          }
        }),
      );
      await sleep(r.int(250)); // sometimes long enough to sync, sometimes not
    }

    // Everyone comes back. Time how long until every copy holds every change.
    const t0 = performance.now();
    for (const m of members) {
      if (!m.online) {
        await m.local.request("start_sharing");
        m.online = true;
      }
    }
    await waitFor("the members to link up again", linked, 60_000);
    await waitFor("every copy to hold every change", same, 60_000);
    res.changes = members[0]!.host.status().log.changes;

    // The same log on every member, and the same graph. A copy applies a change to its Relate store just after
    // logging it, and equal counts can hide two copies that each still lack one change, so look until both agree.
    const logs = () =>
      members.map((m) => {
        const ids = readFileSync(join(hostDir(m.dataDir, GRAPH), "changes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id as string);
        return sha(ids.sort().join("\n"));
      });
    const graphs = async () => {
      const at = new Date().toISOString();
      const out: string[] = [];
      for (const m of members) {
        const snap = await m.local.request<Row>("snapshot", { at, limit: 1000 });
        const state = { nodes: snap.nodes, edges: snap.edges, beliefs: await m.call("beliefs", { limit: 200 }), open: await m.call("open_questions", { limit: 200 }), conflicts: await m.call("conflicts", {}) };
        out.push(sha(canonical(state)));
      }
      return out;
    };
    const end = Date.now() + 20_000;
    do {
      res.log_hashes = logs();
      res.graph_hashes = await graphs();
      res.catch_up_ms = Math.round(performance.now() - t0);
    } while ((new Set(res.graph_hashes).size > 1 || new Set(res.log_hashes).size > 1) && Date.now() < end && (await sleep(50), true));
    res.changes = members[0]!.host.status().log.changes;
    res.ok = new Set(res.log_hashes).size === 1 && new Set(res.graph_hashes).size === 1;
  } catch (e) {
    res.error = (e as Error).message;
  } finally {
    for (const m of members) m.local.close();
    for (const h of hosts) h.stop();
    // A host finishes writing a moment after it is stopped, so remove its folder once it has.
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        rmSync(root, { recursive: true, force: true });
        if (!existsSync(root)) break;
      } catch {
        // still being written: try again
      }
    }
  }
  return res;
}

const roots: string[] = [];

// One run, in this process: print its result and leave.
if (values.one) {
  const res = await run(Number(values.one));
  await sleep(300);
  for (const root of roots) rmSync(root, { recursive: true, force: true }); // anything a stopping host wrote after its run was cleared
  console.log(`RESULT ${JSON.stringify(res)}`);
  process.exit(0);
}

// Every run in a process of its own, as members' hosts are: nothing is carried from one run to the next.
const results: RunResult[] = [];
for (let n = 1; n <= RUNS; n++) {
  let res: RunResult;
  try {
    const out = execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, "--one", String(n), "--members", String(MEMBERS), "--rounds", String(ROUNDS), "--seed", String(SEED)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    res = JSON.parse(out.slice(out.lastIndexOf("RESULT ") + 7));
  } catch (e) {
    res = { run: n, ok: false, changes: 0, writes: 0, refused: 0, offline_writes: 0, presence_flips: 0, catch_up_ms: 0, log_hashes: [], graph_hashes: [], error: `the run's process failed: ${(e as Error).message.slice(0, 200)}` };
  }
  results.push(res);
  if (values.verbose || !res.ok) console.log(`run ${n}: ${res.ok ? "identical" : `DIFFERENT ${res.error ?? ""} logs=${res.log_hashes} graphs=${res.graph_hashes}`}  changes=${res.changes} writes=${res.writes} offline=${res.offline_writes} flips=${res.presence_flips} catch-up=${res.catch_up_ms}ms`);
}

const ok = results.filter((r) => r.ok);
const sum = (f: (r: RunResult) => number) => results.reduce((a, r) => a + f(r), 0);
const ms = ok.map((r) => r.catch_up_ms).sort((a, b) => a - b);
const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0;
const summary = {
  runs: RUNS,
  members: MEMBERS,
  rounds: ROUNDS,
  seed: SEED,
  identical: ok.length,
  different: RUNS - ok.length,
  writes: sum((r) => r.writes),
  written_while_offline: sum((r) => r.offline_writes),
  refused: sum((r) => r.refused),
  times_a_member_went_offline_or_came_back: sum((r) => r.presence_flips),
  changes_per_run_median: results.map((r) => r.changes).sort((a, b) => a - b)[Math.floor(RUNS / 2)],
  catch_up_ms: { median: pct(0.5), p95: pct(0.95), max: ms.at(-1) ?? 0 },
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};
console.log(JSON.stringify(summary, null, 1));
if (values.json) writeFileSync(values.json, JSON.stringify({ summary, results }, null, 1) + "\n");
process.exit(ok.length === RUNS ? 0 : 1);
