// The tools that each do several things (one per action, mode or option), and
// the dates every tool takes: listed as a plain `format`, checked where the
// call is handled.

import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { RESERVED_TOOL_NAMES } from "../src/core/pack.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { Session } from "../src/mcp/server.js";
import { readTurn } from "../src/p2p/ice.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { pause, tempDir } from "./helpers.js";

const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const hosts: Host[] = [];
afterAll(() => hosts.forEach((h) => h.stop()));

/** An agent's session on its own machine. `holdMs` is how long a write stays on the machine before it is shared. */
async function agent(user: string, o: { graph?: string; holdMs?: number; browserView?: () => Promise<string> } = {}) {
  const dataDir = tempDir();
  const started = new Map<string, Host>();
  const open = async (name: string) => {
    let h = started.get(name);
    if (!h) {
      h = await Host.start({ dataDir, graph: name, user, signal, ice, holdMs: o.holdMs ?? 1500 });
      hosts.push(h);
      started.set(name, h);
    }
    return LocalHost.connect(h.socket);
  };
  const graph = o.graph ?? "main";
  const session = new Session({ local: () => open(graph), openLocal: open, dataDir, identity: () => loadIdentity(dataDir, user), signal, ice, joinWaitMs: 3000, browserView: o.browserView });
  await session.start();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await session.server.connect(a);
  const client = new Client({ name: user, version: "0" });
  await client.connect(b);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    const first = (r.content as { text: string }[]).find((c) => !c.text.startsWith("News"))!.text;
    if (r.isError) throw new Error(first);
    if (r.structuredContent) return r.structuredContent;
    try {
      return JSON.parse(first);
    } catch {
      return first;
    }
  };
  const tools = async () => (await client.listTools()).tools;
  return { call, raw, tools, dataDir };
}

describe("the tool list", () => {
  it("is the 26 tools, and the server's own are the reserved names", async () => {
    const me = await agent("alice", { browserView: async () => "http://127.0.0.1:1/#token=t" });
    const names = (await me.tools()).map((t) => t.name).sort();
    const model = ["add_claim", "ask_question", "basis", "beliefs", "conflicts", "history", "link", "open_questions", "recent", "reply", "search", "thread", "withdraw"];
    expect(names).toEqual([...model, ...RESERVED_TOOL_NAMES].sort());
    expect(names).toHaveLength(26);
  });

  it("lists dates as a plain format, with no validation pattern", async () => {
    const me = await agent("alice");
    const tools = await me.tools();
    const props = (n: string) => tools.find((t) => t.name === n)!.inputSchema.properties as Record<string, any>;
    expect(props("add_claim").about_from).toEqual({ type: "string", format: "date", description: expect.any(String) });
    expect(props("add_claim").about_to).toMatchObject({ type: "string", format: "date" });
    expect(props("beliefs").about_from).toMatchObject({ type: "string", format: "date" });
    for (const [tool, arg] of [["search", "at"], ["beliefs", "at"], ["open_questions", "at"], ["thread", "at"], ["conflicts", "at"], ["recent", "since"], ["open_view", "at"]] as const)
      expect(props(tool)[arg], `${tool}.${arg}`).toMatchObject({ type: "string", format: "date-time" });
    expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/\\\\d/); // no date regex anywhere in the listing
  });
});

