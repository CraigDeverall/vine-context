// The host: one long-running process per graph that owns its Relate store.
//
// Every Claude Code session on this machine reaches it through a local socket
// (they are the host's own user, so they get the admin role). While sharing,
// it is also the centre of the star: peers reach it over WebRTC, with the
// role their invite gave them. Everyone is told when someone new joins.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Graph, type Caller, type Role } from "../core/graph.js";
import { fingerprint, NAME_RE } from "../core/identity.js";
import { autoShare } from "../core/paths.js";
import { Hub } from "../p2p/hub.js";
import { formatCode } from "../p2p/link.js";
import { PEER_METHODS, lineReader, type Event, type Message, type Request } from "../p2p/protocol.js";
import { iceServers, nostrSignaller, type SignalFactory } from "../p2p/signal.js";
import { InviteStore, PeerStore, hostDir, inviteLink, socketPath } from "./state.js";

const ROLES = new Set<Role>(["reader", "contributor", "admin"]);

export interface HostOptions {
  dataDir: string;
  graph: string;
  model?: string;
  /** The host's own name: recorded as $by for local calls. */
  user: string;
  /** Exit after this many seconds with no local clients and no sharing. 0 never exits. */
  idleSeconds?: number;
  signal?: SignalFactory;
  ice?: string[];
  log?(msg: string): void;
  /** Called after the host stops (shutdown request or idle). */
  onStop?(): void;
}

export class HostRunningError extends Error {}

/** True if a host answers on the socket. */
export function hostAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

export class Host {
  readonly socket: string;
  private server!: Server;
  private clients = new Set<Socket>();
  private hub?: Hub;
  private store: PeerStore;
  private invites: InviteStore;
  private idleTimer?: NodeJS.Timeout;
  private stopped = false;
  private me: Caller;

  private constructor(
    readonly graph: Graph,
    private o: HostOptions,
  ) {
    this.socket = socketPath(o.dataDir, o.graph);
    this.store = new PeerStore(hostDir(o.dataDir, o.graph));
    this.invites = new InviteStore(hostDir(o.dataDir, o.graph));
    this.me = { id: o.user, role: "admin" };
  }

  static async start(o: HostOptions): Promise<Host> {
    const path = socketPath(o.dataDir, o.graph);
    if (await hostAlive(path)) throw new HostRunningError(`A host for graph '${o.graph}' is already running.`);
    const graph = await Graph.open({ dataDir: o.dataDir, name: o.graph, model: o.model });
    const host = new Host(graph, o);
    await host.listen();
    // Sharing is on by default and survives a restart (a sleep, a reboot, an idle exit), so
    // members can come back with their codes. Only stop_sharing turns it off, and it stays off.
    if (host.sharingWanted()) host.startSharing();
    host.armIdle();
    return host;
  }

  private log(m: string) {
    this.o.log?.(m);
  }

