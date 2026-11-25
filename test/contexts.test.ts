// A chat's contexts (usually one): a chat keeps what it chose (by the chat's
// id), a new chat starts with its folder's linked contexts if there are any,
// and there's no default. With several, reads span them and writes are routed.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { Session } from "../src/mcp/server.js";
import { readTurn, saveTurn } from "../src/p2p/ice.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const hosts: Host[] = [];
afterAll(() => hosts.forEach((h) => h.stop()));

/** One person's machine: its contexts' hosts, and chats (by id) started in a folder. */
function machine(user: string) {
  const dataDir = tempDir();
  const started = new Map<string, Host>();
  const open = async (name: string) => {
    let h = started.get(name);
    if (!h) {
      h = await Host.start({ dataDir, graph: name, user, signal, ice, holdMs: 100 });
      hosts.push(h);
      started.set(name, h);
    }
    return LocalHost.connect(h.socket);
  };
  const chat = async (o: { id?: string; cwd?: string; configured?: string } = {}) => {
    const session = new Session({ local: o.configured ? () => open(o.configured!) : undefined, openLocal: open, dataDir, chat: o.id, cwd: o.cwd, identity: () => loadIdentity(dataDir, user), signal, ice });
    await session.start();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await session.server.connect(a);
    const client = new Client({ name: `${user}-agent`, version: "1" });
    await client.connect(b);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await raw(name, args);
      const t = (r.content as { text: string }[]).find((c) => !c.text.startsWith("News"))!.text;
      if (r.isError) throw new Error(t);
      if (r.structuredContent && name !== "add_claim" && name !== "ask_question" && name !== "reply") return r.structuredContent;
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    };
    const tools = async () => (await client.listTools()).tools;
    return { call, raw, tools, close: () => session.close() };
  };
  return { dataDir, chat };
}

describe("one context per chat", () => {
  it("starts with none, says how to choose, and keeps the chosen context when the chat is reopened", async () => {
    const me = machine("alice");
    const first = await me.chat({ id: "chat-1", cwd: tempDir("vine-empty-") });
    const none = await first.call("context_info");
    expect(none).toMatchObject({ context: null, your_contexts: [] });
    expect(none.next).toMatch(/no default/);
    expect((await first.tools()).map((t) => t.name)).toContain("add_claim"); // still offered, to explain
    await expect(first.call("search", { query: "x" })).rejects.toThrow(/Ask the person which context/);
    expect(await first.call("context_activity")).toMatchObject({ context: null });

    await first.call("use_context", { name: "lunch", description: "Where and when the team has lunch" });
    await first.call("add_claim", { text: "The team lunch is on Fridays" });
    // No context argument: a chat has one context.
    expect((await first.tools()).find((t) => t.name === "add_claim")!.inputSchema.properties).not.toHaveProperty("context");
    expect(JSON.parse(readFileSync(join(me.dataDir, "links.json"), "utf8")).chats["chat-1"]).toMatchObject({ contexts: [{ name: "lunch", id: expect.any(String) }], write_to: "lunch" });
    expect(existsSync(join(me.dataDir, "graphs", "main"))).toBe(false);

    // The same chat, reopened: its context is back.
    const again = await me.chat({ id: "chat-1" });
    expect(await again.call("context_info")).toMatchObject({ context: "lunch", description: "Where and when the team has lunch", started_from: "chat" });
    expect((await again.call("search", { query: "lunch" })).map((r: any) => r.text)).toEqual(["The team lunch is on Fridays"]);
    // Another chat doesn't get it.
    expect((await me.chat({ id: "chat-2" }).then((c) => c.call("context_info"))).context).toBe(null);
  });

  it("switches the chat's context, replacing the one it had", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat-1", configured: "main" });
    expect((await c.call("context_info")).started_from).toBe("configured");
    await c.call("use_context", { name: "ops", description: "Runbooks and on-call notes" });
    const info = await c.call("context_info");
    expect(info).toMatchObject({ context: "ops", your_contexts: ["main", "ops"] });
    const d = await c.call("describe_context", { description: "  Runbooks:   on-call notes  " });
    expect(d).toEqual({ context: "ops", description: "Runbooks: on-call notes" });
    expect((await c.call("context_activity")).recent[0].summary).toMatch(/^described the context: Runbooks/);
    // An admin sees the open join codes (the new context's own, and one for Sam), until they're cancelled.
    const sam = await c.call("share_context", { label: "for Sam", role: "reader" });
    const open = (await c.call("context_activity")).invites;
    expect(open[0]).toMatchObject({ id: sam.invite.id, label: "for Sam", role: "reader", code: sam.code });
    await c.call("revoke_invite", { id: sam.invite.id });
    // Going offline and back online, without a new join code.
    await c.call("stop_sharing");
    expect((await c.call("context_activity")).sharing).toBe(false);
    expect(await c.call("start_sharing")).toMatchObject({ sharing: true });
    expect((await c.call("context_activity")).sharing).toBe(true);
    expect((await c.call("context_activity")).invites.map((i: any) => i.id)).not.toContain(sam.invite.id);
  });

  it("starts new chats in a linked folder with its context, without writing into the folder", async () => {
    const me = machine("alice");
    const project = tempDir("vine-project-");
    const setup = await me.chat({ id: "setup", cwd: project });
    await setup.call("use_context", { name: "team", description: "What the team knows" });
    expect(await setup.call("link_folder")).toMatchObject({ folder: project, linked: ["team"] });
    expect(existsSync(join(project, ".p2p-context"))).toBe(false);

    const sub = join(project, "src");
    mkdirSync(sub);
    const later = await me.chat({ id: "later", cwd: sub });
    expect(await later.call("context_info")).toMatchObject({ context: "team", started_from: "folder", folder: { folder: project, linked: true } });
    // A chat that already chose a context keeps its own, whatever the folder says.
    const other = await me.chat({ id: "other", cwd: tempDir() });
    await other.call("use_context", { name: "notes", description: "My notes" });
    expect((await me.chat({ id: "other", cwd: project }).then((c) => c.call("context_info"))).context).toBe("notes");

    await setup.call("link_folder", { off: true });
    expect((await me.chat({ id: "fresh", cwd: sub }).then((c) => c.call("context_info"))).context).toBe(null);
  });
});

