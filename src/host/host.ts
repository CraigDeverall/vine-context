// The host: one long-running process per graph on each member's machine. It
// owns this machine's copy of the graph: the change log, the Relate store
// built from it, and the group secret.
//
// - Agent sessions on this machine reach it through a local socket, with this
//   machine's role in the graph.
// - A write is checked, made into a change, applied here at once, and held
//   for HOLD_MS so it can be taken back; then it is numbered, signed and sent.
// - While sharing (the default), it is in the mesh: linked to every other
//   online member, swapping the changes each side lacks. If this machine is
//   an admin it also answers the join codes it made.
// - Changes from others are checked (signature, graph, the author's role at
//   the change's time) and applied. A membership change that arrives "in the
//   past" rebuilds the store from the log, so every machine ends up the same.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { compareChanges, DATA_KINDS, MEMBER_KINDS, ROLES, signChange, uuidv7, wellFormed, type Change, type Role, type Unsigned } from "../core/changes.js";
import { Graph, ToolError, type ApplyContext, type Caller } from "../core/graph.js";
import { defaultName, fingerprint, loadIdentity, NAME_RE, type Identity } from "../core/identity.js";
import { ChangeLog } from "../core/log.js";
import { cleanDescription, Members, type Member } from "../core/members.js";
import { autoShare } from "../core/paths.js";
import { InviteDesk, type Admission, type Newcomer } from "../p2p/invites.js";
import { b64u, formatCode, unb64u } from "../p2p/link.js";
import { groupLink, Mesh } from "../p2p/mesh.js";
import { lineReader, type Event, type Message, type Request } from "../p2p/protocol.js";
import { iceServers, nostrSignaller, type SignalFactory } from "../p2p/signal.js";
import { briefing, digest } from "./digest.js";
import { InviteStore, hostDir, inviteLink, isLive, socketPath } from "./state.js";

/** How long a write stays on this machine, where Undo removes it without trace, before it is sent. */
export const HOLD_MS = Number(process.env.VINE_HOLD_MS ?? 10_000);

export interface HostOptions {
  dataDir: string;
  graph: string;
  /** This machine's name in its graphs (default: the identity's). */
  user?: string;
  identity?: Identity;
  /** Exit after this many seconds with no local clients and no sharing. 0 never exits. */
  idleSeconds?: number;
  signal?: SignalFactory;
  ice?: string[];
  /** Overrides HOLD_MS (tests). */
  holdMs?: number;
  log?(msg: string): void;
  onStop?(): void;
}

