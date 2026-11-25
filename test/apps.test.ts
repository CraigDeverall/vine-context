// MCP App views, the tools that open them,
// and the localhost page for agents that can't show views.

import { EventEmitter } from "node:events";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { defaultName, loadIdentity, nameSource } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { APP_MIME, VIEWS } from "../src/mcp/apps.js";
import { Session } from "../src/mcp/server.js";
import { formatCode, newLink } from "../src/p2p/link.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { startUi, type UiServer } from "../src/ui/server.js";
import { pause, tempDir } from "./helpers.js";

const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const hosts: Host[] = [];
const uis: UiServer[] = [];
afterAll(async () => {
  for (const u of uis) await u.close();
  hosts.forEach((h) => h.stop());
});

/** An agent's session on its own machine (data folder), with graph switching. */
async function agent(user: string, graph = "main", opts: { storedName?: boolean } = {}) {
  const dataDir = tempDir();
  const started = new Map<string, Host>();
  const open = async (name: string) => {
    let h = started.get(name);
    if (!h) {
      h = await Host.start({ dataDir, graph: name, user, signal, ice, holdMs: 1500 });
      hosts.push(h);
      started.set(name, h);
    }
    return LocalHost.connect(h.socket);
  };
  const make = () =>
    new Session({
      local: () => open(graph),
      openLocal: open,
      dataDir,
      identity: () => (opts.storedName ? loadIdentity(dataDir) : loadIdentity(dataDir, user)),
      signal,
      ice,
      joinWaitMs: 3000,
    });
  const session = make();
  await session.start();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await session.server.connect(a);
  const client = new Client({ name: user, version: "0" });
  let listChanges = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanges++;
  });
  await client.connect(b);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    const first = (r.content as { text: string }[]).find((c) => !c.text.startsWith("News: "))!.text;
    if (r.isError) throw new Error(first);
    if (r.structuredContent) return r.structuredContent;
    try {
      return JSON.parse(first);
    } catch {
      return first;
    }
  };
  return { client, raw, call, dataDir, make, changes: () => listChanges };
}

const uiOf = (tool: { _meta?: Record<string, unknown> }) => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;