describe("several contexts in one chat", () => {
  it("adds a second context, routes writes, reads across both, and removes them down to none", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat-1" });
    await c.call("use_context", { name: "incident", description: "The checkout slowdown of 10 Nov" });
    await c.call("add_context", { name: "infra", description: "How our infrastructure is set up" });
    const info = await c.call("context_info");
    expect(info.contexts.map((x: any) => [x.name, x.writes_here])).toEqual([
      ["incident", true],
      ["infra", false],
    ]);
    // With several, the tools take `context` and say what each is for.
    const add = (await c.tools()).find((t) => t.name === "add_claim")!;
    expect(add.inputSchema.properties).toHaveProperty("context");
    expect(add.description).toMatch(/'incident' \(writes go here by default\): The checkout slowdown[\s\S]*'infra': How our infrastructure/);
    expect((await c.raw("add_claim", { text: "Checkout p95 rose to 4 s" })).structuredContent.context).toBe("incident");
    expect((await c.raw("add_claim", { text: "Checkout runs on three nodes", context: "infra" })).structuredContent.context).toBe("infra");
    expect((await c.call("search", { query: "checkout" })).map((r: any) => r.context).sort()).toEqual(["incident", "infra"]);
    expect(await c.call("model_guide")).toMatch(/## Several contexts/);
    await expect(c.call("add_claim", { text: "x", context: "lunch" })).rejects.toThrow(/doesn't use 'lunch'/);

    // Reopened, the chat has both, and the same write context.
    expect((await me.chat({ id: "chat-1" }).then((x) => x.call("context_info"))).contexts.map((x: any) => x.name)).toEqual(["incident", "infra"]);

    await c.call("remove_context", { name: "incident" });
    expect(await c.call("context_info")).toMatchObject({ context: "infra", write_to: "infra" });
    expect((await c.tools()).find((t) => t.name === "add_claim")!.inputSchema.properties).not.toHaveProperty("context");
    await c.call("remove_context");
    expect((await c.call("context_info")).context).toBe(null);
    expect((await me.chat({ id: "chat-1" }).then((x) => x.call("context_info"))).context).toBe(null);
  });

  it("reads a link saved before chats could hold several", async () => {
    const me = machine("alice");
    const setup = await me.chat({ id: "old" });
    await setup.call("use_context", { name: "team", description: "What the team knows" });
    const file = join(me.dataDir, "links.json");
    const links = JSON.parse(readFileSync(file, "utf8"));
    links.chats.old = { name: "team", id: links.chats.old.contexts[0].id, at: links.chats.old.at };
    writeFileSync(file, JSON.stringify(links));
    expect((await me.chat({ id: "old" }).then((x) => x.call("context_info"))).context).toBe("team");
  });
});

describe("pinning one context to a folder", () => {
  it("pins and unpins contexts one at a time, in the chat or not", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat-1", cwd: "/work/shop" });
    await c.call("use_context", { name: "incident", description: "The checkout slowdown" });
    await c.call("add_context", { name: "infra", description: "How our infrastructure is set up" });
    await c.call("remove_context", { name: "infra" });
    expect((await c.call("context_info")).folder).toMatchObject({ linked: false, pinned: [] });

    await c.call("link_folder", { name: "infra" }); // not in this chat
    await c.call("link_folder", { name: "incident" });
    await c.call("link_folder", { name: "incident" }); // again: still once
    expect((await c.call("context_info")).folder.pinned).toEqual(["infra", "incident"]);
    await expect(c.call("link_folder", { name: "lunch" })).rejects.toThrow(/no context 'lunch'/);
    // A new chat in the folder, or below it, starts with both.
    const fresh = await me.chat({ id: "chat-2", cwd: "/work/shop/api" });
    expect((await fresh.call("context_info")).contexts.map((x: any) => x.name)).toEqual(["infra", "incident"]);

    await c.call("link_folder", { name: "infra", off: true });
    expect((await c.call("context_info")).folder).toMatchObject({ linked: true, pinned: ["incident"] });
    await c.call("link_folder", { name: "incident", off: true });
    expect((await c.call("context_info")).folder.pinned).toEqual([]);
    expect((await me.chat({ id: "chat-3", cwd: "/work/shop" }).then((x) => x.call("context_info"))).context).toBe(null);
  });
});

