// Host-side state that lives beside a graph, never inside it: where the local
// socket is, and which peers the host has approved.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../core/graph.js";

/** The local socket for a graph's host. Unix socket paths are limited to ~104 bytes, so long ones move to the temp folder. */
export function socketPath(dataDir: string, graph: string): string {
  if (process.platform === "win32") {
    const h = createHash("sha256").update(`${dataDir}\0${graph}`).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\p2pcg-${h}`;
  }
  const preferred = join(dataDir, "run", `${graph}.sock`);
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  const h = createHash("sha256").update(`${dataDir}\0${graph}`).digest("hex").slice(0, 16);
  return join(process.platform === "darwin" ? "/tmp" : tmpdir(), `p2pcg-${h}.sock`);
}

export function hostDir(dataDir: string, graph: string): string {
  const dir = join(dataDir, "hosts", graph);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface ApprovedPeer {
  name: string;
  key: string;
  role: Role;
  approved_at: string;
}

/** Peers the host approved, keyed by public key. Written atomically, readable only by the host's user. */
export class PeerStore {
  private file: string;
  private peers = new Map<string, ApprovedPeer>();

  constructor(dir: string) {
    this.file = join(dir, "peers.json");
    if (existsSync(this.file)) for (const p of JSON.parse(readFileSync(this.file, "utf8")) as ApprovedPeer[]) this.peers.set(p.key, p);
  }

  get(key: string): ApprovedPeer | undefined {
    return this.peers.get(key);
  }

  byName(name: string): ApprovedPeer | undefined {
    return [...this.peers.values()].find((p) => p.name === name);
  }

  all(): ApprovedPeer[] {
    return [...this.peers.values()];
  }

  put(p: ApprovedPeer): void {
    this.peers.set(p.key, p);
    this.save();
  }

  remove(key: string): boolean {
    const had = this.peers.delete(key);
    if (had) this.save();
    return had;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 1) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
