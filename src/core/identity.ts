// This install's identity: a display name and an Ed25519 key pair. Peers send
// their public key and sign the host's challenge with it, so a host that
// approved a key recognises it again in later sessions.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform, userInfo } from "node:os";
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

/** Where a display name came from, strongest first. */
export type NameSource = "VINE_USER" | "set_my_name" | "git" | "os" | "login" | "generated";

/**
 * Sources that are a guess rather than the person's own name: ask them for a
 * name instead of only offering to change it.
 */
export const isGuessedName = (source: NameSource): boolean => source === "login" || source === "generated";

/** The raw places a name can be found on this machine. Tests pass their own. */
export interface NameProbes {
  /** git's global user.name. */
  git(): string | undefined;
  /** The full name on the computer account. */
  os(): string | undefined;
  /** The login name. */
  login(): string | undefined;
}

const run = (cmd: string, args: string[]): string | undefined => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim() || undefined;
  } catch {
    return undefined;
  }
};

const login = (): string | undefined => {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined; // no passwd entry, as in some containers
  }
};

export const systemProbes: NameProbes = {
  git: () => run("git", ["config", "--global", "user.name"]),
  os: () => {
    if (platform() === "darwin") return run("id", ["-F"]);
    if (platform() === "win32") return undefined;
    const user = login();
    // The passwd entry's fifth field, up to its first comma, is the full name.
    return user ? run("getent", ["passwd", user])?.split(":")[4]?.split(",")[0] : undefined;
  },
  login,
};

/** Account names that say nothing about who someone is, and collide between machines. */
const GENERIC = new Set([
  "root", "admin", "administrator", "system administrator", "user", "guest", "owner", "default", "home", "dev", "developer", "test",
  "ubuntu", "debian", "fedora", "centos", "ec2-user", "ec2 default user", "cloud user", "azureuser", "runner", "codespace", "gitpod",
  "vscode", "node", "pi", "docker", "vagrant",
]);

/** A found name, cleaned to a valid display name; nothing if it is unusable or generic. */
function usable(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = raw.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 40).trim();
  return NAME_RE.test(n) && !GENERIC.has(n.toLowerCase()) ? n : undefined;
}

const ADJECTIVES = [
  "Amber", "Brisk", "Calm", "Clever", "Copper", "Dusty", "Early", "Fern", "Gentle", "Golden", "Hazel", "Ivory", "Jolly", "Keen", "Lively", "Mellow",
  "Misty", "Nimble", "Olive", "Plucky", "Quiet", "Rustic", "Sandy", "Silver", "Spry", "Steady", "Sunny", "Tidy", "Velvet", "Warm", "Wild", "Zesty",
];
const ANIMALS = [
  "Badger", "Bison", "Crane", "Dingo", "Egret", "Falcon", "Gecko", "Heron", "Ibis", "Jackal", "Kestrel", "Lemur", "Lynx", "Marten", "Newt", "Ocelot",
  "Osprey", "Otter", "Panda", "Puffin", "Quail", "Raven", "Robin", "Stoat", "Swift", "Tapir", "Thrush", "Vole", "Walrus", "Wombat", "Wren", "Yak",
];

/** A made-up name that is always the same for a key, for when nothing better is found. */
export function generatedName(publicKey: string): string {
  const h = createHash("sha256").update("vine-name-v1:").update(unb64u(publicKey)).digest();
  return `${ADJECTIVES[h[0]! % ADJECTIVES.length]} ${ANIMALS[h[1]! % ANIMALS.length]}`;
}

/**
 * Your display name in graphs and where it came from: VINE_USER, else the name
 * you set (set_my_name), else git's user.name, else the full name on your
 * computer account, else your login name, else a name made up from your key.
 */
export function resolveName(dataDir: string, probes: NameProbes = systemProbes): { name: string; source: NameSource } {
  if (process.env.VINE_USER) return { name: process.env.VINE_USER, source: "VINE_USER" };
  const stored = storedName(dataDir);
  if (stored) return { name: stored, source: "set_my_name" };
  for (const source of ["git", "os", "login"] as const) {
    const name = usable(probes[source]());
    if (name) return { name, source };
  }
  return { name: generatedName(storedKeys(dataDir).publicKey), source: "generated" };
}

export function defaultName(dataDir: string): string {
  return resolveName(dataDir).name;
}

/** Where the name comes from, for telling people how to change it. */
export function nameSource(dataDir: string): NameSource {
  return resolveName(dataDir).source;
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

/** This install's key pair from <dataDir>/identity.json, created on first use. */
function storedKeys(dataDir: string): { publicKey: string; privateKey: string } {
  const file = identityFile(dataDir);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const stored = { publicKey: b64u(raw), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(stored, null, 1) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return stored;
}

/** Loads this install's identity from <dataDir>/identity.json, creating it on first use. */
export function loadIdentity(dataDir: string, name = defaultName(dataDir)): Identity {
  const stored = storedKeys(dataDir);
  const key = createPrivateKey({ key: Buffer.from(stored.privateKey, "base64"), format: "der", type: "pkcs8" });
  return {
    name,
    publicKey: stored.publicKey,
    sign: (message) => b64u(sign(null, Buffer.from(message), key)),
  };
}