describe("the TURN server tools", () => {
  it("never take a password: the server is saved for VINE_TURN_PASSWORD, and a kept password is left alone", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat-1" });
    const tool = (await c.tools()).find((t) => t.name === "set_turn_server")!;
    expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(["host", "port", "transport", "username"]);

    const before = process.env.VINE_TURN_PASSWORD;
    delete process.env.VINE_TURN_PASSWORD;
    try {
      const r = await c.call("set_turn_server", { host: "turn.example.org", username: "sam", transport: "tls" });
      expect(r).toMatchObject({ turn: "turn.example.org:5349 (tls)", password_store: "env", answered: false, terminal_command: "vine turn set turn.example.org:5349 --user sam --tls" });
      expect(readFileSync(join(me.dataDir, "network.json"), "utf8")).not.toMatch(/password/);

      // Set in a terminal, with the password kept by vine: the tool won't replace it.
      saveTurn(me.dataDir, { host: "turn.example.org", username: "sam", store: "file", password: "kept-secret" });
      await expect(c.call("set_turn_server", { host: "other.example.org", username: "sam" })).rejects.toThrow(/already set[\s\S]*vine turn set/);
      expect(readTurn(me.dataDir)).toMatchObject({ host: "turn.example.org", store: "file", password: "kept-secret" });

      expect(await c.call("remove_turn_server")).toMatchObject({ removed: true });
      expect(readTurn(me.dataDir)).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.VINE_TURN_PASSWORD = before;
    }
  });
});

