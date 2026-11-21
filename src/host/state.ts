// Host-side state that lives beside a graph, never inside it: where the local
// socket is, which peers the host has approved, and its invites.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../core/graph.js";
import { b64u, formatCode, unb64u, type Link } from "../p2p/link.js";

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
  /** When they first joined. */
  approved_at: string;
  /** The invite they first joined with. */
  invite?: string;
  /** What their install said about itself when they joined. */
  agent?: string;
  agent_version?: string;
  p2pcg?: string;
  platform?: string;
}

/** People let into the graph, keyed by public key. Written atomically, readable only by the host's user. */
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

/**
 * One join code. It works for one machine: the first key that uses it is let
 * in and bound to it, and from then on only that key gets in with it (that is
 * how the person rejoins in later sessions). An unused invite expires.
 */
export interface Invite {
  id: string;
  room: string;
  secret: string;
  label?: string;
  /** The role the person gets when they first join (default contributor). */
  role?: Role;
  created_at: string;
  /** Unused invites stop working after this; bound ones don't expire. */
  expires_at: string;
  bound?: { key: string; name: string; at: string };
  revoked?: { at: string; reason: string };
}

export type InviteState = "open" | "used" | "expired" | "revoked";

export const DEFAULT_INVITE_HOURS = 24;
const MAX_LIVE_INVITES = 50;
const KEEP_DEAD_MS = 7 * 24 * 3600_000;

export const inviteLink = (i: Invite): Link => ({ room: i.room, secret: unb64u(i.secret) });

export function inviteState(i: Invite, now = Date.now()): InviteState {
  if (i.revoked) return "revoked";
  if (i.bound) return "used";
  return Date.parse(i.expires_at) <= now ? "expired" : "open";
}

/** A live invite is one the host listens for: open, or bound to someone. */
export const isLive = (i: Invite, now = Date.now()) => ["open", "used"].includes(inviteState(i, now));

/** The host's invites, by id. Written atomically, readable only by the host's user. */
export class InviteStore {
  private file: string;
  private invites = new Map<string, Invite>();

  constructor(dir: string) {
    this.file = join(dir, "invites.json");
    if (existsSync(this.file)) for (const i of JSON.parse(readFileSync(this.file, "utf8")) as Invite[]) this.invites.set(i.id, i);
    // Forget invites that have been dead for a week.
    const cutoff = Date.now() - KEEP_DEAD_MS;
    let pruned = false;
    for (const i of this.invites.values()) {
      const deadSince = i.revoked ? Date.parse(i.revoked.at) : !i.bound ? Date.parse(i.expires_at) : Infinity;
      if (deadSince < cutoff) {
        this.invites.delete(i.id);
        pruned = true;
      }
    }
    if (pruned) this.save();
  }

  create(opts: { label?: string; role?: Role; hours?: number; now?: number } = {}): Invite {
    const now = opts.now ?? Date.now();
    if (this.live(now).length >= MAX_LIVE_INVITES) throw new Error(`There are already ${MAX_LIVE_INVITES} live invites. Revoke some first.`);
    const hours = opts.hours ?? DEFAULT_INVITE_HOURS;
    if (!(hours > 0 && hours <= 24 * 30)) throw new Error("An invite lasts between a few minutes and 30 days (expires_hours up to 720).");
    const room = b64u(randomBytes(16));
    const inv: Invite = {
      id: `inv_${room.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase()}`,
      room,
      secret: b64u(randomBytes(32)),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + hours * 3600_000).toISOString(),
    };
    this.invites.set(inv.id, inv);
    this.save();
    return inv;
  }

  get(id: string): Invite | undefined {
    return this.invites.get(id);
  }

  all(): Invite[] {
    return [...this.invites.values()];
  }

  live(now = Date.now()): Invite[] {
    return this.all().filter((i) => isLive(i, now));
  }

  bind(id: string, key: string, name: string): void {
    const i = this.invites.get(id);
    if (!i || i.bound) return;
    i.bound = { key, name, at: new Date().toISOString() };
    this.save();
  }

  revoke(id: string, reason: string): Invite | undefined {
    const i = this.invites.get(id);
    if (!i || i.revoked) return undefined;
    i.revoked = { at: new Date().toISOString(), reason };
    this.save();
    return i;
  }

  /** Revokes every invite bound to a key (the person was removed). */
  revokeForKey(key: string, reason: string): Invite[] {
    return this.all()
      .filter((i) => i.bound?.key === key && !i.revoked)
      .map((i) => this.revoke(i.id, reason)!);
  }

  summary(i: Invite, now = Date.now()) {
    const state = inviteState(i, now);
    return {
      id: i.id,
      label: i.label ?? null,
      role: i.role ?? "contributor",
      state,
      // The code is shown only while someone can still take it up.
      code: state === "open" ? formatCode(inviteLink(i)) : null,
      for: i.bound ? { name: i.bound.name, since: i.bound.at } : null,
      created_at: i.created_at,
      expires_at: i.bound ? null : i.expires_at,
      revoked: i.revoked ?? null,
    };
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 1) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
