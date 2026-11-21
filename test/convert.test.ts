// Graphs from before change logs: the first time the new host starts one, it
// keeps everything (same ids, authors, times, withdrawals and links) by
// writing it into the log as one import change, and the people the old host
// had let in become members.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Graph } from "../src/core/graph.js";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { tempDir } from "./helpers.js";

describe("converting a graph from before change logs", () => {
  it("imports its items and members once, keeping ids, and builds the same graph again from the log", async () => {
    const dataDir = tempDir();
    const g = await Graph.open({ dataDir, name: "old" });
    const rows = (g as any).rows.bind(g);
    await rows(`CREATE (:Claim {id: 'c_abcd2345', text: 'An old claim', recorded_at: datetime('2026-11-01T10:00:00Z'), recorded_by: 'craig'})`);
    await rows(`CREATE (:Claim {id: 'c_efgh6789', text: 'An old withdrawn claim', recorded_at: datetime('2026-11-02T10:00:00Z'), recorded_by: 'sam', withdrawn_at: datetime('2026-11-03T10:00:00Z'), withdrawn_by: 'sam'})`);
    await rows(`CREATE (:Question {id: 'q_jkmn2345', text: 'An old question?', recorded_at: datetime('2026-11-01T11:00:00Z'), recorded_by: 'sam'})`);
    await rows(
      `MATCH (a:Claim {id: 'c_abcd2345'}), (q:Question {id: 'q_jkmn2345'}) CREATE (a)-[:ANSWERS {recorded_at: datetime('2026-11-01T12:00:00Z'), recorded_by: 'craig'}]->(q)`,
    );
    // The old host had let sam in.
    const sam = loadIdentity(tempDir(), "sam");
    mkdirSync(join(dataDir, "hosts", "old"), { recursive: true });
    writeFileSync(join(dataDir, "hosts", "old", "peers.json"), JSON.stringify([{ name: "sam", key: sam.publicKey, role: "contributor", approved_at: "2026-11-01T09:00:00Z" }]));

    const start = async () => {
      const h = await Host.start({ dataDir, graph: "old", user: "craig" });
      const c = await LocalHost.connect(h.socket);
      return { h, c };
    };
    let { h, c } = await start();
    const check = async () => {
      const snap = await c.request<any>("snapshot", { limit: 100 });
      expect(snap.nodes.map((n: any) => n.id).sort()).toEqual(["Claim:c_abcd2345", "Claim:c_efgh6789", "Question:q_jkmn2345"]);
      expect(snap.nodes.find((n: any) => n.key === "c_efgh6789").ended).toBe(true);
      expect(snap.edges).toEqual([expect.objectContaining({ type: "ANSWERS", source: "Claim:c_abcd2345", target: "Question:q_jkmn2345" })]);
      const hist = await c.request<any>("call", { tool: "history", args: { id: "c_abcd2345" } });
      expect(hist.item).toMatchObject({ recorded_by: "craig", recorded_at: "2026-11-01T10:00:00Z" });
    };
    await check();
    const info = await c.request<any>("info");
    expect(info.people.map((p: any) => [p.name, p.role])).toEqual([
      ["craig", "admin"],
      ["sam", "contributor"],
    ]);
    expect(info.log.changes).toBe(3); // create, import, add_member

    // A restart doesn't import again; a store that doesn't match the log is built again from it.
    c.close();
    h.stop();
    ({ h, c } = await start());
    await check();
    expect((await c.request<any>("info")).log.changes).toBe(3);
    await (h.graph as any).rows(`MATCH (n:Claim {id: 'c_abcd2345'}) DETACH DELETE n`);
    await (h.graph as any).rows(`MATCH (m:_P2pcgMeta) SET m.applied = 'stale'`);
    c.close();
    h.stop();
    ({ h, c } = await start());
    await check();
    c.close();
    h.stop();
  });
});
