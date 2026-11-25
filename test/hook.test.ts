// The agent hook (`vine hook`): what it tells a chat's agent about its context,
// and that other members' news reaches the agent once, whether the hook or the
// MCP server gets there first.

import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { hookOutput, hookText } from "../src/cli/hook.js";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { chatMarks, readNews } from "../src/host/news.js";
import { setFolderLink } from "../src/mcp/links.js";
import { Session } from "../src/mcp/server.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

process.env.VINE_AUTO_SHARE = "on";
const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const hosts: Host[] = [];
afterAll(() => hosts.forEach((h) => h.stop()));

async function agent(user: string, graph: string, chat: string) {
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
  const session = new Session({ local: () => open(graph), openLocal: open, identity: () => loadIdentity(dataDir, user), dataDir, signal, ice, joinWaitMs: 10_000, chat });
  await session.start();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await session.server.connect(a);
  const client = new Client({ name: `${user}-agent`, version: "1.0.0" });
  await client.connect(b);
  const texts = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as any).content.map((c: { text: string }) => c.text) as string[];
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await texts(name, args)).find((t) => !t.startsWith("News"))!);
  const hook = (event: "session-start" | "prompt", env: NodeJS.ProcessEnv = {}) => hookText({ event, input: { session_id: chat, cwd: dataDir }, dataDir, env });
  return { dataDir, chat, call, texts, hook, instructions: () => client.getInstructions() };
}

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("the agent hook", () => {
  it("tells a chat's agent what its context is for, then reminds it where the chat records", async () => {
    const a = await agent("alice", "launch", "chat-brief");
    await a.call("describe_context", { description: "Decisions about the spring launch" });
    await a.call("add_claim", { text: "The launch is on 3 March" });
    await waitFor(() => (a.hook("session-start") ?? "").includes("1 claim"));

    const start = a.hook("session-start")!;
    expect(start).toContain('this chat uses the shared context "launch" (only this machine\'s person so far)');
    expect(start).toContain("What it is for: Decisions about the spring launch");
    expect(start).toContain("1 claim and 0 questions have been recorded in it.");
    expect(start).toContain("add_claim and ask_question");

    // Beside a prompt: one line, not the briefing again.
    const prompt = a.hook("prompt")!;
    expect(prompt).toBe('Vine Context: this chat records to "launch". Decisions and open questions from this work that fit its purpose belong there (add_claim, ask_question).');
    expect(a.hook("prompt", { VINE_HOOKS: "quiet" })).toBeUndefined();
    expect(a.hook("prompt", { VINE_HOOKS: "off" })).toBeUndefined();
    expect(a.hook("session-start", { VINE_HOOKS: "off" })).toBeUndefined();

    // A session start tells it again (a compaction or resume lost the first telling).
    expect(a.hook("session-start")).toContain("What it is for");

    // The answer is in the shape Claude Code and Codex read.
    const out = JSON.parse(hookOutput({ event: "prompt", input: { session_id: a.chat, hook_event_name: "UserPromptSubmit" }, dataDir: a.dataDir, env: {} }));
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: prompt });
  });

  it("briefs a chat that picked up its context after the session started, and says nothing for a chat with none", async () => {
    const a = await agent("alice", "notes", "chat-late");
    const other = (chat: string, cwd: string) => hookText({ event: "prompt", input: { session_id: chat, cwd }, dataDir: a.dataDir, env: {} });

    // A chat this machine has never seen, in a folder with no context: nothing.
    expect(other("chat-unknown", "/nowhere/at/all")).toBeUndefined();
    expect(hookOutput({ event: "prompt", input: { session_id: "chat-unknown", cwd: "/nowhere/at/all" }, dataDir: a.dataDir, env: {} })).toBe("");

    // The first prompt of a chat with a context gets the briefing (no session start told it), the next the reminder.
    expect(a.hook("prompt")).toContain('this chat uses the shared context "notes"');
    expect(a.hook("prompt")).toMatch(/^Vine Context: this chat records to "notes"\./);

    // A new chat in a linked folder starts with the folder's context, as the MCP server does. Other agents' field names are read too.
    setFolderLink(a.dataDir, "/work/project", { contexts: [{ name: "notes" }] });
    expect(other("chat-in-folder", "/work/project/src")).toContain('this chat uses the shared context "notes"');
    expect(hookText({ event: "session-start", input: { conversationId: "chat-anti", workspacePaths: ["/work/project"] }, dataDir: a.dataDir, env: {} })).toContain('"notes"');
    expect(chatMarks(a.dataDir, "chat-anti").briefed).toEqual(["notes"]);
  });

  it("gives other members' news to the agent once: beside the prompt, or on a tool result, whichever comes first", async () => {
    const alice = await agent("alice", "team", "chat-alice");
    const bob = await agent("bob", "bobs-notes", "chat-bob");
    alice.hook("session-start");
    const shared = await alice.call("share_context", { label: "for Bob" });
    await bob.call("join_context", { code: shared.code });
    await alice.texts("context_info"); // the join notice, out of the way

    // Bob answers Alice's question: her agent hears it beside her next prompt, without calling a vine tool.
    const q = await alice.call("ask_question", { text: "Which venue is booked for the launch?" });
    await waitFor(async () => ((await bob.call("open_questions", { context: "team" })) as any[]).some((r) => r.id === q.id));
    await bob.call("add_claim", { text: "The town hall is booked for the launch", answers: [q.id], context: "team" });
    await waitFor(() => readNews(alice.dataDir, "team").length === 1);

    const told = alice.hook("prompt")!;
    expect(told).toContain('Vine Context, new from other members of "team":');
    expect(told).toMatch(/- bob answered your question .*The town hall is booked for the launch/);
    expect(told).toContain('this chat records to "team"');
    // Once: not beside the next prompt, and not on the MCP server's next tool result either.
    expect(alice.hook("prompt")).not.toContain("new from other members");
    expect((await alice.texts("context_info")).join("\n")).not.toContain("answered your question");

    // The other way round: the tool result gets there first, so the hook stays quiet.
    const q2 = await alice.call("ask_question", { text: "Who brings the projector?" });
    await waitFor(async () => ((await bob.call("open_questions", { context: "team" })) as any[]).some((r) => r.id === q2.id));
    await bob.call("add_claim", { text: "Bob brings the projector", answers: [q2.id], context: "team" });
    await waitFor(() => readNews(alice.dataDir, "team").length === 2);
    await waitFor(async () => (await alice.texts("context_info")).join("\n").includes("Bob brings the projector"));
    expect(alice.hook("prompt")).not.toContain("new from other members");

    // Bob's own chat isn't told about what Bob wrote.
    expect(bob.hook("prompt") ?? "").not.toContain("new from other members");
  });

  it("says in the server's first 512 characters when to record", async () => {
    const a = await agent("alice", "solo", "chat-instr");
    const head = a.instructions()!.slice(0, 512);
    expect(head).toContain("Use it during ordinary work, not only when asked");
    expect(head).toContain("add_claim, ask_question");
    expect(head.endsWith("what it is for. ")).toBe(true);
  });
});

