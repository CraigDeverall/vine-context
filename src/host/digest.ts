// The sync digest: what changes from other members mean for this machine's
// person, worked out after they arrive (a live sync, or a catch-up after being
// offline). Not just "bob claimed …", but:
//   - a claim of yours was replaced (and by what);
//   - a question of yours was answered;
//   - a new conflict: a claim contradicts another (yours first);
//   - two current claims replace the same claim: nobody settled which holds;
//   - a possible overlap: a new claim close to an existing one by someone else,
//     with no link between them, for the agent to link if they are related.
// Nothing is linked automatically: recording SUPPORTS, CONTRADICTS or REPLACES
// stays the agent's (and person's) decision.
//
// The briefing is the same idea for someone who has just joined: everything is
// new to them, so it says what the context holds, what's open and what's
// disputed.

import type { Change } from "../core/changes.js";
import { contentWords } from "../core/embed.js";
import type { Caller, Graph } from "../core/graph.js";

const MAX_LINES = 12;
const MAX_OVERLAP_CHECKS = 40;

export interface DigestContext {
  graph: Graph;
  me: string;
  name(key: string): string;
  reader: Caller;
}

const q = (s: string, n = 90) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Shared content words, as a share of the shorter text's: a rough "about the same thing" for the offline embedder. */
export function overlap(a: string, b: string): number {
  const x = new Set(contentWords(a).filter((w) => w.length > 2));
  const y = new Set(contentWords(b).filter((w) => w.length > 2));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared < 3 ? 0 : shared / Math.min(x.size, y.size);
}

