// Sends protocol messages over a WebRTC data channel. Large messages (a long
// tool result) are split into chunks, because SCTP message size limits vary
// between WebRTC stacks.

import type { DataChannel } from "node-datachannel";
import type { Message } from "./protocol.js";

const CHUNK = 16_000;
const MAX_MESSAGE = 8 * 1024 * 1024;

type Chunk = { t: "chunk"; id: number; i: number; n: number; d: string };

export class FramedChannel {
  private nextChunkId = 1;
  private partial = new Map<number, { parts: string[]; got: number; size: number }>();
  private handlers: ((m: Message) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  closed = false;

  constructor(readonly dc: DataChannel) {
    dc.onMessage((raw) => this.receive(String(raw)));
    dc.onClosed(() => this.markClosed());
    dc.onError(() => this.markClosed());
  }

  onMessage(fn: (m: Message | any) => void): void {
    this.handlers.push(fn);
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  send(m: Message | Record<string, unknown>): void {
    if (this.closed || !this.dc.isOpen()) throw new Error("The connection is closed.");
    const text = JSON.stringify(m);
    if (text.length <= CHUNK) {
      this.dc.sendMessage(text);
      return;
    }
    if (text.length > MAX_MESSAGE) throw new Error("Message too large to send.");
    const id = this.nextChunkId++;
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++) {
      const c: Chunk = { t: "chunk", id, i, n, d: text.slice(i * CHUNK, (i + 1) * CHUNK) };
      this.dc.sendMessage(JSON.stringify(c));
    }
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      // already closed
    }
    this.markClosed();
  }

  private receive(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m?.t === "chunk") {
      const c = m as Chunk;
      if (!Number.isInteger(c.n) || c.n < 1 || c.n > MAX_MESSAGE / CHUNK + 1) return;
      let p = this.partial.get(c.id);
      if (!p) this.partial.set(c.id, (p = { parts: new Array(c.n), got: 0, size: 0 }));
      if (p.parts[c.i] === undefined && typeof c.d === "string") {
        p.parts[c.i] = c.d;
        p.got++;
        p.size += c.d.length;
        if (p.size > MAX_MESSAGE) return void this.partial.delete(c.id);
      }
      if (p.got < c.n) return;
      this.partial.delete(c.id);
      try {
        m = JSON.parse(p.parts.join(""));
      } catch {
        return;
      }
    }
    for (const h of this.handlers) h(m);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers.splice(0)) h();
  }
}
