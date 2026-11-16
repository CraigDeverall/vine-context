// A minimal Nostr relay client for signalling: publish ephemeral events and
// subscribe by tag, across several relays, with per-relay timeouts and
// reconnects. nostr-tools is used only to sign (finalizeEvent).
//
// A host runs for hours, through sleeps and network drops, so each relay is
// pinged; one that stops answering is dropped and reconnected, forever, with
// the wait between tries capped. A connection that dies without closing
// (common after a sleep) would otherwise look open while hearing nothing.
//
// Why not nostr-tools' SimplePool: in nostr-tools 2.26 a failed relay
// connection overflows the stack (spike A, 2026-11-15).

import WebSocket from "ws";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";

type Handler = (ev: Event) => void;

export class RelaySet {
  private sockets = new Map<string, WebSocket>();
  private subs = new Map<string, { filter: Filter; handler: Handler }>();
  private waiting = new Map<string, Map<string, (ok: boolean) => void>>();
  private seen = new Set<string>();
  private closed = false;
  private sk = generateSecretKey();
  readonly status = new Map<string, "connecting" | "open" | "down">();

  constructor(
    private relays: string[],
    private timeoutMs = 4000,
    private keepalive: { pingMs: number; maxWaitMs: number } = { pingMs: 30_000, maxWaitMs: 60_000 },
  ) {
    for (const url of relays) this.connect(url, 0);
  }

  private connect(url: string, attempt: number) {
    if (this.closed) return;
    this.status.set(url, "connecting");
    const ws = new WebSocket(url, { handshakeTimeout: this.timeoutMs });
    this.sockets.set(url, ws);
    let alive = true;
    let ping: NodeJS.Timeout | undefined;
    ws.on("pong", () => (alive = true));
    ws.on("open", () => {
      attempt = 0;
      this.status.set(url, "open");
      for (const [id, s] of this.subs) ws.send(JSON.stringify(["REQ", id, s.filter]));
      ping = setInterval(() => {
        if (!alive) return ws.terminate(); // no pong since the last ping: dead
        alive = false;
        ws.ping();
      }, this.keepalive.pingMs);
      ping.unref();
    });
    ws.on("message", (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg[0] === "EVENT") {
        const ev = msg[2] as Event;
        if (this.seen.has(ev.id)) return;
        this.seen.add(ev.id);
        this.subs.get(msg[1] as string)?.handler(ev);
      } else if (msg[0] === "OK") {
        this.waiting.get(url)?.get(msg[1] as string)?.(msg[2] === true);
      }
    });
    let gone = false;
    const down = () => {
      // "error" and "close" both arrive for one failure; act once, and only for the current socket.
      if (gone) return;
      gone = true;
      clearInterval(ping);
      ws.removeAllListeners("message");
      if (this.sockets.get(url) !== ws) return;
      this.status.set(url, "down");
      for (const resolve of this.waiting.get(url)?.values() ?? []) resolve(false);
      if (this.closed) return;
      const wait = Math.min(500 * 2 ** attempt, this.keepalive.maxWaitMs);
      setTimeout(() => this.connect(url, attempt + 1), wait).unref();
    };
    ws.on("error", down);
    ws.on("close", down);
  }

  subscribe(filter: Filter, handler: Handler): string {
    const id = Math.random().toString(36).slice(2, 10);
    this.subs.set(id, { filter, handler });
    for (const ws of this.sockets.values())
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["REQ", id, filter]));
    return id;
  }

  /** Publish to every relay. Resolves as soon as one relay accepts, or with 0 when all fail or time out. */
  publish(template: { kind: number; tags: string[][]; content: string }): Promise<number> {
    const ev = finalizeEvent({ ...template, created_at: Math.floor(Date.now() / 1000) }, this.sk);
    return new Promise((resolve) => {
      let pending = this.relays.length;
      let accepted = 0;
      const settle = (ok: boolean) => {
        if (ok && ++accepted === 1) resolve(1);
        if (--pending === 0 && accepted === 0) resolve(0);
      };
      for (const url of this.relays) {
        const ws = this.sockets.get(url);
        const send = () => {
          const map = this.waiting.get(url) ?? new Map();
          this.waiting.set(url, map);
          const timer = setTimeout(() => done(false), this.timeoutMs);
          const done = (ok: boolean) => {
            clearTimeout(timer);
            if (map.delete(ev.id)) settle(ok);
          };
          map.set(ev.id, done);
          ws!.send(JSON.stringify(["EVENT", ev]));
        };
        if (ws?.readyState === WebSocket.OPEN) send();
        else if (ws?.readyState === WebSocket.CONNECTING) {
          const t = setTimeout(() => settle(false), this.timeoutMs);
          ws.once("open", () => (clearTimeout(t), send()));
          ws.once("error", () => (clearTimeout(t), settle(false)));
        } else settle(false);
      }
    });
  }

  close() {
    this.closed = true;
    for (const ws of this.sockets.values()) {
      ws.on("error", () => undefined); // terminating a connecting socket emits an error
      ws.terminate();
    }
  }
}
