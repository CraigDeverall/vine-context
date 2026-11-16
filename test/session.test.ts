// Two agents' MCP sessions: Alice shares her graph, Bob joins it with the
// code, Bob's tools switch to Alice's graph at once, and Alice's agent is told he joined.

import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { Session } from "../src/mcp/server.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const hosts: Host[] = [];
afterAll(() => hosts.forEach((h) => h.stop()));

async function agent(user: string, graph: string) {
  const dataDir = tempDir();
  const host = await Host.start({ dataDir, graph, user, signal, ice });
  hosts.push(host);
  const session = new Session({
    local: () => LocalHost.connect(host.socket),
    identity: () => loadIdentity(dataDir, user),
    dataDir,
    signal,
    ice,
    joinWaitMs: 3000,
  });
  await session.start();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await session.server.connect(a);
  const client = new Client({ name: user, version: "0" });
  let listChanges = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanges++;
  });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).find((c) => !c.text.startsWith("News: "))!.text;
    if (r.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  /** Every text item of a tool result, join notices included. */
  const raw = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as any).content.map((c: { text: string }) => c.text).join("\n") as string;
  return { client, call, raw, changes: () => listChanges };
}

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("MCP sessions across the star", () => {
  it("shares, joins, tells the host's agent, switches tools, and leaves", async () => {
    const alice = await agent("alice", "team");
    const bob = await agent("bob", "bobs-notes");

    // Bob starts on his own graph.
    await bob.call("add_claim", { text: "Bob's private note" });
    expect((await bob.call("graph_info")).using).toMatch(/your graph 'bobs-notes'/);

    const shared = await alice.call("share_graph", { label: "for Bob" });
    expect(shared.send).toBe(`Join my context graph: /p2p-context-graph:join ${shared.code}`);
    const joined = await bob.call("join_graph", { code: `Here you go: ${shared.code} thanks` });
    expect(joined).toMatchObject({ joined: "alice's graph 'team'", role: "contributor", told: expect.stringMatching(/Everyone/) });
    expect(joined.your_fingerprint).toMatch(/^[0-9a-f-]{14}$/);
    expect((await bob.call("graph_info")).using).toMatch(/alice's graph 'team'/);

    // Alice's agent hears about it on its next tool call, with what Bob's install said about itself.
    await waitFor(async () => /News: bob joined your graph/.test(await alice.raw("sharing_status")));

    // Bob's add_claim now writes to Alice's graph, and his own note isn't there.
    const c = await bob.call("add_claim", { text: "Bob's finding for the team" });
    const seen = await alice.call("search", { query: "finding for the team" });
    expect(seen[0]).toMatchObject({ id: c.id, recorded_by: "bob" });
    expect((await bob.call("beliefs")).map((b: any) => b.text)).toEqual(["Bob's finding for the team"]);
    expect(await bob.call("model_guide")).toMatch(/Claims and Questions/);

    // Readers don't get write tools.
    await alice.call("set_peer_role", { name: "bob", role: "reader" });
    await waitFor(async () => !(await bob.client.listTools()).tools.some((t) => t.name === "add_claim"));
    await alice.call("set_peer_role", { name: "bob", role: "contributor" });
    await waitFor(async () => (await bob.client.listTools()).tools.some((t) => t.name === "add_claim"));

    // Leaving puts Bob back on his own graph.
    expect(await bob.call("leave_graph")).toMatch(/back on your graph 'bobs-notes'/);
    expect((await bob.call("beliefs")).map((b: any) => b.text)).toEqual(["Bob's private note"]);

    // Bob's machine kept the code: join_graph with no code rejoins, without approval.
    const back = await bob.call("join_graph", {});
    expect(back.joined).toBe("alice's graph 'team'");
  });

  it("tells the agent clearly when the host stops sharing", async () => {
    const alice = await agent("alice", "brief");
    const bob = await agent("bob", "own");
    const { code } = await alice.call("share_graph");
    await bob.call("join_graph", { code });
    await waitFor(async () => (await bob.call("graph_info")).using.includes("alice's graph"));
    await alice.call("stop_sharing");
    await waitFor(async () => {
      try {
        await bob.call("beliefs");
        return false;
      } catch (e) {
        return /stopped sharing[\s\S]*leave_graph/.test((e as Error).message);
      }
    });
  });

  it("rejects text that isn't a join code, and says what to do with an old link", async () => {
    const bob = await agent("bob", "solo");
    await expect(bob.call("join_graph", { code: "https://example.com/not-a-code" })).rejects.toThrow(/not a p2pcg join code/);
    await expect(bob.call("join_graph", { code: "p2pcg://join/abcdefghijklmnopqrstuv#abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq" })).rejects.toThrow(/old p2pcg:\/\/ join link/);
    const zed = await agent("zed", "zeds-own"); // has never joined anything
    await expect(zed.call("join_graph", {})).rejects.toThrow(/haven't joined a graph/);
  });
});