export async function digest(changes: Change[], ctx: DigestContext): Promise<string[]> {
  const others = changes.filter((c) => c.author !== ctx.me && ["claim", "question", "reply", "link", "withdraw"].includes(c.kind));
  if (!others.length) return [];
  const g = ctx.graph;

  // Every item the changes touch, looked up once.
  const ids: string[] = [];
  for (const c of others) {
    const b = c.body;
    if (typeof b.node === "string") ids.push(b.node);
    ids.push(...arr(b.replaces), ...arr(b.answers), ...arr(b.contradicts), ...arr(b.supports));
    if (typeof b.question === "string") ids.push(b.question);
    if (typeof b.from === "string") ids.push(b.from);
    if (typeof b.to === "string") ids.push(b.to);
  }
  const items = await g.items(ids);
  const mine = (id: string) => items.get(id)?.author === ctx.me;
  const text = (id: string) => q(items.get(id)?.text ?? id);

  const yours: string[] = [];
  const general: string[] = [];
  const replacedTargets = new Set<string>();
  const contradictions: [string, string, string][] = [];

  for (const c of others) {
    const who = ctx.name(c.author);
    const b = c.body;
    const rels: [string, string, string][] = [];
    if (c.kind === "claim" && typeof b.node === "string") {
      for (const t of arr(b.replaces)) rels.push(["REPLACES", b.node, t]);
      for (const t of arr(b.answers)) rels.push(["ANSWERS", b.node, t]);
      for (const t of arr(b.contradicts)) rels.push(["CONTRADICTS", b.node, t]);
    } else if (c.kind === "link" && typeof b.from === "string" && typeof b.to === "string" && typeof b.relation === "string") {
      rels.push([b.relation, b.from, b.to]);
    } else if (c.kind === "reply" && typeof b.question === "string" && mine(b.question)) {
      yours.push(`${who} replied to your question ${b.question} ${text(b.question)}: ${q(String(b.text ?? ""))}.`);
    } else if (c.kind === "withdraw" && typeof b.node === "string" && mine(b.node)) {
      yours.push(`${who} withdrew your ${items.get(b.node)?.label === "Question" ? "question" : "claim"} ${b.node} ${text(b.node)}.`);
    }
    for (const [rel, from, to] of rels) {
      if (!items.has(from) || !items.has(to)) continue;
      if (rel === "REPLACES") {
        replacedTargets.add(to);
        (mine(to) ? yours : general).push(
          mine(to) ? `${who} replaced your claim ${to} ${text(to)} with ${from} ${text(from)}.` : `${who} replaced ${to} ${text(to)} with ${from} ${text(from)}.`,
        );
      } else if (rel === "ANSWERS") {
        (mine(to) ? yours : general).push(
          mine(to) ? `${who} answered your question ${to} ${text(to)}: ${from} ${text(from)}.` : `${who} answered ${to} ${text(to)}: ${from} ${text(from)}.`,
        );
      } else if (rel === "CONTRADICTS") {
        contradictions.push([who, from, to]);
      }
    }
  }

  for (const [who, from, to] of contradictions) {
    const a = items.get(from)!;
    const b = items.get(to)!;
    if (!a.current || !b.current) continue;
    (mine(to) || mine(from) ? yours : general).push(
      mine(to)
        ? `New conflict: ${who}'s claim ${from} ${text(from)} contradicts your claim ${to} ${text(to)}.`
        : `New conflict: ${who}'s claim ${from} ${text(from)} contradicts ${b.by}'s claim ${to} ${text(to)}.`,
    );
  }

  // Two current claims replacing one: nobody has settled which holds.
  for (const t of replacedTargets) {
    const r = await g.currentReplacers(t);
    if (r.length >= 2)
      general.push(
        `Unsettled: ${r.length} current claims replace ${t} ${text(t)}: ${r.map((x) => `${x.id} by ${x.by} ${q(x.text, 60)}`).join("; ")}. Settle it with a claim that replaces them, or link them CONTRADICTS.`,
      );
  }

  // Possible overlaps: new claims close to an existing claim by someone else, with no link between them.
  const overlaps: string[] = [];
  const newClaims = others.filter((c) => c.kind === "claim" && typeof c.body.node === "string").slice(0, MAX_OVERLAP_CHECKS);
  for (const c of newClaims) {
    const node = c.body.node as string;
    const own = items.get(node);
    if (!own?.current) continue;
    const linked = await g.linkedIds(node);
    let found: Record<string, unknown>[] = [];
    try {
      found = (await g.call("search", { query: own.text, kind: "claim", limit: 6 }, ctx.reader)) as Record<string, unknown>[];
    } catch {
      continue;
    }
    const match = found.find((r) => r.id !== node && !linked.has(String(r.id)) && r.recorded_by !== own.by && overlap(own.text, String(r.text ?? "")) >= 0.4);
    if (match)
      overlaps.push(
        `Possible overlap: ${own.by}'s new claim ${node} ${q(own.text, 70)} and ${match.recorded_by}'s claim ${match.id} ${q(String(match.text), 70)}. If they're related, link them (SUPPORTS, CONTRADICTS or REPLACES).`,
      );
  }

  const lines = [...yours, ...general, ...overlaps];
  const authors = [...new Set(others.map((c) => ctx.name(c.author)))];
  const head = others.length >= 3 ? [`Caught up ${others.length} changes from ${authors.join(", ")}.`] : [];
  const shown = [...head, ...lines].slice(0, MAX_LINES);
  const more = head.length + lines.length - shown.length;
  return more > 0 ? [...shown, `…and ${more} more (context_activity lists them).`] : shown;
}

/** For someone who has just joined: what the context holds, and what is open or disputed. */
export async function briefing(g: Graph, reader: Caller): Promise<Record<string, unknown>> {
  const read = async (tool: string, args: Record<string, unknown> = {}) => {
    try {
      return (await g.call(tool, args, reader)) as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  const info = await g.info();
  const open = await read("open_questions");
  const conflicts = await read("conflicts");
  const recent = await read("recent", { since: "2000-01-01T00:00:00Z", limit: 5 });
  return {
    holds: info.nodes,
    open_questions: open.slice(0, 5).map((r) => ({ id: r.id, text: r.text, by: r.recorded_by })),
    open_question_count: open.length,
    conflicts: conflicts.slice(0, 5).map((r: any) => ({ claim: r.claim?.text ?? r.claim, contradicts: r.contradicts?.text ?? r.contradicts, flagged_by: r.flagged_by })),
    conflict_count: conflicts.length,
    latest: recent.map((r) => ({ id: r.id, text: r.text, by: r.recorded_by, at: r.recorded_at })),
  };
}
