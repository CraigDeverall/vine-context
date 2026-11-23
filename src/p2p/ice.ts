// The STUN and TURN servers WebRTC links use.
//
// STUN servers only tell a machine its public address; two public ones are the
// default. A TURN server carries the data between two machines that can't
// reach each other directly (strict NAT). There is none by default: a person
// who needs one sets it with `vine turn set` (or the set_turn_server tool),
// and it is kept in <data dir>/network.json for every Vine process on the
// machine. Each new link reads it, so a running host picks up a change.
//
// VINE_ICE, when set, replaces all of this with its own list.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodeDataChannel, { type IceServer } from "node-datachannel";
import { keychainDelete, keychainGet, keychainSet, type SecretStore } from "../core/secret.js";

export const DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
export const TURN_PASSWORD_ENV = "VINE_TURN_PASSWORD";
const KEYCHAIN_SERVICE = "vine-context-turn";

export type TurnTransport = "udp" | "tcp" | "tls";
export const TURN_TRANSPORTS: TurnTransport[] = ["udp", "tcp", "tls"];

export interface TurnSetting {
  host: string;
  port: number;
  username: string;
  transport: TurnTransport;
  store: SecretStore;
  /** Only with store "file". */
  password?: string;
}

/** What a PeerConnection is given. */
export interface IceConfig {
  servers: (string | IceServer)[];
  /** "relay": use only a TURN server's addresses (tests, and `vine turn test`). */
  policy?: "all" | "relay";
}

/** Read for each new link, so a changed setting is picked up. A plain list is fixed. */
export type IceSource = (string | IceServer)[] | (() => IceConfig);

/** What status shows. It never holds a password. */
export interface IceSummary {
  stun: string[];
  /** "host:port (udp)", or null when there's none. */
  turn: string | null;
  /** Where the list came from: the defaults, `vine turn set`, or VINE_ICE. */
  source: "default" | "setting" | "env";
  /** Why a TURN server that is set can't be used, if so. */
  problem?: string;
}

export function rtcConfig(ice: IceSource): { iceServers: (string | IceServer)[]; iceTransportPolicy?: "all" | "relay" } {
  const c = typeof ice === "function" ? ice() : { servers: ice };
  return { iceServers: c.servers, ...(c.policy ? { iceTransportPolicy: c.policy } : {}) };
}

const networkFile = (dataDir: string) => join(dataDir, "network.json");
const account = (t: Pick<TurnSetting, "host" | "port" | "username">) => `${t.username}@${t.host}:${t.port}`;
const label = (t: Pick<TurnSetting, "host" | "port" | "transport">) => `${t.host}:${t.port} (${t.transport})`;

function valid(t: any): t is TurnSetting {
  return (
    t &&
    typeof t.host === "string" &&
    t.host !== "" &&
    Number.isInteger(t.port) &&
    t.port > 0 &&
    t.port < 65536 &&
    typeof t.username === "string" &&
    TURN_TRANSPORTS.includes(t.transport) &&
    ["file", "keychain", "env"].includes(t.store)
  );
}

