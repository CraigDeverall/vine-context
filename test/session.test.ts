// Two agents' MCP sessions: Alice shares her graph, Bob joins it with the
// code and gets his own copy, writes flow both ways, and Alice's agent is told
// he joined.

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

process.env.P2PCG_AUTO_SHARE = "on";
const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const hosts: Host[] = [];
afterAll(() => hosts.forEach((h) => h.stop()));

async function agent(user: string, graph: string) {
  const dataDir = tempDir();
  const started = new Map<string, Host>();
  const open = async (name: string) => {
    let h = started.get(name);
    if (!h) {
      h = await Host.start({ dataDir, graph: name, user, signal, ice, holdMs: 200 });
      hosts.push(h);
      started.set(name, h);
    }
    return LocalHost.connect(h.socket);
  };
  const session = new Session({
    local: () => open(graph),
    openLocal: open,
    identity: () => loadIdentity(dataDir, user),
    dataDir,
    signal,
    ice,
    joinWaitMs: 10_000,
  });
  await session.start();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await session.server.connect(a);
  const client = new Client({ name: `${user}-agent`, version: "1.2.3" });
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
  /** Every text item of a tool result, notices included. */
  const raw = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as any).content.map((c: { text: string }) => c.text).join("\n") as string;
  return { client, call, raw, changes: () => listChanges };
}

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("MCP sessions on replicated graphs", () => {
  it("shares, joins into a local copy, tells everyone, and syncs both ways", async () => {
    const alice = await agent("alice", "team");
    const bob = await agent("bob", "bobs-notes");

    await bob.call("add_claim", { text: "Bob's private note" });
    expect((await bob.call("context_info")).using).toBe("your context 'bobs-notes'");
    await alice.call("add_claim", { text: "Alice's finding" });

    const shared = await alice.call("share_context", { label: "for Bob" });
    expect(shared.send).toBe(`Join my context graph: /p2p-context-graph:join ${shared.code}`);
    const before = bob.changes();
    const joined = await bob.call("join_context", { code: `Here you go: ${shared.code} thanks` });
    expect(joined).toMatchObject({ joined: "alice's context 'team'", here_as: "team", role: "contributor", told: expect.stringMatching(/Everyone/) });
    expect(joined.your_fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(bob.changes()).toBeGreaterThan(before);
    expect((await bob.call("context_info")).using).toBe("'team' (alice's context; you are a contributor)");
    // Bob's copy already has Alice's claim, and both of bob's contexts are attached: reads search both, saying which.
    expect((await bob.call("search", { query: "finding", context: "team" })).map((r: any) => r.text)).toEqual(["Alice's finding"]);
    const both = await bob.call("search", { query: "Alice's finding Bob's note" });
    expect(new Set(both.map((r: any) => r.context))).toEqual(new Set(["team", "bobs-notes"]));

    // Alice's agent hears about Bob on its next tool result, with his agent.
    const news = await alice.raw("context_info");
    expect(news).toMatch(/^News: bob joined your context 'team' as contributor with the invite 'for Bob'/);
    expect(news).toContain(joined.your_fingerprint);
    expect(news).toContain("bob-agent 1.2.3");
    expect(await alice.raw("context_info")).not.toMatch(/News:/); // once only

    // Writes flow both ways.
    await bob.call("add_claim", { text: "Bob adds to the team graph" });
    const find = async (who: typeof alice, text: string) => ((await who.call("beliefs")) as any[]).find((r) => r.text === text);
    await waitFor(async () => Boolean(await find(alice, "Bob adds to the team graph")));
    expect(await find(alice, "Bob adds to the team graph")).toMatchObject({ recorded_by: "bob" });
    await alice.call("add_claim", { text: "Alice replies in the team graph" });
    await waitFor(async () => Boolean(await find(bob, "Alice replies in the team graph")));

    // Bob's own graph is still his.
    await bob.call("use_context", { name: "bobs-notes" });
    expect((await bob.call("search", { query: "note" })).map((r: any) => r.text)).toEqual(["Bob's private note"]);
  });

  it("rejects text that isn't a join code, and says what to do with an old link", async () => {
    const bob = await agent("bob", "own");
    await expect(bob.call("join_context", { code: "hello there" })).rejects.toThrow(/not a p2pcg join code/);
    await expect(bob.call("join_context", { code: "p2pcg://join/abc#k=def" })).rejects.toThrow(/old p2pcg:\/\/ join link/);
    await expect(bob.call("join_context", { code: "p2pcg1_abc.def" })).rejects.toThrow(/damaged or cut short/);
  });
});