  private listen(): Promise<void> {
    if (process.platform !== "win32") {
      mkdirSync(dirname(this.socket), { recursive: true, mode: 0o700 });
      if (existsSync(this.socket)) unlinkSync(this.socket); // stale: hostAlive said no one answers
    }
    this.server = createServer((sock) => this.onClient(sock));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socket, () => {
        this.server.off("error", reject);
        // Local clients act as the host's user (admin), so only that user may connect.
        if (process.platform !== "win32") chmodSync(this.socket, 0o600);
        resolve();
      });
    });
  }

  private onClient(sock: Socket) {
    this.clients.add(sock);
    this.armIdle();
    const write = (m: Message) => {
      if (!sock.destroyed) sock.write(JSON.stringify(m) + "\n");
    };
    sock.on(
      "data",
      lineReader(async (m) => {
        if (m.t !== "req") return;
        try {
          write({ t: "res", id: m.id, result: await this.handleLocal(m) });
        } catch (e) {
          write({ t: "res", id: m.id, error: { message: (e as Error).message } });
        }
      }),
    );
    const gone = () => {
      this.clients.delete(sock);
      this.armIdle();
    };
    sock.on("close", gone);
    sock.on("error", gone);
  }

  private broadcastLocal(e: Event) {
    const line = JSON.stringify(e) + "\n";
    for (const c of this.clients) if (!c.destroyed) c.write(line);
  }

  private async call(caller: Caller, tool: string, args: unknown): Promise<unknown> {
    const result = await this.graph.call(tool, args, caller);
    const spec = this.graph.tools.find((t) => t.name === tool);
    if (spec?.kind === "write") {
      const e: Event = { t: "evt", event: "changed", data: { tool, by: caller.id, at: new Date().toISOString() } };
      this.broadcastLocal(e);
      this.hub?.broadcast(e);
    }
    return result;
  }

  /** Requests from this machine: the host's own user. */
  async handleLocal(req: Request): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, any>;
    switch (req.method) {
      case "describe":
        return this.graph.describe(this.o.user, this.me);
      case "call":
        return this.call(this.me, p.tool, p.args);
      case "info":
        return { ...(await this.graph.info()), host: this.o.user, sharing: this.sharingSummary(), people: this.people() };
      case "snapshot":
        return this.graph.snapshot(p);
      case "share":
        return this.share(p);
      case "revoke_invite":
        return this.revokeInvite(p.id);
      case "rename":
        return this.rename(p.name);
      case "unshare":
        return this.unshare();
      case "status":
        return this.status();
      case "set_role":
        return this.setRole(p.name, p.role);
      case "remove":
        return this.remove(p.name);
      case "shutdown":
        setImmediate(() => this.stop());
        return { stopping: true };
      default:
        throw new Error(`Unknown method '${req.method}'.`);
    }
  }

  /** Requests from peers who joined. */
  async handlePeer(peer: { name: string; role: Role }, req: Request): Promise<unknown> {
    if (!PEER_METHODS.has(req.method)) throw new Error(`Peers can't call '${req.method}'.`);
    const caller: Caller = { id: peer.name, role: peer.role };
    const p = (req.params ?? {}) as Record<string, any>;
    if (req.method === "describe") return this.graph.describe(this.o.user, caller);
    if (req.method === "info") return { ...(await this.graph.info()), host: this.o.user, people: this.people() };
    if (req.method === "snapshot") return this.graph.snapshot(p); // a read: every role may
    return this.call(caller, p.tool, p.args);
  }

  /** Starts sharing if needed, and makes a new invite: one join code for one person's machine. */
  share(opts: { label?: unknown; role?: unknown; expires_hours?: unknown } = {}) {
    const label = opts.label === undefined || opts.label === null || opts.label === "" ? undefined : String(opts.label).slice(0, 60);
    const role = opts.role === undefined || opts.role === null ? undefined : this.checkRole(opts.role);
    const hours = opts.expires_hours === undefined || opts.expires_hours === null ? undefined : Number(opts.expires_hours);
    const already = Boolean(this.hub);
    const hub = this.startSharing();
    const inv = hub.invite({ label, role, hours });
    return { ...this.invites.summary(inv), code: formatCode(inviteLink(inv)), already_sharing: already };
  }

  private get sharingFile(): string {
    return join(hostDir(this.o.dataDir, this.o.graph), "sharing.json");
  }

  /** Sharing is on unless it was turned off with stop_sharing (or P2PCG_AUTO_SHARE is off and it was never turned on). */
  private sharingWanted(): boolean {
    try {
      return JSON.parse(readFileSync(this.sharingFile, "utf8")).on === true;
    } catch {
      return autoShare();
    }
  }

  private rememberSharing(on: boolean) {
    try {
      mkdirSync(dirname(this.sharingFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.sharingFile, JSON.stringify({ on }) + "\n", { mode: 0o600 });
    } catch (e) {
      this.log(`couldn't save the sharing setting: ${(e as Error).message}`);
    }
  }

  /** Starts listening for every live invite, without making a new one. */
  startSharing(): Hub {
    if (this.hub) return this.hub;
    this.rememberSharing(true);
    const o = this.o;
    this.hub = new Hub({
      get hostName() {
        return o.user; // follows rename
      },
      store: this.store,
      invites: this.invites,
      signal: this.o.signal ?? nostrSignaller,
      ice: this.o.ice ?? iceServers(),
      onRequest: (peer, req) => this.handlePeer(peer, req),
      onChange: () => this.broadcastLocal({ t: "evt", event: "peers", data: this.status() }),
      onJoin: (person) => {
        // Everyone in the graph hears about a newcomer: this machine's sessions and every peer but them.
        const e: Event = { t: "evt", event: "joined", data: person };
        this.broadcastLocal(e);
        const key = this.store.byName(person.name)?.key;
        this.hub?.broadcast(e, key);
      },
      log: (m) => this.log(m),
    });
    this.armIdle();
    this.log(`sharing graph '${this.o.graph}'`);
    return this.hub;
  }

  revokeInvite(id: unknown) {
    const inv = typeof id === "string" ? this.invites.get(id) : undefined;
    if (!inv) throw new Error(`No invite '${String(id)}'. sharing_status lists them.`);
    if (inv.revoked) return { revoked: inv.id, already: true };
    if (this.hub) this.hub.revoke(inv.id);
    else this.invites.revoke(inv.id, "The host cancelled this join code.");
    this.broadcastLocal({ t: "evt", event: "peers", data: this.status() });
    return { revoked: inv.id, label: inv.label ?? null, was_for: inv.bound?.name ?? null };
  }

  /** Your new display name: what you record from now on, and what peers see. */
  rename(name: unknown): { name: string } {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error("Names are 1–40 letters, digits, spaces, dots, dashes or underscores.");
    this.o.user = name;
    this.me = { id: name, role: "admin" };
    this.log(`your name is now '${name}'`);
    return { name };
  }

  /** Stops sharing, and keeps it off across restarts. */
  unshare(): { stopped: boolean } {
    this.rememberSharing(false);
    return this.closeHub();
  }

  private closeHub(): { stopped: boolean } {
    if (!this.hub) return { stopped: false };
    this.hub.stop();
    this.hub = undefined;
    this.armIdle();
    this.log("stopped sharing");
    return { stopped: true };
  }

  private sharingSummary() {
    const peers = this.hub?.list() ?? [];
    return {
      sharing: Boolean(this.hub),
      connected: peers.filter((p) => p.state === "active").length,
    };
  }

  status() {
    const live = this.hub?.list() ?? [];
    return {
      graph: this.o.graph,
      host: this.o.user,
      sharing: Boolean(this.hub),
      invites: this.invites
        .all()
        .filter((i) => !i.revoked || Date.now() - Date.parse(i.revoked.at) < 24 * 3600_000)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((i) => this.invites.summary(i)),
      connected: live.filter((p) => p.state === "active").map(({ name, fingerprint, role, since }) => ({ name, fingerprint, role, since })),
      people: this.people(),
    };
  }

  private checkRole(role: unknown): Role {
    if (!ROLES.has(role as Role)) throw new Error("role must be reader, contributor or admin.");
    return role as Role;
  }

  /** Everyone in the graph: the host, and each person who joined, with what we know about them. */
  people() {
    const online = new Set((this.hub?.list() ?? []).filter((p) => p.state === "active").map((p) => p.key));
    return [
      { name: this.o.user, role: "admin" as Role, host: true, online: true },
      ...this.store.all().map((p) => ({
        name: p.name,
        fingerprint: fingerprint(p.key),
        role: p.role,
        joined_at: p.approved_at,
        invite: p.invite ? { id: p.invite, label: this.invites.get(p.invite)?.label ?? null } : null,
        agent: p.agent ? `${p.agent}${p.agent_version ? ` ${p.agent_version}` : ""}` : null,
        p2pcg: p.p2pcg ?? null,
        platform: p.platform ?? null,
        online: online.has(p.key),
      })),
    ];
  }

  setRole(name: string, role: unknown) {
    const r = this.checkRole(role);
    const p = this.store.byName(name);
    if (!p) throw new Error(`No one named '${name}' has joined this graph.`);
    this.store.put({ ...p, role: r });
    this.hub?.setRole(name, r);
    return { name, role: r };
  }

  remove(name: string) {
    const p = this.store.byName(name);
    const removed = p ? this.store.remove(p.key) : false;
    if (p) for (const inv of this.invites.revokeForKey(p.key, `removed ${name}`)) this.hub?.revoke(inv.id, "The host removed you from this graph.");
    const dropped = this.hub?.disconnect(name, "The host removed you from this graph.") ?? false;
    if (!removed && !dropped) throw new Error(`No peer named '${name}'.`);
    return { removed: name, was_member: removed, was_connected: dropped };
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    const secs = this.o.idleSeconds ?? 0;
    if (!secs || this.stopped || this.clients.size || this.hub) return;
    this.idleTimer = setTimeout(() => {
      this.log(`idle for ${secs}s; stopping`);
      this.stop();
    }, secs * 1000);
    this.idleTimer.unref();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.closeHub(); // stopping the host isn't stopping sharing: it resumes on the next start
    for (const c of this.clients) c.destroy();
    this.server.close();
    if (process.platform !== "win32" && existsSync(this.socket)) unlinkSync(this.socket);
    this.o.onStop?.();
  }
}