describe("MCP App views", () => {
  it("serves each view as an app resource, and tools point at their views", async () => {
    const alice = await agent("alice");
    const { resources } = await alice.client.listResources();
    for (const view of Object.keys(VIEWS)) expect(resources).toContainEqual(expect.objectContaining({ uri: `ui://vine/${view}`, mimeType: APP_MIME }));
    const read = await alice.client.readResource({ uri: "ui://vine/explorer" });
    const html = (read.contents[0] as { text: string }).text;
    expect(read.contents[0]!.mimeType).toBe(APP_MIME);
    expect(html).toContain('window.__VINE_VIEW__="explorer"');
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/i); // self-contained: nothing loaded from elsewhere

    const { tools } = await alice.client.listTools();
    const by = (n: string) => tools.find((t) => t.name === n)!;
    expect(uiOf(by("open_console"))).toBe("ui://vine/console");
    expect(uiOf(by("open_contexts"))).toBe("ui://vine/contexts");
    // The contexts panel is also offered beside the conversation, where a host has that.
    expect((by("open_contexts")._meta as any)["openai/ui"]).toEqual({ entrypoints: [{ type: "thread" }] });
    expect((by("open_console")._meta as any)["openai/ui"]).toBeUndefined();
    expect(uiOf(by("explore_context"))).toBe("ui://vine/explorer");
    expect(uiOf(by("add_claim"))).toBe("ui://vine/receipt");
    expect(uiOf(by("conflicts"))).toBe("ui://vine/conflicts");
    expect(uiOf(by("search"))).toBeUndefined();
  });

  it("gives a write's receipt what was written and how to undo it", async () => {
    const alice = await agent("alice");
    const r = await alice.raw("add_claim", { text: "The cache hit rate fell to 40% after the deploy" });
    expect(JSON.parse(r.content[0].text).id).toMatch(/^c_/); // the agent still gets the plain result
    expect(r.structuredContent).toMatchObject({
      view: "receipt",
      tool: "add_claim",
      input: { text: "The cache hit rate fell to 40% after the deploy" },
      undo: { take_back: true, withdraw: true },
      where: "your context 'main'",
    });
    // While it is held on this machine, take_back removes it without trace.
    expect(r.structuredContent.result.shared_at).toBeDefined();
    await alice.call("take_back", { id: r.structuredContent.result.change });
    expect(await alice.call("beliefs")).toEqual([]);
  });

  it("shows the graph as it stood at a moment, and tells the agent only a summary", async () => {
    const alice = await agent("alice");
    const a = await alice.call("add_claim", { text: "Sign-ups doubled in October" });
    await pause();
    const before = new Date().toISOString();
    await pause();
    const b = await alice.call("add_claim", { text: "The October campaign drove the sign-ups", supports: [a.result.id] });
    await alice.call("withdraw", { id: a.result.id });

    const r = await alice.raw("explore_context");
    expect(r.content[0].text).not.toContain("Sign-ups doubled"); // the picture is for the person
    const now = r.structuredContent;
    expect(now.nodes.map((n: any) => [n.key, n.ended])).toEqual([
      [b.result.id, false],
      [a.result.id, true],
    ]);
    expect(now.edges).toEqual([expect.objectContaining({ type: "SUPPORTS", source: `Claim:${b.result.id}`, target: `Claim:${a.result.id}` })]);
    expect(now.schema.time).toEqual({ recorded: "recorded_at", ended: "withdrawn_at" });

    const then = (await alice.raw("explore_context", { at: before })).structuredContent;
    expect(then.nodes.map((n: any) => [n.key, n.ended])).toEqual([[a.result.id, false]]);
    expect(then.edges).toEqual([]);
  });

  it("opens the contexts panel with everything it shows, and tells the agent only a summary", async () => {
    const alice = await agent("alice");
    const c = await alice.call("add_claim", { text: "Shown in the contexts panel" });
    const r = await alice.raw("open_contexts");
    // The view gets the same state it then polls for.
    expect(r.structuredContent).toMatchObject({ context: "main", you: { name: "alice", role: "admin" }, your_contexts: ["main"], invites: [] });
    expect(r.structuredContent.snapshot.nodes.map((n: any) => n.title)).toContain("Shown in the contexts panel");
    expect(r.structuredContent.recent[0]).toMatchObject({ kind: "claim", mine: true, node: c.result?.id ?? c.id });
    const polled = await alice.call("context_activity", { limit: 40, snapshot: true });
    expect(Object.keys(polled).sort()).toEqual(Object.keys(r.structuredContent).sort());
    // The agent reads a line about what the person sees, not the context's items.
    const said = (r.content as { text: string }[]).map((x) => x.text).join("\n");
    expect(said).toContain("contexts panel");
    expect(said).not.toContain("Shown in the contexts panel");
  });

  it("opens the console with your sharing state", async () => {
    const alice = await agent("alice");
    expect(await alice.call("open_console")).toMatchObject({ sharing: false, can_invite: true, people: [expect.objectContaining({ name: "alice", you: true, creator: true })], links: [] });
    await alice.call("share_context");
    expect(await alice.call("open_console")).toMatchObject({ sharing: true, invites: [expect.objectContaining({ state: "open", code: expect.stringMatching(/^vine1_/) })] });
    await alice.call("stop_sharing");
  });

  it("joins with a code into its own copy, and explores it", async () => {
    const alice = await agent("alice", "team");
    const bob = await agent("bob", "own");
    await alice.call("add_claim", { text: "Alice's finding about the build" });
    const { code } = await alice.call("share_context", { role: "reader" });
    const joined = await bob.call("join_context", { code });
    expect(joined).toMatchObject({ joined: "alice's context 'team'", here_as: "team", role: "reader", as: "bob" });
    const state = await bob.call("open_console");
    expect(state).toMatchObject({ host: "alice", can_invite: false, you: { name: "bob", role: "reader" } });
    const snap = (await bob.raw("explore_context")).structuredContent;
    expect(snap).toMatchObject({ graph: "team", where: expect.stringContaining("alice's context") });
    expect(snap.nodes.map((n: any) => n.title)).toEqual(["Alice's finding about the build"]);
    // Joining makes it this chat's context; as a reader there, bob gets no write tools.
    expect(await bob.call("context_info")).toMatchObject({ context: "team", role: "reader" });
    expect((await bob.raw("add_claim", { text: "A reader tries to write" })).isError).toBe(true);
    // Back to bob's own graph, then to the joined one again without the code.
    await bob.call("use_context", { name: "own" });
    expect((await bob.call("context_info")).your_contexts).toEqual(["own", "team"]);
    expect(await bob.call("use_context", { name: "team" })).toMatchObject({ using: expect.stringContaining("alice's context") });
    await alice.call("stop_sharing");
  });
});