describe("dates are checked where the call is handled", () => {
  it("refuses a day that isn't a real YYYY-MM-DD date, and says what one looks like", async () => {
    const me = await agent("alice");
    for (const bad of ["2026-02-30", "2026-13-01", "01/03/2026", "2026-3-1", "yesterday", ""]) {
      const r = await me.raw("add_claim", { text: "Dated wrongly", about_from: bad });
      expect(r.isError, bad).toBe(true);
      expect(r.content[0].text, bad).toMatch(/about_from: must be a real calendar date as YYYY-MM-DD, for example 2026-03-01/);
    }
    await expect(me.call("add_claim", { text: "Dated wrongly", about_to: "2025-02-29" })).rejects.toThrow(/about_to: must be a real calendar date/);
    await expect(me.call("beliefs", { about_from: "2026-06-31" })).rejects.toThrow(/about_from: must be a real calendar date/);
    // Nothing was recorded by the refused writes.
    expect(await me.call("beliefs")).toEqual([]);
    // A real day (a leap day too) is taken.
    const ok = await me.raw("add_claim", { text: "Dated rightly", about_from: "2024-02-29", about_to: "2024-03-01" });
    expect(ok.isError).toBeFalsy();
    expect(await me.call("beliefs", { about_from: "2024-02-01", about_to: "2024-12-31" })).toHaveLength(1);
  });

  it("refuses a moment that isn't ISO 8601 with a time zone", async () => {
    const me = await agent("alice");
    await me.raw("add_claim", { text: "Something to find" });
    const moment = /must be an ISO 8601 date-time with a time zone, for example 2026-03-01T09:00:00Z/;
    for (const bad of ["2026-03-01", "2026-03-01T09:00:00", "2026-02-30T09:00:00Z", "2026-03-01 09:00:00Z", "now"]) {
      await expect(me.call("search", { query: "find", at: bad }), bad).rejects.toThrow(moment);
      await expect(me.call("beliefs", { at: bad }), bad).rejects.toThrow(moment);
      await expect(me.call("open_questions", { at: bad }), bad).rejects.toThrow(moment);
      await expect(me.call("conflicts", { at: bad }), bad).rejects.toThrow(moment);
      await expect(me.call("recent", { since: bad }), bad).rejects.toThrow(moment);
      await expect(me.call("open_view", { view: "explorer", at: bad }), bad).rejects.toThrow(moment);
    }
    await expect(me.call("thread", { question: "q_none", at: "tomorrow" })).rejects.toThrow(moment);
    // With an offset or Z, and with fractions of a second, it is taken.
    for (const good of ["2099-03-01T09:00:00Z", "2099-03-01T09:00:00.123+13:00"]) {
      expect(await me.call("search", { query: "find", at: good })).toHaveLength(1);
      expect(await me.call("recent", { since: good })).toEqual([]);
      expect((await me.raw("open_view", { view: "explorer", at: good })).isError).toBeFalsy();
    }
  });
});

