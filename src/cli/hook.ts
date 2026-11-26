// `vine hook <event>`: what an agent's lifecycle hook runs. It reads the hook's
// JSON from stdin (the chat's id and folder), and answers with text for the
// model's context:
//
//   session-start   what the chat's context is for, and that decisions and
//                   open questions from the chat belong in it
//   prompt          what other members' changes meant since the agent was last
//                   told (the sync digest), and a one-line reminder of where
//                   the chat records
//
// The agent then knows the context is there without first calling one of its
// tools. Everything is read from this machine's data folder: no host is
// started or asked, so it adds a few milliseconds to a prompt and works
// offline. It never fails a prompt: on any error it says nothing and exits 0.
//
// Claude Code and Codex share one hook format (and Gemini CLI's is the same):
// the answer is `{ hookSpecificOutput: { hookEventName, additionalContext } }`.
// The text states facts rather than giving orders: agents treat hook text that
// reads as commands with suspicion.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Change } from "../core/changes.js";
import { Members } from "../core/members.js";
import { defaultDataDir } from "../core/paths.js";
import { chatMarks, markSeen, unseenNews, updateChatMarks } from "../host/news.js";
import { chatIdFromEnv, chatLink, folderLink, resolveRef, type Ref } from "../mcp/links.js";

export type HookEvent = "session-start" | "prompt";

export interface HookOptions {
  event: HookEvent;
  /** The hook's stdin, parsed: field names differ by agent, so several are read. */
  input: Record<string, unknown>;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
}

const MAX_NEWS_LINES = 8;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const first = (v: unknown): string | undefined => (Array.isArray(v) ? str(v[0]) : undefined);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The chat's contexts on this machine (local names), and where its writes go. */
function chatContexts(o: HookOptions, chat: string | undefined, cwd: string): { names: string[]; writeTo?: string } {
  const env = o.env ?? process.env;
  const configured = env.VINE_CONTEXT ?? env.VINE_GRAPH;
  // The same order the MCP server uses: the chat's own, else its folder's, else the configured one.
  const link = (chat ? chatLink(o.dataDir, chat) : undefined) ?? folderLink(o.dataDir, cwd) ?? (configured ? { contexts: [{ name: configured } as Ref], write_to: configured } : undefined);
  if (!link) return { names: [] };
  const names: string[] = [];
  let writeTo: string | undefined;
  for (const ref of link.contexts) {
    const name = resolveRef(o.dataDir, ref);
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (ref.name === link.write_to) writeTo = name;
  }
  return { names, writeTo: writeTo ?? names[0] };
}

/** What a context is for and how much it holds, from its change log. */
function summary(dataDir: string, name: string): { description: string | null; members: number; claims: number; questions: number } {
  const file = join(dataDir, "hosts", name, "changes.jsonl");
  const changes: Change[] = [];
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        changes.push(JSON.parse(line) as Change);
      } catch {
        // a torn last line: skip it
      }
    }
  const members = new Members(changes);
  const ids = (kind: string) => new Set(changes.filter((c) => c.kind === kind).map((c) => c.id)).size;
  return { description: members.description, members: members.current().length, claims: ids("claim"), questions: ids("question") };
}

function briefing(dataDir: string, names: string[], writeTo: string | undefined): string {
  const lines: string[] = [];
  for (const name of names) {
    const s = summary(dataDir, name);
    const who = s.members > 1 ? `shared with ${plural(s.members - 1, "other member")}` : "only this machine's person so far";
    lines.push(`Vine Context: this chat uses the shared context "${name}" (${who}).`);
    lines.push(s.description ? `What it is for: ${s.description}` : "It has no description yet (update_context sets one).");
    lines.push(`${plural(s.claims, "claim")} and ${plural(s.questions, "question")} have been recorded in it.`);
  }
  if (names.length > 1 && writeTo) lines.push(`Writes from this chat go to "${writeTo}" unless a call names another.`);
  lines.push(
    "Decisions reached, facts established and questions left open in this chat that fit a context's purpose belong in it, so the other members' agents can use them: " +
      "the vine-context tools add_claim and ask_question record them (search first for what is already there; model_guide explains how).",
  );
  return lines.join("\n");
}

