// The host's side of the star: answers WebRTC offers that arrive through
// signalling, checks each peer, and routes approved peers' requests to the host.
//
// The hub listens on one signalling room per live invite. The room an offer
// arrives on says which invite (and so which secret) the peer must prove.
//
// Invite rules, checked once the peer has proved the secret and its key:
// - A bound invite lets in only the key it is bound to; any other key is told
//   the code was used on another machine.
// - An open invite with someone already waiting on it turns others away.
// - Approving the waiting peer binds the invite to their key. Refusing them
//   revokes the invite: a refusal usually means the code reached the wrong
//   person, so the owner sends a fresh one.
// - An unused invite stops working when it expires.
//
// A peer's first frames, in order:
//   host → {t:"challenge", nonce}
//   peer → {t:"auth", proof, name, key, sig}   proof = HMAC(invite secret), sig = Ed25519 over the nonce
//   host → {t:"welcome", role, host} | {t:"pending", host} | {t:"denied", reason}
// Nothing else is accepted before "welcome".

import { randomBytes } from "node:crypto";
import nodeDataChannel, { type PeerConnection } from "node-datachannel";
import { fingerprint, NAME_RE, verifySignature } from "../core/identity.js";
import type { Role } from "../core/graph.js";
import { inviteLink, isLive, type ApprovedPeer, type Invite, type InviteStore, type PeerStore } from "../host/state.js";
import { FramedChannel } from "./channel.js";
import { b64u, checkProof } from "./link.js";
import type { Event, Request } from "./protocol.js";
import type { SignalFactory, Signaller } from "./signal.js";

const MAX_PEERS = 30;
const MAX_PENDING = 20;
const PROVE_WITHIN_MS = 15_000;

export type PeerState = "connecting" | "pending" | "active";

export interface PeerInfo {
  name: string;
  key: string;
  fingerprint: string;
  role?: Role;
  state: PeerState;
  since: string;
}

interface Peer {
  /** Map key: the invite and the peer's signalling id. */
  id: string;
  from: string;
  invite: string;
  pc: PeerConnection;
  ch?: FramedChannel;
  answer?: { sdp: string; sdpType: string };
  state: PeerState;
  name?: string;
  key?: string;
  role?: Role;
  since: string;
}

export interface HubOptions {
  hostName: string;
  store: PeerStore;
  invites: InviteStore;
  signal: SignalFactory;
  ice: string[];
  /** Handles an active peer's request; the caller is the peer's name and role. */
  onRequest(peer: { name: string; role: Role }, req: Request): Promise<unknown>;
  /** Called whenever the peer list changes (joins, approvals, leaves). */
  onChange(): void;
  log?(msg: string): void;
}

export class Hub {
  private peers = new Map<string, Peer>();
  /** One signaller per live invite, by invite id. */
  private rooms = new Map<string, Signaller>();
  private sweep: NodeJS.Timeout;
  private stopped = false;

  constructor(private o: HubOptions) {
    for (const inv of o.invites.live()) this.listen(inv);
    // Stop listening for invites that expire unused.
    this.sweep = setInterval(() => this.closeDead(), 60_000);
    this.sweep.unref();
  }

  /** Makes a new invite and starts listening for it. */
  invite(opts: { label?: string; hours?: number } = {}): Invite {
    const inv = this.o.invites.create(opts);
    this.listen(inv);
    this.log(`new invite ${inv.id}${inv.label ? ` (${inv.label})` : ""}`);
    return inv;
  }

  /** Cancels an invite: its code stops working and anyone on it is disconnected. */
  revoke(id: string, reason = "The host cancelled this join code."): boolean {
    const inv = this.o.invites.revoke(id, reason);
    for (const p of this.peers.values()) if (p.invite === id) this.drop(p, reason);
    this.unlisten(id);
    return Boolean(inv);
  }

  private listen(inv: Invite): void {
    if (this.rooms.has(inv.id) || this.stopped) return;
    this.rooms.set(inv.id, this.o.signal(inviteLink(inv), (m) => void this.onSignal(inv.id, m)));
  }

  private unlisten(id: string): void {
    this.rooms.get(id)?.close();
    this.rooms.delete(id);
  }

  private closeDead(): void {
    for (const id of this.rooms.keys()) {
      const inv = this.o.invites.get(id);
      if (!inv || !isLive(inv)) this.unlisten(id);
    }
  }

