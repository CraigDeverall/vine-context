// A member found through the relays whose links never connect: the mesh
// counts it, says so once, and forgets it when a link works.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { Mesh, groupLink } from "../src/p2p/mesh.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

const meshes: Mesh[] = [];
afterEach(() => meshes.splice(0).forEach((m) => m.stop()));

const waitFor = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("an unreachable member", () => {
  it("is reported after two failed attempts, once", async () => {
    const signal = memorySignaller(new EventEmitter());
    const group = groupLink("g-unreachable", Buffer.alloc(32, 1));
    const a = loadIdentity(tempDir(), "ana");
    const b = loadIdentity(tempDir(), "sam");
    const members = new Set([a.publicKey, b.publicKey]);
    const reported: string[] = [];
    // Relay-only with no TURN server: the handshake goes through the (fake) relays, but no route can connect.
    const blocked = () => ({ servers: [], policy: "relay" as const });
    const make = (id: typeof a, onUnreachable?: (k: string) => void) => {
      const m = new Mesh({
        group,
        graphId: "g-unreachable",
        identity: id,
        signal,
        ice: blocked,
        isMember: (k) => members.has(k),
        myJoin: () => undefined,
        have: () => ({}),
        missing: () => [],
        receive: async () => [],
        onUnreachable,
        pingMs: 200,
        helloMs: 300,
        connectMs: 600,
      });
      meshes.push(m);
      return m;
    };
    const ma = make(a, (k) => reported.push(k));
    const mb = make(b, (k) => reported.push(`b:${k}`));
    await waitFor(() => ma.unreachable().length > 0 || mb.unreachable().length > 0);
    const [side, other] = ma.unreachable().length ? [ma, b] : [mb, a];
    expect(side.unreachable()[0]).toMatchObject({ key: other.publicKey, attempts: 2 });
    expect(side.online().filter((l) => l.state === "active")).toHaveLength(0);
    // More failures don't repeat the notice.
    await new Promise((r) => setTimeout(r, 2000));
    expect(reported.filter((r) => r.endsWith(other.publicKey))).toHaveLength(1);
  });
});
