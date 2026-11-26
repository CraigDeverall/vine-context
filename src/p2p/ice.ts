// The STUN and TURN servers WebRTC links use.
//
// STUN servers only tell a machine its public address; two public ones are the
// default. A TURN server carries the data between two machines that can't
// reach each other directly (strict NAT). There is none by default: a person
// who needs one sets it with `vine turn set` (or the turn_server tool),
// and it is kept in <data dir>/network.json for every Vine process on the
// machine. Each new link reads it, so a running host picks up a change.
//
// Or the TURN server is Cloudflare's (`vine turn set --provider cloudflare`):
// then this machine keeps a TURN key in its keychain, and mints short-lived
// credentials from it at connect time (see cloudflare.ts). They're held in
// memory until near expiry, and minted again on the next connection after.
//
// VINE_ICE, when set, replaces all of this with its own list.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodeDataChannel, { type IceServer } from "node-datachannel";
import { keychainDelete, keychainGet, keychainSet, type SecretStore } from "../core/secret.js";
import { mintCredentials, type MintedTurn } from "./cloudflare.js";

export const DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
export const TURN_PASSWORD_ENV = "VINE_TURN_PASSWORD";
/** Where a Cloudflare TURN key's secret is read from, when it was set with --store env. */
export const CLOUDFLARE_SECRET_ENV = "VINE_CLOUDFLARE_TURN_SECRET";
/** Mint again when credentials have less than this left. */
const REFRESH_BEFORE_MS = 3600_000;
/** After a failed mint, wait this long before trying again. */
const RETRY_AFTER_MS = 30_000;
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

/** Cloudflare Realtime TURN: a key whose secret is in the keychain (or an env var), never in network.json. */
export interface CloudflareTurnSetting {
  provider: "cloudflare";
  keyId: string;
  store: "keychain" | "env";
  /** The key's name on the account, for show. */
  name?: string;
}

export type AnyTurnSetting = TurnSetting | CloudflareTurnSetting;

/** What a PeerConnection is given. */
export interface IceConfig {
  servers: (string | IceServer)[];
  /** "relay": use only a TURN server's addresses (tests, and `vine turn test`). */
  policy?: "all" | "relay";
}

/**
 * Read for each new link, so a changed setting is picked up. A plain list is
 * fixed. A function may carry `prepare`, awaited before a link is made (to
 * fetch credentials that are minted, not stored).
 */
export type IceSource = (string | IceServer)[] | ((() => IceConfig) & { prepare?: () => Promise<void> });

/** Gets the source ready for a new link. Never throws: a link without TURN is still worth trying. */
export async function prepareIce(ice: IceSource): Promise<void> {
  if (typeof ice !== "function" || !ice.prepare) return;
  try {
    await ice.prepare();
  } catch {
    // resolveIce reports the problem
  }
}