  list(): PeerInfo[] {
    return [...this.peers.values()]
      .filter((p) => p.key && p.name)
      .map((p) => ({ name: p.name!, key: p.key!, fingerprint: fingerprint(p.key!), role: p.role, state: p.state, since: p.since }));
  }

  /** Approves a waiting peer (by name) with a role. */
  approve(name: string, role: Role): ApprovedPeer {
    const p = [...this.peers.values()].find((x) => x.state === "pending" && x.name === name);
    if (!p) throw new Error(`No one named '${name}' is waiting to join.`);
    const approved: ApprovedPeer = { name, key: p.key!, role, approved_at: new Date().toISOString() };
    this.o.store.put(approved);
    this.o.invites.bind(p.invite, p.key!, name);
    this.activate(p, role);
    return approved;
  }

  /** Refuses a waiting peer (which revokes the invite they used), or disconnects a connected one. */
  disconnect(name: string, reason: string): boolean {
    let found = false;
    for (const p of this.peers.values())
      if (p.name === name) {
        found = true;
        if (p.state === "pending") {
          this.o.invites.revoke(p.invite, `refused ${name}`);
          this.unlisten(p.invite);
        }
        this.drop(p, reason);
      }
    return found;
  }

  /** Changes a connected peer's role at once; the peer is told to refresh its tools. */
  setRole(name: string, role: Role): void {
    for (const p of this.peers.values())
      if (p.name === name && p.state === "active") {
        p.role = role;
        this.sendTo(p, { t: "evt", event: "role", data: { role } });
      }
  }

