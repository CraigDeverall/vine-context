// Builds the example graphs in examples/data from one scenario: three people
// (alice, bob, carol) investigating a checkout slowdown, then deciding what to
// do about it. Every call is backdated, so the explorer's time slider and the
// `at` reads show the story unfold: a contradiction appears and is settled, an
// assumption turns out false and flags the decisions resting on it.
//
//   npm run examples        (rewrites examples/data)

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Graph, type Caller } from "../src/core/graph.ts";
import { packageRoot } from "../src/core/package-root.ts";

type Row = Record<string, any>;
const alice: Caller = { id: "alice", role: "admin" };
const bob: Caller = { id: "bob", role: "contributor" };
const carol: Caller = { id: "carol", role: "contributor" };

// 10 Nov 2026, times in UTC.
const at = (day: number, hhmm: string) => `2026-11-${String(day).padStart(2, "0")}T${hhmm}:00.000Z`;

async function incident(g: Graph) {
  const call = async (who: Caller, when: string, tool: string, args: Row) => (await g.call(tool, args, who, { now: when })) as Row;
  const latency = await call(alice, at(10, "14:20"), "add_claim", {
    text: "Checkout p95 latency rose from 300 ms to 4 s at 13:58 on 10 Nov",
    source: "Grafana: checkout dashboard",
    about_from: "2026-11-10",
    about_to: "2026-11-10",
  });
  const whatChanged = await call(alice, at(10, "14:25"), "ask_question", { text: "What changed around 13:58 on 10 Nov?", about: [latency.id] });
  const deploy = await call(bob, at(10, "14:40"), "add_claim", {
    text: "The 14:05 deploy of payments-api caused the checkout slowdown",
    source: "#incident-2211",
  });
  await call(carol, at(10, "15:10"), "add_claim", {
    text: "The slowdown started at 13:58, seven minutes before the 14:05 deploy",
    source: "load balancer access logs",
    supports: [latency.id],
    contradicts: [deploy.id],
  });
  const pool = await call(bob, at(10, "15:30"), "add_claim", {
    text: "The orders database connection pool hit its limit of 50 connections at 13:57",
    source: "pg_stat_activity snapshot",
  });
  const whyPool = await call(alice, at(10, "15:45"), "ask_question", { text: "Why did the orders connection pool run out?", about: [pool.id] });
  const mobile = await call(carol, at(10, "16:30"), "add_claim", {
    text: "Mobile app 5.12, released at 13:50, retries failed requests immediately and without limit",
    source: "mobile release notes 5.12",
  });
  const retries = await call(carol, at(10, "16:50"), "add_claim", {
    text: "Retries from mobile 5.12 held orders database connections open until the pool ran out",
    supports: [pool.id],
    answers: [whyPool.id],
  });
  await call(carol, at(10, "16:51"), "link", { from: mobile.id, relation: "SUPPORTS", to: retries.id });
  const redis = await call(bob, at(10, "17:05"), "add_claim", { text: "The Redis cache was down during the incident" });
  await call(bob, at(10, "17:20"), "withdraw", { id: redis.id, reason: "Wrong incident: that was the staging cluster" });
  await call(bob, at(10, "17:40"), "add_claim", {
    text: "Mobile retries exhausting the orders database pool caused the checkout slowdown, not the 14:05 deploy",
    replaces: [deploy.id],
    supports: [retries.id],
    answers: [whatChanged.id],
  });
  await call(alice, at(10, "18:00"), "ask_question", { text: "Should the API gateway rate-limit each client?" });
  await call(alice, at(11, "09:15"), "add_claim", {
    text: "Per-client rate limiting at the gateway would have contained the retry storm within a minute",
    source: "replay of 10 Nov traffic in staging",
    supports: [retries.id],
  });
}

