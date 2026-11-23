// Links through a real TURN server. Skipped unless VINE_TEST_TURN names one
// (host:port): `npm run test:turn` starts coturn in Docker and sets it, and CI
// does the same on Linux.
//
// The member with the TURN server is made relay-only, so a link can only form
// through the server; the other member has no STUN or TURN server at all.

import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host, placeReplica } from "../src/host/host.js";
import { checkStoredTurn, checkTurn, parseHostPort, resolveIce, saveTurn, type IceSource } from "../src/p2p/ice.js";
import { joinWithCode } from "../src/p2p/join.js";
import { parseCode } from "../src/p2p/link.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

const where = process.env.VINE_TEST_TURN;
const username = process.env.VINE_TEST_TURN_USER ?? "vine";
const password = process.env.VINE_TEST_TURN_PASSWORD ?? "vine-test-only";

process.env.VINE_AUTO_SHARE = "on";
delete process.env.VINE_ICE;

type Row = Record<string, any>;
const running: Host[] = [];
const clients: LocalHost[] = [];
afterAll(() => {
  clients.forEach((c) => c.close());
  running.forEach((h) => h.stop());
});

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 25_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** A data folder whose setting is the test TURN server. */
function withTurn(dataDir = tempDir()): string {
  saveTurn(dataDir, { ...parseHostPort(where!), username, password });
  return dataDir;
}

interface Member {
  host: Host;
  local: LocalHost;
  texts(): Promise<string[]>;
}

/** `relayOnly` members use the setting in their data folder and nothing but its TURN server; the others have no servers. */
async function member(name: string, graph: string, dataDir: string, signal: ReturnType<typeof memorySignaller>, relayOnly: boolean): Promise<Member> {
  const log = process.env.VINE_TEST_LOG ? (m: string) => console.log(`${name}: ${m}`) : undefined;
  const host = await Host.start({ dataDir, graph, user: name, signal, holdMs: 100, log, ...(relayOnly ? { icePolicy: "relay" as const } : { ice: [] }) });
  running.push(host);
  const local = await LocalHost.connect(host.socket);
  clients.push(local);
  return { host, local, texts: async () => ((await local.request("call", { tool: "beliefs", args: {} })) as Row[]).map((r) => r.text).sort() };
}

const linked = (m: Member) => async () => (await m.local.request<Row>("status")).links.some((l: Row) => l.state === "active");
let n = 0;

describe.skipIf(!where)("a TURN server", () => {
  it("answers the check with the right password, and not with a wrong one", async () => {
    const good = await checkStoredTurn(withTurn());
    expect(good).toMatchObject({ ok: true, relay: expect.stringMatching(/:\d+$/) });

    const { host, port } = parseHostPort(where!);
    const bad = await checkTurn({ hostname: host, port: port ?? 3478, username, password: "not-the-password", relayType: "TurnUdp" }, 6000);
    expect(bad.ok).toBe(false);
  });

  it("carries a join and the sync when only the inviting member has it", async () => {
    const signal = memorySignaller(new EventEmitter());
    const aliceDir = withTurn();
    const alice = await member("alice", `turn${++n}`, aliceDir, signal, true);
    await alice.local.request("call", { tool: "add_claim", args: { text: "Written before bob joined" } });

    // Bob joins with no STUN or TURN server of his own: alice's side answers through hers.
    const { code } = await alice.local.request<{ code: string }>("share", {});
    const bobDir = tempDir();
    const welcome = await joinWithCode(parseCode(code), loadIdentity(bobDir, "bob"), { signal, ice: [], about: {} });
    expect(placeReplica(bobDir, welcome.graph.name, welcome.graph, welcome.changes)).toBe(true);
    const bob = await member("bob", welcome.graph.name, bobDir, signal, false);
    expect(await bob.texts()).toEqual(["Written before bob joined"]);

    await waitFor(linked(alice));
    await bob.local.request("call", { tool: "add_claim", args: { text: "Bob's claim" } });
    await alice.local.request("call", { tool: "add_claim", args: { text: "Alice's claim" } });
    await waitFor(async () => (await alice.texts()).includes("Bob's claim"));
    await waitFor(async () => (await bob.texts()).includes("Alice's claim"));

    // Status shows the server and the route, and never the password.
    const status = await alice.local.request<Row>("status");
    expect(status.ice).toEqual(resolveIce(aliceDir).summary);
    expect(status.ice).toMatchObject({ turn: expect.stringContaining("(udp)"), source: "setting" });
    expect(status.links).toEqual([expect.objectContaining({ name: "bob", state: "active", route: "relayed" })]);
    expect(JSON.stringify(status)).not.toContain(password);
    // Bob set nothing, so his status has no server to show.
    expect((await bob.local.request<Row>("status")).ice).toBeUndefined();
  });

  it("carries a join and the sync when only the joining member has it", async () => {
    const signal = memorySignaller(new EventEmitter());
    const alice = await member("alice", `turn${++n}`, tempDir(), signal, false);
    await alice.local.request("call", { tool: "add_claim", args: { text: "Alice's first claim" } });

    const { code } = await alice.local.request<{ code: string }>("share", {});
    const bobDir = withTurn();
    const relayOnly: IceSource = () => ({ ...resolveIce(bobDir).config, policy: "relay" });
    const welcome = await joinWithCode(parseCode(code), loadIdentity(bobDir, "bob"), { signal, ice: relayOnly, about: {} });
    expect(placeReplica(bobDir, welcome.graph.name, welcome.graph, welcome.changes)).toBe(true);
    const bob = await member("bob", welcome.graph.name, bobDir, signal, true);

    await waitFor(linked(bob));
    await bob.local.request("call", { tool: "add_claim", args: { text: "Bob's claim" } });
    await waitFor(async () => (await alice.texts()).includes("Bob's claim"));
    expect((await bob.local.request<Row>("status")).links).toEqual([expect.objectContaining({ name: "alice", route: "relayed" })]);
  });

  it("is picked up by a host that was already running", async () => {
    const signal = memorySignaller(new EventEmitter());
    // Alice starts relay-only with no server set: no link can form.
    const aliceDir = tempDir();
    const alice = await member("alice", `turn${++n}`, aliceDir, signal, true);
    const { code } = await alice.local.request<{ code: string }>("share", {});
    const bobDir = tempDir();
    await expect(joinWithCode(parseCode(code), loadIdentity(bobDir, "bob"), { signal, ice: [], about: {}, timeoutMs: 6000 })).rejects.toThrow(/TURN server/);

    // The server is set while her host runs: the next join goes through.
    withTurn(aliceDir);
    const again = await alice.local.request<{ code: string }>("share", {});
    const welcome = await joinWithCode(parseCode(again.code), loadIdentity(bobDir, "bob"), { signal, ice: [], about: {} });
    expect(welcome.graph.name).toBeDefined();
  });
});