  broadcast(e: Event): void {
    for (const p of this.peers.values()) if (p.state === "active") this.sendTo(p, e);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sweep);
    for (const p of this.peers.values()) this.drop(p, "The host stopped sharing.", { t: "closed" });
    for (const id of [...this.rooms.keys()]) this.unlisten(id);
  }

  private log(m: string) {
    this.o.log?.(m);
  }

  private async onSignal(invite: string, m: any): Promise<void> {
    if (this.stopped || m?.type !== "offer" || typeof m.from !== "string" || typeof m.sdp !== "string") return;
    const signaller = this.rooms.get(invite);
    const inv = this.o.invites.get(invite);
    if (!signaller || !inv || !isLive(inv)) return this.unlisten(invite);
    const id = `${invite}:${m.from}`;
    const existing = this.peers.get(id);
    if (existing) {
      // The peer retries its offer when our answer got lost: send the same answer again.
      if (existing.answer) await signaller.send({ type: "answer", to: m.from, ...existing.answer });
      return;
    }
    if (this.peers.size >= MAX_PEERS) return this.log(`ignoring offer from ${m.from}: ${MAX_PEERS} peers already`);

    const pc = new nodeDataChannel.PeerConnection(`p2pcg-host-${m.from}`, { iceServers: this.o.ice });
    const peer: Peer = { id, from: m.from, invite, pc, state: "connecting", since: new Date().toISOString() };
    this.peers.set(id, peer);
    pc.onStateChange((s) => {
      if (s === "failed" || s === "closed" || s === "disconnected") this.forget(peer);
    });
    pc.onDataChannel((dc) => this.onChannel(peer, new FramedChannel(dc)));
    setTimeout(() => {
      if (peer.state === "connecting" && this.peers.get(peer.id) === peer) this.drop(peer, "Took too long to connect.");
    }, PROVE_WITHIN_MS + 15_000).unref();

    try {
      pc.setRemoteDescription(m.sdp, m.sdpType);
      const local = await gathered(pc);
      peer.answer = { sdp: local.sdp, sdpType: local.type };
      await signaller.send({ type: "answer", to: m.from, ...peer.answer });
    } catch (e) {
      this.log(`offer from ${m.from} failed: ${(e as Error).message}`);
      this.forget(peer);
    }
  }

  private onChannel(peer: Peer, ch: FramedChannel): void {
    peer.ch = ch;
    const nonce = b64u(randomBytes(16));
    const proveTimer = setTimeout(() => peer.state === "connecting" && this.drop(peer, "No proof of the join code received."), PROVE_WITHIN_MS);
    proveTimer.unref();
    ch.onClose(() => this.forget(peer));
    ch.onMessage(async (m: any) => {
      if (peer.state === "connecting") {
        clearTimeout(proveTimer);
        return this.onAuth(peer, nonce, m);
      }
      if (peer.state === "active" && m?.t === "req") {
        const req = m as Request;
        try {
          const result = await this.o.onRequest({ name: peer.name!, role: peer.role! }, req);
          this.sendTo(peer, { t: "res", id: req.id, result });
        } catch (e) {
          this.sendTo(peer, { t: "res", id: req.id, error: { message: (e as Error).message } });
        }
      }
    });
    const greet = () => this.sendTo(peer, { t: "challenge", nonce, host: this.o.hostName });
    if (ch.dc.isOpen()) greet();
    else ch.dc.onOpen(greet);
  }

  private onAuth(peer: Peer, nonce: string, m: any): void {
    const inv = this.o.invites.get(peer.invite);
    if (!inv || !isLive(inv)) return this.drop(peer, "This join code no longer works. Ask for a new one.");
    if (m?.t !== "auth" || !checkProof(inviteLink(inv).secret, nonce, peer.from, m.proof)) return this.drop(peer, "Wrong or missing join code secret.");
    if (typeof m.key !== "string" || !verifySignature(m.key, `p2pcg-id-v1:${nonce}:${peer.from}`, m.sig))
      return this.drop(peer, "Identity signature did not verify.");
    if (typeof m.name !== "string" || !NAME_RE.test(m.name)) return this.drop(peer, "Names are 1–40 letters, digits, spaces, dots, dashes or underscores.");
    peer.key = m.key;

    if (inv.bound && inv.bound.key !== m.key) return this.drop(peer, "This code has already been used on another machine. Ask for a new code of your own.");
    const known = this.o.store.get(m.key);
    if (inv.bound) {
      // The machine this code belongs to, rejoining.
      if (!known) return this.drop(peer, "The host removed you from this graph. Ask for a new code.");
      peer.name = known.name;
      return this.activate(peer, known.role);
    }
    const waiting = [...this.peers.values()].find((p) => p !== peer && p.invite === peer.invite && p.state === "pending");
    if (waiting && waiting.key !== m.key) return this.drop(peer, "Someone else is already waiting to join with this code. Ask for a new code of your own.");
    if (waiting) this.drop(waiting, "You connected again from another session."); // same machine, a fresh attempt
    if (known) {
      // Someone the host already approved, with a fresh code: it becomes theirs.
      this.o.invites.bind(inv.id, m.key, known.name);
      peer.name = known.name;
      return this.activate(peer, known.role);
    }
    const taken =
      m.name === this.o.hostName ||
      this.o.store.byName(m.name) !== undefined ||
      [...this.peers.values()].some((p) => p !== peer && p.name === m.name);
    if (taken) return this.drop(peer, `The name '${m.name}' is taken on this host. Set P2PCG_USER to another name and join again.`);
    if ([...this.peers.values()].filter((p) => p.state === "pending").length >= MAX_PENDING) return this.drop(peer, "Too many people are waiting to join.");
    peer.name = m.name;
    peer.state = "pending";
    this.sendTo(peer, { t: "pending", host: this.o.hostName });
    this.log(`${m.name} (${fingerprint(m.key)}) is waiting for approval (invite ${inv.id}${inv.label ? `, ${inv.label}` : ""})`);
    this.o.onChange();
  }

  private activate(peer: Peer, role: Role): void {
    peer.state = "active";
    peer.role = role;
    this.sendTo(peer, { t: "welcome", role, name: peer.name, host: this.o.hostName });
    this.log(`${peer.name} joined as ${role}`);
    this.o.onChange();
  }

  private sendTo(peer: Peer, m: Record<string, unknown>): void {
    try {
      peer.ch?.send(m);
    } catch {
      this.forget(peer);
    }
  }

  private drop(peer: Peer, reason: string, frame: Record<string, unknown> = { t: "denied", reason }): void {
    this.sendTo(peer, frame);
    // Give the frame a moment to leave before closing.
    setTimeout(() => {
      try {
        peer.pc.close();
      } catch {
        // already closed
      }
    }, 200).unref();
    this.forget(peer);
  }

  private forget(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return;
    this.peers.delete(peer.id);
    if (peer.name) this.log(`${peer.name} left`);
    this.o.onChange();
  }
}

export function gathered(pc: PeerConnection): Promise<{ sdp: string; type: string }> {
  return new Promise((resolve, reject) => {
    const done = () => {
      const d = pc.localDescription();
      if (d) resolve(d as { sdp: string; type: string });
      else reject(new Error("no local description"));
    };
    if (pc.gatheringState() === "complete") return done();
    pc.onGatheringStateChange((s) => s === "complete" && done());
  });
}
