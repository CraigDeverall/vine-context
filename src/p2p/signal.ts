// Signalling: how a host and a joining peer exchange WebRTC offers and answers.
//
// Messages are sealed with the link's key and published on a topic named by a
// hash of the room, so a relay sees neither the secret nor the contents.
// Production uses public Nostr relays; tests use an in-process bus.

import { EventEmitter } from "node:events";
import { RelaySet } from "./nostr.js";
import { roomKeys, seal, unseal, type Link } from "./link.js";

export interface Signaller {
  /** Resolves true once at least one relay accepted the message. */
  send(message: unknown): Promise<boolean>;
  close(): void;
}

export type SignalFactory = (link: Link, onMessage: (m: any) => void) => Signaller;

export const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://offchain.pub",
  "wss://relay.snort.social",
  "wss://relay.nostr.net",
  "wss://nos.lol",
];

const KIND = 25050; // ephemeral: relays forward it but don't store it

export function relayList(): string[] {
  const env = process.env.P2PCG_RELAYS;
  return env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_RELAYS;
}

export const nostrSignaller: SignalFactory = (link, onMessage) => {
  const { tag, key } = roomKeys(link);
  const relays = new RelaySet(relayList());
  relays.subscribe({ kinds: [KIND], "#t": [tag], since: Math.floor(Date.now() / 1000) - 10 }, (ev) => {
    const m = unseal(key, ev.content);
    if (m) onMessage(m);
  });
  return {
    send: async (m) => (await relays.publish({ kind: KIND, tags: [["t", tag]], content: seal(key, m) })) > 0,
    close: () => relays.close(),
  };
};

/** An in-process signalling bus, for tests: the same sealing, no network. */
export function memorySignaller(bus = new EventEmitter()): SignalFactory {
  bus.setMaxListeners(100);
  return (link, onMessage) => {
    const { tag, key } = roomKeys(link);
    const listener = (content: string) => {
      const m = unseal(key, content);
      if (m) onMessage(m);
    };
    bus.on(tag, listener);
    return {
      send: async (m) => {
        const content = seal(key, m);
        setImmediate(() => bus.emit(tag, content));
        return true;
      },
      close: () => bus.off(tag, listener),
    };
  };
}

/** STUN/TURN servers. P2PCG_ICE takes a comma-separated list, e.g. turn:user:pass@host:3478. */
export function iceServers(): string[] {
  const env = process.env.P2PCG_ICE;
  if (env !== undefined) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
}
