// Does this network look like it needs a TURN server? A quick, read-only
// check, for `vine doctor` and `vine setup`.
//
// - STUN over UDP, to two servers from one socket. No answer from either:
//   UDP is blocked here (common on corporate networks and some guest Wi-Fi),
//   and direct connections won't work. Both answer but report different
//   public ports for the same socket: the NAT gives each destination its own
//   mapping ("symmetric"), which defeats direct connections to most peers.
// - The Nostr relays, which carry the handshakes: at least one must open.
//
// It decides "likely": two strict networks can still meet, a strict one often
// reaches an open one, and only one machine in a pair needs TURN.

import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import WebSocket from "ws";
import { DEFAULT_STUN } from "./ice.js";
import { relayList } from "./signal.js";

const MAGIC = 0x2112a442;

export function bindingRequest(txid: Buffer): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0); // Binding Request
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  txid.copy(b, 8);
  return b;
}

/** The public address in a STUN Binding success response, or undefined. */
export function parseBindingResponse(msg: Buffer, txid: Buffer): { address: string; port: number } | undefined {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || msg.readUInt32BE(4) !== MAGIC || !msg.subarray(8, 20).equals(txid)) return undefined;
  const len = msg.readUInt16BE(2);
  let off = 20;
  let mapped: { address: string; port: number } | undefined;
  while (off + 4 <= 20 + len && off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const alen = msg.readUInt16BE(off + 2);
    const v = msg.subarray(off + 4, off + 4 + alen);
    if ((type === 0x0020 || type === 0x0001) && v.length >= 8 && v[1] === 0x01) {
      const xor = type === 0x0020;
      const port = v.readUInt16BE(2) ^ (xor ? MAGIC >>> 16 : 0);
      const raw = v.readUInt32BE(4) ^ (xor ? MAGIC : 0);
      const address = [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join(".");
      if (xor) return { address, port }; // XOR-MAPPED-ADDRESS wins
      mapped = { address, port };
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return mapped;
}

/** "stun:host:port" → host and port. */
export function stunTarget(url: string): { host: string; port: number } | undefined {
  const m = /^stuns?:([^:?]+)(?::(\d+))?/i.exec(url.trim());
  return m ? { host: m[1]!, port: m[2] ? Number(m[2]) : 3478 } : undefined;
}

export interface StunAnswer {
  server: string;
  address?: string;
  port?: number;
  error?: string;
}

/** Asks each STUN server for this machine's public address, all from one UDP socket. */
export function probeStun(servers: string[] = DEFAULT_STUN, timeoutMs = 3000): Promise<StunAnswer[]> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const asks = servers.map((server) => ({ server, target: stunTarget(server), txid: randomBytes(12), answer: undefined as StunAnswer | undefined }));
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try {
        sock.close();
      } catch {
        // closed
      }
      resolve(asks.map((a) => a.answer ?? { server: a.server, error: a.target ? "no answer" : "not a stun: address" }));
    };
    sock.on("error", (e) => {
      for (const a of asks) a.answer ??= { server: a.server, error: e.message };
      finish();
    });
    sock.on("message", (msg) => {
      for (const a of asks) {
        if (a.answer) continue;
        const r = parseBindingResponse(msg, a.txid);
        if (r) a.answer = { server: a.server, ...r };
      }
      if (asks.every((a) => a.answer || !a.target)) finish();
    });
    sock.bind(0, () => {
      const send = () => {
        for (const a of asks) {
          if (a.answer || !a.target) continue;
          sock.send(bindingRequest(a.txid), a.target.port, a.target.host, (e) => {
            if (e && !a.answer) a.answer = { server: a.server, error: e.message };
          });
        }
      };
      // UDP drops packets: ask again a couple of times.
      for (const at of [0, 400, 1200]) timers.push(setTimeout(send, at));
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}

export interface RelayAnswer {
  relay: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

/** Opens a WebSocket to each relay, and closes it. */
export function probeRelays(relays: string[] = relayList(), timeoutMs = 5000): Promise<RelayAnswer[]> {
  return Promise.all(
    relays.map(
      (relay) =>
        new Promise<RelayAnswer>((resolve) => {
          const start = Date.now();
          let ws: WebSocket;
          let settled = false;
          const end = (r: RelayAnswer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              ws.terminate();
            } catch {
              // closed
            }
            resolve(r);
          };
          const timer = setTimeout(() => end({ relay, ok: false, error: "timed out" }), timeoutMs);
          try {
            ws = new WebSocket(relay, { handshakeTimeout: timeoutMs });
          } catch (e) {
            return end({ relay, ok: false, error: (e as Error).message });
          }
          ws.on("open", () => end({ relay, ok: true, ms: Date.now() - start }));
          ws.on("error", (e) => end({ relay, ok: false, error: e.message }));
        }),
    ),
  );
}

export type NatVerdict = "direct" | "public" | "symmetric" | "udp-blocked" | "unknown";

export interface NetCheck {
  stun: StunAnswer[];
  relays: RelayAnswer[];
  nat: NatVerdict;
  /** Whether this network looks like it needs TURN. */
  needsTurn: boolean;
  /** The relays that opened. */
  relaysUp: number;
  /** Plain words, one or two sentences. */
  summary: string;
}

const localAddresses = () =>
  new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter(Boolean)
      .map((i) => i!.address),
  );

/** The verdict from STUN answers alone. */
export function judgeNat(stun: StunAnswer[], local: Set<string> = localAddresses()): NatVerdict {
  const got = stun.filter((s) => s.address && s.port);
  if (!stun.length) return "unknown";
  if (!got.length) return "udp-blocked";
  if (got.length < 2) return got.some((s) => local.has(s.address!)) ? "public" : "direct";
  const first = got[0]!;
  if (got.some((s) => s.address !== first.address || s.port !== first.port)) return "symmetric";
  return local.has(first.address!) ? "public" : "direct";
}

export function describeNet(nat: NatVerdict, relaysUp: number, relays: number): { needsTurn: boolean; summary: string } {
  const needsTurn = nat === "udp-blocked" || nat === "symmetric";
  const net = {
    public: "This machine has a public address: direct connections should work.",
    direct: "STUN works and the NAT keeps one public address per connection: direct connections should work with most members.",
    symmetric:
      "The two STUN servers saw different public ports (a strict, \"symmetric\" NAT, common on corporate networks, VPNs and phone hotspots): direct connections will likely fail, so this network will likely need TURN.",
    "udp-blocked":
      "No STUN server answered over UDP, so UDP looks blocked here (common on corporate networks and guest Wi-Fi): direct connections won't work, so this network will need TURN.",
    unknown: "No STUN servers to ask, so the network wasn't checked.",
  }[nat];
  const rel =
    relaysUp === 0
      ? ` None of the ${relays} Nostr relays opened, so members can't find each other from here (check the network, or set VINE_RELAYS).`
      : ` ${relaysUp} of ${relays} Nostr relays opened, enough to find members.`;
  return { needsTurn, summary: net + rel };
}

/** Both checks at once. Read-only: nothing is sent but STUN requests and WebSocket opens. */
export async function checkNetwork(o: { stun?: string[]; relays?: string[]; timeoutMs?: number } = {}): Promise<NetCheck> {
  const [stun, relays] = await Promise.all([probeStun(o.stun, o.timeoutMs), probeRelays(o.relays, o.timeoutMs)]);
  const nat = judgeNat(stun);
  const relaysUp = relays.filter((r) => r.ok).length;
  return { stun, relays, nat, relaysUp, ...describeNet(nat, relaysUp, relays.length) };
}
