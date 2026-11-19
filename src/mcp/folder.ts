// `.p2p-context`: the contexts a folder's conversations start with.
//
// A JSON file in a project folder (or any parent of it):
//
//   {
//     "contexts": [
//       { "name": "team", "id": "0193…" },
//       { "name": "incident-42", "id": "0194…" }
//     ],
//     "write_to": "team"
//   }
//
// Every new conversation started in that folder attaches those contexts, and
// writes go to `write_to` unless a call names another. A context is found by
// its id first (the same context can sit under another name on a teammate's
// machine), then by name. The file holds no secrets, so it can be committed.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { readGroup } from "../host/host.js";

export const FOLDER_FILE = ".p2p-context";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface FolderEntry {
  name: string;
  id?: string;
}

export interface FolderConfig {
  file: string;
  contexts: FolderEntry[];
  write_to?: string;
}

/** The nearest `.p2p-context`, from `start` up to the filesystem root. */
export function findFolderFile(start: string): string | undefined {
  let dir = start;
  const root = parse(dir).root;
  for (;;) {
    const f = join(dir, FOLDER_FILE);
    if (existsSync(f)) return f;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

export function readFolderFile(file: string): FolderConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  const r = raw as { contexts?: unknown; write_to?: unknown };
  const list = Array.isArray(r.contexts) ? r.contexts : [];
  const contexts: FolderEntry[] = [];
  for (const c of list) {
    if (typeof c === "string" && NAME_RE.test(c)) contexts.push({ name: c });
    else if (c && typeof c === "object" && typeof (c as FolderEntry).name === "string" && NAME_RE.test((c as FolderEntry).name))
      contexts.push({ name: (c as FolderEntry).name, ...(typeof (c as FolderEntry).id === "string" ? { id: (c as FolderEntry).id } : {}) });
  }
  return { file, contexts, ...(typeof r.write_to === "string" ? { write_to: r.write_to } : {}) };
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

/**
 * Which local contexts a folder file names: found (with the local name to
 * attach), and missing (not on this machine: ask a member for a join code).
 */
export function resolveFolder(cfg: FolderConfig, dataDir: string): { found: { entry: FolderEntry; local: string }[]; missing: FolderEntry[]; write_to?: string } {
  const here = localContexts(dataDir);
  const found: { entry: FolderEntry; local: string }[] = [];
  const missing: FolderEntry[] = [];
  for (const entry of cfg.contexts) {
    const byId = entry.id ? here.find((c) => c.id === entry.id) : undefined;
    const byName = !entry.id ? here.find((c) => c.name === entry.name) : undefined;
    const hit = byId ?? byName;
    if (hit) found.push({ entry, local: hit.name });
    else missing.push(entry);
  }
  const w = cfg.write_to ? found.find((f) => f.entry.name === cfg.write_to || f.local === cfg.write_to)?.local : undefined;
  return { found, missing, ...(w ? { write_to: w } : {}) };
}

export function writeFolderFile(dir: string, contexts: FolderEntry[], write_to?: string): string {
  const file = join(dir, FOLDER_FILE);
  writeFileSync(file, JSON.stringify({ contexts, ...(write_to ? { write_to } : {}) }, null, 2) + "\n");
  return file;
}
