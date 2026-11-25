// Cloudflare Realtime TURN: the TURN server most people can set up in a few
// minutes, on their own Cloudflare account.
//
// A TURN key (an id and a secret) lives on this machine, in the OS keychain.
// It never goes to a member or into a link: at connect time the host asks
// Cloudflare for short-lived credentials with it, and gives those to WebRTC.
// The credentials are kept in memory only, until near expiry.
//
// Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/

import type { IceServer } from "node-datachannel";

export const CLOUDFLARE_RTC = "https://rtc.live.cloudflare.com/v1";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** Where a person creates a TURN key by hand. */
export const CLOUDFLARE_TURN_KEYS_PAGE = "https://dash.cloudflare.com/?to=/:account/calls";
/** Where a person makes an API token that may create TURN keys. */
export const CLOUDFLARE_TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
/** How long minted credentials last (seconds). */
export const CREDENTIAL_TTL = 12 * 3600;

export type Fetch = typeof fetch;

export interface MintedTurn {
  servers: IceServer[];
  username: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The URLs Cloudflare offered, for show. */
  urls: string[];
}

/** One of Cloudflare's TURN URLs, as node-datachannel takes it. Port 53 and plain STUN are left out. */
export function toIceServer(url: string, username: string, credential: string): IceServer | undefined {
  const m = /^(turns?):([^:?]+):(\d+)(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
  if (!m) return undefined;
  const [, scheme, hostname, portS, transport] = m;
  const port = Number(portS);
  if (port === 53) return undefined; // often blocked, and slow to time out
  const tls = scheme!.toLowerCase() === "turns";
  const relayType = tls ? "TurnTls" : (transport ?? "udp").toLowerCase() === "tcp" ? "TurnTcp" : "TurnUdp";
  return { hostname: hostname!, port, username, password: credential, relayType };
}

/**
 * The servers to give WebRTC: UDP first (fastest), then TLS on 443 (gets
 * through most firewalls), then the rest. A few are enough: each one is tried.
 */
export function pickServers(urls: string[], username: string, credential: string): IceServer[] {
  const all = urls.map((u) => toIceServer(u, username, credential)).filter((s): s is IceServer => Boolean(s));
  const rank = (s: IceServer) => (s.relayType === "TurnUdp" && s.port === 3478 ? 0 : s.relayType === "TurnTls" && s.port === 443 ? 1 : s.relayType === "TurnUdp" ? 2 : s.relayType === "TurnTcp" ? 3 : 4);
  return all.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

async function failure(r: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await r.json()) as any;
    const msgs = (body?.errors ?? []).map((e: any) => e?.message).filter(Boolean);
    detail = msgs.length ? `: ${msgs.join("; ")}` : "";
  } catch {
    // not JSON
  }
  const hint =
    r.status === 401 || r.status === 403
      ? " Cloudflare refused the key or token: check it was copied whole, and (for a token) that it has the Realtime or Calls Write permission."
      : r.status === 404
        ? " Cloudflare doesn't know that key id or account id."
        : "";
  return new Error(`${what} failed (HTTP ${r.status})${detail}.${hint}`);
}

/** Short-lived TURN credentials from a TURN key. The secret goes only in the Authorization header. */
export async function mintCredentials(keyId: string, secret: string, opts: { ttl?: number; fetch?: Fetch; now?: () => number } = {}): Promise<MintedTurn> {
  const f = opts.fetch ?? fetch;
  const ttl = opts.ttl ?? CREDENTIAL_TTL;
  const now = opts.now ?? Date.now;
  const r = await f(`${CLOUDFLARE_RTC}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw await failure(r, "Asking Cloudflare for TURN credentials");
  const body = (await r.json()) as any;
  const list: any[] = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers ? [body.iceServers] : [];
  const turn = list.find((s) => typeof s?.username === "string" && typeof s?.credential === "string");
  if (!turn) throw new Error("Cloudflare's answer had no TURN credentials in it.");
  const urls: string[] = (Array.isArray(turn.urls) ? turn.urls : [turn.urls]).filter((u: unknown): u is string => typeof u === "string");
  const servers = pickServers(urls, turn.username, turn.credential);
  if (!servers.length) throw new Error("Cloudflare's answer had no TURN server Vine can use.");
  return { servers, username: turn.username, expiresAt: now() + ttl * 1000, urls };
}

/** Revokes one minted credential (best effort; they expire anyway). */
export async function revokeCredentials(keyId: string, secret: string, username: string, f: Fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${CLOUDFLARE_RTC}/turn/keys/${encodeURIComponent(keyId)}/credentials/${encodeURIComponent(username)}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Creates a TURN key on the person's account with an API token. The token is used once and not kept. */
export async function createTurnKey(accountId: string, apiToken: string, name: string, f: Fetch = fetch): Promise<{ keyId: string; secret: string; name: string }> {
  const r = await f(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/calls/turn_keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw await failure(r, "Creating a TURN key");
  const body = (await r.json()) as any;
  const res = body?.result ?? body;
  if (typeof res?.uid !== "string" || typeof res?.secret !== "string") throw new Error("Cloudflare created no TURN key (its answer had no key id or secret).");
  return { keyId: res.uid, secret: res.secret, name: typeof res.name === "string" ? res.name : name };
}

/** A key id looks like 32 hex characters; a secret like 64. Loose checks, to catch a paste of the wrong thing. */
export const looksLikeKeyId = (s: string) => /^[A-Za-z0-9_-]{16,128}$/.test(s);
export const looksLikeSecret = (s: string) => /^[A-Za-z0-9_\-.=+/]{20,512}$/.test(s);