export interface GroupInfo {
  id: string;
  name: string;
  /** base64url */
  secret: string;
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

const groupFile = (dataDir: string, graph: string) => join(hostDir(dataDir, graph), "group.json");

export function readGroup(dataDir: string, graph: string): GroupInfo | undefined {
  try {
    const g = JSON.parse(readFileSync(groupFile(dataDir, graph), "utf8"));
    return typeof g.id === "string" && typeof g.secret === "string" ? g : undefined;
  } catch {
    return undefined;
  }
}

function writeGroup(dataDir: string, graph: string, g: GroupInfo) {
  const file = groupFile(dataDir, graph);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(g, null, 1) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Puts a graph someone shared with us on this machine, before its host starts:
 * the group details and the change log from the welcome. Returns false if this
 * machine already has a different graph under that name.
 */
export function placeReplica(dataDir: string, graph: string, group: GroupInfo, changes: Change[]): boolean {
  const have = readGroup(dataDir, graph);
  if (have && have.id !== group.id) return false;
  if (!have) writeGroup(dataDir, graph, group);
  const log = new ChangeLog(hostDir(dataDir, graph));
  for (const c of changes) if (wellFormed(c) && c.graph === group.id) log.add(c);
  return true;
}

/** Order-independent digest of the changes a store holds: tells whether the store matches the log. */
class Digest {
  private x = Buffer.alloc(32);
  private n = 0;
  add(id: string) {
    const h = createHash("sha256").update(id).digest();
    for (let i = 0; i < 32; i++) this.x[i]! ^= h[i]!;
    this.n++;
  }
  toString() {
    return `${this.n}:${this.x.toString("hex")}`;
  }
}

export class Host {
  readonly socket: string;
  readonly identity: Identity;
  private server!: Server;
  private clients = new Set<Socket>();
  private log: ChangeLog;
  members: Members;
  private group!: GroupInfo;
  private invites: InviteStore;
  private mesh?: Mesh;
  private desk?: InviteDesk;
  private idleTimer?: NodeJS.Timeout;
  private releaseTimer?: NodeJS.Timeout;
  private stopped = false;
  private digest = new Digest();
  /** Data changes not applied because their author couldn't make them (re-checked on rebuild). */
  private refused = new Map<string, string>();
  private maxDataAt = 0;
  private busy: Promise<unknown> = Promise.resolve();
  /** Admissions wait their turn, so two machines can't both take one code. (Not `busy`: admitting makes a membership change, which queues there.) */
  private admitting: Promise<unknown> = Promise.resolve();
  /** The latest sync digests (what others' changes meant for this machine's person), newest last. */
  private digests: { at: string; lines: string[] }[] = [];

  private constructor(
    readonly graph: Graph,
    private o: HostOptions,
  ) {
    this.socket = socketPath(o.dataDir, o.graph);
    this.identity = o.identity ?? loadIdentity(o.dataDir, o.user ?? defaultName(o.dataDir));
    this.log = new ChangeLog(hostDir(o.dataDir, o.graph));
    this.members = new Members(this.log.all());
    this.invites = new InviteStore(hostDir(o.dataDir, o.graph));
  }

  static async start(o: HostOptions): Promise<Host> {
    const path = socketPath(o.dataDir, o.graph);
    if (await hostAlive(path)) throw new HostRunningError(`A host for graph '${o.graph}' is already running.`);
    const graph = await Graph.open({ dataDir: o.dataDir, name: o.graph });
    const host = new Host(graph, o);
    await host.init();
    await host.listen();
    if (host.sharingWanted()) host.startSharing();
    host.armIdle();
    return host;
  }

  private get holdMs() {
    return this.o.holdMs ?? HOLD_MS;
  }

  private say(m: string) {
    this.o.log?.(m);
  }

  get me(): string {
    return this.identity.publicKey;
  }

  /** Runs state changes one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  // ---- Start-up ---------------------------------------------------------

  private async init() {
    const group = readGroup(this.o.dataDir, this.o.graph);
    if (group) this.group = group;
    else if (!this.log.size) await this.createGraph();
    else throw new Error(`Graph '${this.o.graph}' has a change log but no group details (${groupFile(this.o.dataDir, this.o.graph)}).`);
    this.members = new Members(this.log.all());
    if (this.members.graphId !== this.group.id) throw new Error(`Graph '${this.o.graph}': its change log has no create change for ${this.group.id}.`);

    // The store must hold exactly what the log (and the held changes) say.
    const expected = new Digest();
    for (const c of this.log.all()) expected.add(c.id);
    for (const h of this.log.heldChanges()) expected.add(h.change.id);
    if ((await this.graph.getApplied()) !== expected.toString()) await this.rebuild();
    else {
      this.digest = expected;
      for (const c of this.log.all()) if (DATA_KINDS.has(c.kind)) this.maxDataAt = Math.max(this.maxDataAt, Date.parse(c.at));
    }
    await this.syncMyName();
    this.scheduleRelease();
  }

  /** A new graph: this machine is its creator. */
  private async createGraph() {
    const id = uuidv7();
    this.group = { id, name: this.o.graph, secret: b64u(randomBytes(32)) };
    const now = new Date().toISOString();
    this.log.add(signChange({ id, graph: id, kind: "create", author: this.me, seq: 1, at: now, body: { name: this.o.graph, creator_name: this.identity.name } }, this.identity));
    writeGroup(this.o.dataDir, this.o.graph, this.group);
    await this.graph.reset();
  }

  /** Makes, signs and logs a change at once (membership changes are never held). */
  private signNow(kind: Change["kind"], body: Record<string, unknown>, at = new Date().toISOString()): Change {
    const c = signChange({ id: uuidv7(), graph: this.group.id, kind, author: this.me, seq: this.log.nextSeq(this.me), at, body }, this.identity);
    this.log.add(c);
    return c;
  }

  /** If this machine's name changed, tell the graph. */
  private async syncMyName() {
    const m = this.members.get(this.me);
    if (m && !m.removed_at && m.name !== this.identity.name && NAME_RE.test(this.identity.name)) await this.renameTo(this.identity.name);
  }

  // ---- Applying ---------------------------------------------------------

  private ctx(): ApplyContext {
    return {
      name: (key) => this.members.displayName(key),
      isAdmin: (key, at) => this.members.roleAt(key, at) === "admin",
    };
  }

  /** Applies a data change if its author could make it then. */
  private async applyData(c: Pick<Change, "id" | "kind" | "author" | "at" | "body">, own = false) {
    const needs: Role = "contributor";
    const allowed = own || this.members.allows(c.author, c.at, needs);
    if (!allowed) {
      this.refused.set(c.id, "its author couldn't make this change at that time");
      return { status: "refused" as const, reason: "not allowed" };
    }
    this.refused.delete(c.id);
    const r = await this.graph.apply(c, this.ctx());
    if (r.status === "refused") this.refused.set(c.id, r.reason);
    this.maxDataAt = Math.max(this.maxDataAt, Date.parse(c.at));
    return r;
  }

  /** Builds the store again from the log: every change, in the order every machine uses. */
  private async rebuild() {
    this.say("building the store from the change log");
    await this.graph.reset();
    this.members = new Members(this.log.all());
    this.refused.clear();
    this.maxDataAt = 0;
    this.digest = new Digest();
    for (const c of [...this.log.all()].sort(compareChanges)) {
      if (DATA_KINDS.has(c.kind)) await this.applyData(c);
      this.digest.add(c.id);
    }
    for (const h of this.log.heldChanges()) {
      await this.applyData(h.change, true);
      this.digest.add(h.change.id);
    }
    await this.graph.refreshNames(this.names());
    await this.graph.setApplied(this.digest.toString());
  }

  private names(): Map<string, string> {
    return new Map(this.members.all().map((m) => [m.key, this.members.displayName(m.key)]));
  }

  /**
   * Takes changes from another member (or a welcome). Returns the ones that
   * were new here, to pass on.
   */
  receive(changes: unknown[], from?: string): Promise<Change[]> {
    const done = this.receiveNow(changes, from);
    void done.then((fresh) => this.afterSync(fresh)).catch((e) => this.say(`digest failed: ${(e as Error).message}`));
    return done;
  }

  /** Works out what others' new changes mean here, and tells this machine's sessions. */
  private async afterSync(fresh: Change[]) {
    const data = fresh.filter((c) => DATA_KINDS.has(c.kind) && c.author !== this.me && !this.refused.has(c.id));
    if (!data.length) return;
    const lines = await digest(data, { graph: this.graph, me: this.me, name: (k) => this.members.displayName(k), reader: this.readCaller() });
    if (!lines.length) return;
    this.digests.push({ at: new Date().toISOString(), lines });
    this.digests = this.digests.slice(-20);
    this.broadcastLocal({ t: "evt", event: "digest", data: { context: this.o.graph, lines } });
  }

  private receiveNow(changes: unknown[], from?: string): Promise<Change[]> {
    return this.serial(async () => {
      const fresh: Change[] = [];
      for (const c of changes) {
        if (!wellFormed(c) || c.graph !== this.group.id) continue;
        if (this.log.add(c)) fresh.push(c);
      }
      if (!fresh.length) return fresh;
      this.say(`received ${fresh.length} new change(s)${from ? ` from ${fingerprint(from)}` : ""}`);
      const membership = fresh.filter((c) => MEMBER_KINDS.has(c.kind));
      const before = this.members;
      if (membership.length) this.members = new Members(this.log.all());
      // A membership change older than data already applied (or one that may make a refused change valid) means building again.
      const inThePast = membership.length > 0 && (membership.some((c) => Date.parse(c.at) <= this.maxDataAt) || this.refused.size > 0);
      if (inThePast) {
        await this.rebuild();
      } else {
        for (const c of fresh.sort(compareChanges)) {
          if (DATA_KINDS.has(c.kind)) await this.applyData(c);
          this.digest.add(c.id);
        }
        if (membership.length) await this.graph.refreshNames(this.names());
        await this.graph.setApplied(this.digest.toString());
      }
      if (membership.length) this.afterMembership(before, membership);
      const data = fresh.filter((c) => DATA_KINDS.has(c.kind));
      if (data.length) this.broadcastLocal({ t: "evt", event: "changed", data: { count: data.length, from: from ? this.members.displayName(from) : null } });
      return fresh;
    });
  }

  /** Tells this machine's sessions about joins, and acts on removals. */
  private afterMembership(before: Members, changes: Change[]) {
    for (const c of changes) {
      if (c.kind === "add_member" && typeof c.body.key === "string" && !before.isMember(c.body.key) && this.members.isMember(c.body.key)) {
        const m = this.members.get(c.body.key)!;
        if (m.key !== this.me) this.broadcastLocal({ t: "evt", event: "joined", data: this.personNotice(m) });
        // They may already have said hello and been ignored as a stranger: say hello back.
        this.mesh?.nudge();
      }
      if (c.kind === "remove_member" && typeof c.body.key === "string") {
        if (c.body.key === this.me) {
          this.say("this machine was removed from the graph");
          this.mesh?.stop();
          this.mesh = undefined;
          this.desk?.stop();
          this.desk = undefined;
          this.broadcastLocal({ t: "evt", event: "removed", data: { by: this.members.displayName(c.author), at: c.at } });
        } else {
          this.mesh?.drop(c.body.key, [c]);
          for (const inv of this.invites.revokeForKey(c.body.key, "removed")) this.desk?.revoke(inv.id);
        }
      }
      if (c.kind === "set_role" && c.body.key === this.me) this.broadcastLocal({ t: "evt", event: "role", data: { role: this.members.get(this.me)?.role } });
    }
  }

  private personNotice(m: Member) {
    return {
      name: this.members.displayName(m.key),
      fingerprint: fingerprint(m.key),
      role: m.role,
      invite: m.invite ?? null,
      joined_at: m.joined_at,
      added_by: this.members.displayName(m.added_by),
      ...(m.about ?? {}),
    };
  }

  // ---- Writing ----------------------------------------------------------

  private caller(): Caller {
    const role = this.members.roleAt(this.me, new Date().toISOString());
    if (!role) throw new ToolError(this.members.get(this.me)?.removed_at ? "You were removed from this graph: you can read your copy, but not write to it." : "You are not a member of this graph.");
    return { id: this.members.displayName(this.me), key: this.me, role };
  }

  private readCaller(): Caller {
    const role = this.members.roleAt(this.me, new Date().toISOString());
    return { id: this.members.displayName(this.me), key: this.me, role: role ?? "reader" };
  }

  /** A write from this machine: checked, applied here, held for HOLD_MS, then sent. */
  private write(tool: string, args: unknown) {
    return this.serial(async () => {
      const caller = this.caller();
      const now = new Date().toISOString();
      const p = await this.graph.prepare(tool, args, caller, now);
      const change: Unsigned = { id: uuidv7(), graph: this.group.id, kind: p.kind, author: this.me, at: now, body: p.body };
      const r = await this.applyData(change, true);
      if (r.status === "refused") throw new ToolError(`That change can't be made: ${r.reason}.`);
      const until = Date.now() + this.holdMs;
      this.log.hold(change, until);
      this.digest.add(change.id);
      await this.graph.setApplied(this.digest.toString());
      this.scheduleRelease();
      this.broadcastLocal({ t: "evt", event: "changed", data: { count: 1, from: null } });
      const result = r.status === "applied" ? r.result : { waiting_for: r.waiting };
      return { ...result, change: change.id, shared_at: new Date(until).toISOString() };
    });
  }

  /** Undo, while a write is still held: it is removed and never leaves this machine. */
  takeBack(changeId: string) {
    return this.serial(async () => {
      const held = this.log.heldChanges().find((h) => h.change.id === changeId || h.change.body.node === changeId);
      if (!held) {
        if (this.log.get(changeId) || this.log.all().some((c) => c.body.node === changeId))
          throw new ToolError("It has already been shared with the other members, so it can't be taken back without trace. Withdraw it instead (it stays in the history).");
        throw new ToolError(`No write ${changeId} from this machine.`);
      }
      this.log.unhold(held.change.id);
      if (held.change.kind === "claim" || held.change.kind === "question" || held.change.kind === "reply") await this.graph.discard(held.change.id);
      else {
        await this.rebuild();
        return { taken_back: held.change.id };
      }
      // The digest is order-independent: removing the id is adding it again (XOR).
      this.digest.add(held.change.id);
      await this.graph.setApplied(this.digest.toString());
      this.broadcastLocal({ t: "evt", event: "changed", data: { count: 1, from: null } });
      return { taken_back: held.change.id, kind: held.change.kind, node: held.change.body.node ?? null };
    });
  }

  private scheduleRelease() {
    clearTimeout(this.releaseTimer);
    const held = this.log.heldChanges();
    if (!held.length || this.stopped) return;
    const next = Math.min(...held.map((h) => h.until));
    this.releaseTimer = setTimeout(() => void this.release(), Math.max(0, next - Date.now()));
    this.releaseTimer.unref();
  }

  /** Numbers, signs and sends the held writes whose time is up. */
  release(force = false) {
    return this.serial(async () => {
      const due = this.log.heldChanges().filter((h) => force || h.until <= Date.now());
      const out: Change[] = [];
      for (const h of due.sort((a, b) => compareChanges({ ...a.change, seq: 0 }, { ...b.change, seq: 0 }))) {
        this.log.unhold(h.change.id);
        const c = signChange({ ...h.change, seq: this.log.nextSeq(this.me) }, this.identity);
        this.log.add(c);
        out.push(c);
      }
      if (out.length) {
        this.say(`sent ${out.length} change(s) to ${this.mesh?.online().filter((l) => l.state === "active").length ?? 0} linked member(s)`);
        this.mesh?.broadcast(out);
      }
      this.scheduleRelease();
      return out;
    });
  }

  /** A membership change from this machine: applied and sent at once. */
  private member(kind: Change["kind"], body: Record<string, unknown>) {
    return this.serial(async () => {
      const before = this.members;
      const c = this.signNow(kind, body);
      this.members = new Members(this.log.all());
      const refused = this.members.refused.find((r) => r.id === c.id);
      if (refused) {
        // Shouldn't happen (we check first), but never leave a refused change unexplained.
        this.say(`own membership change refused: ${refused.reason}`);
      }
      this.digest.add(c.id);
      await this.graph.refreshNames(this.names());
      await this.graph.setApplied(this.digest.toString());
      this.mesh?.broadcast([c]);
      this.afterMembership(before, [c]);
      return c;
    });
  }

  private requireAdmin() {
    if (this.members.roleAt(this.me, new Date().toISOString()) !== "admin") throw new ToolError("Only an admin of this graph can do that.");
  }

  private checkRole(role: unknown): Role {
    if (!ROLES.includes(role as Role)) throw new ToolError("role must be reader, contributor or admin.");
    return role as Role;
  }

  private memberByName(name: string): Member {
    const m = this.members.byName(name);
    if (!m) throw new ToolError(`No one named '${name}' is in this graph.`);
    return m;
  }

  async setRole(name: string, role: unknown) {
    this.requireAdmin();
    const r = this.checkRole(role);
    const m = this.memberByName(name);
    if (m.creator && r !== "admin") throw new ToolError("The graph's creator stays an admin.");
    await this.member("set_role", { key: m.key, role: r });
    return { name: this.members.displayName(m.key), role: r };
  }

  async remove(name: string) {
    this.requireAdmin();
    const m = this.memberByName(name);
    if (m.creator) throw new ToolError("The graph's creator can't be removed.");
    if (m.key === this.me) throw new ToolError("You can't remove yourself.");
    await this.member("remove_member", { key: m.key });
    return {
      removed: m.name,
      note: "Every member's machine stops talking to them. They keep the copy they already had: removing someone can't take back what they received.",
    };
  }

  private async renameTo(name: string) {
    if (!NAME_RE.test(name)) throw new ToolError("Names are 1–40 letters, digits, spaces, dots, dashes or underscores.");
    const taken = this.members.current().find((m) => m.key !== this.me && m.name === name);
    if (taken) throw new ToolError(`Someone in this graph is already called '${name}'.`);
    await this.member("rename", { name });
  }

  async setDescription(text: unknown) {
    this.requireAdmin();
    const d = cleanDescription(text);
    if (!d) throw new ToolError("Describe the context in a sentence or two: what goes in it, and what doesn't.");
    await this.member("describe", { description: d });
    return { context: this.o.graph, description: d };
  }

  async rename(name: string) {
    const m = this.members.get(this.me);
    if (!m || m.removed_at || m.name === name) return { name };
    await this.renameTo(name);
    return { name };
  }

  // ---- Invites ----------------------------------------------------------

  share(opts: { label?: unknown; role?: unknown; expires_hours?: unknown } = {}) {
    this.requireAdmin();
    const label = opts.label === undefined || opts.label === null || opts.label === "" ? undefined : String(opts.label).slice(0, 60);
    const role = opts.role === undefined || opts.role === null ? undefined : this.checkRole(opts.role);
    const hours = opts.expires_hours === undefined || opts.expires_hours === null ? undefined : Number(opts.expires_hours);
    const already = Boolean(this.mesh);
    this.startSharing();
    const inv = this.desk!.invite({ label, role, hours });
    return { ...this.invites.summary(inv), code: formatCode(inviteLink(inv)), already_sharing: already };
  }

  revokeInvite(id: unknown) {
    if (typeof id !== "string" || !this.invites.get(id)) throw new ToolError(`No invite '${String(id)}'.`);
    const inv = this.invites.get(id)!;
    if (this.desk) this.desk.revoke(id);
    else this.invites.revoke(id, "The host cancelled this join code.");
    return { revoked: id, label: inv.label ?? null };
  }

  /** Someone proved a live join code: decide, and send them the graph. */
  private admit(n: Newcomer): Promise<Admission> {
    // One at a time: the code is read and tied to a machine with a membership write in between.
    const run = this.admitting.then(() => this.admitOne(n));
    this.admitting = run.catch(() => undefined);
    return run;
  }

  private admitOne(n: Newcomer): Promise<Admission> {
    return (async () => {
      if (this.members.roleAt(this.me, new Date().toISOString()) !== "admin") return { deny: "The person who made this code can no longer invite people to this graph." };
      // The invite as it stands now: someone ahead in the queue may have used it or it may have been cancelled.
      const inv = this.invites.get(n.invite.id);
      if (!inv || !isLive(inv)) return { deny: "This join code no longer works. Ask for a new one." };
      if (inv.bound && inv.bound.key !== n.key)
        return { deny: "This code has already been used on another machine. If that wasn't you, tell the person who sent it: the code may have leaked. Ask for a new code of your own." };
      const existing = this.members.get(n.key);
      if (existing?.removed_at && inv.bound) return { deny: "You were removed from this graph. Ask for a new code." };
      // A code that nobody has used is for someone new: a member using it would take it from them.
      if (existing && !existing.removed_at && !inv.bound)
        return { deny: "You are already in this graph, and this code is for someone else. It hasn't been used up: they can still join with it." };
      if (!existing || existing.removed_at) {
        const taken = this.members.current().some((m) => m.name === n.name);
        if (taken) return { deny: `The name '${n.name}' is taken in this graph. Set another name (set_my_name) and use the code again.` };
        await this.member("add_member", {
          key: n.key,
          name: n.name,
          role: inv.role ?? "contributor",
          invite: { id: inv.id, label: inv.label ?? null },
          about: n.about ?? {},
        });
        this.say(`${n.name} (${fingerprint(n.key)}) joined with invite ${inv.id}${inv.label ? ` (${inv.label})` : ""}`);
      }
      this.invites.bind(inv.id, n.key, n.name);
      await this.release(true); // send them everything, held writes too
      return {
        welcome: {
          graph: this.group,
          role: this.members.get(n.key)?.role ?? "contributor",
          changes: this.log.all(),
        },
      };
    })();
  }

  // ---- Sharing ----------------------------------------------------------

  private get sharingFile(): string {
    return join(hostDir(this.o.dataDir, this.o.graph), "sharing.json");
  }

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
      this.say(`couldn't save the sharing setting: ${(e as Error).message}`);
    }
  }