describe("vine hook on the command line", () => {
  const cli = (args: string[], input: string, env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { input, encoding: "utf8", env: { ...process.env, ...env } });

  it("answers in JSON for a chat with a context, and never fails", async () => {
    const a = await agent("alice", "cli-notes", "chat-cli");
    const env = { VINE_DATA_DIR: a.dataDir, VINE_HOOKS: "" };
    const r = cli(["hook", "session-start"], JSON.stringify({ session_id: "chat-cli", cwd: a.dataDir, hook_event_name: "SessionStart" }), env);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain('"cli-notes"');

    // Nothing to say, bad input, a bad event: silent, and still exit 0 (a failing prompt hook can block the prompt).
    for (const [args, input] of [
      [["hook", "prompt"], JSON.stringify({ session_id: "nobody", cwd: "/nowhere" })],
      [["hook", "prompt"], "not json"],
      [["hook", "nonsense"], "{}"],
    ] as const) {
      const quiet = cli([...args], input, { ...env, CLAUDE_CODE_SESSION_ID: "", CODEX_SESSION_ID: "", VINE_CHAT: "", VINE_CONTEXT: "" });
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toBe("");
    }
  });

  it("the plugin's wrapper passes on only a real answer, whatever the installed vine does", () => {
    const wrapper = join("plugin", "hooks", "vine-hook.mjs");
    const fake = (script: string) => {
      const bin = tempDir();
      mkdirSync(bin, { recursive: true });
      const file = join(bin, "vine");
      writeFileSync(file, `#!/bin/sh\n${script}\n`);
      chmodSync(file, 0o755);
      return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
    };
    const run = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [wrapper, "prompt"], { input: "{}", encoding: "utf8", env });

    if (process.platform === "win32") return; // the stand-in vine is a shell script
    // An older vine with no `hook` command prints its usage and exits 2.
    expect(run(fake('echo "vine 0.1.0: usage"; exit 2'))).toBe("");
    // Usage printed with a clean exit is still not an answer.
    expect(run(fake('echo "Usage: vine <command>"'))).toBe("");
    // No vine at all.
    expect(execFileSync(process.execPath, [wrapper, "prompt"], { input: "{}", encoding: "utf8", env: { ...process.env, PATH: tempDir() } })).toBe("");
    // A real answer goes through, with the hook's stdin.
    const answer = '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"hi"}}';
    expect(run(fake(`cat >/dev/null; echo '${answer}'`)).trim()).toBe(answer);
  });
});