/** What status shows. It never holds a password. */
export interface IceSummary {
  stun: string[];
  /** "host:port (udp)", or null when there's none. */
  turn: string | null;
  /** Where the list came from: the defaults, `vine turn set`, or VINE_ICE. */
  source: "default" | "setting" | "env";
  /** Whose TURN server, when one is set: Cloudflare's (minted credentials) or one of your own. */
  provider?: "cloudflare" | "custom";
  /** When the minted credentials run out (Cloudflare), ISO. */
  expires?: string;
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

function validCloudflare(t: any): t is CloudflareTurnSetting {
  return Boolean(t) && t.provider === "cloudflare" && typeof t.keyId === "string" && t.keyId !== "" && ["keychain", "env"].includes(t.store);
}

function valid(t: any): t is TurnSetting {
  return (
    t &&
    t.provider === undefined &&
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

/** The stored TURN setting of either kind, without looking up any secret. */
export function readTurnSetting(dataDir: string): AnyTurnSetting | undefined {
  try {
    const t = JSON.parse(readFileSync(networkFile(dataDir), "utf8")).turn;
    return valid(t) || validCloudflare(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The stored TURN server of your own (not Cloudflare's), without looking up its password. */
export function readTurn(dataDir: string): TurnSetting | undefined {
  const t = readTurnSetting(dataDir);
  return t && !isCloudflare(t) ? t : undefined;
}

export const isCloudflare = (t: AnyTurnSetting | undefined): t is CloudflareTurnSetting => (t as CloudflareTurnSetting | undefined)?.provider === "cloudflare";

/** The stored Cloudflare TURN key, if that's the setting. */
export function readCloudflare(dataDir: string): CloudflareTurnSetting | undefined {
  const t = readTurnSetting(dataDir);
  return isCloudflare(t) ? t : undefined;
}

const cfAccount = (t: Pick<CloudflareTurnSetting, "keyId">) => `cloudflare:${t.keyId}`;
const keychainAccount = (t: AnyTurnSetting) => (isCloudflare(t) ? cfAccount(t) : account(t));

/** Removes the keychain entry of the setting that was there before, unless the new one uses the same entry. */
function dropOldSecret(before: AnyTurnSetting | undefined, now: AnyTurnSetting) {
  if (before?.store !== "keychain") return;
  if (now.store === "keychain" && keychainAccount(before) === keychainAccount(now)) return;
  keychainDelete(KEYCHAIN_SERVICE, keychainAccount(before));
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

  const before = readTurnSetting(dataDir);
  if (store === "keychain") keychainSet(KEYCHAIN_SERVICE, account(t), input.password!);
  if (store === "file") t.password = input.password;
  dropOldSecret(before, t);
  write(dataDir, { turn: t });
  minted.delete(dataDir);
  return t;
}

export interface CloudflareInput {
  keyId: string;
  /** The key's secret. Required for the keychain store; refused for env. */
  secret?: string;
  store?: "keychain" | "env";
  name?: string;
}

/**
 * Saves a Cloudflare TURN key as this machine's TURN server, replacing any
 * other. The secret goes to the OS keychain (or nowhere, with env); never
 * into network.json.
 */
export function saveCloudflareTurn(dataDir: string, input: CloudflareInput): CloudflareTurnSetting {
  const store = input.store ?? "keychain";
  const t: CloudflareTurnSetting = { provider: "cloudflare", keyId: input.keyId.trim(), store, ...(input.name ? { name: input.name } : {}) };
  if (!validCloudflare(t)) throw new Error("A Cloudflare TURN key needs its key id, and the keychain or env store.");
  if (store === "env") {
    if (input.secret !== undefined) throw new Error(`With the env store the secret isn't saved: set ${CLOUDFLARE_SECRET_ENV} where Vine runs, and give no secret here.`);
  } else if (!input.secret) throw new Error("The TURN key's secret is needed.");
  const before = readTurnSetting(dataDir);
  if (store === "keychain") keychainSet(KEYCHAIN_SERVICE, cfAccount(t), input.secret!);
  dropOldSecret(before, t);
  write(dataDir, { turn: t });
  minted.delete(dataDir);
  return t;
}

/** Forgets the TURN server (and its password, wherever it was kept). True if there was one. */
export function clearTurn(dataDir: string): boolean {
  const before = readTurnSetting(dataDir);
  if (before?.store === "keychain") keychainDelete(KEYCHAIN_SERVICE, keychainAccount(before));
  minted.delete(dataDir);
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

function fromKeychain(dataDir: string, acct: string): string | undefined {
  let stamp = "";
  try {
    const s = statSync(networkFile(dataDir));
    stamp = `${s.mtimeMs}:${s.size}:${acct}`;
  } catch {
    // just read
  }
  let hit = keychainCache.get(dataDir);
  if (!hit || hit.stamp !== stamp || hit.password === undefined) {
    hit = { stamp, password: keychainGet(KEYCHAIN_SERVICE, acct) };
    keychainCache.set(dataDir, hit);
  }
  return hit.password;
}

function turnPassword(dataDir: string, t: TurnSetting): { password?: string; problem?: string } {
  if (t.store === "file") return t.password ? { password: t.password } : { problem: "its password is missing from network.json" };
  if (t.store === "env") {
    const p = process.env[TURN_PASSWORD_ENV];
    return p ? { password: p } : { problem: `${TURN_PASSWORD_ENV} isn't set where this is running` };
  }
  const password = fromKeychain(dataDir, account(t));
  return password ? { password } : { problem: "its password wasn't found in the keychain" };
}

function cloudflareSecret(dataDir: string, t: CloudflareTurnSetting): { secret?: string; problem?: string } {
  if (t.store === "env") {
    const s = process.env[CLOUDFLARE_SECRET_ENV];
    return s ? { secret: s } : { problem: `${CLOUDFLARE_SECRET_ENV} isn't set where this is running` };
  }
  const secret = fromKeychain(dataDir, cfAccount(t));
  return secret ? { secret } : { problem: "the TURN key's secret wasn't found in the keychain (run `vine setup` or `vine turn set --provider cloudflare` again)" };
}

// ---- Minted credentials (Cloudflare) ------------------------------------

interface MintState {
  /** Which key these are for: a changed setting starts over. */
  key: string;
  creds?: MintedTurn;
  inflight?: Promise<void>;
  failedAt?: number;
  error?: string;
}

/** Per data folder, in memory only. */
const minted = new Map<string, MintState>();

const usable = (m: MintState | undefined, now = Date.now()) => (m?.creds && m.creds.expiresAt - now > 60_000 ? m.creds : undefined);
const fresh = (m: MintState | undefined, now = Date.now()) => Boolean(m?.creds && m.creds.expiresAt - now > REFRESH_BEFORE_MS);

/**
 * Mints Cloudflare credentials when there are none, or they're near expiry.
 * One request at a time per data folder; a failure waits a little before the
 * next try (unless forced). Does nothing for other settings.
 */
export async function refreshIce(dataDir: string, opts: { force?: boolean } = {}): Promise<void> {
  if (process.env.VINE_ICE !== undefined) return;
  const t = readCloudflare(dataDir);
  if (!t) return;
  const key = `${t.keyId}:${t.store}`;
  let m = minted.get(dataDir);
  if (!m || m.key !== key) {
    m = { key };
    minted.set(dataDir, m);
  }
  const state = m;
  if (state.inflight) return state.inflight;
  const now = Date.now();
  if (!opts.force && fresh(state, now)) return;
  if (!opts.force && state.failedAt && now - state.failedAt < RETRY_AFTER_MS) return;
  const { secret, problem } = cloudflareSecret(dataDir, t);
  if (!secret) {
    state.failedAt = now;
    state.error = problem;
    return;
  }
  state.inflight = mintCredentials(t.keyId, secret)
    .then((creds) => {
      state.creds = creds;
      state.failedAt = undefined;
      state.error = undefined;
    })
    .catch((e: Error) => {
      state.failedAt = Date.now();
      state.error = e.message;
    })
    .finally(() => {
      state.inflight = undefined;
    });
  return state.inflight;
}

/** Forgets minted credentials (tests, and a changed setting). */
export function forgetMinted(dataDir?: string): void {
  if (dataDir === undefined) minted.clear();
  else minted.delete(dataDir);
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
  const any = readTurnSetting(dataDir);
  if (!any) return { config: { servers: DEFAULT_STUN }, summary: { stun: DEFAULT_STUN, turn: null, source: "default" } };
  if (isCloudflare(any)) {
    const m = minted.get(dataDir);
    const creds = m?.key === `${any.keyId}:${any.store}` ? usable(m) : undefined;
    // Stale or missing: start minting for the next link (prepare waits for it; this doesn't).
    if (!fresh(m)) void refreshIce(dataDir);
    const problem = creds ? undefined : (m?.error ?? cloudflareSecret(dataDir, any).problem ?? "no credentials fetched yet");
    return {
      config: { servers: creds ? [...DEFAULT_STUN, ...creds.servers] : DEFAULT_STUN },
      summary: {
        stun: DEFAULT_STUN,
        turn: CLOUDFLARE_LABEL,
        source: "setting",
        provider: "cloudflare",
        ...(creds ? { expires: new Date(creds.expiresAt).toISOString() } : {}),
        ...(problem ? { problem } : {}),
      },
    };
  }
  const { password, problem } = turnPassword(dataDir, any);
  return {
    config: { servers: password ? [...DEFAULT_STUN, turnServer(any, password)] : DEFAULT_STUN },
    summary: { stun: DEFAULT_STUN, turn: label(any), source: "setting", provider: "custom", ...(problem ? { problem } : {}) },
  };
}

export const CLOUDFLARE_LABEL = "Cloudflare Realtime TURN (turn.cloudflare.com)";

/** The setting as a live source: each new link reads it, after minting credentials if they're due. */
export const storedIce = (dataDir: string): IceSource => Object.assign(() => resolveIce(dataDir).config, { prepare: () => refreshIce(dataDir) });

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

/** Checks the stored TURN server. For Cloudflare, mints fresh credentials and tries each server it gave. */
export async function checkStoredTurn(dataDir: string, timeoutMs?: number, check: typeof checkTurn = checkTurn): Promise<TurnCheck & { turn: string | null }> {
  const any = readTurnSetting(dataDir);
  if (!any) return { ok: false, turn: null, error: "No TURN server is set." };
  if (isCloudflare(any)) {
    await refreshIce(dataDir, { force: true });
    const m = minted.get(dataDir);
    const creds = usable(m);
    if (!creds) return { ok: false, turn: CLOUDFLARE_LABEL, error: `Couldn't get TURN credentials from Cloudflare: ${m?.error ?? cloudflareSecret(dataDir, any).problem ?? "no answer"}.` };
    let last: TurnCheck = { ok: false, error: "Cloudflare gave no TURN server." };
    for (const s of creds.servers) {
      last = await check(s, timeoutMs);
      if (last.ok) break;
    }
    return { turn: CLOUDFLARE_LABEL, ...last };
  }
  const t = any;
  const { password, problem } = turnPassword(dataDir, t);
  if (!password) return { ok: false, turn: label(t), error: `The TURN server can't be used: ${problem}.` };
  return { turn: label(t), ...(await check(turnServer(t, password), timeoutMs)) };
}
