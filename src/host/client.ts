// A client of the local host, over its socket. Starts a host in the
// background if none is running, so the first session to need a graph brings
// its host up and later sessions share it.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { RpcClient, lineReader, type Message } from "../p2p/protocol.js";
import { hostDir, socketPath } from "./state.js";

export class LocalHost extends EventEmitter {
  private rpc: RpcClient;
  closed = false;

  private constructor(private sock: Socket) {
    super();
    this.rpc = new RpcClient((m) => {
      if (this.closed) throw new Error("The local host has stopped.");
      sock.write(JSON.stringify(m) + "\n");
    }, 60_000);
    sock.on(
      "data",
      lineReader((m: Message) => {
        if (this.rpc.handle(m)) return;
        if (m.t === "evt") this.emit("event", m);
      }),
    );
    const gone = () => {
      if (this.closed) return;
      this.closed = true;
      this.rpc.failAll("The local host has stopped.");
      this.emit("close");
    };
    sock.on("close", gone);
    sock.on("error", gone);
  }

  static connect(path: string): Promise<LocalHost> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(path);
      sock.once("connect", () => resolve(new LocalHost(sock)));
      sock.once("error", reject);
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.rpc.request<T>(method, params);
  }

  close(): void {
    this.closed = true;
    this.sock.destroy();
  }
}

export interface EnsureOptions {
  dataDir: string;
  graph: string;
  /** Seconds the background host waits with no clients before it exits. */
  idleSeconds?: number;
  /** How to run the CLI again: defaults to this process's own command line. */
  command?: { file: string; args: string[] };
}

/** Connects to the graph's host, starting one in the background if needed. */
export async function ensureHost(o: EnsureOptions): Promise<LocalHost> {
  const path = socketPath(o.dataDir, o.graph);
  try {
    return await LocalHost.connect(path);
  } catch {
    // no host yet: start one
  }
  const cmd = o.command ?? { file: process.execPath, args: [...process.execArgv, process.argv[1]!] };
  const args = [...cmd.args, "host", "--graph", o.graph, "--idle", String(o.idleSeconds ?? 600)];
  const logFile = join(hostDir(o.dataDir, o.graph), "host.log");
  const out = openSync(logFile, "a");
  const child = spawn(cmd.file, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, VINE_DATA_DIR: o.dataDir },
  });
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  child.unref();
  // The child has its own handle on the log now. Holding ours would keep the host's folder
  // open, and Windows refuses to rename (or remove) a folder with a file open in it.
  closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      return await LocalHost.connect(path);
    } catch {
      // Exit code 3: another host won the race to start, so keep trying to connect.
      if (exited !== null && exited !== 3) throw new Error(`The graph host failed to start (exit ${exited}). See ${logFile}.`);
    }
  }
  throw new Error(`The graph host did not start within 20s. See ${logFile}.`);
}
