// Spike A: a host-star WebRTC network, with node-datachannel and public Nostr
// relays used only for signalling.
//
//   host:  npx tsx spikes/p2p-star.ts host [--peers N]   → prints a p2pcg:// link
//   peer:  npx tsx spikes/p2p-star.ts join '<link>'
//
// Signalling: ephemeral Nostr events (kind 25050, not stored by relays), tagged
// with a hash of the room id and AES-256-GCM encrypted with a key derived from
// the link secret. The secret is in the link's #fragment and never sent.
// Non-trickle ICE: each side waits for gathering to finish and sends one SDP.
// After the channel opens, the host challenges the peer to prove the secret
// (HMAC) before it accepts any other frame.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import nodeDataChannel, { type DataChannel, type PeerConnection } from "node-datachannel";
import { RelaySet } from "../src/p2p/nostr.ts";

const RELAYS = (process.env.P2PCG_RELAYS ?? "wss://relay.primal.net,wss://offchain.pub,wss://relay.snort.social,wss://relay.nostr.net,wss://nos.lol").split(",");
const ICE = (process.env.P2PCG_ICE ?? "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478").split(",");
const KIND = 25050;
const t0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

// ---- link and crypto ------------------------------------------------------
function parseLink(link: string) {
  const m = /^p2pcg:\/\/join\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)$/.exec(link);
  if (!m) throw new Error("not a p2pcg join link");
  return { room: m[1]!, secret: unb64u(m[2]!) };
}
function roomKeys(room: string, secret: Buffer) {
  const tag = createHash("sha256").update(`p2pcg-room:${room}`).digest("hex").slice(0, 32);
  const key = Buffer.from(hkdfSync("sha256", secret, room, "p2pcg-signal-v1", 32));
  return { tag, key };
}
function seal(key: Buffer, obj: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), body]));
}
function open(key: Buffer, s: string): any | null {
  try {
    const raw = unb64u(s);
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString());
  } catch {
    return null; // someone else's traffic on the same tag, or tampered
  }
}
const mac = (secret: Buffer, nonce: string, peer: string) =>
  createHmac("sha256", secret).update(`${nonce}:${peer}`).digest();

// ---- signalling over Nostr --------------------------------------------------
function signaller(room: string, secret: Buffer, onMessage: (m: any) => void) {
  const { tag, key } = roomKeys(room, secret);
  const relays = new RelaySet(RELAYS);
  relays.subscribe({ kinds: [KIND], "#t": [tag], since: Math.floor(Date.now() / 1000) - 5 }, (ev) => {
    const m = open(key, ev.content);
    if (m) onMessage(m);
  });
  return {
    send: (m: unknown) => relays.publish({ kind: KIND, tags: [["t", tag]], content: seal(key, m) }),
    close: () => relays.close(),
    status: relays.status,
  };
}

function gathered(pc: PeerConnection): Promise<{ sdp: string; type: string }> {
  return new Promise((resolve) => {
    const done = () => resolve(pc.localDescription() as { sdp: string; type: string });
    if (pc.gatheringState() === "complete") return done();
    pc.onGatheringStateChange((s) => s === "complete" && done());
  });
}
const candTypes = (sdp: string) => [...new Set([...sdp.matchAll(/ typ (\w+)/g)].map((m) => m[1]))].join(",");
const send = (dc: DataChannel, obj: unknown) => dc.sendMessage(JSON.stringify(obj));

