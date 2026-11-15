// The second built-in pack: decisions, the options weighed, and the
// assumptions they rest on, with what needs review when things change.

import { describe, expect, it } from "vitest";
import { admin, alice, bob, openGraph, pause, reader } from "./helpers.js";

type Row = Record<string, any>;
const model = "decision-log";

describe("decision-log", () => {
  it("records a decision with its options and finds it by meaning and keywords", async () => {
    const g = await openGraph({ model });
    const d = (await g.call("record_decision", { text: "Use Postgres for the orders service", rationale: "The team knows it and we need transactions" }, alice)) as Row;
    expect(d.id).toMatch(/^d_[a-z2-9]{8}$/);
    await g.call("add_option", { decision: d.id, text: "Postgres", outcome: "chosen" }, alice);
    await g.call("add_option", { decision: d.id, text: "DynamoDB", outcome: "rejected", reason: "No multi-item transactions on our plan" }, alice);

    const [current] = (await g.call("decisions", {}, reader)) as Row[];
    expect(current).toMatchObject({ id: d.id, chose: ["Postgres"], rejected: [{ option: "DynamoDB", reason: "No multi-item transactions on our plan" }] });
    const found = (await g.call("search", { query: "which database for orders" }, reader)) as Row[];
    expect(found[0]).toMatchObject({ id: d.id, kind: "decision", current: true });
  });

  it("supersedes a decision, and still answers what stood before", async () => {
    const g = await openGraph({ model });
    const old = (await g.call("record_decision", { text: "Release every two weeks" }, alice)) as Row;
    await pause();
    const before = new Date().toISOString();
    await pause();
    const now = (await g.call("record_decision", { text: "Release every week", supersedes: [old.id] }, bob)) as Row;
    expect(((await g.call("decisions", {}, reader)) as Row[]).map((r) => r.id)).toEqual([now.id]);
    expect(((await g.call("decisions", { at: before }, reader)) as Row[]).map((r) => r.id)).toEqual([old.id]);
  });

  it("flags decisions resting on an assumption that turned out false", async () => {
    const g = await openGraph({ model });
    const d = (await g.call("record_decision", { text: "Run the API on a single node" }, alice)) as Row;
    const other = (await g.call("record_decision", { text: "Keep the free CDN tier" }, alice)) as Row;
    const a = (await g.call("add_assumption", { text: "Traffic stays under 1,000 requests a second", decisions: [d.id] }, alice)) as Row;
    expect(a.decisions).toBe(1);
    expect(await g.call("needs_review", {}, reader)).toEqual([]);

    const r = (await g.call("invalidate_assumption", { id: a.id, because: "Black Friday peaked at 4,000 a second" }, bob)) as Row;
    expect(r.decisions_to_review).toEqual([d.id]);
    const review = (await g.call("needs_review", {}, reader)) as Row[];
    expect(review).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ id: d.id }),
        because_of: expect.objectContaining({ id: a.id }),
        why: "assumption found false: Black Friday peaked at 4,000 a second",
      }),
    ]);
    expect(review.some((x) => x.decision.id === other.id)).toBe(false);

    // Superseding the decision settles it.
    await g.call("record_decision", { text: "Run the API on three nodes behind a load balancer", supersedes: [d.id] }, alice);
    expect(await g.call("needs_review", {}, reader)).toEqual([]);
  });

  it("flags decisions that depend on one that was superseded", async () => {
    const g = await openGraph({ model });
    const base = (await g.call("record_decision", { text: "Host on AWS" }, alice)) as Row;
    const dep = (await g.call("record_decision", { text: "Use SQS for the job queue", depends_on: [base.id] }, alice)) as Row;
    await g.call("record_decision", { text: "Host on GCP", supersedes: [base.id] }, bob);
    const review = (await g.call("needs_review", {}, reader)) as Row[];
    expect(review).toEqual([expect.objectContaining({ decision: expect.objectContaining({ id: dep.id }), why: "depends on a superseded decision" })]);
  });

  it("checks links and authorship", async () => {
    const g = await openGraph({ model });
    const d = (await g.call("record_decision", { text: "Adopt trunk-based development" }, alice)) as Row;
    const a = (await g.call("add_assumption", { text: "CI runs in under ten minutes" }, alice)) as Row;
    await expect(g.call("link", { from: d.id, relation: "SUPERSEDES", to: a.id }, alice)).rejects.toThrow(/links two decisions/);
    await g.call("link", { from: d.id, relation: "RESTS_ON", to: a.id }, alice);
    await expect(g.call("link", { from: d.id, relation: "RESTS_ON", to: a.id }, alice)).rejects.toThrow(/already exists/);
    await expect(g.call("withdraw", { id: d.id }, bob)).rejects.toThrow(/Only its author \(alice\) or an admin/);
    await g.call("withdraw", { id: d.id, reason: "recorded twice" }, admin);
    expect(await g.call("decisions", {}, reader)).toEqual([]);
    const h = (await g.call("history", { id: d.id }, reader)) as Row;
    expect(h.item).toMatchObject({ withdrawn_by: "root", withdraw_reason: "recorded twice" });
    expect(h.links).toEqual([expect.objectContaining({ direction: "out", type: "RESTS_ON", id: a.id })]);
  });
});
