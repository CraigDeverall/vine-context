// The example story, in one place: three people (alice, bob, carol)
// investigating a checkout slowdown on 10 Nov 2026. A contradiction appears
// and is settled, a mistaken claim is withdrawn, and a question is answered.
//
// Two things play it: `scripts/make-examples.ts` writes it, backdated, into
// the example store that ships with the package, and `vine demo` runs it live
// through three replicating hosts.

export interface Step {
  who: "alice" | "bob" | "carol";
  /** When it happened in the story: day of November 2026 and time, UTC. */
  day: number;
  time: string;
  tool: string;
  /** Tool arguments. A string "@name" (alone or in a list) is the id of the step that was saved as `name`. */
  args: Record<string, unknown>;
  /** Saves this step's result id under this name, for later steps. */
  as?: string;
  /** What to tell a watcher, in plain words. */
  note: string;
}

export const GRAPH_NAME = "incident";
export const GRAPH_DESCRIPTION = "The checkout slowdown of 10 Nov 2026: what we found, what we still don't know, and what we disagreed about";

export const STEPS: Step[] = [
  {
    who: "alice", day: 10, time: "14:20", tool: "add_claim", as: "latency",
    args: { text: "Checkout p95 latency rose from 300 ms to 4 s at 13:58 on 10 Nov", source: "Grafana: checkout dashboard", about_from: "2026-11-10", about_to: "2026-11-10" },
    note: "records what the dashboard shows",
  },
  { who: "alice", day: 10, time: "14:25", tool: "ask_question", as: "whatChanged", args: { text: "What changed around 13:58 on 10 Nov?", about: ["@latency"] }, note: "asks the first question" },
  { who: "bob", day: 10, time: "14:40", tool: "add_claim", as: "deploy", args: { text: "The 14:05 deploy of payments-api caused the checkout slowdown", source: "#incident-2211" }, note: "blames the deploy" },
  {
    who: "carol", day: 10, time: "15:10", tool: "add_claim",
    args: { text: "The slowdown started at 13:58, seven minutes before the 14:05 deploy", source: "load balancer access logs", supports: ["@latency"], contradicts: ["@deploy"] },
    note: "contradicts bob: the graph now holds a conflict",
  },
  { who: "bob", day: 10, time: "15:30", tool: "add_claim", as: "pool", args: { text: "The orders database connection pool hit its limit of 50 connections at 13:57", source: "pg_stat_activity snapshot" }, note: "finds the pool ran out" },
  { who: "alice", day: 10, time: "15:45", tool: "ask_question", as: "whyPool", args: { text: "Why did the orders connection pool run out?", about: ["@pool"] }, note: "asks why" },
  { who: "carol", day: 10, time: "16:30", tool: "add_claim", as: "mobile", args: { text: "Mobile app 5.12, released at 13:50, retries failed requests immediately and without limit", source: "mobile release notes 5.12" }, note: "spots the mobile release" },
  {
    who: "carol", day: 10, time: "16:50", tool: "add_claim", as: "retries",
    args: { text: "Retries from mobile 5.12 held orders database connections open until the pool ran out", supports: ["@pool"], answers: ["@whyPool"] },
    note: "answers alice's second question",
  },
  { who: "carol", day: 10, time: "16:51", tool: "link", args: { from: "@mobile", relation: "SUPPORTS", to: "@retries" }, note: "links the release as evidence" },
  { who: "bob", day: 10, time: "17:05", tool: "add_claim", as: "redis", args: { text: "The Redis cache was down during the incident" }, note: "adds a claim about Redis" },
  { who: "bob", day: 10, time: "17:20", tool: "withdraw", args: { id: "@redis", reason: "Wrong incident: that was the staging cluster" }, note: "withdraws it: wrong incident. It stays in the history, marked as ended" },
  {
    who: "bob", day: 10, time: "17:40", tool: "add_claim",
    args: { text: "Mobile retries exhausting the orders database pool caused the checkout slowdown, not the 14:05 deploy", replaces: ["@deploy"], supports: ["@retries"], answers: ["@whatChanged"] },
    note: "replaces his deploy claim: the conflict settles, and alice's first question is answered",
  },
  { who: "alice", day: 10, time: "18:00", tool: "ask_question", args: { text: "Should the API gateway rate-limit each client?" }, note: "asks what to do about it" },
  {
    who: "alice", day: 11, time: "09:15", tool: "add_claim",
    args: { text: "Per-client rate limiting at the gateway would have contained the retry storm within a minute", source: "replay of 10 Nov traffic in staging", supports: ["@retries"] },
    note: "replays the traffic in staging the next morning. Her last question is still open",
  },
];

/** The step's moment in the story, as an ISO timestamp. */
export const storyTime = (s: Step): string => `2026-11-${String(s.day).padStart(2, "0")}T${s.time}:00.000Z`;

/** Fills in "@name" references from the ids of earlier steps. */
export function resolveArgs(args: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  const one = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("@")) {
      const id = ids.get(v.slice(1));
      if (!id) throw new Error(`scenario: no step saved as ${v}`);
      return id;
    }
    return Array.isArray(v) ? v.map(one) : v;
  };
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, one(v)]));
}

/**
 * Plays the story through `call`, which runs one tool as one person and
 * returns its result (with an `id` for writes that make something).
 */
export async function playScenario(call: (step: Step, args: Record<string, unknown>) => Promise<{ id?: string } | undefined | void>, onStep?: (step: Step, index: number) => void | Promise<void>): Promise<void> {
  const ids = new Map<string, string>();
  for (const [i, step] of STEPS.entries()) {
    await onStep?.(step, i);
    const r = await call(step, resolveArgs(step.args, ids));
    if (step.as) {
      if (!r?.id) throw new Error(`scenario: step ${i} (${step.tool}) gave no id to save as ${step.as}`);
      ids.set(step.as, r.id);
    }
  }
}
