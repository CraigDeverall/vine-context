import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/core/changes.js";
import { Graph, ToolError } from "../src/core/graph.js";
import { act, admin, alice, bob, ctx, openGraph, pause, reader, tempDir } from "./helpers.js";

type Row = Record<string, any>;
const ids = (rows: unknown) => (rows as Row[]).map((r) => r.id);

describe("temporal-claims", () => {
  it("records a claim and finds it with hybrid search", async () => {
    const g = await openGraph();
    const c = (await act(g, "add_claim", { text: "The ONT restarts every night at 03:00", source: "router log" }, alice)) as Row;
    expect(c.id).toMatch(/^c_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await act(g, "add_claim", { text: "Lunch is at noon on Fridays" }, alice);
    const found = (await act(g, "search", { query: "when does the ONT restart?" }, reader)) as Row[];
    expect(found[0]).toMatchObject({ id: c.id, kind: "claim", source: "router log", recorded_by: "alice" });
    expect(found[0]!.recorded_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(found[0]).not.toHaveProperty("embedding");
  });

  it("answers what was believed at an earlier moment", async () => {
    const g = await openGraph();
    const old = (await act(g, "add_claim", { text: "The outage lasts 4 minutes" }, alice)) as Row;
    await pause();
    const before = new Date().toISOString();
    await pause();
    const fix = (await act(g, "add_claim", { text: "The outage lasts 6 minutes", replaces: [old.id] }, bob)) as Row;

    expect(ids(await act(g, "beliefs", {}, reader))).toEqual([fix.id]);
    expect(ids(await act(g, "beliefs", { at: before }, reader))).toEqual([old.id]);
    // The replaced claim is still in its history.
    const h = (await act(g, "history", { id: old.id }, reader)) as Row;
    expect(h.links).toEqual([expect.objectContaining({ direction: "in", type: "REPLACES", id: fix.id, recorded_by: "bob" })]);
  });

  it("traces what a claim rests on, and marks evidence that no longer stands", async () => {
    const g = await openGraph();
    const decision = (await act(g, "add_claim", { text: "We book the Orangery" }, alice)) as Row;
    const fits = (await act(g, "add_claim", { text: "The Orangery fits the budget", supports: [decision.id] }, bob)) as Row;
    const quote = (await act(g, "add_claim", { text: "The Orangery quoted 1,800", supports: [fits.id] }, bob)) as Row;
    const other = (await act(g, "add_claim", { text: "Lunch is at noon" }, alice)) as Row;
    await pause();
    const before = new Date().toISOString();
    await pause();

    let rows = (await act(g, "basis", { id: decision.id }, reader)) as Row[];
    expect(rows.map((r) => [r.id, r.steps, r.current])).toEqual([[fits.id, 1, true], [quote.id, 2, true]]);
    expect(rows[1]!.supports).toEqual([fits.id]);
    expect(ids(rows)).not.toContain(other.id);
    expect(ids(await act(g, "basis", { id: decision.id, depth: 1 }, reader))).toEqual([fits.id]);

    // The quote is replaced, and something contradicts the middle claim.
    const dearer = (await act(g, "add_claim", { text: "The Orangery now quotes 2,600", replaces: [quote.id] }, bob)) as Row;
    const doubt = (await act(g, "add_claim", { text: "The Orangery does not fit the budget", contradicts: [fits.id] }, alice)) as Row;
    rows = (await act(g, "basis", { id: decision.id }, reader)) as Row[];
    expect(rows[0]).toMatchObject({ id: fits.id, current: true, contradicted_by: [doubt.id] });
    expect(rows[1]).toMatchObject({ id: quote.id, current: false, withdrawn: false, replaced_by: [dearer.id] });
    // As of the earlier moment, it all still stood.
    rows = (await act(g, "basis", { id: decision.id, at: before }, reader)) as Row[];
    expect(rows.map((r) => [r.current, r.replaced_by, r.contradicted_by])).toEqual([[true, [], []], [true, [], []]]);
    await expect(act(g, "basis", { id: "c_missing" }, reader)).rejects.toThrow(ToolError);
  });

  it("filters beliefs by the period they are about", async () => {
    const g = await openGraph();
    const nov = (await act(g, "add_claim", { text: "November outages", about_from: "2026-11-01", about_to: "2026-11-30" }, alice)) as Row;
    const oct = (await act(g, "add_claim", { text: "October outages", about_from: "2026-10-01", about_to: "2026-10-31" }, alice)) as Row;
    const always = (await act(g, "add_claim", { text: "The router is a TP-Link" }, alice)) as Row;
    const got = ids(await act(g, "beliefs", { about_from: "2026-11-10", about_to: "2026-11-12" }, reader));
    expect(got).toEqual(expect.arrayContaining([nov.id, always.id]));
    expect(got).not.toContain(oct.id);
  });

  it("closes a question when a current claim answers it, and reopens it if that claim is replaced", async () => {
    const g = await openGraph();
    const q = (await act(g, "ask_question", { text: "Why does the WAN drop?" }, alice)) as Row;
    expect(ids(await act(g, "open_questions", {}, reader))).toEqual([q.id]);
    const a = (await act(g, "add_claim", { text: "The ISP reboots the ONT", answers: [q.id] }, bob)) as Row;
    expect(await act(g, "open_questions", {}, reader)).toEqual([]);
    const s = (await act(g, "search", { query: "WAN drop", kind: "question" }, reader)) as Row[];
    expect(s[0]).toMatchObject({ id: q.id, answered: true });
    // A replacement that doesn't answer the question reopens it.
    await act(g, "add_claim", { text: "Not sure the ISP reboots it", replaces: [a.id] }, bob);
    expect(ids(await act(g, "open_questions", {}, reader))).toEqual([q.id]);
  });

  it("keeps a thread of replies on a question, until a claim answers it", async () => {
    const g = await openGraph();
    const q = (await act(g, "ask_question", { text: "Which day is the team lunch?" }, alice)) as Row;
    const r1 = (await act(g, "reply", { question: q.id, text: "Friday suits most people" }, bob)) as Row;
    expect(r1.id).toMatch(/^r_/);
    await pause();
    await act(g, "reply", { question: q.id, text: "Not this week: Friday is a holiday" }, alice);
    expect(await act(g, "open_questions", {}, reader)).toEqual([expect.objectContaining({ id: q.id, replies: 2 })]);
    let t = (await act(g, "thread", { question: q.id }, reader)) as Row;
    expect(t.replies.map((r: Row) => r.recorded_by)).toEqual(["bob", "alice"]);
    expect(t).toMatchObject({ answered: false, answers: [] });
    // A reply is a reply, not an answer: a claim closes the question.
    const c = (await act(g, "add_claim", { text: "The team lunch is on Thursday this week", answers: [q.id], source: `reply ${r1.id}` }, bob)) as Row;
    t = (await act(g, "thread", { question: q.id }, reader)) as Row;
    expect(t).toMatchObject({ answered: true, answers: [expect.objectContaining({ id: c.id })] });
    expect(await act(g, "open_questions", {}, reader)).toEqual([]);
    // Its author can withdraw a reply; a reply to an unknown question is refused.
    await act(g, "withdraw", { id: r1.id }, bob);
    expect(((await act(g, "thread", { question: q.id }, reader)) as Row).replies).toHaveLength(1);
    await expect(act(g, "reply", { question: "q_nope", text: "hi" }, bob)).rejects.toThrow(/No current question/);
  });

  it("lists conflicts between current claims only", async () => {
    const g = await openGraph();
    const a = (await act(g, "add_claim", { text: "The firmware causes the drop" }, alice)) as Row;
    const b = (await act(g, "add_claim", { text: "The ISP causes the drop", contradicts: [a.id] }, bob)) as Row;
    const conflicts = (await act(g, "conflicts", {}, reader)) as Row[];
    expect(conflicts).toEqual([expect.objectContaining({ claim: expect.objectContaining({ id: b.id }), contradicts: expect.objectContaining({ id: a.id }), flagged_by: "bob" })]);
    await act(g, "add_claim", { text: "Confirmed: the ISP causes it", replaces: [a.id, b.id] }, admin);
    expect(await act(g, "conflicts", {}, reader)).toEqual([]);
  });

  it("links existing items and refuses bad links", async () => {
    const g = await openGraph();
    const a = (await act(g, "add_claim", { text: "Claim A" }, alice)) as Row;
    const b = (await act(g, "add_claim", { text: "Claim B" }, alice)) as Row;
    const q = (await act(g, "ask_question", { text: "Question Q?" }, alice)) as Row;
    await act(g, "link", { from: a.id, relation: "SUPPORTS", to: b.id }, bob);
    await expect(act(g, "link", { from: a.id, relation: "SUPPORTS", to: b.id }, bob)).rejects.toThrow(/already exists/);
    await expect(act(g, "link", { from: a.id, relation: "ANSWERS", to: b.id }, bob)).rejects.toThrow(/to a question/);
    await expect(act(g, "link", { from: a.id, relation: "SUPPORTS", to: q.id }, bob)).rejects.toThrow(/links two claims/);
    await expect(act(g, "link", { from: a.id, relation: "SUPPORTS", to: a.id }, bob)).rejects.toThrow(/itself/);
    await expect(act(g, "link", { from: "c_missing", relation: "SUPPORTS", to: b.id }, bob)).rejects.toThrow(/No current claim c_missing/);
  });

  it("rejects unknown ids without writing anything", async () => {
    const g = await openGraph();
    await expect(act(g, "add_claim", { text: "Orphan", supports: ["c_nope1234"] }, alice)).rejects.toThrow(/unknown or withdrawn: c_nope1234/);
    expect(await act(g, "beliefs", {}, reader)).toEqual([]);
  });

  it("lets only the author or an admin withdraw", async () => {
    const g = await openGraph();
    const c = (await act(g, "add_claim", { text: "Mistaken claim" }, alice)) as Row;
    await expect(act(g, "withdraw", { id: c.id }, bob)).rejects.toThrow(/Only its author \(alice\)/);
    await act(g, "withdraw", { id: c.id, reason: "typo" }, alice);
    await expect(act(g, "withdraw", { id: c.id }, alice)).rejects.toThrow(/already withdrawn/);
    expect(await act(g, "beliefs", {}, reader)).toEqual([]);
    const c2 = (await act(g, "add_claim", { text: "Another" }, alice)) as Row;
    await act(g, "withdraw", { id: c2.id }, admin);
    const recent = (await act(g, "recent", { since: "2000-01-01T00:00:00Z" }, reader)) as Row[];
    expect(recent.map((r) => r.withdrawn_by)).toEqual(["root", "alice"]);
  });

  it("enforces roles and input schemas", async () => {
    const g = await openGraph();
    await expect(act(g, "add_claim", { text: "x" }, reader)).rejects.toThrow(/needs the contributor role/);
    await expect(act(g, "add_claim", { text: "x", extra: 1 }, alice)).rejects.toThrow(/Unrecognized key/);
    await expect(act(g, "add_claim", { text: "x", about_from: "15 Nov" }, alice)).rejects.toThrow(/about_from/);
    await expect(act(g, "add_claim", { text: "x", about_from: "2026-11-02", about_to: "2026-11-01" }, alice)).rejects.toThrow(/after about_to/);
    await expect(act(g, "search", { query: "x", limit: 500 }, reader)).rejects.toThrow(/limit/);
    await expect(act(g, "no_such_tool", {}, alice)).rejects.toThrow(/No tool/);
    // Server parameters can't be smuggled in as inputs.
    await expect(act(g, "add_claim", { text: "x", by: "mallory" }, alice)).rejects.toThrow(ToolError);
  });
});

describe("graph runtime", () => {
  it("keeps a graph's data across reopening", async () => {
    const dataDir = tempDir();
    const g1 = await Graph.open({ dataDir, name: "keep" });
    const c = (await act(g1, "add_claim", { text: "Persisted claim" }, alice)) as Row;
    const g2 = await Graph.open({ dataDir, name: "keep" });
    expect(ids(await act(g2, "beliefs", {}, reader))).toContain(c.id);
  });

  it("runs concurrent calls one at a time", async () => {
    const g = await openGraph();
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => act(g, "add_claim", { text: `Claim number ${i}` }, alice)));
    expect(new Set(made.map((m) => (m as Row).id)).size).toBe(10);
    expect((await act(g, "beliefs", {}, reader)) as Row[]).toHaveLength(10);
  });

  it("refuses a write through call: writes are changes", async () => {
    const g = await openGraph();
    await expect(g.call("add_claim", { text: "x" }, alice)).rejects.toThrow(/change log/);
  });
});

