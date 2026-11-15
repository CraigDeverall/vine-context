// The wire protocol between a host and its clients, used both on the local
// socket and over WebRTC data channels: one JSON object per message.
//
//   {t: "req", id, method, params}   client → host
//   {t: "res", id, result}           host → client
//   {t: "res", id, error: {message}} host → client
//   {t: "evt", event, data}          host → clients, unprompted
//
// The host decides which methods each kind of client may call: local clients
// are the host's own user, peers only get describe, call and info.

import type { InputSpecT } from "../core/pack.js";
import type { Role, SnapshotSchema } from "../core/graph.js";

export type Request = { t: "req"; id: number; method: string; params?: unknown };
export type Response = { t: "res"; id: number; result?: unknown; error?: { message: string } };
export type Event = { t: "evt"; event: string; data?: unknown };
export type Message = Request | Response | Event;

export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  kind: "read" | "write";
  role: Role;
  input: Record<string, InputSpecT>;
  view?: "receipt" | "conflicts";
  undo?: { tool: string; arg: string; field: string };
}

/** What a client needs to offer a host's graph as MCP tools. */
export interface GraphDescription {
  graph: string;
  host: string;
  model: { name: string; version: number; title: string; description: string };
  guide: string;
  schema: SnapshotSchema;
  tools: ToolDescriptor[];
  you: { id: string; role: Role };
}

/** Methods a peer may call. Everything else is for the host's own user. */
export const PEER_METHODS = new Set(["describe", "call", "info", "snapshot"]);

export class RemoteError extends Error {}

/** Matches responses to requests, for any transport that delivers whole messages. */
export class RpcClient {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private sendRaw: (m: Message) => void,
    private timeoutMs = 30_000,
  ) {}

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemoteError(`The host did not answer '${method}' within ${this.timeoutMs / 1000}s.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.sendRaw({ t: "req", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Feed every response here. Returns false for messages that are not responses. */
  handle(m: Message): boolean {
    if (m.t !== "res") return false;
    const p = this.pending.get(m.id);
    if (!p) return true;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new RemoteError(m.error.message));
    else p.resolve(m.result);
    return true;
  }

  failAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RemoteError(reason));
    }
    this.pending.clear();
  }
}

/** Splits a stream of bytes into newline-delimited JSON messages. */
export function lineReader(onMessage: (m: Message) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  };
}