describe("details and deleting", () => {
  it("shows any local context's details, and deletes one only when its name is confirmed", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat-1", cwd: "/work/app" });
    await c.call("use_context", { name: "incident", description: "The checkout slowdown" });
    await c.call("add_context", { name: "infra", description: "How our infrastructure is set up" });
    await c.call("add_claim", { text: "Checkout p95 rose to 4 s" });
    await c.call("link_folder");
    const other = await me.chat({ id: "chat-2" });
    await other.call("use_context", { name: "incident" });

    // Details: for a context in the chat, and for one that isn't.
    expect(await c.call("context_details", { name: "incident" })).toMatchObject({
      name: "incident",
      description: "The checkout slowdown",
      role: "admin",
      yours: true,
      in_chat: true,
      writes_here: true,
      members: 1,
      items: { Claim: 1 },
    });
    expect(await other.call("context_details", { name: "infra" })).toMatchObject({ name: "infra", in_chat: false, writes_here: false, role: "admin" });
    expect((await other.call("context_info")).contexts.map((x: any) => x.name)).toEqual(["incident"]);
    await expect(c.call("context_details", { name: "lunch" })).rejects.toThrow(/no context 'lunch'/);

    // Deleting needs the name again, exactly.
    await expect(c.call("delete_context", { name: "incident", confirm: "yes" })).rejects.toThrow(/Not deleted/);
    expect(existsSync(join(me.dataDir, "graphs", "incident"))).toBe(true);

    const r = await c.call("delete_context", { name: "incident", confirm: "incident" });
    expect(r).toMatchObject({ deleted: "incident", your_contexts: ["infra"], write_to: "infra" });
    expect(existsSync(join(me.dataDir, "graphs", "incident"))).toBe(false);
    expect(existsSync(join(me.dataDir, "hosts", "incident"))).toBe(false);
    expect(readdirSync(join(me.dataDir, "graphs"))).toEqual(["infra"]);
    expect((await c.call("context_info")).contexts.map((x: any) => x.name)).toEqual(["infra"]);
    // The chat's and the folder's links no longer name it.
    const links = JSON.parse(readFileSync(join(me.dataDir, "links.json"), "utf8"));
    expect(links.chats["chat-1"].contexts.map((x: any) => x.name)).toEqual(["infra"]);
    expect(links.folders[resolve("/work/app")].contexts.map((x: any) => x.name)).toEqual(["infra"]);
    expect(links.chats["chat-2"]).toBeUndefined();

    // Another chat that used it is told, and doesn't start an empty context under its name.
    await expect(other.call("context_info")).rejects.toThrow(/was deleted from this machine/);
    expect((await other.call("context_info")).context).toBe(null);
    expect(existsSync(join(me.dataDir, "graphs", "incident"))).toBe(false);
    await expect(c.call("delete_context", { name: "incident", confirm: "incident" })).rejects.toThrow(/no context 'incident'/);
  });
});

describe("question threads", () => {
  it("lets agents reply on a question's thread and answer it with a claim", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat", configured: "team" });
    const q = await c.call("ask_question", { text: "Which day is the team lunch?" });
    const r = await c.raw("reply", { question: q.id, text: "Bob says Thursday suits most people" });
    expect(r.content.at(-1).text).toMatch(/^\(in your context 'team'\)/);
    const t = await c.call("thread", { question: q.id });
    expect(t.replies.map((x: any) => x.text)).toEqual(["Bob says Thursday suits most people"]);
    await c.call("add_claim", { text: "The team lunch is on Thursdays", answers: [q.id] });
    expect(await c.call("thread", { question: q.id })).toMatchObject({ answered: true });
    expect((await c.call("context_activity")).recent.map((x: any) => x.summary)).toContainEqual(expect.stringMatching(/^replied to q_/));
  });
});

describe("finding a context", () => {
  it("searches every context on this machine by name and description, and says which this chat uses", async () => {
    const me = machine("alice");
    const c = await me.chat({ id: "chat-find", cwd: tempDir("vine-empty-") });
    expect(await c.call("find_context", { query: "lunch" })).toMatchObject({ found: [], your_contexts: [] });

    await c.call("use_context", { name: "lunch", description: "Where and when the team has lunch" });
    await c.call("add_context", { name: "ops", description: "Runbooks, deploys and on-call notes" });
    await c.call("use_context", { name: "lunch" }); // ops stays on the machine, out of the chat

    const r = await c.call("find_context", { query: "on-call runbooks" });
    expect(r.searched).toBe(2);
    expect(r.found[0]).toMatchObject({ name: "ops", description: "Runbooks, deploys and on-call notes", in_chat: false, writes_here: false, members: 1 });
    expect((await c.call("find_context", { query: "team lunch", limit: 1 })).found).toEqual([expect.objectContaining({ name: "lunch", in_chat: true, writes_here: true })]);

    // A description set later is found on the next search.
    await c.call("describe_context", { description: "Friday lunch spots and the dietary list" });
    expect((await c.call("find_context", { query: "dietary", limit: 1 })).found[0]).toMatchObject({ name: "lunch", description: "Friday lunch spots and the dietary list" });
  });
});
