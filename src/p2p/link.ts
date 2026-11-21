// Join codes and the cryptography around them.
//
//   vine1_<room>.<secret>
//
// Each invite has its own code. The room (16 random bytes) names the
// signalling topic and tells the host which invite is being used. The secret
// (32 random bytes) never leaves the two machines: signalling is encrypted with
// a key derived from it, and a peer proves it holds it with an HMAC over the
// host's challenge before any other message is accepted. The "1" is the format
// version; "vine2_" is kept for a later format (short code words).

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

export const CODE_PREFIX = "vine1_";

export function formatCode(l: Link): string {
  return `${CODE_PREFIX}${l.room}.${b64u(l.secret)}`;
}

const CODE_RE = /(?<![A-Za-z0-9_-])vine1_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;
const DAMAGED_RE = /vine1_[A-Za-z0-9_.-]*/;

/** Finds a join code in text (it may be pasted with other words around it). */
export function parseCode(text: string): Link {
  const t = text.trim();
  const m = CODE_RE.exec(t);
  if (m) {
    const secret = unb64u(m[2]!);
    if (b64u(unb64u(m[1]!)) === m[1] && unb64u(m[1]!).length === 16 && secret.length === 32 && b64u(secret) === m[2]) return { room: m[1]!, secret };
  }
  if (m || DAMAGED_RE.test(t)) throw new Error("That join code is damaged or cut short: copy the whole code (vine1_ then two parts joined by a dot) again.");
  throw new Error("That is not a Vine Context join code. It looks like vine1_<room>.<secret>.");
}

export function roomKeys(l: Link): { tag: string; key: Buffer } {
  const tag = createHash("sha256").update(`vine-room:${l.room}`).digest("hex").slice(0, 32);
  const key = Buffer.from(hkdfSync("sha256", l.secret, l.room, "vine-signal-v1", 32));
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
  return b64u(createHmac("sha256", secret).update(`vine-join-v1:${nonce}:${peer}`).digest());
}

export function checkProof(secret: Buffer, nonce: string, peer: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const want = unb64u(proof(secret, nonce, peer));
  const got = unb64u(given);
  return got.length === want.length && timingSafeEqual(got, want);
}
