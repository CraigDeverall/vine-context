// Join links and the cryptography around them.
//
//   p2pcg://join/<room>#<secret>
//
// The room (16 random bytes) names the signalling topic. The secret (32 random
// bytes) is in the #fragment and never leaves the joining machine: signalling
// is encrypted with a key derived from it, and a peer proves it holds it with
// an HMAC over the host's challenge before any other message is accepted.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const b64u = (b: Buffer) => b.toString("base64url");
export const unb64u = (s: string) => Buffer.from(s, "base64url");

export interface Link {
  room: string;
  secret: Buffer;
}

export function newLink(): Link {
  return { room: b64u(randomBytes(16)), secret: randomBytes(32) };
}

export function formatLink(l: Link): string {
  return `p2pcg://join/${l.room}#${b64u(l.secret)}`;
}

const LINK_RE = /p2pcg:\/\/join\/([A-Za-z0-9_-]{16,64})#([A-Za-z0-9_-]{32,128})/;

/** Finds a join link in text (it may be pasted with other words around it). */
export function parseLink(text: string): Link {
  const m = LINK_RE.exec(text.trim());
  if (!m) throw new Error("That is not a p2pcg join link. It looks like p2pcg://join/<room>#<secret>.");
  const secret = unb64u(m[2]!);
  if (secret.length !== 32) throw new Error("The link's secret is damaged: copy the whole link again.");
  return { room: m[1]!, secret };
}

export function roomKeys(l: Link): { tag: string; key: Buffer } {
  const tag = createHash("sha256").update(`p2pcg-room:${l.room}`).digest("hex").slice(0, 32);
  const key = Buffer.from(hkdfSync("sha256", l.secret, l.room, "p2pcg-signal-v1", 32));
  return { tag, key };
}

export function seal(key: Buffer, obj: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), body]));
}

/** Decrypts a sealed message, or returns null for anything not sealed with this key. */
export function unseal(key: Buffer, s: string): any | null {
  try {
    const raw = unb64u(s);
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString());
  } catch {
    return null;
  }
}

export function proof(secret: Buffer, nonce: string, peer: string): string {
  return b64u(createHmac("sha256", secret).update(`p2pcg-join-v1:${nonce}:${peer}`).digest());
}

export function checkProof(secret: Buffer, nonce: string, peer: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const want = unb64u(proof(secret, nonce, peer));
  const got = unb64u(given);
  return got.length === want.length && timingSafeEqual(got, want);
}