  /** Joins the mesh (and, as an admin, answers join codes). */
  startSharing(): void {
    if (this.mesh || this.stopped) return;
    this.rememberSharing(true);
    if (!this.members.isMember(this.me)) return;
    const signal = this.o.signal ?? nostrSignaller;
    const ice = this.o.ice ?? iceServers();
    this.mesh = new Mesh({
      group: groupLink(this.group.id, unb64u(this.group.secret)),
      graphId: this.group.id,
      identity: this.identity,
      signal,
      ice,
      isMember: (key) => this.members.isMember(key),
      myJoin: () => this.log.all().find((c) => c.kind === "add_member" && c.body.key === this.me),
      have: () => this.log.have(),
      missing: (theirs) => this.log.missing(theirs),
      receive: (changes, from) => this.receive(changes, from),
      onChange: () => this.broadcastLocal({ t: "evt", event: "peers", data: { online: this.mesh?.online().length ?? 0 } }),
      log: (m) => this.say(m),
    });
    this.desk = new InviteDesk({
      hostName: () => this.members.displayName(this.me),
      invites: this.invites,
      signal,
      ice,
      admit: (n) => this.admit(n),
      log: (m) => this.say(m),
    });
    this.armIdle();
    this.say(`sharing graph '${this.o.graph}'`);
  }

