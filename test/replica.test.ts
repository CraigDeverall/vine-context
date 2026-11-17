// Replicated graphs: every member keeps a full copy, and the online members
// keep each other in step over the mesh. These run real WebRTC between hosts
// in one process, with in-process signalling.

import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host, placeReplica } from "../src/host/host.js";
import { joinWithCode } from "../src/p2p/join.js";
import { parseCode } from "../src/p2p/link.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

// Graphs share by default; the test config turns that off for the other tests.
process.env.P2PCG_AUTO_SHARE = "on";
const signal = memorySignaller(new EventEmitter());
const ice: string[] = [];
const running: Host[] = [];
afterAll(() => running.forEach((h) => h.stop()));

type Row = Record<string, any>;
const HOLD = 150;

interface Member {
  name: string;
  dataDir: string;
  graph: string;
  host: Host;
  local: LocalHost;
  events: { event: string; data: any }[];
  call(tool: string, args?: Record<string, unknown>): Promise<any>;
  restart(): Promise<void>;
  stop(): void;
}

async function member(name: string, graph: string, dataDir = tempDir()): Promise<Member> {
  const m = { name, dataDir, graph, events: [] as { event: string; data: any }[] } as Member;
  const start = async () => {
    m.host = await Host.start({ dataDir, graph, user: name, signal, ice, holdMs: HOLD });
    running.push(m.host);
    m.local = await LocalHost.connect(m.host.socket);
    m.local.on("event", (e) => m.events.push(e));
  };
  await start();
  m.call = (tool, args = {}) => m.local.request("call", { tool, args });
  m.restart = async () => {
    m.stop();
    await start();
  };
  m.stop = () => {
    m.local.close();
    m.host.stop();
  };
  return m;
}

/** Joins `owner`'s graph with a fresh code, as join_graph does. */
async function join(owner: Member, name: string, opts: { role?: string; label?: string } = {}): Promise<Member> {
  const { code } = await owner.local.request<{ code: string }>("share", opts);
  const dataDir = tempDir();
  const welcome = await joinWithCode(parseCode(code), loadIdentity(dataDir, name), { signal, ice, about: { agent: "test-agent", platform: "testOS" } });
  expect(placeReplica(dataDir, welcome.graph.name, welcome.graph, welcome.changes)).toBe(true);
  return member(name, welcome.graph.name, dataDir);
}

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const texts = async (m: Member) => ((await m.call("beliefs", {})) as Row[]).map((r) => r.text).sort();
const has = (m: Member, text: string) => async () => (await texts(m)).includes(text);
let n = 0;