describe("applying changes", () => {
  const change = (kind: string, author: string, at: string, body: Record<string, unknown>) => ({ id: uuidv7(), kind: kind as never, author, at, body });

  it("gives the same graph whatever order changes arrive in: a link waits for its ends", async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 9, 0, s)).toISOString();
    const claimA = change("claim", alice.key!, t(1), { node: "c_a", text: "Claim A", supports: [], contradicts: [], replaces: [], answers: [] });
    const claimB = change("claim", bob.key!, t(2), { node: "c_b", text: "Claim B", supports: ["c_a"], contradicts: [], replaces: [], answers: [] });
    const link = change("link", alice.key!, t(3), { from: "c_a", relation: "CONTRADICTS", to: "c_b" });
    const orders = [
      [claimA, claimB, link],
      [link, claimB, claimA],
      [claimB, link, claimA],
    ];
    const states: string[] = [];
    for (const order of orders) {
      const g = await openGraph();
      const results = [];
      for (const c of order) results.push((await g.apply(c, ctx)).status);
      if (order[0] === link) expect(results[0]).toBe("pending");
      const snap = await g.snapshot();
      states.push(JSON.stringify({ nodes: snap.nodes.map((n) => n.id).sort(), edges: snap.edges.map((e) => `${e.source}-${e.type}-${e.target}`).sort() }));
    }
    expect(new Set(states).size).toBe(1);
    expect(states[0]).toContain("Claim:c_b-SUPPORTS-Claim:c_a");
    expect(states[0]).toContain("Claim:c_a-CONTRADICTS-Claim:c_b");
  });

  it("keeps the earlier of two withdrawals, and refuses one by someone else", async () => {
    const g = await openGraph();
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 9, 0, s)).toISOString();
    await g.apply(change("claim", alice.key!, t(1), { node: "c_w", text: "To withdraw" }), ctx);
    expect((await g.apply(change("withdraw", bob.key!, t(2), { node: "c_w" }), ctx)).status).toBe("refused");
    await g.apply(change("withdraw", alice.key!, t(5), { node: "c_w", reason: "late" }), ctx);
    await g.apply(change("withdraw", admin.key!, t(3), { node: "c_w", reason: "early" }), ctx);
    const h = (await act(g, "history", { id: "c_w" }, reader)) as Row;
    expect(h.item).toMatchObject({ withdrawn_by: "root", withdraw_reason: "early" });
  });

  it("applies a change twice as once", async () => {
    const g = await openGraph();
    const c = change("claim", alice.key!, new Date().toISOString(), { node: "c_twice", text: "Once only" });
    expect((await g.apply(c, ctx)).status).toBe("applied");
    expect((await g.apply(c, ctx)).status).toBe("applied");
    expect(ids(await act(g, "beliefs", {}, reader))).toEqual(["c_twice"]);
  });
});
