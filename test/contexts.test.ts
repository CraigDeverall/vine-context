// Several contexts in one conversation, context descriptions, and a folder's
// `.p2p-context` file attaching contexts to every new conversation there.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

/** One person's machine: its contexts' hosts, and conversations started in a folder. */
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
  const conversation = async (cwd?: string, first = "main") => {
    const session = new Session({ local: () => open(first), openLocal: open, dataDir, cwd, identity: () => loadIdentity(dataDir, user), signal, ice });
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
      if (r.structuredContent && name !== "add_claim" && name !== "ask_question") return r.structuredContent;
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    };
    const tools = async () => (await client.listTools()).tools;
    return { call, raw, tools, client };
  };
  return { dataDir, conversation, host: (name: string) => started.get(name)! };
}

describe("several contexts in one conversation", () => {
  it("routes writes to the named or write context, reads across all, and says which context each result is from", async () => {
    const me = machine("alice");
    const chat = await me.conversation();
    await chat.call("use_context", { name: "incident", description: "The checkout slowdown of 10 Nov: findings and open questions" });
    await chat.call("use_context", { name: "infra", description: "How our infrastructure is set up: hosts, networks, deploys" });
    await chat.call("attach_context", { name: "incident", write_here: true });
    const info = await chat.call("context_info");
    expect(info.attached.map((c: any) => [c.context, c.writes_here, c.description])).toEqual([
      ["infra", false, "How our infrastructure is set up: hosts, networks, deploys"],
      ["incident", true, "The checkout slowdown of 10 Nov: findings and open questions"],
    ]);
    expect(info.write_to).toBe("incident");

    // The write tools tell the agent where writes go and what each context is for.
    const add = (await chat.tools()).find((t) => t.name === "add_claim")!;
    expect(add.description).toMatch(/Attached contexts: 'infra': How our infrastructure[\s\S]*'incident' \(writes go here by default\)/);
    expect(add.inputSchema.properties).toHaveProperty("context");

    // A write without `context` goes to the write context; with it, to that one.
    const a = await chat.raw("add_claim", { text: "Checkout p95 rose to 4 s at 13:58" });
    expect(a.content.at(-1).text).toMatch(/^\(in your context 'incident'\)/);
    expect(a.structuredContent.context).toBe("incident");
    const b = await chat.raw("add_claim", { text: "The checkout service runs on three nodes behind the gateway", context: "infra" });
    expect(b.structuredContent.context).toBe("infra");

    // Reads search both, each row saying its context; `context` narrows to one.
    const rows = await chat.call("search", { query: "checkout" });
    expect(rows.map((r: any) => r.context).sort()).toEqual(["incident", "infra"]);
    expect((await chat.call("search", { query: "checkout", context: "infra" })).map((r: any) => r.context)).toEqual(["infra"]);
    // An id lives in one context: history finds it there.
    const h = await chat.raw("history", { id: b.structuredContent.result.id });
    expect(h.content.at(-1).text).toMatch(/from your context 'infra'/);

    // The guide lists the contexts; detaching leaves the other.
    expect(await chat.call("model_guide")).toMatch(/## Several contexts[\s\S]*'incident' \(writes go here by default\)/);
    await chat.call("detach_context", { name: "infra" });
    expect((await chat.call("context_info")).attached.map((c: any) => c.context)).toEqual(["incident"]);
    await expect(chat.call("detach_context", { name: "incident" })).rejects.toThrow(/only context attached/);
  });

  it("lets an admin describe a context, and asks for a description when there's none", async () => {
    const me = machine("alice");
    const chat = await me.conversation();
    const made = await chat.call("use_context", { name: "planning" });
    expect(made.next ?? "").toBe(made.next); // a new context without a description says to ask for one when it shares
    const d = await chat.call("describe_context", { description: "  Planning the Q1 roadmap:   priorities and decisions  " });
    expect(d).toEqual({ context: "planning", description: "Planning the Q1 roadmap: priorities and decisions" });
    expect((await chat.call("context_info")).attached[0].description).toBe("Planning the Q1 roadmap: priorities and decisions");
    expect((await chat.call("context_activity")).recent[0].summary).toMatch(/^described the context: Planning the Q1 roadmap/);
  });
});

describe("a folder's .p2p-context", () => {
  it("attaches the folder's contexts to every new conversation there, finding them by id, and says which are missing", async () => {
    const me = machine("alice");
    const project = tempDir("p2pcg-project-");
    const setup = await me.conversation(project);
    await setup.call("use_context", { name: "team", description: "What the team knows" });
    await setup.call("use_context", { name: "notes", description: "My own notes" });
    await setup.call("attach_context", { name: "team", write_here: true });
    const saved = await setup.call("save_folder_contexts");
    expect(saved.wrote).toBe(join(project, ".p2p-context"));
    const file = JSON.parse(readFileSync(saved.wrote, "utf8"));
    expect(file).toMatchObject({ contexts: [{ name: "notes", id: expect.any(String) }, { name: "team", id: expect.any(String) }], write_to: "team" });

    // A new conversation in a subfolder starts with them.
    const sub = join(project, "src");
    mkdirSync(sub);
    const later = await me.conversation(sub);
    const info = await later.call("context_info");
    expect(info.attached.map((c: any) => c.context)).toEqual(["notes", "team"]);
    expect(info.write_to).toBe("team");
    expect(info.folder.file).toBe(saved.wrote);

    // A context the file names that isn't on this machine: the agent is told to ask for a code.
    writeFileSync(saved.wrote, JSON.stringify({ ...file, contexts: [...file.contexts, { name: "elsewhere", id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000" }] }));
    const third = await me.conversation(project);
    const r = await third.raw("context_info");
    expect(r.content[0].text).toMatch(/News: this folder's \.p2p-context asks for the context 'elsewhere'.*join code/);
    expect(JSON.parse(r.content[1].text).folder.missing).toEqual([{ name: "elsewhere", id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000" }]);
  });

  it("starts on the default context where there is no file", async () => {
    const me = machine("alice");
    const chat = await me.conversation(tempDir("p2pcg-empty-"));
    expect((await chat.call("context_info")).attached.map((c: any) => c.context)).toEqual(["main"]);
    expect(existsSync(join(me.dataDir, "graphs", "main"))).toBe(true);
  });
});