async function decisions(g: Graph) {
  const call = async (who: Caller, when: string, tool: string, args: Row) => (await g.call(tool, args, who, { now: when })) as Row;
  const limit = await call(alice, at(11, "10:00"), "record_decision", {
    text: "Add per-client rate limiting at the API gateway",
    rationale: "It protects every backend from any one misbehaving client, including old app versions we can't update",
    decided_by: "incident review, 11 Nov",
    source: "incident review notes for #incident-2211",
  });
  await call(alice, at(11, "10:02"), "add_option", { decision: limit.id, text: "Rate limiting at the API gateway", outcome: "chosen" });
  await call(alice, at(11, "10:03"), "add_option", {
    decision: limit.id,
    text: "Fix retries in the mobile app only",
    outcome: "rejected",
    reason: "Old app versions stay in use for months",
  });
  await call(alice, at(11, "10:04"), "add_option", {
    decision: limit.id,
    text: "Double the orders database pool size",
    outcome: "rejected",
    reason: "Moves the bottleneck to database CPU",
  });
  const header = await call(bob, at(11, "10:20"), "add_assumption", {
    text: "Every mobile request carries a client id header the gateway can limit on",
    decisions: [limit.id],
  });
  const rate = await call(bob, at(11, "10:40"), "record_decision", { text: "Limit each client to 20 requests a second", depends_on: [limit.id] });
  await call(bob, at(11, "10:41"), "add_assumption", { text: "No legitimate client needs more than 20 requests a second", decisions: [rate.id] });
  await call(carol, at(11, "11:00"), "record_decision", {
    text: "Ship mobile 5.13 with exponential backoff and at most three retries by 20 Nov",
    rationale: "Fixes the cause for current app versions",
  });
  const thursdays = await call(alice, at(11, "11:30"), "record_decision", { text: "Release only on Thursdays" });
  await call(carol, at(12, "09:30"), "invalidate_assumption", {
    id: header.id,
    because: "Mobile versions before 5.0 don't send the client id header: 12% of traffic",
  });
  await call(alice, at(12, "10:00"), "record_decision", {
    text: "Release on any weekday, with an hour of watching dashboards after each release",
    supersedes: [thursdays.id],
    rationale: "Waiting for Thursday batched changes and made the 10 Nov incident harder to untangle",
  });
}

function verify(dir: string): string | undefined {
  const relate = [process.env.RELATE_BIN, join(homedir(), ".local", "bin", "relate"), "relate"].find((c) => c && (c === "relate" || existsSync(c)))!;
  try {
    const out = execFileSync(relate, ["-d", dir, "--json", "MATCH (n) WHERE NOT n:_P2pcgMeta RETURN labels(n)[0] AS label, count(*) AS n ORDER BY label"], {
      encoding: "utf8",
      env: { ...process.env, RELATE_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = (JSON.parse(out) as { data: { label: string; n: number }[] }).data;
    if (!rows.length) throw new Error(`${dir} is empty`);
    return rows.map((r) => `${r.n} ${r.label}`).join(", ");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("examples: the relate CLI isn't installed, so the copies weren't checked");
      return undefined;
    }
    throw e;
  }
}

// Each graph is built by its own process, straight into examples/data: a
// Relate store is only complete on disk once the process that wrote it exits.
async function buildHere(name: string, model: string, fill: (g: Graph) => Promise<void>, out: string) {
  const g = await Graph.open({ dataDir: out, name, model });
  await fill(g);
}

const GRAPHS = { incident: ["temporal-claims", incident], decisions: ["decision-log", decisions] } as const;
const out = join(packageRoot(), "examples", "data");
const [, , mode, which] = process.argv;

if (mode === "--one" && which && which in GRAPHS) {
  const [model, fill] = GRAPHS[which as keyof typeof GRAPHS];
  await buildHere(which, model, fill, out);
  process.exit(0);
}

for (const [name, [model]] of Object.entries(GRAPHS)) {
  const dest = join(out, "graphs", name);
  rmSync(dest, { recursive: true, force: true });
  execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, "--one", name], { stdio: "inherit" });
  const counts = verify(dest);
  console.log(`examples: ${name} (${model}) -> examples/data/graphs/${name}${counts ? `: ${counts}` : ""}`);
}
