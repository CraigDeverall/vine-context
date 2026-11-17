// The mesh: every online member of a graph connected to every other, keeping
// each other's change logs in step.
//
// Members meet in the group's signalling room (named and sealed with the
// group secret, which only members hold) and set up WebRTC links with each
// other. Of two members, the one with the smaller key makes the offer.
//
// A link's first frames, both ways:
//   {t:"hi", key, nonce}
//   {t:"prove", sig, proof, joined?}   sig: Ed25519 over the other's nonce; proof: HMAC(group secret)
// `joined` may carry the prover's add_member change, for a member who sees
// them before their add_member reached it. Only current members are accepted.
// Then both send {t:"have"} (one number per author), each sends what the other
// lacks ({t:"changes"}), and from then on new changes are forwarded as they
// come. Links are pinged; one that goes quiet is dropped and set up again.

import { randomBytes } from "node:crypto";
import nodeDataChannel, { type PeerConnection } from "node-datachannel";
import type { Change, Have } from "../core/changes.js";
import { fingerprint, verifySignature, type Identity } from "../core/identity.js";
import { FramedChannel } from "./channel.js";
import { gathered } from "./invites.js";
import { b64u, checkProof, proof, type Link } from "./link.js";
import type { SignalFactory, Signaller } from "./signal.js";

/** Up to 20 members: at most 19 links each. A little room for reconnects. */
const MAX_LINKS = 30;
const BATCH = 400;

export interface MeshOptions {
  group: Link;
  graphId: string;
  identity: Identity;
  signal: SignalFactory;
  ice: string[];
  /** Is this key a current member? */
  isMember(key: string): boolean;
  /** This machine's add_member change, if it has one, to show members who haven't seen it yet. */
  myJoin(): Change | undefined;
  have(): Have;
  missing(theirs: Have): Change[];
  /** Takes changes from a member; returns those that were new here (to forward). */
  receive(changes: Change[], from: string): Promise<Change[]>;
  onChange?(): void;
  log?(m: string): void;
  /** Ping interval and the silence after which a link is dropped. */
  pingMs?: number;
  helloMs?: number;
}

interface PeerLink {
  id: string;
  pc: PeerConnection;
  ch?: FramedChannel;
  key?: string;
  /** The other side's session id in the room. */
  them: string;
  state: "connecting" | "active";
  nonce: string;
  proven: { me: boolean; them: boolean };
  lastHeard: number;
  since: string;
  answer?: { sdp: string; sdpType: string };
  initiator: boolean;
  /** Sync frames that arrived before this side finished checking the link: handled once it has. */
  early: any[];
}

export interface LinkInfo {
  key: string;
  fingerprint: string;
  state: "connecting" | "active";
  since: string;
}

export class Mesh {
  private me = b64u(randomBytes(6));
  private room: Signaller;
  private links = new Map<string, PeerLink>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private lastHelloReply = new Map<string, number>();

  constructor(private o: MeshOptions) {
    this.room = o.signal(o.group, (m) => void this.onSignal(m));
    const pingMs = o.pingMs ?? 15_000;
    this.timers.push(setInterval(() => this.hello(), o.helloMs ?? 30_000));
    this.timers.push(setInterval(() => this.keepalive(pingMs), pingMs));
    for (const t of this.timers) t.unref();
    this.hello();
  }

  get myKey(): string {
    return this.o.identity.publicKey;
  }

  /** Members this machine has a link to. */
  online(): LinkInfo[] {
    return [...this.links.values()]
      .filter((l) => l.key)
      .map((l) => ({ key: l.key!, fingerprint: fingerprint(l.key!), state: l.state, since: l.since }));
  }

  /** The signalling relays' states, for status. */
  relayStatus(): Record<string, string> {
    return this.room.status?.() ?? {};
  }

  isOnline(key: string): boolean {
    return [...this.links.values()].some((l) => l.key === key && l.state === "active");
  }

  /** Sends new changes to every linked member, except the one they came from. */
  broadcast(changes: Change[], exceptKey?: string): void {
    if (!changes.length) return;
    for (const l of this.links.values()) if (l.state === "active" && l.key !== exceptKey) this.sendChanges(l, changes);
  }

  /** Says hello again now: after a new member is added, so links to them don't wait for the next round. */
  nudge(): void {
    this.hello();
  }

  /**
   * Drops links to a key (removed from the graph). `farewell` (the removal
   * itself) is sent first, so the removed machine learns it was removed.
   */
  drop(key: string, farewell: Change[] = [], reason = "removed"): void {
    for (const l of [...this.links.values()]) {
      if (l.key !== key) continue;
      if (l.state === "active" && farewell.length) {
        this.sendChanges(l, farewell);
        setTimeout(() => this.close(l, reason), 1000).unref();
      } else this.close(l, reason);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const l of [...this.links.values()]) this.close(l, "stopped");
    this.room.close();
  }

