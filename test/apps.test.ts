// M3: MCP App views, the tools that open them, model packs from the studio,
// and the localhost page for agents that can't show views.

import { EventEmitter } from "node:events";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { defaultName, loadIdentity, nameSource } from "../src/core/identity.js";
import { loadPack } from "../src/core/pack.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { APP_MIME, VIEWS } from "../src/mcp/apps.js";
import { Session } from "../src/mcp/server.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { startUi, type UiServer } from "../src/ui/server.js";
import { pause, tempDir, writePack } from "./helpers.js";

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
  const open = async (name: string, model?: string) => {
    let h = started.get(name);
    if (!h) {
      h = await Host.start({ dataDir, graph: name, model, user, signal, ice });
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
    for (const view of Object.keys(VIEWS)) expect(resources).toContainEqual(expect.objectContaining({ uri: `ui://p2pcg/${view}`, mimeType: APP_MIME }));
    const read = await alice.client.readResource({ uri: "ui://p2pcg/explorer" });
    const html = (read.contents[0] as { text: string }).text;
    expect(read.contents[0]!.mimeType).toBe(APP_MIME);
    expect(html).toContain('window.__P2PCG_VIEW__="explorer"');
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/i); // self-contained: nothing loaded from elsewhere

    const { tools } = await alice.client.listTools();
    const by = (n: string) => tools.find((t) => t.name === n)!;
    expect(uiOf(by("open_console"))).toBe("ui://p2pcg/console");
    expect(uiOf(by("explore_graph"))).toBe("ui://p2pcg/explorer");
    expect(uiOf(by("model_studio"))).toBe("ui://p2pcg/studio");
    expect(uiOf(by("add_claim"))).toBe("ui://p2pcg/receipt");
    expect(uiOf(by("conflicts"))).toBe("ui://p2pcg/conflicts");
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
      undo: { tool: "withdraw", arg: "id", field: "id" },
      where: "your graph 'main'",
    });
    const id = r.structuredContent.result.id;
    await alice.call(r.structuredContent.undo.tool, { [r.structuredContent.undo.arg]: id });
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

    const r = await alice.raw("explore_graph");
    expect(r.content[0].text).not.toContain("Sign-ups doubled"); // the picture is for the person
    const now = r.structuredContent;
    expect(now.nodes.map((n: any) => [n.key, n.ended])).toEqual([
      [b.result.id, false],
      [a.result.id, true],
    ]);
    expect(now.edges).toEqual([expect.objectContaining({ type: "SUPPORTS", source: `Claim:${b.result.id}`, target: `Claim:${a.result.id}` })]);
    expect(now.schema.time).toEqual({ recorded: "recorded_at", ended: "withdrawn_at" });

    const then = (await alice.raw("explore_graph", { at: before })).structuredContent;
    expect(then.nodes.map((n: any) => [n.key, n.ended])).toEqual([[a.result.id, false]]);
    expect(then.edges).toEqual([]);
  });

  it("opens the console with your sharing state", async () => {
    const alice = await agent("alice");
    expect(await alice.call("open_console")).toMatchObject({ mode: "host", sharing: false, people: [expect.objectContaining({ name: "alice", host: true })], connected: [] });
    await alice.call("share_graph");
    expect(await alice.call("open_console")).toMatchObject({ mode: "host", sharing: true, invites: [expect.objectContaining({ state: "open", code: expect.stringMatching(/^p2pcg1_/) })] });
    await alice.call("stop_sharing");
  });

  it("lets a peer explore the host's graph, and shows the peer its connection", async () => {
    const alice = await agent("alice", "team");
    const bob = await agent("bob", "own");
    await alice.call("add_claim", { text: "Alice's finding about the build" });
    const { code } = await alice.call("share_graph", { role: "reader" });
    await bob.call("join_graph", { code });
    let state: any;
    for (let i = 0; i < 100 && state?.state !== "active"; i++) {
      state = await bob.call("open_console");
      await pause(50);
    }
    expect(state).toMatchObject({ mode: "peer", host: "alice", state: "active", role: "reader", you: { name: "bob" } });
    const snap = (await bob.raw("explore_graph")).structuredContent;
    expect(snap).toMatchObject({ graph: "team", where: expect.stringContaining("alice's graph 'team'") });
    expect(snap.nodes.map((n: any) => n.title)).toEqual(["Alice's finding about the build"]);
    // A reader has no add_claim, so no receipt tool either; the studio can't manage packs on someone else's machine.
    expect(await bob.call("model_studio")).toMatchObject({ mode: "peer", can_manage: false, packs: [] });
    await bob.call("leave_graph");
    await alice.call("stop_sharing");
  });
});