describe("replicated graphs", () => {
  it("joins with a code: a full copy at once, everyone told, the code tied to that machine", async () => {
    const alice = await member("alice", `team${++n}`);
    await alice.call("add_claim", { text: "Written before bob joined" });
    const bob = await join(alice, "bob", { label: "for bob" });
    // Bob's copy has alice's claim straight away, before any sync.
    expect(await texts(bob)).toEqual(["Written before bob joined"]);
    const info = await bob.local.request<Row>("info");
    expect(info.you).toMatchObject({ name: "bob", role: "contributor" });
    expect(info.people.map((p: Row) => p.name).sort()).toEqual(["alice", "bob"]);
    // Alice's sessions are told who joined.
    await waitFor(() => alice.events.some((e) => e.event === "joined"));
    expect(alice.events.find((e) => e.event === "joined")!.data).toMatchObject({ name: "bob", role: "contributor", invite: { label: "for bob" }, agent: "test-agent", platform: "testOS" });
    // Someone else using bob's code is turned away.
    const status = await alice.local.request<Row>("status");
    const used = status.invites.find((i: Row) => i.label === "for bob");
    expect(used).toMatchObject({ state: "used", for: { name: "bob" } });
  });

  it("syncs writes both ways once they leave the hold; Undo in the hold means it never leaves", async () => {
    const alice = await member("alice", `team${++n}`);
    const bob = await join(alice, "bob");
    await waitFor(async () => (await bob.local.request<Row>("status")).links.some((l: Row) => l.state === "active"));

    const kept = await bob.call("add_claim", { text: "Bob's shared claim" });
    expect(kept.shared_at).toBeDefined();
    const oops = await bob.call("add_claim", { text: "My home address is 1 Secret Street" });
    expect(await bob.local.request("take_back", { id: oops.change })).toMatchObject({ taken_back: oops.change });
    await alice.call("add_claim", { text: "Alice's shared claim" });

    await waitFor(has(alice, "Bob's shared claim"));
    await waitFor(has(bob, "Alice's shared claim"));
    await sleep(HOLD * 3);
    expect(await texts(alice)).not.toContain("My home address is 1 Secret Street");
    expect(await texts(bob)).not.toContain("My home address is 1 Secret Street");
    // After the hold, it can only be withdrawn.
    await expect(bob.local.request("take_back", { id: kept.change })).rejects.toThrow(/already been shared/);
  });

  it("catches up after being offline, and members sync with each other while the creator is away", async () => {
    const alice = await member("alice", `team${++n}`);
    const bob = await join(alice, "bob");
    const carol = await join(alice, "carol");
    await waitFor(async () => (await bob.local.request<Row>("status")).people.length === 3);

    // Bob goes offline; alice writes; bob comes back and catches up.
    bob.stop();
    await alice.call("add_claim", { text: "Written while bob was away" });
    await bob.restart();
    await waitFor(has(bob, "Written while bob was away"));

    // Bob writes offline, from his own copy.
    await bob.local.request("unshare");
    await bob.call("add_claim", { text: "Written by bob offline" });
    await sleep(HOLD * 2);
    expect(await texts(bob)).toContain("Written by bob offline");

    // Alice (the creator) goes away. Bob comes online; carol gets bob's write from bob.
    alice.stop();
    await bob.local.request("start_sharing");
    await waitFor(has(carol, "Written by bob offline"));
    await carol.call("add_claim", { text: "Carol wrote while alice was away" });
    await waitFor(has(bob, "Carol wrote while alice was away"));

    // Alice comes back and has everything.
    await alice.restart();
    await waitFor(has(alice, "Carol wrote while alice was away"));
    await waitFor(has(alice, "Written by bob offline"));
  });

  it("applies roles everywhere: a reader can't write, and a removed member's later writes are refused", async () => {
    const alice = await member("alice", `team${++n}`);
    const bob = await join(alice, "bob", { role: "reader" });
    const carol = await join(alice, "carol");
    await expect(bob.call("add_claim", { text: "A reader's write" })).rejects.toThrow(/needs the contributor role/);

    await alice.local.request("set_role", { name: "bob", role: "contributor" });
    await waitFor(async () => (await bob.local.request<Row>("info")).you.role === "contributor");
    await bob.call("add_claim", { text: "Now bob can write" });
    await waitFor(has(alice, "Now bob can write"));

    await alice.local.request("remove", { name: "carol" });
    await waitFor(async () => (await bob.local.request<Row>("info")).people.find((p: Row) => p.name === "carol")?.removed_at);
    await waitFor(() => carol.events.some((e) => e.event === "removed"));
    await expect(carol.call("add_claim", { text: "Carol after removal" })).rejects.toThrow(/removed/);
    // Carol still has her copy to read.
    expect(await texts(carol)).toContain("Now bob can write");
  });

  it("ends up with the same graph on every machine", async () => {
    const alice = await member("alice", `team${++n}`);
    const bob = await join(alice, "bob");
    const carol = await join(alice, "carol");
    const everyone = [alice, bob, carol];
    await waitFor(async () => {
      for (const m of everyone) if ((await m.local.request<Row>("status")).links.filter((l: Row) => l.state === "active").length < 2) return false;
      return true;
    });
    const claims: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      const m = everyone[i % 3]!;
      const ids = Object.values(claims);
      const args: Record<string, unknown> = { text: `Claim ${i} by ${m.name}` };
      if (ids.length && i % 2) args.supports = [ids[(i * 7) % ids.length]];
      try {
        const r = await m.call("add_claim", args);
        claims[`c${i}`] = r.id;
      } catch {
        // a support target this member hasn't received yet: fine, skip it
      }
    }
    const snap = async (m: Member) => {
      const s = await m.local.request<Row>("snapshot", { limit: 1000 });
      return JSON.stringify({ nodes: s.nodes.map((x: Row) => x.id).sort(), edges: s.edges.map((e: Row) => `${e.source}>${e.type}>${e.target}`).sort() });
    };
    await waitFor(async () => {
      const all = await Promise.all(everyone.map(snap));
      return new Set(all).size === 1 && JSON.parse(all[0]!).nodes.length === Object.keys(claims).length;
    }, 30_000);
  });

  it("keeps sharing across a restart, and stop_sharing stays off", async () => {
    const alice = await member("alice", `team${++n}`);
    expect((await alice.local.request<Row>("status")).sharing).toBe(true);
    await alice.restart();
    expect((await alice.local.request<Row>("status")).sharing).toBe(true);
    await alice.local.request("unshare");
    await alice.restart();
    expect((await alice.local.request<Row>("status")).sharing).toBe(false);
  });

  it("turns away a second machine using a code that's already been used", async () => {
    const alice = await member("alice", `team${++n}`);
    const { code } = await alice.local.request<{ code: string }>("share", {});
    const bobDir = tempDir();
    await joinWithCode(parseCode(code), loadIdentity(bobDir, "bob"), { signal, ice });
    await expect(joinWithCode(parseCode(code), loadIdentity(tempDir(), "mallory"), { signal, ice })).rejects.toThrow(/already been used on another machine/);
    // The machine it belongs to can use it again (say, to fetch the graph again).
    await expect(joinWithCode(parseCode(code), loadIdentity(bobDir, "bob"), { signal, ice })).resolves.toMatchObject({ graph: { name: alice.graph } });
  });

  it("keeps a write that was still held when the host stopped, and sends it on the next start", async () => {
    const alice = await member("alice", `team${++n}`);
    const bob = await join(alice, "bob");
    alice.host.stop();
    // Writing straight to the store isn't possible without a host: use bob, and stop him mid-hold.
    await bob.call("add_claim", { text: "Held when bob stopped" });
    bob.stop();
    await alice.restart();
    await bob.restart();
    await waitFor(has(alice, "Held when bob stopped"));
  });
});