  private log(m: string) {
    this.o.log?.(m);
  }

  private hello(to?: string) {
    if (this.stopped) return;
    void this.room.send({ type: "hello", from: this.me, key: this.myKey, ...(to ? { to } : {}) });
  }

  private keepalive(pingMs: number) {
    const now = Date.now();
    for (const l of [...this.links.values()]) {
      if (l.state === "active" && now - l.lastHeard > pingMs * 3) {
        this.log(`no word from ${l.key ? fingerprint(l.key) : l.them} for ${Math.round((now - l.lastHeard) / 1000)}s; reconnecting`);
        this.close(l, "silent");
        this.hello();
        continue;
      }
      if (l.state === "connecting" && now - l.lastHeard > 45_000) {
        this.close(l, "took too long to connect");
        continue;
      }
      if (l.state === "active") this.send(l, { t: "ping" });
    }
  }

  private linkTo(key: string): PeerLink | undefined {
    return [...this.links.values()].find((l) => l.key === key);
  }

  private async onSignal(m: any): Promise<void> {
    if (this.stopped || !m || typeof m.from !== "string" || m.from === this.me) return;
    if (m.to && m.to !== this.me) return;
    if (m.type === "hello") {
      if (typeof m.key !== "string" || m.key === this.myKey || !this.o.isMember(m.key)) return;
      const existing = this.linkTo(m.key);
      // The same session, still linked or linking: nothing to do. A new session of
      // that member (it restarted, or went offline and back) replaces a link that
      // may still look alive on this side.
      if (existing && existing.them === m.from && (existing.state === "active" || Date.now() - existing.lastHeard < 20_000)) return;
      if (existing) this.close(existing, existing.them === m.from ? "stale" : "they reconnected");
      if (this.myKey < m.key) return this.offer(m.from, m.key);
      // They make the offer: make sure they've heard of us.
      const last = this.lastHelloReply.get(m.from) ?? 0;
      if (Date.now() - last > 5000) {
        this.lastHelloReply.set(m.from, Date.now());
        this.hello(m.from);
      }
      return;
    }
    if (m.type === "offer" && typeof m.sdp === "string" && typeof m.key === "string") return this.answer(m);
    if (m.type === "answer" && typeof m.sdp === "string") {
      const l = this.links.get(m.from);
      if (!l || !l.initiator || l.answer) return;
      l.answer = { sdp: m.sdp, sdpType: m.sdpType };
      try {
        l.pc.setRemoteDescription(m.sdp, m.sdpType);
      } catch (e) {
        this.close(l, `bad answer: ${(e as Error).message}`);
      }
    }
  }

  private newLink(them: string, initiator: boolean, key?: string): PeerLink | undefined {
    if (this.links.size >= MAX_LINKS) {
      this.log(`ignoring ${them}: ${MAX_LINKS} links already`);
      return undefined;
    }
    const pc = new nodeDataChannel.PeerConnection(`p2pcg-mesh-${this.me}-${them}`, { iceServers: this.o.ice });
    const l: PeerLink = {
      id: them,
      pc,
      them,
      key,
      state: "connecting",
      nonce: b64u(randomBytes(16)),
      proven: { me: false, them: false },
      lastHeard: Date.now(),
      since: new Date().toISOString(),
      initiator,
      early: [],
    };
    this.links.set(them, l);
    pc.onStateChange((s) => {
      if (s === "failed" || s === "closed" || s === "disconnected") this.forget(l);
    });
    return l;
  }

  private async offer(them: string, key: string) {
    const l = this.newLink(them, true, key);
    if (!l) return;
    const dc = l.pc.createDataChannel("p2pcg-mesh");
    this.attach(l, new FramedChannel(dc));
    try {
      const offer = await gathered(l.pc);
      const msg = { type: "offer", from: this.me, to: them, key: this.myKey, sdp: offer.sdp, sdpType: offer.type };
      await this.room.send(msg);
      // Relays can drop messages: resend until answered.
      const retry = setInterval(() => {
        if (l.answer || this.links.get(them) !== l || this.stopped) return clearInterval(retry);
        void this.room.send(msg);
      }, 3000);
      retry.unref();
    } catch (e) {
      this.log(`offer to ${fingerprint(key)} failed: ${(e as Error).message}`);
      this.forget(l);
    }
  }