describe("model packs from the studio", () => {
  it("lists packs and graphs, checks a pack, installs it, and starts a graph with it", async () => {
    const alice = await agent("alice");
    const studio = await alice.call("model_studio");
    expect(studio.packs.map((p: any) => p.name)).toEqual(["decision-log", "temporal-claims"]);
    expect(studio.graphs).toEqual(["main"]);
    expect(studio.model.schema.nodes.map((n: any) => n.label)).toEqual(["Claim", "Question"]);

    // A broken pack fails the check and can't be installed.
    const broken = writePack({
      "model.yaml": "name: broken\nversion: 1\ntitle: Broken\ndescription: x\nnodes:\n  Note:\n    description: A note\n    key: id\n    properties:\n      id: { type: id, required: true }\n",
      "tools.yaml": "tools:\n  - name: notes\n    kind: read\n    description: Lists the notes in order\n    steps:\n      - cypher: MATCH (n:Note) RETURN n.id AS id ORDER BY nope\n",
    });
    const report = await alice.call("validate_model", { path: broken });
    expect(report).toMatchObject({ ok: false, tools: [expect.objectContaining({ tool: "notes", outcome: "failed" })] });
    expect((await alice.raw("install_model", { path: broken })).isError).toBe(true);

    // A good one: decision-log under another name.
    const mine = tempDir("p2pcg-pack-");
    cpSync(loadPack(join("models", "decision-log")).dir, mine, { recursive: true });
    const yaml = join(mine, "model.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace("name: decision-log", "name: team-decisions"));
    expect((await alice.call("validate_model", { path: mine })).ok).toBe(true);
    expect(await alice.call("install_model", { path: mine })).toMatchObject({ installed: "team-decisions", replaced_version: null });
    expect((await alice.call("model_studio")).packs).toContainEqual(expect.objectContaining({ name: "team-decisions", source: "installed" }));

    const before = alice.changes();
    expect(await alice.call("use_graph", { name: "decisions", model: "team-decisions" })).toMatchObject({ using: "your graph 'decisions'" });
    expect(alice.changes()).toBeGreaterThan(before);
    const names = (await alice.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("record_decision");
    expect(names).not.toContain("add_claim");
    await alice.call("record_decision", { text: "Ship the beta on 1 December" });

    // An existing graph keeps its model.
    expect((await alice.raw("use_graph", { name: "decisions", model: "temporal-claims" })).content[0].text).toMatch(/already exists with the model 'team-decisions'/);
    await alice.call("use_graph", { name: "main" });
    expect((await alice.client.listTools()).tools.map((t) => t.name)).toContain("add_claim");
  });

  it("refuses to install over a built-in pack's name", async () => {
    const alice = await agent("alice");
    expect((await alice.raw("install_model", { path: join(process.cwd(), "models", "decision-log") })).content[0].text).toMatch(/built-in pack's name/);
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
    expect(names).toEqual(expect.arrayContaining(["open_console", "explore_graph", "model_studio", "add_claim"]));
    expect(names).not.toContain("browser_view"); // the page's own sessions don't hand out more links
    const r: any = await client.callTool({ name: "open_console", arguments: {} });
    expect(r.structuredContent).toMatchObject({ mode: "host", graph: "main" });
    await client.close();
  });
});

describe("names, auto-share and which graph", () => {
  it("saves a chosen name with the key, and the host records under it from then on", async () => {
    const before = process.env.P2PCG_USER;
    delete process.env.P2PCG_USER;
    try {
      const me = await agent("first", "main", { storedName: true });
      const r = await me.call("set_my_name", { name: "Craig Deverall" });
      expect(r).toMatchObject({ name: "Craig Deverall", fingerprint: expect.stringMatching(/^[0-9a-f]{4}-/) });
      expect(defaultName(me.dataDir)).toBe("Craig Deverall");
      expect(nameSource(me.dataDir)).toBe("set_my_name");
      const c = await me.call("add_claim", { text: "Recorded after the rename" });
      expect(await me.call("history", { id: c.result.id })).toMatchObject({ item: { recorded_by: "Craig Deverall" } });
      expect(await me.call("open_console")).toMatchObject({ you: { name: "Craig Deverall", name_from: "set_my_name" } });
      expect((await me.raw("set_my_name", { name: "<script>" })).isError).toBe(true);
    } finally {
      if (before !== undefined) process.env.P2PCG_USER = before;
    }
  });

  it("shares a new graph straight away and returns a join code", async () => {
    const me = await agent("alice");
    process.env.P2PCG_AUTO_SHARE = "on";
    try {
      const r = await me.call("use_graph", { name: "planning", model: "decision-log" });
      expect(r).toMatchObject({ created: "your graph 'planning'", code: expect.stringMatching(/^p2pcg1_/), send: expect.stringContaining(r.code), shared_as: { name: "alice" } });
      expect(await me.call("graph_info")).toMatchObject({ sharing: { sharing: true } });
      // Switching back to an existing graph doesn't share it.
      const back = await me.call("use_graph", { name: "main" });
      expect(back).not.toHaveProperty("code");
      await me.call("use_graph", { name: "planning" });
      await me.call("stop_sharing");
    } finally {
      process.env.P2PCG_AUTO_SHARE = "off";
    }
  });

  it("says which graph each model tool acted on", async () => {
    const me = await agent("alice");
    const r = await me.raw("add_claim", { text: "Where did this go?" });
    expect(r.content.at(-1).text).toBe("(on your graph 'main')");
    expect(JSON.parse(r.content[0].text).id).toMatch(/^c_/);
  });
});