describe("the localhost page", () => {
  async function ui() {
    const alice = await agent("alice");
    const server = await startUi({ session: alice.make });
    uis.push(server);
    const token = new URL(server.url).hash.replace("#token=", "");
    return { server, token, base: `http://127.0.0.1:${server.port}` };
  }

  it("serves the host page with a strict content security policy", async () => {
    const { base } = await ui();
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'.*connect-src 'self'.*frame-ancestors 'none'/);
    expect(await r.text()).toContain("<div id=\"root\">");
  });

  it("refuses the MCP endpoint without the token, from another origin, or under another host name", async () => {
    const { base, token, server } = await ui();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${token}`, origin: "https://evil.example" })).status).toBe(403);
    // fetch won't send a custom Host header, so a DNS-rebinding request is made by hand.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path: "/mcp", method: "POST", headers: { host: `rebind.example:${server.port}`, authorization: `Bearer ${token}`, "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(init));
    });
    expect(status).toBe(421);
  });

  it("runs a full MCP session over HTTP with the token", async () => {
    const { base, token } = await ui();
    const client = new Client({ name: "browser", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["open_console", "explore_context", "add_claim"]));
    expect(names).not.toContain("browser_view"); // the page's own sessions don't hand out more links
    const r: any = await client.callTool({ name: "open_console", arguments: {} });
    expect(r.structuredContent).toMatchObject({ graph: "main", you: { role: "admin" } });
    await client.close();
  });
});

describe("names, auto-share and which graph", () => {
  it("saves a chosen name with the key, and the host records under it from then on", async () => {
    const before = process.env.VINE_USER;
    delete process.env.VINE_USER;
    try {
      const me = await agent("first", "main", { storedName: true });
      // Until they choose a name, an invite's result says where the name came from.
      expect((await me.call("share_context")).your_name).toContain(`'${defaultName(me.dataDir)}'`);
      const r = await me.call("set_my_name", { name: "Craig Deverall" });
      expect(r).toMatchObject({ name: "Craig Deverall", fingerprint: expect.stringMatching(/^[0-9a-f]{4}-/) });
      expect(defaultName(me.dataDir)).toBe("Craig Deverall");
      expect(nameSource(me.dataDir)).toBe("set_my_name");
      const c = await me.call("add_claim", { text: "Recorded after the rename" });
      expect(await me.call("history", { id: c.result.id })).toMatchObject({ item: { recorded_by: "Craig Deverall" } });
      expect(await me.call("open_console")).toMatchObject({ you: { name: "Craig Deverall", name_from: "set_my_name" } });
      expect(await me.call("share_context")).not.toHaveProperty("your_name");
      expect((await me.raw("set_my_name", { name: "<script>" })).isError).toBe(true);
    } finally {
      if (before !== undefined) process.env.VINE_USER = before;
    }
  });

  it("puts a new context online straight away, and makes no join code until asked", async () => {
    const me = await agent("alice");
    process.env.VINE_AUTO_SHARE = "on";
    try {
      const r = await me.call("use_context", { name: "planning" });
      expect(r).toMatchObject({ created: "your context 'planning'", next: expect.stringContaining("no join code") });
      expect(r).not.toHaveProperty("code");
      expect(r).not.toHaveProperty("send");
      expect(await me.call("context_info")).toMatchObject({ sharing: { sharing: true } });
      expect((await me.call("sharing_status")).invites).toEqual([]);
      // Inviting is its own step, with the role the person chose.
      const inv = await me.call("share_context", { label: "for Sam", role: "reader" });
      expect(inv).toMatchObject({ code: expect.stringMatching(/^vine1_/), send: expect.stringContaining(inv.code), invite: { role: "reader" }, shared_as: { name: "alice" } });
      expect((await me.call("sharing_status")).invites).toHaveLength(1);
      // Switching back to an existing graph doesn't share it.
      const back = await me.call("use_context", { name: "main" });
      expect(back).not.toHaveProperty("code");
      await me.call("use_context", { name: "planning" });
      await me.call("stop_sharing");
    } finally {
      process.env.VINE_AUTO_SHARE = "off";
    }
  });

  it("says clearly when no one answers a code, and stays on its own graph", async () => {
    const me = await agent("alice");
    await me.call("add_claim", { text: "Mine, on main" });
    const r = await me.raw("join_context", { code: formatCode(newLink()) });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/isn't online right now/);
    expect((await me.call("context_info")).using).toBe("your context 'main'");
    expect((await me.call("search", { query: "Mine" })).length).toBe(1);
  });

  it("reports recent activity, the people and the graph", async () => {
    const me = await agent("alice");
    const c = await me.call("add_claim", { text: "Seen in the activity feed" });
    const a = await me.call("context_activity", { snapshot: true });
    expect(a).toMatchObject({ graph: "main", you: { name: "alice", role: "admin" }, members: 1, your_contexts: ["main"] });
    expect(a.recent[0]).toMatchObject({ kind: "claim", by: "alice", mine: true, held: true, node: c.result?.id ?? c.id, summary: "claimed: Seen in the activity feed" });
    expect(a.snapshot.nodes.map((n: any) => n.title)).toContain("Seen in the activity feed");
    expect(a.people).toEqual([expect.objectContaining({ name: "alice", you: true, creator: true })]);
  });

  it("says which graph each model tool acted on", async () => {
    const me = await agent("alice");
    const r = await me.raw("add_claim", { text: "Where did this go?" });
    expect(r.content.at(-1).text).toMatch(/^\(in your context 'main'\) It stays on this machine until /);
    expect(JSON.parse(r.content[0].text).id).toMatch(/^c_/);
  });
});