describe("withdraw: undo before it is shared, else a withdrawal", () => {
  it("undoes a write that is still only on this machine, and says so", async () => {
    const me = await agent("alice", { holdMs: 5000 });
    const c = await me.raw("add_claim", { text: "Recorded by mistake" });
    const { id, change } = c.structuredContent.result;
    expect(c.content.map((x: any) => x.text).join("\n")).toMatch(/until then withdraw removes it without trace/);
    // By the item's id.
    const undone = await me.call("withdraw", { id });
    expect(undone).toMatchObject({ taken_back: change, kind: "claim", node: id, note: expect.stringMatching(/never left this machine/) });
    expect(undone).not.toHaveProperty("withdrawn_at");
    // No trace: not in the history, nor in the activity.
    await expect(me.call("history", { id })).rejects.toThrow();
    expect((await me.call("recent", { activity: true })).recent.map((r: any) => r.kind)).not.toContain("claim");
    // By the write's change id, which is how a link (it has no id of its own) is undone.
    const a = (await me.raw("add_claim", { text: "First" })).structuredContent.result;
    const q = (await me.raw("ask_question", { text: "Does anything answer this?" })).structuredContent.result;
    const l = (await me.raw("link", { from: a.id, relation: "ANSWERS", to: q.id })).structuredContent.result;
    expect(await me.call("open_questions")).toEqual([]);
    expect(await me.call("withdraw", { id: l.change })).toMatchObject({ taken_back: l.change });
    expect((await me.call("open_questions")).map((x: any) => x.id)).toEqual([q.id]);
  });

  it("withdraws what was already shared, keeping it in the history, and says so", async () => {
    const me = await agent("alice", { holdMs: 50 });
    const { id } = (await me.raw("add_claim", { text: "Shared, then withdrawn" })).structuredContent.result;
    await pause(300);
    const r = await me.raw("withdraw", { id, reason: "no longer true" });
    const result = JSON.parse(r.content[0].text);
    expect(result).toMatchObject({ id, withdrawn_at: expect.any(String), change: expect.any(String) });
    expect(result).not.toHaveProperty("taken_back");
    expect(r.content.map((x: any) => x.text).join("\n")).toMatch(/Withdrawn: it stays in the history/);
    expect(await me.call("beliefs")).toEqual([]);
    expect(JSON.stringify(await me.call("history", { id }))).toContain("no longer true"); // still in the history, with the reason
  });

  it("with undo_only, fails once it has been shared instead of withdrawing", async () => {
    const me = await agent("alice", { holdMs: 50 });
    const { id, change } = (await me.raw("add_claim", { text: "Too late to undo" })).structuredContent.result;
    await pause(300);
    await expect(me.call("withdraw", { id: change, undo_only: true })).rejects.toThrow(/already been shared/);
    await expect(me.call("withdraw", { id: "x_none", undo_only: true })).rejects.toThrow(/No write x_none/);
    expect((await me.call("beliefs")).map((b: any) => b.id)).toEqual([id]); // still current
  });

  it("withdraws, not undoes, a new item that something else already links to", async () => {
    const me = await agent("alice", { holdMs: 5000 });
    const a = (await me.raw("add_claim", { text: "Sign-ups doubled" })).structuredContent.result;
    const b = (await me.raw("add_claim", { text: "The campaign drove them", supports: [a.id] })).structuredContent.result;
    const r = await me.call("withdraw", { id: a.id });
    expect(r).toMatchObject({ id: a.id, withdrawn_at: expect.any(String) });
    expect(await me.call("history", { id: a.id })).toMatchObject({ item: { id: a.id } });
    expect((await me.call("beliefs")).map((x: any) => x.id)).toEqual([b.id]);
  });

  it("doesn't undo a withdrawal by withdrawing again, but does by the withdrawal's change id", async () => {
    const me = await agent("alice", { holdMs: 400 });
    const { id } = (await me.raw("add_claim", { text: "Withdrawn, then not" })).structuredContent.result;
    await pause(700); // the claim is shared; the withdrawal that follows is held
    const w = await me.call("withdraw", { id });
    expect(w).toMatchObject({ id, withdrawn_at: expect.any(String) });
    // A second withdraw of the item is not an undo of the first.
    await expect(me.call("withdraw", { id })).rejects.toThrow();
    expect(await me.call("beliefs")).toEqual([]);
    expect(await me.call("withdraw", { id: w.change })).toMatchObject({ taken_back: w.change });
    expect((await me.call("beliefs")).map((b: any) => b.id)).toEqual([id]);
  });
});

describe("recent: changes since a moment, or a context's activity", () => {
  it("lists changes since a moment, and needs the moment", async () => {
    const me = await agent("alice");
    const before = new Date(Date.now() - 1000).toISOString();
    const { id } = (await me.raw("add_claim", { text: "A recent finding" })).structuredContent.result;
    expect((await me.call("recent", { since: before })).map((r: any) => r.id)).toContain(id);
    await expect(me.call("recent")).rejects.toThrow(/Give `since`[\s\S]*or set `activity`/);
  });

  it("with activity, says who wrote what and who is here; with snapshot, the items too", async () => {
    const me = await agent("alice");
    const { id } = (await me.raw("add_claim", { text: "Seen in the activity" })).structuredContent.result;
    const a = await me.call("recent", { activity: true, limit: 5 });
    expect(a).toMatchObject({ context: "main", contexts: [expect.objectContaining({ name: "main", writes_here: true })], your_contexts: ["main"], you: { name: "alice", role: "admin" }, invites: [] });
    expect(a.recent[0]).toMatchObject({ kind: "claim", mine: true, node: id, summary: expect.stringMatching(/^claimed: Seen in the activity/) });
    expect(a).not.toHaveProperty("snapshot");
    const s = await me.call("recent", { activity: true, snapshot: true });
    expect(s.snapshot.nodes.map((n: any) => n.title)).toEqual(["Seen in the activity"]);
    // A context the chat doesn't use falls back to the one it does (the panel may ask for one just removed).
    expect(await me.call("recent", { activity: true, context: "gone" })).toMatchObject({ context: "main" });
  });

  it("with activity, never takes the notices meant for the agent", async () => {
    const alice = await agent("alice", { graph: "team" });
    const bob = await agent("bob", { graph: "own" });
    const { code } = await alice.call("share_context");
    await bob.call("join_context", { code });
    await pause(200);
    const polled = await alice.raw("recent", { activity: true });
    expect(polled.content.map((c: any) => c.text).join("\n")).not.toMatch(/^News/m);
    const next = await alice.raw("context_info");
    expect(next.content[0].text).toMatch(/^News: bob joined/);
    await alice.call("sharing", { action: "off" });
  });
});

