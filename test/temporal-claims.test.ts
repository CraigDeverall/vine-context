import { describe, expect, it } from "vitest";
import { Graph, ToolError } from "../src/core/graph.js";
import { admin, alice, bob, openGraph, pause, reader, tempDir, writePack } from "./helpers.js";

type Row = Record<string, any>;
const ids = (rows: unknown) => (rows as Row[]).map((r) => r.id);

describe("temporal-claims", () => {
  it("records a claim and finds it with hybrid search", async () => {
    const g = await openGraph();
    const c = (await g.call("add_claim", { text: "The ONT restarts every night at 03:00", source: "router log" }, alice)) as Row;
    expect(c.id).toMatch(/^c_[a-z2-9]{8}$/);
    await g.call("add_claim", { text: "Lunch is at noon on Fridays" }, alice);
    const found = (await g.call("search", { query: "when does the ONT restart?" }, reader)) as Row[];
    expect(found[0]).toMatchObject({ id: c.id, kind: "claim", source: "router log", recorded_by: "alice" });
    expect(found[0]!.recorded_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(found[0]).not.toHaveProperty("embedding");
  });

  it("answers what was believed at an earlier moment", async () => {
    const g = await openGraph();
    const old = (await g.call("add_claim", { text: "The outage lasts 4 minutes" }, alice)) as Row;
    await pause();
    const before = new Date().toISOString();
    await pause();
    const fix = (await g.call("add_claim", { text: "The outage lasts 6 minutes", replaces: [old.id] }, bob)) as Row;

    expect(ids(await g.call("beliefs", {}, reader))).toEqual([fix.id]);
    expect(ids(await g.call("beliefs", { at: before }, reader))).toEqual([old.id]);
    // The replaced claim is still in its history.
    const h = (await g.call("history", { id: old.id }, reader)) as Row;
    expect(h.links).toEqual([expect.objectContaining({ direction: "in", type: "REPLACES", id: fix.id, recorded_by: "bob" })]);
  });

  it("filters beliefs by the period they are about", async () => {
    const g = await openGraph();
    const nov = (await g.call("add_claim", { text: "November outages", about_from: "2026-11-01", about_to: "2026-11-30" }, alice)) as Row;
    const oct = (await g.call("add_claim", { text: "October outages", about_from: "2026-10-01", about_to: "2026-10-31" }, alice)) as Row;
    const always = (await g.call("add_claim", { text: "The router is a TP-Link" }, alice)) as Row;
    const got = ids(await g.call("beliefs", { about_from: "2026-11-10", about_to: "2026-11-12" }, reader));
    expect(got).toEqual(expect.arrayContaining([nov.id, always.id]));
    expect(got).not.toContain(oct.id);
  });

  it("closes a question when a current claim answers it, and reopens it if that claim is replaced", async () => {
    const g = await openGraph();
    const q = (await g.call("ask_question", { text: "Why does the WAN drop?" }, alice)) as Row;
    expect(ids(await g.call("open_questions", {}, reader))).toEqual([q.id]);
    const a = (await g.call("add_claim", { text: "The ISP reboots the ONT", answers: [q.id] }, bob)) as Row;
    expect(await g.call("open_questions", {}, reader)).toEqual([]);
    const s = (await g.call("search", { query: "WAN drop", kind: "question" }, reader)) as Row[];
    expect(s[0]).toMatchObject({ id: q.id, answered: true });
    // A replacement that doesn't answer the question reopens it.
    await g.call("add_claim", { text: "Not sure the ISP reboots it", replaces: [a.id] }, bob);
    expect(ids(await g.call("open_questions", {}, reader))).toEqual([q.id]);
  });

  it("lists conflicts between current claims only", async () => {
    const g = await openGraph();
    const a = (await g.call("add_claim", { text: "The firmware causes the drop" }, alice)) as Row;
    const b = (await g.call("add_claim", { text: "The ISP causes the drop", contradicts: [a.id] }, bob)) as Row;
    const conflicts = (await g.call("conflicts", {}, reader)) as Row[];
    expect(conflicts).toEqual([expect.objectContaining({ claim: expect.objectContaining({ id: b.id }), contradicts: expect.objectContaining({ id: a.id }), flagged_by: "bob" })]);
    await g.call("add_claim", { text: "Confirmed: the ISP causes it", replaces: [a.id, b.id] }, admin);
    expect(await g.call("conflicts", {}, reader)).toEqual([]);
  });

  it("links existing items and refuses bad links", async () => {
    const g = await openGraph();
    const a = (await g.call("add_claim", { text: "Claim A" }, alice)) as Row;
    const b = (await g.call("add_claim", { text: "Claim B" }, alice)) as Row;
    const q = (await g.call("ask_question", { text: "Question Q?" }, alice)) as Row;
    await g.call("link", { from: a.id, relation: "SUPPORTS", to: b.id }, bob);
    await expect(g.call("link", { from: a.id, relation: "SUPPORTS", to: b.id }, bob)).rejects.toThrow(/already exists/);
    await expect(g.call("link", { from: a.id, relation: "ANSWERS", to: b.id }, bob)).rejects.toThrow(/to a question/);
    await expect(g.call("link", { from: a.id, relation: "SUPPORTS", to: q.id }, bob)).rejects.toThrow(/links two claims/);
    await expect(g.call("link", { from: a.id, relation: "SUPPORTS", to: a.id }, bob)).rejects.toThrow(/itself/);
    await expect(g.call("link", { from: "c_missing", relation: "SUPPORTS", to: b.id }, bob)).rejects.toThrow(/No current claim c_missing/);
  });

  it("rejects unknown ids without writing anything", async () => {
    const g = await openGraph();
    await expect(g.call("add_claim", { text: "Orphan", supports: ["c_nope1234"] }, alice)).rejects.toThrow(/unknown or withdrawn: c_nope1234/);
    expect(await g.call("beliefs", {}, reader)).toEqual([]);
  });

  it("lets only the author or an admin withdraw", async () => {
    const g = await openGraph();
    const c = (await g.call("add_claim", { text: "Mistaken claim" }, alice)) as Row;
    await expect(g.call("withdraw", { id: c.id }, bob)).rejects.toThrow(/Only its author \(alice\)/);
    await g.call("withdraw", { id: c.id, reason: "typo" }, alice);
    await expect(g.call("withdraw", { id: c.id }, alice)).rejects.toThrow(/already withdrawn/);
    expect(await g.call("beliefs", {}, reader)).toEqual([]);
    const c2 = (await g.call("add_claim", { text: "Another" }, alice)) as Row;
    await g.call("withdraw", { id: c2.id }, admin);
    const recent = (await g.call("recent", { since: "2000-01-01T00:00:00Z" }, reader)) as Row[];
    expect(recent.map((r) => r.withdrawn_by)).toEqual(["root", "alice"]);
  });

  it("enforces roles and input schemas", async () => {
    const g = await openGraph();
    await expect(g.call("add_claim", { text: "x" }, reader)).rejects.toThrow(/needs the contributor role/);
    await expect(g.call("add_claim", { text: "x", extra: 1 }, alice)).rejects.toThrow(/Unrecognized key/);
    await expect(g.call("add_claim", { text: "x", about_from: "15 Nov" }, alice)).rejects.toThrow(/about_from/);
    await expect(g.call("add_claim", { text: "x", about_from: "2026-11-02", about_to: "2026-11-01" }, alice)).rejects.toThrow(/after about_to/);
    await expect(g.call("search", { query: "x", limit: 500 }, reader)).rejects.toThrow(/limit/);
    await expect(g.call("no_such_tool", {}, alice)).rejects.toThrow(/No tool/);
    // Server parameters can't be smuggled in as inputs.
    await expect(g.call("add_claim", { text: "x", by: "mallory" }, alice)).rejects.toThrow(ToolError);
  });
});

describe("graph runtime", () => {
  it("keeps a graph's data and model across reopening, and refuses another model", async () => {
    const dataDir = tempDir();
    const g1 = await Graph.open({ dataDir, name: "keep" });
    const c = (await g1.call("add_claim", { text: "Persisted claim" }, alice)) as Row;
    const g2 = await Graph.open({ dataDir, name: "keep" });
    expect(ids(await g2.call("beliefs", {}, reader))).toContain(c.id);

    const other = writePack({
      "model.yaml": "name: other\nversion: 1\ntitle: O\ndescription: Other.\nnodes:\n  N: { description: n }\n",
      "tools.yaml": "tools:\n  - name: count\n    kind: read\n    description: Count the nodes.\n    steps:\n      - cypher: MATCH (n:N) RETURN count(n) AS n\n",
    });
    await expect(Graph.open({ dataDir, name: "keep", model: other })).rejects.toThrow(/uses the model 'temporal-claims'/);
  });

  it("rolls back every step when a later step reports an error", async () => {
    const pack = writePack({
      "model.yaml": "name: tx\nversion: 1\ntitle: T\ndescription: Transactions.\nnodes:\n  N: { description: n }\n",
      "tools.yaml": [
        "tools:",
        "  - name: make_then_fail",
        "    kind: write",
        "    description: Creates a node, then fails.",
        "    steps:",
        "      - cypher: \"CREATE (:N {v: 1})\"",
        "      - cypher: RETURN 'nope' AS _error",
        "  - name: count",
        "    kind: read",
        "    description: Count the nodes.",
        "    steps:",
        "      - cypher: MATCH (n:N) RETURN count(n) AS n",
        "        single: true",
      ].join("\n"),
    });
    const g = await openGraph({ model: pack });
    await expect(g.call("make_then_fail", {}, alice)).rejects.toThrow("nope");
    expect(await g.call("count", {}, reader)).toEqual({ n: 0 });
  });

  it("applies migrations once", async () => {
    const pack = writePack({
      "model.yaml": "name: mig\nversion: 1\ntitle: M\ndescription: Migrations.\nnodes:\n  N: { description: n }\n",
      "tools.yaml": "tools:\n  - name: count\n    kind: read\n    description: Count the nodes.\n    steps:\n      - cypher: MATCH (n:N) RETURN count(n) AS n\n        single: true\n",
      "migrations/001-seed.cypher": "CREATE (:N {v: 1});\nCREATE (:N {v: 2});\n",
    });
    const dataDir = tempDir();
    const g1 = await Graph.open({ dataDir, name: "m", model: pack });
    expect(await g1.call("count", {}, reader)).toEqual({ n: 2 });
    const g2 = await Graph.open({ dataDir, name: "m", model: pack });
    expect(await g2.call("count", {}, reader)).toEqual({ n: 2 });
  });

  it("runs concurrent calls one at a time", async () => {
    const g = await openGraph();
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => g.call("add_claim", { text: `Claim number ${i}` }, alice)));
    expect(new Set(made.map((m) => (m as Row).id)).size).toBe(10);
    expect((await g.call("beliefs", {}, reader)) as Row[]).toHaveLength(10);
  });
});