  private async answer(m: any) {
    if (!this.o.isMember(m.key) && m.key !== this.myKey) return;
    const existing = this.links.get(m.from);
    if (existing) {
      if (existing.answer && !existing.initiator) await this.room.send({ type: "answer", from: this.me, to: m.from, ...existing.answer });
      return;
    }
    const byKey = this.linkTo(m.key);
    if (byKey?.state === "active" && byKey.them === m.from) return;
    if (byKey) this.close(byKey, "they reconnected");
    const l = this.newLink(m.from, false, m.key);
    if (!l) return;
    l.pc.onDataChannel((dc) => this.attach(l, new FramedChannel(dc)));
    try {
      l.pc.setRemoteDescription(m.sdp, m.sdpType);
      const local = await gathered(l.pc);
      l.answer = { sdp: local.sdp, sdpType: local.type };
      await this.room.send({ type: "answer", from: this.me, to: m.from, ...l.answer });
    } catch (e) {
      this.log(`answer to ${m.from} failed: ${(e as Error).message}`);
      this.forget(l);
    }
  }

  private attach(l: PeerLink, ch: FramedChannel) {
    l.ch = ch;
    ch.onClose(() => this.forget(l));
    ch.onMessage((m: any) => void this.onFrame(l, m));
    const greet = () => this.send(l, { t: "hi", key: this.myKey, nonce: l.nonce });
    if (ch.dc.isOpen()) greet();
    else ch.dc.onOpen(greet);
  }

  private async onFrame(l: PeerLink, m: any) {
    l.lastHeard = Date.now();
    switch (m?.t) {
      case "hi": {
        if (typeof m.key !== "string" || typeof m.nonce !== "string") return this.close(l, "bad hello");
        if (l.key && l.key !== m.key) return this.close(l, "key changed");
        l.key = m.key;
        const msg = `p2pcg-mesh-v1:${this.o.graphId}:${m.nonce}:${this.myKey}`;
        return this.send(l, {
          t: "prove",
          sig: this.o.identity.sign(msg),
          proof: proof(this.o.group.secret, m.nonce, this.myKey),
          joined: this.o.myJoin() ?? null,
        });
      }
      case "prove": {
        if (!l.key) return this.close(l, "prove before hello");
        const ok =
          verifySignature(l.key, `p2pcg-mesh-v1:${this.o.graphId}:${l.nonce}:${l.key}`, m.sig) && checkProof(this.o.group.secret, l.nonce, l.key, m.proof);
        if (!ok) return this.close(l, "proof did not verify");
        if (!this.o.isMember(l.key) && m.joined) await this.o.receive([m.joined], l.key);
        if (!this.o.isMember(l.key)) return this.close(l, "not a member");
        l.proven.them = true;
        l.state = "active";
        this.log(`linked with ${fingerprint(l.key)}`);
        this.o.onChange?.();
        this.send(l, { t: "have", have: this.o.have() });
        // The other side may have checked us first and already sent its sync frames.
        for (const f of l.early.splice(0)) await this.onFrame(l, f);
        return;
      }
      case "have": {
        if (l.state !== "active") return void l.early.push(m);
        const missing = this.o.missing(m.have && typeof m.have === "object" ? m.have : {});
        if (missing.length) this.log(`catching ${fingerprint(l.key!)} up: ${missing.length} change(s)`);
        this.sendChanges(l, missing);
        return;
      }
      case "changes": {
        if (!Array.isArray(m.changes)) return;
        if (l.state !== "active") return void (l.early.length < 1000 && l.early.push(m));
        const fresh = await this.o.receive(m.changes, l.key!);
        this.broadcast(fresh, l.key);
        return;
      }
      case "ping":
        return this.send(l, { t: "pong" });
      case "pong":
        return;
    }
  }

  private sendChanges(l: PeerLink, changes: Change[]) {
    for (let i = 0; i < changes.length; i += BATCH) this.send(l, { t: "changes", changes: changes.slice(i, i + BATCH) });
  }

  private send(l: PeerLink, m: Record<string, unknown>) {
    try {
      l.ch?.send(m);
    } catch {
      this.forget(l);
    }
  }

  private close(l: PeerLink, reason: string) {
    this.log(`closing link ${l.key ? fingerprint(l.key) : l.them}: ${reason}`);
    try {
      l.pc.close();
    } catch {
      // already closed
    }
    this.forget(l);
  }

  private forget(l: PeerLink) {
    if (this.links.get(l.id) !== l) return;
    this.links.delete(l.id);
    try {
      l.pc.close();
    } catch {
      // already closed
    }
    this.o.onChange?.();
    // Look for the others again soon: this one may come straight back.
    if (!this.stopped) setTimeout(() => this.hello(), 1000).unref();
  }
}

/** The group's signalling room: named from the graph id, sealed with the group secret. */
export function groupLink(graphId: string, secret: Buffer): Link {
  return { room: `group-${graphId}`, secret };
}
