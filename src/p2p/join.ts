// The newcomer's side of a join code: reach the machine that made the code,
// prove the code's secret and this machine's key, and receive the graph (its
// id, name, group secret and whole change log). After that the newcomer has
// its own copy and meets the other members in the mesh; the code isn't needed
// again.

import { randomBytes } from "node:crypto";
import nodeDataChannel from "node-datachannel";
import type { Change } from "../core/changes.js";
import type { Identity } from "../core/identity.js";
import { FramedChannel } from "./channel.js";
import { gathered } from "./invites.js";
import { b64u, proof, type Link } from "./link.js";
import type { SignalFactory } from "./signal.js";

export interface Welcome {
  host: string;
  graph: { id: string; name: string; secret: string };
  role: string;
  changes: Change[];
}

export interface JoinOptions {
  signal: SignalFactory;
  ice: string[];
  about?: Record<string, string | undefined>;
  /** Give up if no one answers by then. */
  timeoutMs?: number;
  log?(msg: string): void;
}

export class JoinRefused extends Error {}

export function joinWithCode(link: Link, identity: Identity, o: JoinOptions): Promise<Welcome> {
  const me = b64u(randomBytes(6));
  const pc = new nodeDataChannel.PeerConnection(`p2pcg-join-${me}`, { iceServers: o.ice });
  let answered = false;
  let offerTimer: NodeJS.Timeout | undefined;
  let settled = false;

  return new Promise<Welcome>((resolve, reject) => {
    const signaller = o.signal(link, (m) => {
      if (m?.type !== "answer" || m.to !== me || answered) return;
      answered = true;
      clearInterval(offerTimer);
      try {
        pc.setRemoteDescription(m.sdp, m.sdpType);
      } catch (e) {
        fail(new Error(`Bad answer: ${(e as Error).message}`));
      }
    });
    const finish = () => {
      settled = true;
      clearInterval(offerTimer);
      clearTimeout(deadline);
      signaller.close();
      setTimeout(() => {
        try {
          pc.close();
        } catch {
          // already closed
        }
      }, 500).unref();
    };
    const fail = (e: Error) => {
      if (settled) return;
      finish();
      reject(e);
    };
    const timeoutMs = o.timeoutMs ?? 30_000;
    const deadline = setTimeout(
      () =>
        fail(
          new Error(
            answered
              ? "Reached the person who invited you, but the connection didn't finish (a TURN server may be needed: P2PCG_ICE)."
              : "No answer. The person who invited you isn't online right now (their machine answers the code), or the code has expired or was cancelled. Try again later, or ask them for a new code.",
          ),
        ),
      timeoutMs,
    );
    deadline.unref();
    pc.onStateChange((s) => {
      if (s === "failed") fail(new Error("Could not reach the person who invited you (NAT traversal failed; a TURN server may be needed: P2PCG_ICE)."));
    });

    const ch = new FramedChannel(pc.createDataChannel("p2pcg-join"));
    ch.onMessage((m: any) => {
      if (settled) return;
      if (m?.t === "challenge") {
        ch.send({
          t: "auth",
          proof: proof(link.secret, m.nonce, me),
          name: identity.name,
          key: identity.publicKey,
          sig: identity.sign(`p2pcg-id-v1:${m.nonce}:${me}`),
          about: o.about ?? {},
        });
      } else if (m?.t === "denied") {
        fail(new JoinRefused(m.reason ?? "The code was refused."));
      } else if (m?.t === "welcome") {
        if (!m.graph || typeof m.graph.id !== "string" || typeof m.graph.secret !== "string" || !Array.isArray(m.changes))
          return fail(new Error("The welcome was incomplete."));
        try {
          ch.send({ t: "thanks" });
        } catch {
          // they close anyway
        }
        finish();
        resolve({ host: String(m.host ?? ""), graph: { id: m.graph.id, name: String(m.graph.name ?? "graph"), secret: m.graph.secret }, role: String(m.role ?? ""), changes: m.changes });
      }
    });
    ch.onClose(() => fail(new Error("The connection closed before the graph arrived.")));

    void (async () => {
      const offer = await gathered(pc);
      const msg = { type: "offer", from: me, sdp: offer.sdp, sdpType: offer.type };
      const send = async () => {
        if (answered || settled) return clearInterval(offerTimer);
        if (!(await signaller.send(msg))) o.log?.("no signalling relay accepted the offer; retrying");
      };
      await send();
      offerTimer = setInterval(() => void send(), 3000);
      offerTimer.unref();
    })().catch((e) => fail(e as Error));
  });
}
