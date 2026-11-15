// This install's identity: a display name and an Ed25519 key pair. Peers send
// their public key and sign the host's challenge with it, so a host that
// approved a key recognises it again in later sessions.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { b64u, unb64u } from "../p2p/link.js";

export interface Identity {
  name: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  sign(message: string): string;
}

export function defaultName(): string {
  return process.env.P2PCG_USER ?? userInfo().username;
}

/** A short, readable form of a public key, for people comparing keys. */
export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(unb64u(publicKey)).digest("hex").slice(0, 12).replace(/(.{4})(?!$)/g, "$1-");
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifySignature(publicKey: string, message: string, signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  try {
    const raw = unb64u(publicKey);
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, unb64u(signature));
  } catch {
    return false;
  }
}

/** Loads this install's identity from <dataDir>/identity.json, creating it on first use. */
export function loadIdentity(dataDir: string, name = defaultName()): Identity {
  const file = join(dataDir, "identity.json");
  let stored: { publicKey: string; privateKey: string };
  if (existsSync(file)) {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
    stored = { publicKey: b64u(raw), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(stored, null, 1) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const key = createPrivateKey({ key: Buffer.from(stored.privateKey, "base64"), format: "der", type: "pkcs8" });
  return {
    name,
    publicKey: stored.publicKey,
    sign: (message) => b64u(sign(null, Buffer.from(message), key)),
  };
}
