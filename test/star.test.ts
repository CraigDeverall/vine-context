// The star network in one process: a real host, real WebRTC data channels on
// loopback, and an in-memory signalling bus instead of public relays.

import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { loadIdentity } from "../src/core/identity.js";
import { LocalHost } from "../src/host/client.js";
import { Host } from "../src/host/host.js";
import { formatCode, parseCode } from "../src/p2p/link.js";
import { RemoteHost } from "../src/p2p/remote.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

const bus = new EventEmitter();
const signal = memorySignaller(bus);
const ice: string[] = [];
const hosts: Host[] = [];
const remotes: RemoteHost[] = [];

afterAll(() => {
  for (const r of remotes) r.close();
  for (const h of hosts) h.stop();
});

let n = 0;
async function startHost(user = "alice") {
  const dataDir = tempDir();
  const host = await Host.start({ dataDir, graph: `star${++n}`, user, signal, ice });
  hosts.push(host);
  const local = await LocalHost.connect(host.socket);
  return { host, local, dataDir };
}

function join(code: string, name: string, dataDir = tempDir(), answerTimeoutMs = 10_000, about?: Record<string, string>) {
  const r = new RemoteHost(parseCode(code), loadIdentity(dataDir, name), { signal, ice, answerTimeoutMs, about });
  remotes.push(r);
  return r;
}

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const nextEvent = (emitter: EventEmitter, name: string, ms = 10_000) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${name} event`)), ms);
    const on = (e: any) => {
      if (e.event !== name) return;
      clearTimeout(t);
      emitter.off("event", on);
      resolve(e);
    };
    emitter.on("event", on);
  });

describe("local sessions share one host", () => {
  it("lets two local clients read each other's writes, and tells them about changes", async () => {
    const { host, local } = await startHost();
    const other = await LocalHost.connect(host.socket);
    const changed = nextEvent(other, "changed");
    const c = await local.request<any>("call", { tool: "add_claim", args: { text: "Both sessions see this" } });
    expect((await changed).data).toMatchObject({ tool: "add_claim", by: "alice" });
    const found = await other.request<any[]>("call", { tool: "search", args: { query: "both sessions" } });
    expect(found[0].id).toBe(c.id);
    other.close();
  });
});

describe("the star", () => {
  it("lets a peer straight in with a code, tells the host's sessions who joined, and records it as the author", async () => {
    const { local } = await startHost("alice");
    const { code } = await local.request<{ code: string }>("share", { label: "for Bob" });
    expect(code).toMatch(/^p2pcg1_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

    const told = nextEvent(local, "joined");
    const bob = join(code, "bob", tempDir(), 10_000, { agent: "test-agent", agent_version: "1.2", p2pcg: "0.0.0", platform: "macOS arm64" });
    expect(await bob.admitted).toBe("active");
    expect((await told).data).toMatchObject({
      name: "bob",
      role: "contributor",
      fingerprint: expect.stringMatching(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/),
      invite: { label: "for Bob" },
      agent: "test-agent",
      agent_version: "1.2",
      platform: "macOS arm64",
    });
    const status = await local.request<any>("status");
    expect(status.people).toEqual([
      expect.objectContaining({ name: "alice", host: true }),
      expect.objectContaining({ name: "bob", role: "contributor", agent: "test-agent 1.2", platform: "macOS arm64", online: true, invite: expect.objectContaining({ label: "for Bob" }) }),
    ]);
    expect(bob.role).toBe("contributor");
    expect(bob.hostName).toBe("alice");

    const d = await bob.request<any>("describe");
    expect(d).toMatchObject({ host: "alice", you: { id: "bob", role: "contributor" }, model: { name: "temporal-claims" } });

    const changed = nextEvent(local, "changed");
    const c = await bob.request<any>("call", { tool: "add_claim", args: { text: "Bob found the root cause" } });
    expect((await changed).data.by).toBe("bob");
    const found = await local.request<any[]>("call", { tool: "search", args: { query: "root cause" } });
    expect(found[0]).toMatchObject({ id: c.id, recorded_by: "bob" });
  });

  it("serves three peers at once", async () => {
    const { local } = await startHost("alice");
    const peers: RemoteHost[] = [];
    for (const name of ["bob", "carol", "dave"]) peers.push(join((await local.request<{ code: string }>("share", { label: `for ${name}` })).code, name));
    expect(await Promise.all(peers.map((p) => p.admitted))).toEqual(["active", "active", "active"]);
    await Promise.all(peers.map((p, i) => p.request("call", { tool: "add_claim", args: { text: `Finding number ${i} from the team` } })));
    const beliefs = await peers[0]!.request<any[]>("call", { tool: "beliefs", args: {} });
    expect(beliefs.map((b) => b.recorded_by).sort()).toEqual(["bob", "carol", "dave"]);
    expect((await local.request<any>("status")).connected).toHaveLength(3);
  });

  it("enforces the role the host gave, and applies role changes at once", async () => {
    const { local } = await startHost("alice");
    const { code } = await local.request<{ code: string }>("share", { role: "reader" });
    const rita = join(code, "rita");
    expect(await rita.admitted).toBe("active");
    expect(rita.role).toBe("reader");
    await expect(rita.request("call", { tool: "add_claim", args: { text: "Readers cannot write" } })).rejects.toThrow(/needs the contributor role/);
    expect(await rita.request("call", { tool: "beliefs", args: {} })).toEqual([]);

    const roleEvent = nextEvent(rita, "role");
    await local.request("set_role", { name: "rita", role: "contributor" });
    await roleEvent;
    expect(rita.role).toBe("contributor");
    await rita.request("call", { tool: "add_claim", args: { text: "Now she can write" } });
  });

  it("never lets a peer call the host's own methods", async () => {
    const { local } = await startHost("alice");
    const { code } = await local.request<{ code: string }>("share", { role: "admin" });
    const mallory = join(code, "mallory");
    expect(await mallory.admitted).toBe("active");
    for (const method of ["share", "unshare", "revoke_invite", "status", "set_role", "remove", "shutdown"])
      await expect(mallory.request(method, {})).rejects.toThrow(/Peers can't call/);
  });

  it("lets the machine a code is bound to back in after sharing restarts, under the name it joined with", async () => {
    const { local } = await startHost("alice");
    const bobDir = tempDir();
    const first = await local.request<{ code: string }>("share");
    const bob1 = join(first.code, "bob", bobDir);
    expect(await bob1.admitted).toBe("active");

    await local.request("unshare");
    await waitFor(() => bob1.state === "closed");
    expect(bob1.reason).toMatch(/stopped sharing/);

    await local.request("share");
    const bob2 = join(first.code, "bobby", bobDir);
    expect(await bob2.admitted).toBe("active");
    expect((await bob2.request<any>("describe")).you.id).toBe("bob");
  });

  it("keeps sharing across a host restart, so members get back in; stop_sharing stays off", async () => {
    const { host, local, dataDir } = await startHost("alice");
    const graph = `star${n}`;
    const bobDir = tempDir();
    const { code } = await local.request<{ code: string }>("share");
    const bob1 = join(code, "bob", bobDir);
    expect(await bob1.admitted).toBe("active");

    // The host stops (a sleep, a reboot, an idle exit) and starts again: still sharing, and bob is let back in.
    local.close();
    host.stop();
    await waitFor(() => bob1.state === "closed");
    const again = await Host.start({ dataDir, graph, user: "alice", signal, ice });
    hosts.push(again);
    expect(again.status().sharing).toBe(true);
    const bob2 = join(code, "bob", bobDir);
    expect(await bob2.admitted).toBe("active");

    // Turned off on purpose: it stays off after a restart.
    again.unshare();
    again.stop();
    const third = await Host.start({ dataDir, graph, user: "alice", signal, ice });
    hosts.push(third);
    expect(third.status().sharing).toBe(false);
  });

  it("shares by default: a graph that was never turned off starts sharing", async () => {
    const before = process.env.P2PCG_AUTO_SHARE;
    delete process.env.P2PCG_AUTO_SHARE;
    try {
      const h = await Host.start({ dataDir: tempDir(), graph: "fresh", user: "alice", signal, ice });
      hosts.push(h);
      expect(h.status().sharing).toBe(true);
    } finally {
      process.env.P2PCG_AUTO_SHARE = before;
    }
  });

  it("refuses a name that is already taken", async () => {
    const { local } = await startHost("alice");
    const { code } = await local.request<{ code: string }>("share");
    const fake = join(code, "alice");
    expect(await fake.admitted).toBe("denied");
    expect(fake.reason).toMatch(/name 'alice' is taken/);
  });

  it("gets no answer with the wrong secret, because signalling can't be decrypted", async () => {
    const { local } = await startHost("alice");
    const { code } = await local.request<{ code: string }>("share");
    const wrong = formatCode({ room: parseCode(code).room, secret: Buffer.alloc(32, 7) });
    const eve = join(wrong, "eve", tempDir(), 1500);
    expect(await eve.admitted).toBe("closed");
    expect(eve.reason).toMatch(/No answer from the host/);
    expect((await local.request<any>("status")).people).toHaveLength(1);
  });

  it("removes a peer: disconnected, their code stops working, and a new code lets them in again", async () => {
    const { local } = await startHost("alice");
    const { code } = await local.request<{ code: string }>("share");
    const dir = tempDir();
    const bob = join(code, "bob", dir);
    expect(await bob.admitted).toBe("active");
    await local.request("remove", { name: "bob" });
    await waitFor(() => bob.state === "denied" || bob.state === "closed");
    expect((await local.request<any>("status")).people).toHaveLength(1);
    const old = join(code, "bob", dir, 1500);
    expect(await old.admitted).toBe("closed"); // the revoked code's room is no longer answered
    const fresh = await local.request<{ code: string }>("share");
    const again = join(fresh.code, "bob", dir);
    expect(await again.admitted).toBe("active");
  });

  it("carries results larger than one data channel message", async () => {
    const { local } = await startHost("alice");
    for (let i = 0; i < 40; i++)
      await local.request("call", { tool: "add_claim", args: { text: `Claim ${i}: ` + "a long explanation of the finding ".repeat(30) } });
    const { code } = await local.request<{ code: string }>("share", { role: "reader" });
    const bob = join(code, "bob");
    expect(await bob.admitted).toBe("active");
    const beliefs = await bob.request<any[]>("call", { tool: "beliefs", args: { limit: 200 } });
    expect(beliefs).toHaveLength(40);
    expect(JSON.stringify(beliefs).length).toBeGreaterThan(40_000);
  });
});

describe("invites: one code per machine", () => {
  async function bound() {
    const { local } = await startHost("alice");
    const inv = await local.request<{ id: string; code: string }>("share", { label: "for Bob" });
    const bobDir = tempDir();
    const bob = join(inv.code, "bob", bobDir);
    expect(await bob.admitted).toBe("active");
    return { local, inv, bobDir, bob };
  }

  it("ties a code to the first machine that uses it: it rejoins, and the invite shows who has it", async () => {
    const { local, inv, bobDir, bob } = await bound();
    bob.close();
    await waitFor(async () => (await local.request<any>("status")).connected.length === 0);
    const again = join(inv.code, "bob", bobDir);
    expect(await again.admitted).toBe("active");
    const status = await local.request<any>("status");
    expect(status.invites).toEqual([expect.objectContaining({ id: inv.id, label: "for Bob", state: "used", code: null, for: expect.objectContaining({ name: "bob" }), expires_at: null })]);
  });

  it("turns away another machine using a code that is already bound", async () => {
    const { inv } = await bound();
    const carol = join(inv.code, "carol");
    expect(await carol.admitted).toBe("denied");
    expect(carol.reason).toMatch(/already been used on another machine/);
  });

  it("tells everyone already in the graph when someone new joins, but not about rejoins", async () => {
    const { local, bob, bobDir, inv } = await bound();
    const carolCode = await local.request<{ code: string }>("share", { label: "for Carol", role: "reader" });
    const bobHears = nextEvent(bob, "joined");
    const hostHears = nextEvent(local, "joined");
    const carol = join(carolCode.code, "carol", tempDir(), 10_000, { agent: "codex", platform: "Linux x64" });
    expect(await carol.admitted).toBe("active");
    expect((await bobHears).data).toMatchObject({ name: "carol", role: "reader", invite: { label: "for Carol" }, agent: "codex", platform: "Linux x64" });
    expect((await hostHears).data.name).toBe("carol");

    // Carol doesn't hear about herself; a rejoin isn't news.
    let news = 0;
    carol.on("event", (e: any) => e.event === "joined" && news++);
    local.on("event", (e: any) => e.event === "joined" && news++);
    bob.close();
    await waitFor(async () => (await local.request<any>("status")).connected.length === 1);
    const again = join(inv.code, "bob", bobDir);
    expect(await again.admitted).toBe("active");
    await new Promise((r) => setTimeout(r, 300));
    expect(news).toBe(0);
  });

  it("refuses an expired code that was never used", async () => {
    const { local } = await startHost("alice");
    const { code, id } = await local.request<{ code: string; id: string }>("share", { expires_hours: 0.5 / 3600 });
    await new Promise((r) => setTimeout(r, 700));
    const late = join(code, "bob", tempDir(), 1500);
    expect(await late.admitted).toBe("closed");
    expect((await local.request<any>("status")).invites).toEqual([expect.objectContaining({ id, state: "expired", code: null })]);
  });

  it("revokes a code: anyone on it is disconnected and it stops working", async () => {
    const { local, inv, bobDir, bob } = await bound();
    expect(await local.request("revoke_invite", { id: inv.id })).toMatchObject({ revoked: inv.id, was_for: "bob" });
    await waitFor(() => bob.state === "denied" || bob.state === "closed");
    const again = join(inv.code, "bob", bobDir, 1500);
    expect(await again.admitted).toBe("closed");
    await expect(local.request("revoke_invite", { id: "inv_nope" })).rejects.toThrow(/No invite/);
  });

  it("binds a fresh code to someone already in the graph, keeping their role, and tells no one", async () => {
    const { local, bobDir } = await bound();
    const second = await local.request<{ code: string; id: string }>("share");
    const bob2 = join(second.code, "bob", bobDir);
    expect(await bob2.admitted).toBe("active");
    const inv = (await local.request<any>("status")).invites.find((i: any) => i.id === second.id);
    expect(inv).toMatchObject({ state: "used", for: { name: "bob" } });
  });
});

describe("the local socket", () => {
  it("is readable and writable by the host's user only", async () => {
    if (process.platform === "win32") return;
    const { host } = await startHost();
    const { statSync } = await import("node:fs");
    expect(statSync(host.socket).mode & 0o777).toBe(0o600);
  });
});
