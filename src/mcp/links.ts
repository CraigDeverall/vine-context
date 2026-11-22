// Which contexts each chat uses (usually one), and (optionally) which new
// chats in a folder start with. Kept in this machine's data folder,
// `links.json`, so nothing is written into project folders:
//
//   {
//     "chats":   { "<chat id>": { "contexts": [{ "name": "team", "id": "0193…" }], "write_to": "team", "at": "…" } },
//     "folders": { "/Users/me/project": { "contexts": [{ "name": "team", "id": "0193…" }], "at": "…" } }
//   }
//
// (A link written before chats could hold several, `{ name, id, at }`, reads
// as one context.)
//
// A chat's id comes from its agent (Claude Code's session id), so reopening
// the chat brings back its context. A context is found by its id first (it
// may have been renamed on this machine), then by name.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { readGroup } from "../host/host.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Ref {
  name: string;
  id?: string;
}

export interface Link {
  contexts: Ref[];
  write_to?: string;
  at: string;
}

type Stored = Link | (Ref & { at: string });

interface Links {
  chats: Record<string, Stored>;
  folders: Record<string, Stored>;
}

/** A stored link, read the same whether it's from before several contexts per chat or not. */
function asLink(x: Stored | undefined): Link | undefined {
  if (!x) return undefined;
  if ("contexts" in x && Array.isArray(x.contexts)) return x;
  const r = x as Ref & { at: string };
  return typeof r.name === "string" ? { contexts: [{ name: r.name, ...(r.id ? { id: r.id } : {}) }], at: r.at } : undefined;
}

/** The chat's id, as its agent gives it: VINE_CHAT, else Claude Code's session id. */
export function chatIdFromEnv(env = process.env): string | undefined {
  return env.VINE_CHAT || env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || undefined;
}

/** The contexts on this machine, by local name, with their ids. */
export function localContexts(dataDir: string): { name: string; id?: string }[] {
  const dir = join(dataDir, "graphs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => NAME_RE.test(n))
    .sort()
    .map((name) => ({ name, id: readGroup(dataDir, name)?.id }));
}

const file = (dataDir: string) => join(dataDir, "links.json");

function load(dataDir: string): Links {
  try {
    const raw = JSON.parse(readFileSync(file(dataDir), "utf8")) as Partial<Links>;
    return { chats: raw.chats ?? {}, folders: raw.folders ?? {} };
  } catch {
    return { chats: {}, folders: {} };
  }
}

function save(dataDir: string, links: Links): void {
  mkdirSync(dataDir, { recursive: true });
  const f = file(dataDir);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(links, null, 1) + "\n");
  renameSync(tmp, f);
}

/** The local name of a context: by id first, then by name; undefined if it isn't on this machine. */
export function resolveRef(dataDir: string, ref: Ref): string | undefined {
  const here = localContexts(dataDir);
  return (ref.id ? here.find((c) => c.id === ref.id) : undefined)?.name ?? here.find((c) => c.name === ref.name && (!ref.id || !c.id))?.name;
}

export function chatLink(dataDir: string, chat: string): Link | undefined {
  return asLink(load(dataDir).chats[chat]);
}

export function setChatLink(dataDir: string, chat: string, link: Omit<Link, "at"> | null): void {
  const links = load(dataDir);
  if (link) links.chats[chat] = { ...link, at: new Date().toISOString() };
  else delete links.chats[chat];
  save(dataDir, links);
}

/** The folder link nearest `start` (it or a parent), with the folder it's on. */
export function folderLink(dataDir: string, start: string): (Link & { folder: string }) | undefined {
  const folders = load(dataDir).folders;
  let dir = resolve(start);
  const root = parse(dir).root;
  for (;;) {
    const hit = asLink(folders[dir]);
    if (hit) return { ...hit, folder: dir };
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

export function setFolderLink(dataDir: string, folder: string, link: Omit<Link, "at"> | null): void {
  const links = load(dataDir);
  const dir = resolve(folder);
  if (link) links.folders[dir] = { ...link, at: new Date().toISOString() };
  else delete links.folders[dir];
  save(dataDir, links);
}

/** Takes a deleted context out of every chat's and folder's link (a link left with none goes too). */
export function forgetContext(dataDir: string, name: string, id?: string): void {
  const links = load(dataDir);
  const is = (r: Ref) => (id && r.id ? r.id === id : r.name === name);
  const prune = (all: Record<string, Stored>) => {
    for (const [k, v] of Object.entries(all)) {
      const l = asLink(v);
      if (!l || !l.contexts.some(is)) continue;
      const contexts = l.contexts.filter((r) => !is(r));
      if (!contexts.length) delete all[k];
      else all[k] = { contexts, ...(l.write_to && contexts.some((r) => r.name === l.write_to) ? { write_to: l.write_to } : {}), at: l.at };
    }
  };
  prune(links.chats);
  prune(links.folders);
  save(dataDir, links);
}
