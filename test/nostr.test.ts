// The relay client survives what a long-running host meets: a relay that
// stops answering without closing (as after a sleep), and a relay that keeps
// dropping. It reconnects every time, and subscribes again each time.

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { RelaySet } from "../src/p2p/nostr.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

/** A local relay that records connections and the subscriptions sent on each. */
async function relay(opts: { autoPong?: boolean; onConnect?: (ws: WebSocket, n: number) => void } = {}) {
  const wss = new WebSocketServer({ port: 0, autoPong: opts.autoPong ?? true });
  await new Promise((r) => wss.once("listening", r));
  const seen = { connections: 0, reqs: 0 };
  wss.on("connection", (ws) => {
    const n = ++seen.connections;
    ws.on("message", (d) => {
      if (JSON.parse(String(d))[0] === "REQ") seen.reqs++;
    });
    opts.onConnect?.(ws, n);
  });
  cleanup.push(() => wss.close());
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, seen, wss };
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("RelaySet", () => {
  it("drops a relay that stops answering pings, reconnects, and subscribes again", async () => {
    // The first connection never answers pings (a dead link that never closed); later ones do.
    const r = await relay({ autoPong: false, onConnect: (ws, n) => n > 1 && ws.on("ping", (d) => ws.pong(d)) });
    const set = new RelaySet([r.url], 1000, { pingMs: 100, maxWaitMs: 50 });
    cleanup.push(() => set.close());
    set.subscribe({ kinds: [1] }, () => undefined);
    await waitFor(() => r.seen.connections >= 2 && set.status.get(r.url) === "open");
    await waitFor(() => r.seen.reqs >= 2); // the subscription is sent again on the new connection
    // And it stays up once pings are answered.
    const n = r.seen.connections;
    await new Promise((res) => setTimeout(res, 400));
    expect(r.seen.connections).toBe(n);
  });

  it("keeps reconnecting past many drops in a row", async () => {
    const r = await relay({ onConnect: (ws, n) => n <= 8 && ws.close() });
    const set = new RelaySet([r.url], 1000, { pingMs: 10_000, maxWaitMs: 50 });
    cleanup.push(() => set.close());
    set.subscribe({ kinds: [1] }, () => undefined);
    await waitFor(() => r.seen.connections >= 9 && set.status.get(r.url) === "open");
  });
});
