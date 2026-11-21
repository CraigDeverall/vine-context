// The invite desk: answers join codes. It runs on the machine that made the
// codes (an admin's), while that machine is sharing; a code whose maker is
// offline waits until it's back.
//
// One signalling room per live invite; the room an offer arrives on says
// which invite (and so which secret) the newcomer must prove. A newcomer's
// first frames, in order:
//   desk → {t:"challenge", nonce, host}
//   them → {t:"auth", proof, name, key, sig, about}   proof = HMAC(invite secret), sig = Ed25519 over the nonce
//   desk → {t:"welcome", ...} | {t:"denied", reason}
// The welcome carries the graph (id, name, group secret) and its whole change
// log, so the newcomer has a full copy from the start and can join the mesh.
// The newcomer answers {t:"thanks"} once it has it, and the connection closes.

import { randomBytes } from "node:crypto";
import nodeDataChannel, { type PeerConnection } from "node-datachannel";
import { NAME_RE, verifySignature } from "../core/identity.js";
import { cleanAbout } from "../core/members.js";
import { inviteLink, isLive, type Invite, type InviteStore } from "../host/state.js";
import { FramedChannel } from "./channel.js";
import { b64u, checkProof } from "./link.js";
import type { SignalFactory, Signaller } from "./signal.js";

const MAX_AT_ONCE = 20;
const PROVE_WITHIN_MS = 15_000;

export interface Newcomer {
  key: string;
  name: string;
  about?: Record<string, string>;
  invite: Invite;
}

export type Admission = { welcome: Record<string, unknown> } | { deny: string };

export interface DeskOptions {
  hostName(): string;
  invites: InviteStore;
  signal: SignalFactory;
  ice: string[];
  /** Decides on someone who proved a live code: let them in (and what to send them), or not. */
  admit(n: Newcomer): Promise<Admission>;
  log?(msg: string): void;
}

interface Pending {
  id: string;
  from: string;
  invite: string;
  pc: PeerConnection;
  ch?: FramedChannel;
  answer?: { sdp: string; sdpType: string };
  done: boolean;
}

export class InviteDesk {
  private pending = new Map<string, Pending>();
  private rooms = new Map<string, Signaller>();
  private sweep: NodeJS.Timeout;
  private stopped = false;

  constructor(private o: DeskOptions) {
    for (const inv of o.invites.live()) this.listen(inv);
    this.sweep = setInterval(() => this.closeDead(), 60_000);
    this.sweep.unref();
  }

  /** Makes a new invite and starts listening for it. */
  invite(opts: { label?: string; role?: Invite["role"]; hours?: number } = {}): Invite {
    const inv = this.o.invites.create(opts);
    this.listen(inv);
    this.o.log?.(`new invite ${inv.id}${inv.label ? ` (${inv.label})` : ""}`);
    return inv;
  }

  /** Cancels an invite: its code stops working. */
  revoke(id: string, reason = "The host cancelled this join code."): boolean {
    const inv = this.o.invites.revoke(id, reason);
    for (const p of this.pending.values()) if (p.invite === id) this.drop(p, reason);
    this.unlisten(id);
    return Boolean(inv);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sweep);
    for (const p of this.pending.values()) this.drop(p, "The host stopped sharing.");
    for (const id of [...this.rooms.keys()]) this.unlisten(id);
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

  private async onSignal(invite: string, m: any): Promise<void> {
    if (this.stopped || m?.type !== "offer" || typeof m.from !== "string" || typeof m.sdp !== "string") return;
    const signaller = this.rooms.get(invite);
    const inv = this.o.invites.get(invite);
    if (!signaller || !inv || !isLive(inv)) return this.unlisten(invite);
    const id = `${invite}:${m.from}`;
    const existing = this.pending.get(id);
    if (existing) {
      if (existing.answer) await signaller.send({ type: "answer", to: m.from, ...existing.answer });
      return;
    }
    if (this.pending.size >= MAX_AT_ONCE) return;
    const pc = new nodeDataChannel.PeerConnection(`p2pcg-desk-${m.from}`, { iceServers: this.o.ice });
    const p: Pending = { id, from: m.from, invite, pc, done: false };
    this.pending.set(id, p);
    pc.onStateChange((s) => {
      if (s === "failed" || s === "closed" || s === "disconnected") this.forget(p);
    });
    pc.onDataChannel((dc) => this.onChannel(p, new FramedChannel(dc)));
    setTimeout(() => this.pending.get(id) === p && this.drop(p, "Took too long to connect."), PROVE_WITHIN_MS + 30_000).unref();
    try {
      pc.setRemoteDescription(m.sdp, m.sdpType);
      const local = await gathered(pc);
      p.answer = { sdp: local.sdp, sdpType: local.type };
      await signaller.send({ type: "answer", to: m.from, ...p.answer });
    } catch (e) {
      this.o.log?.(`offer from ${m.from} failed: ${(e as Error).message}`);
      this.forget(p);
    }
  }

  private onChannel(p: Pending, ch: FramedChannel): void {
    p.ch = ch;
    const nonce = b64u(randomBytes(16));
    ch.onClose(() => this.forget(p));
    ch.onMessage(async (m: any) => {
      if (p.done) {
        if (m?.t === "thanks") this.drop(p, "", false); // they have the log: close
        return;
      }
      p.done = true;
      const inv = this.o.invites.get(p.invite);
      if (!inv || !isLive(inv)) return this.drop(p, "This join code no longer works. Ask for a new one.");
      if (m?.t !== "auth" || !checkProof(inviteLink(inv).secret, nonce, p.from, m.proof)) return this.drop(p, "Wrong or missing join code secret.");
      if (typeof m.key !== "string" || !verifySignature(m.key, `p2pcg-id-v1:${nonce}:${p.from}`, m.sig)) return this.drop(p, "Identity signature did not verify.");
      if (typeof m.name !== "string" || !NAME_RE.test(m.name)) return this.drop(p, "Names are 1–40 letters, digits, spaces, dots, dashes or underscores.");
      let out: Admission;
      try {
        out = await this.o.admit({ key: m.key, name: m.name, about: cleanAbout(m.about), invite: inv });
      } catch (e) {
        out = { deny: (e as Error).message };
      }
      if ("deny" in out) return this.drop(p, out.deny);
      this.send(p, { t: "welcome", host: this.o.hostName(), ...out.welcome });
      setTimeout(() => this.drop(p, "", false), 60_000).unref();
    });
    const greet = () => this.send(p, { t: "challenge", nonce, host: this.o.hostName() });
    if (ch.dc.isOpen()) greet();
    else ch.dc.onOpen(greet);
  }

  private send(p: Pending, m: Record<string, unknown>) {
    try {
      p.ch?.send(m);
    } catch {
      this.forget(p);
    }
  }

  private drop(p: Pending, reason: string, deny = true): void {
    if (deny && reason) this.send(p, { t: "denied", reason });
    setTimeout(() => {
      try {
        p.pc.close();
      } catch {
        // already closed
      }
    }, 300).unref();
    this.forget(p);
  }

  private forget(p: Pending): void {
    if (this.pending.get(p.id) === p) this.pending.delete(p.id);
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
