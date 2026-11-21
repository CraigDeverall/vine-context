// This install's identity: a display name and an Ed25519 key pair. Peers send
// their public key and sign the host's challenge with it, so a host that
// approved a key recognises it again in later sessions.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { b64u, unb64u } from "../p2p/link.js";

export interface Identity {
  name: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  sign(message: string): string;
}

/** What a display name may be: 1–40 letters, digits, spaces, dots, dashes or underscores. */
export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

const identityFile = (dataDir: string) => join(dataDir, "identity.json");

function storedName(dataDir: string): string | undefined {
  try {
    const n = JSON.parse(readFileSync(identityFile(dataDir), "utf8")).name;
    return typeof n === "string" && NAME_RE.test(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** git's user.name, cleaned to a valid display name, if git has one. */
function gitName(): string | undefined {
  try {
    const raw = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    const n = raw.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 40).trim();
    return NAME_RE.test(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Your display name in graphs: P2PCG_USER, else the name you set (set_my_name),
 * else git's user.name, else your login name.
 */
export function defaultName(dataDir?: string): string {
  return process.env.P2PCG_USER ?? (dataDir && storedName(dataDir)) ?? gitName() ?? userInfo().username;
}

/** Where the name comes from, for telling people how to change it. */
export function nameSource(dataDir: string): "P2PCG_USER" | "set_my_name" | "git" | "login" {
  if (process.env.P2PCG_USER) return "P2PCG_USER";
  if (storedName(dataDir)) return "set_my_name";
  return gitName() ? "git" : "login";
}

/** Saves your display name with your key. */
export function setName(dataDir: string, name: string): string {
  const n = name.trim();
  if (!NAME_RE.test(n)) throw new Error("Names are 1–40 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.");
  loadIdentity(dataDir, n); // creates the key if this is the first use
  const file = identityFile(dataDir);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...stored, name: n }, null, 1) + "\n", { mode: 0o600 });
  return n;
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
export function loadIdentity(dataDir: string, name = defaultName(dataDir)): Identity {
  const file = identityFile(dataDir);
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
