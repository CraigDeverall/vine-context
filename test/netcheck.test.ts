// The network check (vine doctor, vine setup): STUN over UDP from one socket,
// against fake STUN servers on this machine, and the verdict from it.

import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { bindingRequest, describeNet, judgeNat, parseBindingResponse, probeStun, stunTarget } from "../src/p2p/netcheck.js";
import { unreachableAdvice } from "../src/p2p/advice.js";

const MAGIC = 0x2112a442;

/** A Binding success response with XOR-MAPPED-ADDRESS. */
function response(req: Buffer, address: string, port: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt16BE(0x0101, 0);
  b.writeUInt16BE(12, 2);
  req.copy(b, 4, 4, 20); // cookie + transaction id
  b.writeUInt16BE(0x0020, 20);
  b.writeUInt16BE(8, 22);
  b.writeUInt8(0, 24);
  b.writeUInt8(1, 25);
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 26);
  const raw = address.split(".").reduce((a, o) => (a << 8) | Number(o), 0) >>> 0;
  b.writeUInt32BE((raw ^ MAGIC) >>> 0, 28);
  return b;
}

const servers: Socket[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A fake STUN server that reports `map(port it saw)` as the public address. */
async function fakeStun(map: (seenPort: number) => { address: string; port: number }): Promise<string> {
  const s = createSocket("udp4");
  servers.push(s);
  s.on("message", (msg, from) => {
    const { address, port } = map(from.port);
    s.send(response(msg, address, port), from.port, from.address);
  });
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
  return `stun:127.0.0.1:${s.address().port}`;
}

describe("STUN", () => {
  it("reads the public address from a Binding response, and ignores someone else's", () => {
    const txid = Buffer.alloc(12, 7);
    const req = bindingRequest(txid);
    expect(req.length).toBe(20);
    expect(parseBindingResponse(response(req, "203.0.113.9", 51000), txid)).toEqual({ address: "203.0.113.9", port: 51000 });
    expect(parseBindingResponse(response(req, "203.0.113.9", 51000), Buffer.alloc(12, 8))).toBeUndefined();
    expect(stunTarget("stun:stun.l.google.com:19302")).toEqual({ host: "stun.l.google.com", port: 19302 });
  });

  it("asks both servers from one socket: the same mapping means direct connections should work", async () => {
    const a = await fakeStun((p) => ({ address: "203.0.113.9", port: p + 1000 }));
    const b = await fakeStun((p) => ({ address: "203.0.113.9", port: p + 1000 }));
    const got = await probeStun([a, b], 2000);
    expect(got.every((g) => g.address === "203.0.113.9")).toBe(true);
    expect(got[0]!.port).toBe(got[1]!.port);
    expect(judgeNat(got, new Set())).toBe("direct");
  });

  it("different public ports for the same socket: symmetric NAT, likely to need TURN", async () => {
    const a = await fakeStun(() => ({ address: "203.0.113.9", port: 40001 }));
    const b = await fakeStun(() => ({ address: "203.0.113.9", port: 40002 }));
    const nat = judgeNat(await probeStun([a, b], 2000), new Set());
    expect(nat).toBe("symmetric");
    expect(describeNet(nat, 3, 5)).toMatchObject({ needsTurn: true, summary: expect.stringContaining("will likely need TURN") });
  });

  it("no answer at all: UDP is blocked", async () => {
    const silent = createSocket("udp4");
    servers.push(silent);
    await new Promise<void>((r) => silent.bind(0, "127.0.0.1", r));
    const got = await probeStun([`stun:127.0.0.1:${silent.address().port}`], 700);
    expect(got[0]!.error).toBeDefined();
    expect(judgeNat(got)).toBe("udp-blocked");
    expect(describeNet("udp-blocked", 0, 5)).toMatchObject({ needsTurn: true, summary: expect.stringContaining("None of the 5 Nostr relays") });
  });

  it("an address that is this machine's own: public, no NAT", () => {
    expect(judgeNat([{ server: "a", address: "198.51.100.1", port: 1 }], new Set(["198.51.100.1"]))).toBe("public");
  });
});

describe("the advice when members can't be connected to", () => {
  it("names the member and the command when nothing gets through and there's no TURN", () => {
    const m = unreachableAdvice(["Sam"], { anyLinked: false, turn: "none" });
    expect(m).toMatch(/^Found Sam's machine, but your networks wouldn't allow a direct connection/);
    expect(m).toContain("vine turn set --provider cloudflare");
    expect(m).toContain("only one of you needs one");
  });
  it("says there's nothing to do when another member is linked", () => {
    expect(unreachableAdvice(["Sam", "Ana"], { anyLinked: true, turn: "none" })).toMatch(/Sam and Ana.*Nothing to do/);
  });
  it("points at vine turn test when a TURN server is set but didn't get through", () => {
    expect(unreachableAdvice(["Sam"], { anyLinked: false, turn: "cloudflare" })).toContain("vine turn test");
  });
});
