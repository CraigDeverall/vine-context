// Changes: the unit of replication. Every write to a graph, and every change
// to who is in it, is one change, signed by its author's key. Each machine
// keeps every change it has seen (the log) and builds its Relate store from
// them; two machines with the same changes end up with the same graph.
//
// A change is made, applied locally at once, and (for writes) held on its
// author's machine for a few seconds so it can be taken back; only then is it
// numbered (`seq`), signed and sent. Each author numbers their own changes 1,
// 2, 3 … with no gaps, so "what I have" is one number per author.

import { randomBytes } from "node:crypto";
import type { Identity } from "./identity.js";
import { verifySignature } from "./identity.js";

export type Role = "reader" | "contributor" | "admin";
export const RANK: Record<Role, number> = { reader: 0, contributor: 1, admin: 2 };
export const ROLES: Role[] = ["reader", "contributor", "admin"];

/** Writes to the graph's content. */
export type DataKind = "claim" | "question" | "link" | "withdraw" | "import";
/** Changes to who is in the graph. */
export type MemberKind = "create" | "add_member" | "set_role" | "remove_member" | "rename";
export type Kind = DataKind | MemberKind;
export const DATA_KINDS = new Set<Kind>(["claim", "question", "link", "withdraw", "import"]);
export const MEMBER_KINDS = new Set<Kind>(["create", "add_member", "set_role", "remove_member", "rename"]);

export interface Change {
  /** UUIDv7: unique, and roughly time-ordered. */
  id: string;
  /** The graph's id: the id of its `create` change. Equal to `id` for the create change itself. */
  graph: string;
  kind: Kind;
  /** The author's Ed25519 public key (base64url). */
  author: string;
  /** The author's own counter, 1, 2, 3 … with no gaps. */
  seq: number;
  /** When it was made, ISO 8601. Machine clocks are assumed to be in sync. */
  at: string;
  body: Record<string, any>;
  /** Ed25519 signature over everything above (canonical JSON). */
  sig: string;
}

export type Unsigned = Omit<Change, "seq" | "sig">;

/** A time-ordered UUID (version 7). */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** JSON with object keys sorted at every level, so the same change always signs the same way. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

const signedText = (c: Omit<Change, "sig">) => `p2pcg-change-v1:${canonical({ ...c })}`;

export function signChange(c: Omit<Change, "sig">, identity: Identity): Change {
  if (c.author !== identity.publicKey) throw new Error("A change can only be signed by its author.");
  return { ...c, sig: identity.sign(signedText(c)) };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set<Kind>([...DATA_KINDS, ...MEMBER_KINDS]);

/** The shape and signature of a change, before anything about the graph is checked. */
export function wellFormed(c: unknown): c is Change {
  if (!c || typeof c !== "object") return false;
  const x = c as Change;
  if (typeof x.id !== "string" || !UUID.test(x.id)) return false;
  if (typeof x.graph !== "string" || !UUID.test(x.graph)) return false;
  if (!KINDS.has(x.kind)) return false;
  if (typeof x.author !== "string" || x.author.length !== 43) return false;
  if (!Number.isInteger(x.seq) || x.seq < 1) return false;
  if (typeof x.at !== "string" || !ISO.test(x.at) || Number.isNaN(Date.parse(x.at))) return false;
  if (!x.body || typeof x.body !== "object" || Array.isArray(x.body)) return false;
  const { sig, ...rest } = x;
  return verifySignature(x.author, signedText(rest), sig);
}

/** The order every machine applies changes in: time, then author, then the author's counter. */
export function compareChanges(a: Pick<Change, "at" | "author" | "seq">, b: Pick<Change, "at" | "author" | "seq">): number {
  const t = Date.parse(a.at) - Date.parse(b.at);
  if (t) return t;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return a.seq - b.seq;
}

/** How many changes from each author a machine has: what it tells the other side when they sync. */
export type Have = Record<string, number>;