/** The stored TURN server, without looking up its password. */
export function readTurn(dataDir: string): TurnSetting | undefined {
  try {
    const t = JSON.parse(readFileSync(networkFile(dataDir), "utf8")).turn;
    return valid(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

export interface TurnInput {
  host: string;
  port?: number;
  username: string;
  transport?: TurnTransport;
  store?: SecretStore;
  /** Required for the file and keychain stores; refused for env. */
  password?: string;
}

/** "turn.example.org" or "turn.example.org:3478" (or "[::1]:3478"). */
export function parseHostPort(s: string): { host: string; port?: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:\s]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error(`"${s}" isn't a server address. Give a host name, or host:port.`);
  return { host: m[1]!, ...(m[2] ? { port: Number(m[2]) } : {}) };
}

/** Saves the TURN server for this machine, replacing any other. */
export function saveTurn(dataDir: string, input: TurnInput): TurnSetting {
  const transport = input.transport ?? "udp";
  const store = input.store ?? "file";
  const t: TurnSetting = {
    host: input.host.trim(),
    port: input.port ?? (transport === "tls" ? 5349 : 3478),
    username: input.username,
    transport,
    store,
  };
  if (!valid(t)) throw new Error("A TURN server needs a host, a port from 1 to 65535, and a username.");
  if (store === "env") {
    if (input.password !== undefined) throw new Error(`With the env store the password isn't saved: set ${TURN_PASSWORD_ENV} where Vine runs, and give no password here.`);
  } else if (!input.password) throw new Error("A password is needed.");

  const before = readTurn(dataDir);
  if (store === "keychain") keychainSet(KEYCHAIN_SERVICE, account(t), input.password!);
  if (store === "file") t.password = input.password;
  if (before?.store === "keychain" && (store !== "keychain" || account(before) !== account(t))) keychainDelete(KEYCHAIN_SERVICE, account(before));
  write(dataDir, { turn: t });
  return t;
}

/** Forgets the TURN server (and its password, wherever it was kept). True if there was one. */
export function clearTurn(dataDir: string): boolean {
  const before = readTurn(dataDir);
  if (before?.store === "keychain") keychainDelete(KEYCHAIN_SERVICE, account(before));
  try {
    rmSync(networkFile(dataDir));
  } catch {
    // none
  }
  return before !== undefined;
}

function write(dataDir: string, value: unknown) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = networkFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** VINE_ICE entries with any "user:pass@" taken out, for status. */
const redact = (s: string) => s.replace(/^(turns?:)[^@]*@/i, "$1");

interface Resolved {
  config: IceConfig;
  summary: IceSummary;
}

// The keychain is a subprocess call: look the password up once per saved setting, not once per link.
const keychainCache = new Map<string, { stamp: string; password: string | undefined }>();

function turnPassword(dataDir: string, t: TurnSetting): { password?: string; problem?: string } {
  if (t.store === "file") return t.password ? { password: t.password } : { problem: "its password is missing from network.json" };
  if (t.store === "env") {
    const p = process.env[TURN_PASSWORD_ENV];
    return p ? { password: p } : { problem: `${TURN_PASSWORD_ENV} isn't set where this is running` };
  }
  let stamp = "";
  try {
    const s = statSync(networkFile(dataDir));
    stamp = `${s.mtimeMs}:${s.size}:${account(t)}`;
  } catch {
    // just read
  }
  let hit = keychainCache.get(dataDir);
  if (!hit || hit.stamp !== stamp || hit.password === undefined) {
    hit = { stamp, password: keychainGet(KEYCHAIN_SERVICE, account(t)) };
    keychainCache.set(dataDir, hit);
  }
  return hit.password ? { password: hit.password } : { problem: "its password wasn't found in the keychain" };
}

const relayType = { udp: "TurnUdp", tcp: "TurnTcp", tls: "TurnTls" } as const;

export function turnServer(t: TurnSetting, password: string): IceServer {
  return { hostname: t.host, port: t.port, username: t.username, password, relayType: relayType[t.transport] };
}

/** The servers to use now, and what to show about them. */
export function resolveIce(dataDir: string): Resolved {
  const env = process.env.VINE_ICE;
  if (env !== undefined) {
    const list = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const turn = list.filter((s) => /^turns?:/i.test(s)).map(redact);
    return {
      config: { servers: list },
      summary: { stun: list.filter((s) => !/^turns?:/i.test(s)), turn: turn.length ? turn.join(", ") : null, source: "env" },
    };
  }
  const t = readTurn(dataDir);
  if (!t) return { config: { servers: DEFAULT_STUN }, summary: { stun: DEFAULT_STUN, turn: null, source: "default" } };
  const { password, problem } = turnPassword(dataDir, t);
  return {
    config: { servers: password ? [...DEFAULT_STUN, turnServer(t, password)] : DEFAULT_STUN },
    summary: { stun: DEFAULT_STUN, turn: label(t), source: "setting", ...(problem ? { problem } : {}) },
  };
}

/** The setting as a live source: each new link reads it. */
export const storedIce =
  (dataDir: string): IceSource =>
  () =>
    resolveIce(dataDir).config;

export interface TurnCheck {
  ok: boolean;
  /** The address the server lent, when ok. */
  relay?: string;
  error?: string;
}

/**
 * Asks the TURN server for a relay address, using nothing else. Getting one
 * proves the host, port, username and password. It doesn't prove the server
 * will carry data to a particular member.
 */
export function checkTurn(server: IceServer, timeoutMs = 10_000): Promise<TurnCheck> {
  return new Promise((resolve) => {
    let done = false;
    const pc = new nodeDataChannel.PeerConnection("vine-turn-check", { iceServers: [server], iceTransportPolicy: "relay" });
    const finish = (r: TurnCheck) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // already closed
      }
      resolve(r);
    };
    const none = "The server gave no relay address. Check the host, port, username and password, and that the server is reachable.";
    const timer = setTimeout(() => finish({ ok: false, error: none }), timeoutMs);
    pc.onLocalCandidate((candidate) => {
      const m = /^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ relay/.exec(candidate);
      if (m) finish({ ok: true, relay: `${m[1]}:${m[2]}` });
    });
    pc.onGatheringStateChange((s) => {
      // Candidates are reported before "complete": give the last one a moment.
      if (s === "complete") setTimeout(() => finish({ ok: false, error: none }), 50);
    });
    try {
      pc.createDataChannel("probe");
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
    }
  });
}

/** Checks the stored TURN server. */
export async function checkStoredTurn(dataDir: string, timeoutMs?: number): Promise<TurnCheck & { turn: string | null }> {
  const t = readTurn(dataDir);
  if (!t) return { ok: false, turn: null, error: "No TURN server is set." };
  const { password, problem } = turnPassword(dataDir, t);
  if (!password) return { ok: false, turn: label(t), error: `The TURN server can't be used: ${problem}.` };
  return { turn: label(t), ...(await checkTurn(turnServer(t, password), timeoutMs)) };
}