describe("context_info: this chat's context, or any one's details", () => {
  it("gives the details of a context, in the chat or not", async () => {
    const me = await agent("alice");
    await me.raw("add_claim", { text: "One claim" });
    await me.call("use_context", { name: "side", description: "A side project", mode: "add" });
    await me.call("use_context", { name: "side", mode: "remove" });
    const info = await me.call("context_info");
    expect(info).toMatchObject({ context: "main", write_to: "main", your_contexts: ["main", "side"] });
    expect(info).not.toHaveProperty("stored_at");
    // With details: the write context by default, or the one named.
    expect(await me.call("context_info", { details: true })).toMatchObject({ name: "main", in_chat: true, writes_here: true, role: "admin", items: { Claim: 1 }, stored_at: expect.stringContaining("main") });
    expect(await me.call("context_info", { context: "side", details: true })).toMatchObject({ name: "side", description: "A side project", in_chat: false, writes_here: false });
    // One the chat doesn't use can only be summarised, so naming it is enough.
    expect(await me.call("context_info", { context: "side" })).toMatchObject({ name: "side", in_chat: false });
    await expect(me.call("context_info", { context: "lunch", details: true })).rejects.toThrow(/no context 'lunch'/);
    await expect(me.call("context_info", { context: "lunch" })).rejects.toThrow(/doesn't use 'lunch'/);
  });
});

describe("use_context: replace, add, remove", () => {
  it("replaces by default, adds alongside, moves where writes go, and removes one or all", async () => {
    const me = await agent("alice");
    expect(await me.call("use_context", { name: "ops", description: "Runbooks" })).toMatchObject({ using: "your context 'ops'", created: "your context 'ops'" });
    expect((await me.call("context_info")).contexts).toMatchObject([{ name: "ops", description: "Runbooks" }]);
    const added = await me.call("use_context", { name: "infra", description: "How it is set up", mode: "add" });
    expect(added).toMatchObject({ write_to: "ops", contexts: [{ name: "ops", writes_here: true }, { name: "infra", writes_here: false }] });
    expect(await me.call("use_context", { name: "infra", mode: "add", write_here: true })).toMatchObject({ write_to: "infra" });
    expect(await me.call("use_context", { name: "infra", mode: "remove" })).toMatchObject({ write_to: "ops", contexts: [{ name: "ops" }] });
    expect(await me.call("use_context", { name: "ops", mode: "replace" })).toMatchObject({ using: "your context 'ops'" });
    expect(await me.call("use_context", { mode: "remove" })).toMatchObject({ contexts: [], write_to: null, next: expect.stringMatching(/no context yet/) });
    // Nothing was deleted.
    expect((await me.call("context_info")).your_contexts).toEqual(["infra", "main", "ops"]);
    await expect(me.call("use_context", {})).rejects.toThrow(/Give the context's `name`/);
    await expect(me.call("use_context", { mode: "add" })).rejects.toThrow(/Give the context's `name`/);
    await expect(me.call("use_context", { name: "lunch", mode: "remove" })).rejects.toThrow(/doesn't use 'lunch'/);
  });
});

describe("update_context: purpose, name, your name", () => {
  it("changes each, alone or together, and needs at least one", async () => {
    const me = await agent("alice");
    await expect(me.call("update_context", {})).rejects.toThrow(/Nothing to change/);
    expect(await me.call("update_context", { purpose: "What we know about checkout" })).toEqual({ purpose: { context: "main", description: "What we know about checkout" } });
    expect((await me.call("context_info")).description).toBe("What we know about checkout");
    const both = await me.call("update_context", { purpose: "Checkout, and payments too", my_name: "Ally" });
    expect(Object.keys(both).sort()).toEqual(["my_name", "purpose"]);
    expect(both.my_name).toMatchObject({ name: "Ally", fingerprint: expect.any(String) });
    expect((await me.call("context_info")).you.name).toBe("Ally");
    // A context the chat doesn't use, by name.
    await me.call("use_context", { name: "side", mode: "add" });
    await me.call("use_context", { name: "side", mode: "remove" });
    await me.call("update_context", { purpose: "A side project", context: "side" });
    expect((await me.call("context_info", { context: "side", details: true })).description).toBe("A side project");
    await expect(me.call("update_context", { purpose: "x", context: "lunch" })).rejects.toThrow(/no context 'lunch'/);
    await expect(me.call("update_context", { rename_to: "Not A Name" })).rejects.toThrow();
    // Renaming is covered where hosts run as their own processes (contexts.test.ts): a store only lets go when its host exits.
  });
});

describe("sharing: status, off, on", () => {
  it("reports the state and the invites, goes offline and comes back", async () => {
    const me = await agent("alice");
    expect(await me.call("sharing", { action: "status" })).toMatchObject({ sharing: false, invites: [] });
    const { invite } = await me.call("share_context", { label: "for Sam" });
    const on = await me.call("sharing", { action: "status" });
    expect(on).toMatchObject({ sharing: true, invites: [expect.objectContaining({ id: invite.id, label: "for Sam", state: "open" })], people: [expect.objectContaining({ name: "alice" })] });
    await me.call("sharing", { action: "off" });
    expect((await me.call("sharing", { action: "status" })).sharing).toBe(false);
    expect(await me.call("sharing", { action: "on" })).toMatchObject({ sharing: true });
    expect((await me.call("sharing", { action: "status" })).sharing).toBe(true);
    // Any context on this machine, by name.
    await me.call("use_context", { name: "side", mode: "add" });
    await me.call("use_context", { name: "side", mode: "remove" });
    expect(await me.call("sharing", { action: "on", context: "side" })).toMatchObject({ sharing: true });
    expect(await me.call("sharing", { action: "status", context: "side" })).toMatchObject({ graph: "side", sharing: true });
    await me.call("sharing", { action: "off", context: "side" });
    await me.call("sharing", { action: "off" });
    await expect(me.call("sharing", {})).rejects.toThrow();
    await expect(me.call("sharing", { action: "pause" })).rejects.toThrow();
  });
});

describe("manage_member: set a role, remove someone, cancel an invite", () => {
  it("does each, and says what an action is missing", async () => {
    const alice = await agent("alice", { graph: "team" });
    const bob = await agent("bob", { graph: "own" });
    const { code } = await alice.call("share_context", { role: "reader" });
    await bob.call("join_context", { code });
    const role = (name: string, s: any) => s.people.find((p: any) => p.name === name)?.role;

    await alice.call("manage_member", { action: "set_role", name: "bob", role: "contributor" });
    expect(role("bob", await alice.call("sharing", { action: "status" }))).toBe("contributor");

    const spare = await alice.call("share_context", { label: "for Carol" });
    await alice.call("manage_member", { action: "revoke_invite", invite: spare.invite.id });
    const invites = (await alice.call("sharing", { action: "status" })).invites;
    expect(invites.find((i: any) => i.id === spare.invite.id)?.state).not.toBe("open");

    await alice.call("manage_member", { action: "remove", name: "bob" });
    expect(role("bob", await alice.call("sharing", { action: "status" })) ?? null).toBeNull();

    await expect(alice.call("manage_member", { action: "set_role", name: "bob" })).rejects.toThrow(/Give their new `role`/);
    await expect(alice.call("manage_member", { action: "set_role", role: "admin" })).rejects.toThrow(/Give the member's `name`/);
    await expect(alice.call("manage_member", { action: "remove" })).rejects.toThrow(/Give the member's `name`/);
    await expect(alice.call("manage_member", { action: "revoke_invite" })).rejects.toThrow(/give its id as `invite`/);
    await expect(alice.call("manage_member", { action: "promote", name: "bob" })).rejects.toThrow();
    await alice.call("sharing", { action: "off" });
  });
});

describe("turn_server: set, clear", () => {
  it("saves a server with no password, forgets it, and says what set needs", async () => {
    const me = await agent("alice");
    const before = process.env.VINE_TURN_PASSWORD;
    delete process.env.VINE_TURN_PASSWORD;
    try {
      await expect(me.call("turn_server", { action: "set" })).rejects.toThrow(/give its `host` and the person's `username`/);
      await expect(me.call("turn_server", { action: "set", host: "turn.example.org" })).rejects.toThrow(/`username`/);
      expect(readTurn(me.dataDir)).toBeUndefined();
      expect(await me.call("turn_server", { action: "set", host: "turn.example.org", username: "sam" })).toMatchObject({ turn: "turn.example.org:3478 (udp)", username: "sam", password_store: "env" });
      expect(readTurn(me.dataDir)).toMatchObject({ host: "turn.example.org", username: "sam" });
      expect(await me.call("turn_server", { action: "clear" })).toMatchObject({ removed: true });
      expect(readTurn(me.dataDir)).toBeUndefined();
      expect(await me.call("turn_server", { action: "clear" })).toMatchObject({ removed: false });
      const tool = (await me.tools()).find((t) => t.name === "turn_server")!;
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/password|credential|secret/i);
    } finally {
      if (before !== undefined) process.env.VINE_TURN_PASSWORD = before;
    }
  });
});

describe("open_view: the contexts panel, the console, the explorer, or a browser link", () => {
  it("shows the view asked for, and tells the page which it is", async () => {
    const me = await agent("alice");
    await me.raw("add_claim", { text: "Shown in a view" });
    expect(await me.call("open_view")).toMatchObject({ view: "contexts", context: "main", snapshot: expect.any(Object), recent: expect.any(Array) });
    expect(await me.call("open_view", { view: "contexts" })).toMatchObject({ view: "contexts", context: "main" });
    expect(await me.call("open_view", { view: "console" })).toMatchObject({ view: "console", graph: "main", people: [expect.objectContaining({ name: "alice" })], you: { name_from: expect.any(String) } });
    const ex = await me.call("open_view", { view: "explorer", limit: 1 });
    expect(ex).toMatchObject({ view: "explorer", graph: "main", where: "your context 'main'" });
    expect(ex.nodes).toHaveLength(1);
    await expect(me.call("open_view", { view: "receipt" })).rejects.toThrow();
    // No browser page in this session: the option isn't offered.
    const tool = (await me.tools()).find((t) => t.name === "open_view")!;
    expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(["at", "context", "limit", "view"]);
  });

  it("with no context yet, the panel says how to choose one", async () => {
    const me = await agent("alice");
    await me.call("use_context", { mode: "remove" });
    expect(await me.call("open_view")).toMatchObject({ view: "contexts", context: null, your_contexts: ["main"] });
    expect(await me.call("recent", { activity: true })).toMatchObject({ context: null, your_contexts: ["main"] });
  });

  it("gives a browser link where the agent can't show views", async () => {
    let asked = 0;
    const me = await agent("alice", { browserView: async () => (asked++, "http://127.0.0.1:4999/#token=test") });
    const tool = (await me.tools()).find((t) => t.name === "open_view")!;
    expect(Object.keys(tool.inputSchema.properties!)).toContain("browser");
    expect(tool.description).toMatch(/pass `browser` for a link/);
    await me.call("open_view", { view: "console" });
    expect(asked).toBe(0); // the page is only started when asked for
    const r = await me.raw("open_view", { browser: true });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ url: "http://127.0.0.1:4999/#token=test", opened: false, note: expect.stringMatching(/Don't share it/) });
    expect(r.structuredContent).toMatchObject({ view: "browser", url: "http://127.0.0.1:4999/#token=test" });
    expect(asked).toBe(1);
  });
});
