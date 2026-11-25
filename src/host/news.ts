// What others' changes meant for this machine's person (the sync digest), kept
// on disk beside the context's host so anything on this machine can read it
// without a running host: `hosts/<context>/news.json`, the latest entries,
// newest last. The host is its only writer.
//
// Each chat keeps a marker of how far it has been told, per context, in
// `chats/<chat id>.json`. Two things deliver news to a chat's agent: the MCP
// server (in front of its next tool result) and the agent hook (`vine hook`,
// beside the person's next prompt). Both read and move the same marker, so an
// entry reaches the agent once.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NewsEntry {
  at: string;
  lines: string[];
}

const KEEP = 50;

const newsFile = (dataDir: string, graph: string) => join(dataDir, "hosts", graph, "news.json");

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The context's kept news, oldest first. */
export function readNews(dataDir: string, graph: string): NewsEntry[] {
  const raw = readJson(newsFile(dataDir, graph));
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is NewsEntry => Boolean(e) && typeof e.at === "string" && Array.isArray(e.lines) && e.lines.every((l: unknown) => typeof l === "string"),
  );
}

export function appendNews(dataDir: string, graph: string, entry: NewsEntry): void {
  writeJson(newsFile(dataDir, graph), [...readNews(dataDir, graph), entry].slice(-KEEP));
}

/** What a chat has been told so far. */
export interface ChatMarks {
  /** Per context: the `at` of the newest news entry its agent was given. */
  seen: Record<string, string>;
  /** The contexts whose purpose its agent has been told (by the hook). */
  briefed: string[];
}

// A chat's id is its agent's (a UUID from Claude Code or Codex); anything else is made safe for a file name.
const chatFile = (dataDir: string, chat: string) => join(dataDir, "chats", `${chat.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.json`);

export function chatMarks(dataDir: string, chat: string): ChatMarks {
  const raw = readJson(chatFile(dataDir, chat)) as Partial<ChatMarks> | undefined;
  const seen: Record<string, string> = {};
  if (raw?.seen && typeof raw.seen === "object") for (const [k, v] of Object.entries(raw.seen)) if (typeof v === "string") seen[k] = v;
  return { seen, briefed: Array.isArray(raw?.briefed) ? raw.briefed.filter((b): b is string => typeof b === "string") : [] };
}

/** Changes a chat's marks. A failed write is not an error: the worst case is news told twice. */
export function updateChatMarks(dataDir: string, chat: string, change: (m: ChatMarks) => void): void {
  const m = chatMarks(dataDir, chat);
  change(m);
  try {
    writeJson(chatFile(dataDir, chat), m);
  } catch {
    // read-only data folder: nothing to do
  }
}

/** The news a chat hasn't been told yet, oldest first. A chat with no marker for the context has none: it starts from now. */
export function unseenNews(dataDir: string, chat: string, graph: string): NewsEntry[] {
  const since = chatMarks(dataDir, chat).seen[graph];
  return since ? readNews(dataDir, graph).filter((e) => e.at > since) : [];
}

/** Moves the chat's marker for a context forward to `at` (never back). */
export function markSeen(dataDir: string, chat: string, graph: string, at: string): void {
  updateChatMarks(dataDir, chat, (m) => {
    if (!m.seen[graph] || m.seen[graph]! < at) m.seen[graph] = at;
  });
}