/** The text to add to the model's context, or nothing. */
export function hookText(o: HookOptions): string | undefined {
  const env = o.env ?? process.env;
  const mode = (env.VINE_HOOKS ?? "").toLowerCase();
  if (/^(0|off|false|no)$/.test(mode)) return undefined;
  const quiet = mode === "quiet";

  const i = o.input;
  const chat = str(i.session_id) ?? str(i.sessionId) ?? str(i.conversation_id) ?? str(i.conversationId) ?? chatIdFromEnv(env);
  const cwd = str(i.cwd) ?? first(i.workspace_roots) ?? first(i.workspacePaths) ?? str(i.workspaceRoot) ?? o.cwd ?? process.cwd();
  const { names, writeTo } = chatContexts(o, chat, cwd);
  if (!names.length) return undefined;
  const now = (o.now ?? new Date()).toISOString();

  const marks = chat ? chatMarks(o.dataDir, chat) : { seen: {}, briefed: [] };
  const parts: string[] = [];

  // What it's for: at the start of a session (and again after a compaction or a resume, when the earlier telling is gone), and for a context the chat picked up since.
  const unbriefed = o.event === "session-start" ? names : names.filter((n) => !marks.briefed.includes(n));
  if (unbriefed.length) parts.push(briefing(o.dataDir, o.event === "session-start" ? names : unbriefed, writeTo));

  if (o.event === "prompt" && chat) {
    let shown = 0;
    let more = 0;
    for (const name of names) {
      const fresh = unseenNews(o.dataDir, chat, name);
      if (!fresh.length) continue;
      const lines = fresh.flatMap((e) => e.lines);
      const room = Math.max(0, MAX_NEWS_LINES - shown);
      if (room) parts.push([`Vine Context, new from other members of "${name}":`, ...lines.slice(0, room).map((l) => `- ${l}`)].join("\n"));
      shown += Math.min(room, lines.length);
      more += Math.max(0, lines.length - room);
      markSeen(o.dataDir, chat, name, fresh.at(-1)!.at);
    }
    if (more) parts.push(`…and ${more} more (the recent tool lists them).`);
  }

  if (o.event === "prompt" && !unbriefed.length && !quiet && writeTo) {
    parts.push(`Vine Context: this chat records to "${writeTo}". Decisions and open questions from this work that fit its purpose belong there (add_claim, ask_question).`);
  }

  if (chat) {
    updateChatMarks(o.dataDir, chat, (m) => {
      // A chat is told news from when it first has the context, not the context's whole past.
      for (const n of names) m.seen[n] ??= now;
      for (const n of unbriefed) if (!m.briefed.includes(n)) m.briefed.push(n);
    });
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

const EVENT_NAMES: Record<HookEvent, string> = { "session-start": "SessionStart", prompt: "UserPromptSubmit" };

/** The hook's stdout: the text in the shape Claude Code, Codex and Gemini CLI read. Empty when there is nothing to say. */
export function hookOutput(o: HookOptions): string {
  const text = hookText(o);
  if (!text) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: str(o.input.hook_event_name) ?? EVENT_NAMES[o.event], additionalContext: text } });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function hookCommand(args: string[]): Promise<number> {
  const event = args[0];
  if (event !== "session-start" && event !== "prompt") {
    console.error("Usage: vine hook session-start|prompt  (reads the agent's hook JSON on stdin)");
    return 0; // never a failing hook: a non-zero exit can block the person's prompt
  }
  try {
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readStdin());
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      // no stdin, or not JSON: the chat's id may still come from the environment
    }
    const out = hookOutput({ event, input, dataDir: defaultDataDir() });
    if (out) process.stdout.write(out + "\n");
  } catch {
    // say nothing
  }
  return 0;
}