  /** Stops sharing, and keeps it off across restarts. */
  unshare(): { stopped: boolean } {
    this.rememberSharing(false);
    return this.closeMesh();
  }

  private closeMesh(): { stopped: boolean } {
    if (!this.mesh && !this.desk) return { stopped: false };
    this.mesh?.stop();
    this.desk?.stop();
    this.mesh = undefined;
    this.desk = undefined;
    this.armIdle();
    this.say("stopped sharing");
    return { stopped: true };
  }

  // ---- Local sessions ---------------------------------------------------

  private listen(): Promise<void> {
    if (process.platform !== "win32") {
      mkdirSync(dirname(this.socket), { recursive: true, mode: 0o700 });
      if (existsSync(this.socket)) unlinkSync(this.socket);
    }
    this.server = createServer((sock) => this.onClient(sock));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socket, () => {
        this.server.off("error", reject);
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

  async handleLocal(req: Request): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, any>;
    switch (req.method) {
      case "describe":
        return this.describe();
      case "call": {
        const spec = this.graph.tools.find((t) => t.name === p.tool);
        if (spec?.kind === "write") return this.write(p.tool, p.args);
        return this.graph.call(p.tool, p.args, this.readCaller());
      }
      case "take_back":
        return this.takeBack(String(p.id ?? ""));
      case "info":
        return this.info();
      case "snapshot":
        return this.graph.snapshot(p);
      case "share":
        return this.share(p);
      case "revoke_invite":
        return this.revokeInvite(p.id);
      case "rename":
        return this.rename(String(p.name ?? ""));
      case "unshare":
        return this.unshare();
      case "start_sharing":
        this.startSharing();
        return { sharing: Boolean(this.mesh) };
      case "activity":
        return this.activity(Number(p.limit ?? 30));
      case "describe_context":
        return this.setDescription(p.description);
      case "briefing":
        return briefing(this.graph, this.readCaller());
      case "status":
        return this.status();
      case "set_role":
        return this.setRole(p.name, p.role);
      case "remove":
        return this.remove(p.name);
      case "sync":
        await this.release(true);
        return { have: this.log.have(), changes: this.log.size };
      case "shutdown":
        setImmediate(() => this.stop());
        return { stopping: true };
      default:
        throw new Error(`Unknown method ${req.method}`);
    }
  }

  describe() {
    const creator = this.members.creator();
    const caller = this.readCaller();
    const d = this.graph.describe(creator ? this.members.displayName(creator.key) : "unknown", caller);
    return { ...d, graph_id: this.group.id, creator: creator?.key === this.me, member: this.members.isMember(this.me), description: this.members.description };
  }

  async info() {
    return {
      ...(await this.graph.info()),
      graph_id: this.group.id,
      description: this.members.description,
      created_by: this.members.creator() ? this.members.displayName(this.members.creator()!.key) : null,
      you: { name: this.members.displayName(this.me), role: this.members.roleAt(this.me, new Date().toISOString()), fingerprint: fingerprint(this.me) },
      sharing: { sharing: Boolean(this.mesh), online: this.mesh?.online().filter((l) => l.state === "active").length ?? 0 },
      people: this.people(),
      log: { changes: this.log.size, held: this.log.heldChanges().length, refused: this.refused.size },
    };
  }

  /**
   * The latest changes, newest first, described for a person: what the
   * Claude Code mod's band and panel show. Held writes (still undoable) are
   * marked.
   */
  activity(limit = 30) {
    const n = Math.min(Math.max(Math.trunc(limit) || 30, 1), 200);
    const held = this.log.heldChanges().map((h) => ({ c: { ...h.change, seq: 0, sig: "" } as Change, held: true, until: h.until }));
    const all = [...held, ...this.log.all().map((c) => ({ c, held: false, until: 0 }))];
    all.sort((a, b) => Date.parse(b.c.at) - Date.parse(a.c.at));
    const name = (k: unknown) => (typeof k === "string" ? this.members.displayName(k) : "someone");
    const describe = (c: Change): string => {
      const b = c.body;
      switch (c.kind) {
        case "claim":
          return `claimed: ${String(b.text ?? "").slice(0, 160)}`;
        case "question":
          return `asked: ${String(b.text ?? "").slice(0, 160)}`;
        case "reply":
          return `replied to ${b.question}: ${String(b.text ?? "").slice(0, 160)}`;
        case "link":
          return `linked ${b.from} ${String(b.relation ?? "").toLowerCase()} ${b.to}`;
        case "withdraw":
          return `withdrew ${b.node}${b.reason ? ` (${String(b.reason).slice(0, 80)})` : ""}`;
        case "create":
          return `created the graph '${b.name}'`;
        case "add_member":
          return `let in ${b.name} as ${b.role}`;
        case "set_role":
          return `made ${name(b.key)} ${b.role}`;
        case "remove_member":
          return `removed ${name(b.key)}`;
        case "rename":
          return `is now called ${b.name}`;
        case "describe":
          return `described the context: ${String(b.description ?? "").slice(0, 120)}`;
      }
      return c.kind;
    };
    return {
      graph: this.o.graph,
      graph_id: this.group.id,
      description: this.members.description,
      digest: this.digests.slice(-3),
      created_by: this.members.creator() ? this.members.displayName(this.members.creator()!.key) : null,
      you: { name: this.members.displayName(this.me), role: this.members.roleAt(this.me, new Date().toISOString()), fingerprint: fingerprint(this.me) },
      sharing: Boolean(this.mesh),
      online: this.mesh?.online().filter((l) => l.state === "active").map((l) => this.members.displayName(l.key)) ?? [],
      members: this.members.current().length,
      people: this.people(),
      relays_up: Object.values(this.mesh?.relayStatus() ?? {}).filter((s) => s === "open").length,
      changes: this.log.size,
      recent: all.slice(0, n).map(({ c, held, until }) => ({
        id: c.id,
        kind: c.kind,
        at: c.at,
        by: name(c.author),
        mine: c.author === this.me,
        summary: describe(c),
        node: typeof c.body.node === "string" ? c.body.node : null,
        held,
        shared_at: held ? new Date(until).toISOString() : null,
      })),
    };
  }

  people() {
    return this.members.all().map((m) => ({
      name: this.members.displayName(m.key),
      fingerprint: fingerprint(m.key),
      role: m.removed_at ? null : m.role,
      you: m.key === this.me,
      creator: m.creator,
      joined_at: m.joined_at,
      removed_at: m.removed_at ?? null,
      invite: m.invite ?? null,
      agent: m.about?.agent ? `${m.about.agent}${m.about.agent_version ? ` ${m.about.agent_version}` : ""}` : null,
      vine: m.about?.vine ?? null,
      platform: m.about?.platform ?? null,
      online: m.key === this.me ? Boolean(this.mesh) : Boolean(this.mesh?.isOnline(m.key)),
    }));
  }

  status() {
    return {
      graph: this.o.graph,
      graph_id: this.group.id,
      description: this.members.description,
      host: this.members.creator() ? this.members.displayName(this.members.creator()!.key) : null,
      you: { name: this.members.displayName(this.me), role: this.members.roleAt(this.me, new Date().toISOString()), fingerprint: fingerprint(this.me) },
      sharing: Boolean(this.mesh),
      can_invite: this.members.roleAt(this.me, new Date().toISOString()) === "admin",
      invites: this.invites
        .all()
        .filter((i) => !i.revoked || Date.now() - Date.parse(i.revoked.at) < 24 * 3600_000)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((i) => this.invites.summary(i)),
      links: this.mesh?.online().map((l) => ({ name: this.members.displayName(l.key), fingerprint: l.fingerprint, state: l.state, since: l.since })) ?? [],
      relays: this.mesh?.relayStatus() ?? {},
      people: this.people(),
      log: { changes: this.log.size, held: this.log.heldChanges().length, refused: this.refused.size },
    };
  }

  // ---- Lifetime ---------------------------------------------------------

  private armIdle() {
    clearTimeout(this.idleTimer);
    const secs = this.o.idleSeconds ?? 0;
    if (!secs || this.stopped || this.clients.size || this.mesh) return;
    this.idleTimer = setTimeout(() => {
      this.say(`idle for ${secs}s; stopping`);
      this.stop();
    }, secs * 1000);
    this.idleTimer.unref();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.releaseTimer); // held writes stay held, and go out on the next start
    this.closeMesh(); // stopping the host isn't stopping sharing: it resumes on the next start
    for (const c of this.clients) c.destroy();
    this.server?.close();
    if (process.platform !== "win32" && existsSync(this.socket)) unlinkSync(this.socket);
    this.o.onStop?.();
  }
}
