import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graph, type Caller } from "../src/core/graph.js";

export const tempDir = (prefix = "p2pcg-test-") => mkdtempSync(join(tmpdir(), prefix));

export const alice: Caller = { id: "alice", role: "contributor" };
export const bob: Caller = { id: "bob", role: "contributor" };
export const admin: Caller = { id: "root", role: "admin" };
export const reader: Caller = { id: "rita", role: "reader" };

let n = 0;
/** A fresh graph in its own data folder. */
export function openGraph(opts: { model?: string; dataDir?: string; name?: string } = {}) {
  return Graph.open({ dataDir: opts.dataDir ?? tempDir(), name: opts.name ?? `g${++n}`, model: opts.model });
}

/** Writes a pack folder from file contents and returns its path. */
export function writePack(files: Record<string, string>): string {
  const dir = tempDir("p2pcg-pack-");
  for (const [name, body] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}

export const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