// ---- host -----------------------------------------------------------------
async function host(expectPeers: number) {
  const room = b64u(randomBytes(16));
  const secret = randomBytes(32);
  console.log(`p2pcg://join/${room}#${b64u(secret)}`);
  const peers = new Map<string, { pc: PeerConnection; authed: boolean }>();
  let finished = 0;

  const sig = signaller(room, secret, async (m) => {
    if (m.type !== "offer" || peers.has(m.from)) return;
    log(`offer from ${m.from} (candidates: ${candTypes(m.sdp)})`);
    const pc = new nodeDataChannel.PeerConnection(`host-${m.from}`, { iceServers: ICE });
    peers.set(m.from, { pc, authed: false });
    pc.onStateChange((s) => log(`${m.from} state ${s}`));
    pc.onDataChannel((dc) => {
      const nonce = b64u(randomBytes(16));
      const peer = peers.get(m.from)!;
      dc.onMessage((raw) => {
        const msg = JSON.parse(String(raw));
        if (!peer.authed) {
          const want = mac(secret, nonce, m.from);
          const got = msg.t === "auth" ? unb64u(msg.mac) : Buffer.alloc(0);
          if (got.length !== want.length || !timingSafeEqual(got, want)) {
            log(`${m.from} failed auth; closing`);
            return pc.close();
          }
          peer.authed = true;
          log(`${m.from} authenticated; pair ${JSON.stringify(pc.getSelectedCandidatePair?.())}`);
          return send(dc, { t: "welcome", peers: [...peers.keys()] });
        }
        if (msg.t === "rpc") return send(dc, { t: "result", id: msg.id, result: msg.params });
        if (msg.t === "bye") {
          log(`${m.from} done`);
          if (++finished >= expectPeers) {
            for (const p of peers.values()) p.pc.close();
            sig.close();
            setTimeout(() => process.exit(0), 200);
          }
        }
      });
      dc.onOpen(() => send(dc, { t: "challenge", nonce }));
      if (dc.isOpen()) send(dc, { t: "challenge", nonce });
    });
    pc.setRemoteDescription(m.sdp, m.sdpType);
    const answer = await gathered(pc);
    const acks = await sig.send({ type: "answer", to: m.from, sdp: answer.sdp, sdpType: answer.type });
    log(`answer to ${m.from} sent (accepted: ${acks ? 'yes' : 'NO'}, candidates: ${candTypes(answer.sdp)})`);
  });
  log(`hosting; waiting for ${expectPeers} peer(s) on ${RELAYS.length} relays`);
}

// ---- peer -----------------------------------------------------------------
async function join(link: string) {
  const { room, secret } = parseLink(link);
  const me = b64u(randomBytes(6));
  const pc = new nodeDataChannel.PeerConnection(`peer-${me}`, { iceServers: ICE });
  pc.onStateChange((s) => log(`state ${s}`));
  const dc = pc.createDataChannel("p2pcg");
  const sig = signaller(room, secret, (m) => {
    if (m.type === "answer" && m.to === me) {
      log(`answer received (candidates: ${candTypes(m.sdp)})`);
      pc.setRemoteDescription(m.sdp, m.sdpType);
    }
  });
  const offer = await gathered(pc);
  const acks = await sig.send({ type: "offer", from: me, sdp: offer.sdp, sdpType: offer.type });
  log(`offer sent as ${me} (accepted: ${acks ? 'yes' : 'NO'})`);

  const rtts: number[] = [];
  const sent = new Map<number, number>();
  let connectedAt = 0;
  dc.onOpen(() => {
    connectedAt = Date.now() - t0;
    log("data channel open");
  });
  dc.onMessage((raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === "challenge") return send(dc, { t: "auth", mac: b64u(mac(secret, msg.nonce, me)) });
    if (msg.t === "welcome") {
      log(`welcomed; peers known to host: ${msg.peers.length}`);
      for (let id = 0; id < 20; id++) {
        sent.set(id, performance.now());
        send(dc, { t: "rpc", id, method: "echo", params: { id, pad: "x".repeat(512) } });
      }
    }
    if (msg.t === "result") {
      rtts.push(performance.now() - sent.get(msg.id)!);
      if (rtts.length === 20) {
        rtts.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            peer: me,
            connectedMs: connectedAt,
            pair: pc.getSelectedCandidatePair?.(),
            rttMs: { p50: +rtts[10]!.toFixed(1), max: +rtts[19]!.toFixed(1) },
          }),
        );
        send(dc, { t: "bye" });
        setTimeout(() => {
          pc.close();
          sig.close();
          process.exit(0);
        }, 300);
      }
    }
  });
  setTimeout(() => {
    log("gave up after 30s");
    process.exit(1);
  }, 30_000);
}

const [role, arg] = process.argv.slice(2);
if (role === "host") await host(Number(process.argv[process.argv.indexOf("--peers") + 1]) || 1);
else if (role === "join" && arg) await join(arg);
else throw new Error("usage: p2p-star.ts host [--peers N] | join <link>");
