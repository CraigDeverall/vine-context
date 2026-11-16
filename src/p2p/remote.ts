// The joining side of the star: connects to a host from a join code, proves
// the code's secret and this install's identity, waits for approval, then
// forwards requests to the host.

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import nodeDataChannel, { type PeerConnection } from "node-datachannel";
import type { Identity } from "../core/identity.js";
import type { Role } from "../core/graph.js";
import { FramedChannel } from "./channel.js";
import { gathered } from "./hub.js";
import { b64u, proof, type Link } from "./link.js";
import { RpcClient, type Message } from "./protocol.js";
import type { SignalFactory, Signaller } from "./signal.js";

export type RemoteState = "connecting" | "pending" | "active" | "denied" | "closed";

export interface RemoteOptions {
  signal: SignalFactory;
  ice: string[];
  /** Give up if the host hasn't answered the offer by then. */
  answerTimeoutMs?: number;
  log?(msg: string): void;
}

export class RemoteHost extends EventEmitter {
  state: RemoteState = "connecting";
  role?: Role;
  hostName?: string;
  reason?: string;
  private me = b64u(randomBytes(6));
  private pc: PeerConnection;
  private ch?: FramedChannel;
  private signaller: Signaller;
  private rpc: RpcClient;
  private offerTimer?: NodeJS.Timeout;
  /** Settles when the host answers our auth: welcome, pending, or a refusal. */
  readonly admitted: Promise<RemoteState>;

  constructor(
    private link: Link,
    private identity: Identity,
    private o: RemoteOptions,
  ) {
    super();
    this.rpc = new RpcClient((m) => this.send(m));
    this.pc = new nodeDataChannel.PeerConnection(`p2pcg-peer-${this.me}`, { iceServers: o.ice });
    let answered = false;
    this.signaller = o.signal(link, (m) => {
      if (m?.type !== "answer" || m.to !== this.me || answered) return;
      answered = true;
      clearInterval(this.offerTimer);
      try {
        this.pc.setRemoteDescription(m.sdp, m.sdpType);
      } catch (e) {
        this.finish("closed", `Bad answer from the host: ${(e as Error).message}`);
      }
    });
    this.pc.onStateChange((s) => {
      if ((s === "failed" || s === "disconnected" || s === "closed") && this.state !== "denied" && this.state !== "closed")
        this.finish("closed", s === "failed" ? "Could not reach the host (NAT traversal failed; a TURN server may be needed)." : "The connection to the host dropped.");
    });

    this.admitted = new Promise<RemoteState>((resolve) => {
      const settle = () => {
        if (this.state !== "connecting") resolve(this.state);
      };
      this.on("state", settle);
    });

    const dc = this.pc.createDataChannel("p2pcg");
    this.ch = new FramedChannel(dc);
    this.ch.onMessage((m: any) => this.onFrame(m));
    this.ch.onClose(() => this.state === "active" || this.state === "pending" ? this.finish("closed", "The connection to the host closed.") : undefined);

    void this.sendOffer(o.answerTimeoutMs ?? 30_000);
  }

  private async sendOffer(timeoutMs: number) {
    const offer = await gathered(this.pc);
    const msg = { type: "offer", from: this.me, sdp: offer.sdp, sdpType: offer.type };
    const started = Date.now();
    const attempt = async () => {
      if (this.state !== "connecting") return clearInterval(this.offerTimer);
      if (Date.now() - started > timeoutMs) {
        clearInterval(this.offerTimer);
        return this.finish("closed", "No answer from the host. Either the host is not sharing right now, or this join code has expired or was cancelled (then ask for a new one).");
      }
      const ok = await this.signaller.send(msg);
      if (!ok) this.o.log?.("no signalling relay accepted the offer; retrying");
    };
    await attempt();
    // Relays can drop messages: resend until the host answers.
    this.offerTimer = setInterval(() => void attempt(), 3000);
    this.offerTimer.unref();
  }

  private onFrame(m: any) {
    switch (m?.t) {
      case "challenge":
        this.hostName = m.host;
        this.ch!.send({
          t: "auth",
          proof: proof(this.link.secret, m.nonce, this.me),
          name: this.identity.name,
          key: this.identity.publicKey,
          sig: this.identity.sign(`p2pcg-id-v1:${m.nonce}:${this.me}`),
        });
        return;
      case "pending":
        this.hostName = m.host;
        return this.setState("pending");
      case "welcome":
        this.hostName = m.host;
        this.role = m.role;
        return this.setState("active");
      case "denied":
        return this.finish("denied", m.reason ?? "The host refused.");
      case "closed":
        return this.finish("closed", "The host stopped sharing.");
      case "evt":
        if (m.event === "role") this.role = m.data?.role;
        this.emit("event", m);
        return;
      case "res":
        this.rpc.handle(m as Message);
        return;
    }
  }

  private send(m: Message) {
    if (this.state !== "active" || !this.ch) throw new Error(this.reason ?? "Not connected to the host.");
    this.ch.send(m);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.rpc.request<T>(method, params);
  }

  private setState(s: RemoteState) {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  private finish(s: "denied" | "closed", reason: string) {
    if (this.state === "denied" || this.state === "closed") return;
    this.reason = reason;
    clearInterval(this.offerTimer);
    this.rpc.failAll(reason);
    this.setState(s);
    this.signaller.close();
    setTimeout(() => {
      try {
        this.pc.close();
      } catch {
        // already closed
      }
    }, 100).unref();
  }

  close(): void {
    this.finish("closed", "You left the graph.");
  }
}
