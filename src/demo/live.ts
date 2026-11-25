// `vine demo`: four members, four hosts, one process. Craig creates the
// example context and invites the other three, who join with real join codes.
// Then the example story plays through each person's own host, so every
// write is signed, held for undo, released and carried to the others over
// WebRTC, exactly as it is between four machines. Part way through, Craig
// stops sharing (he is offline), writes to his own copy, and catches up when
// he comes back. Nothing of yours is touched: each member has a temporary
// data folder of its own.
//
// With no network, the members find each other on an in-process signalling
// bus. With `signal: nostrSignaller` they use the public relays, so a fifth
// member on another machine can join with a code.

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "../core/identity.js";
import { LocalHost } from "../host/client.js";
import { Host, placeReplica } from "../host/host.js";
import type { IceSource } from "../p2p/ice.js";
import { joinWithCode } from "../p2p/join.js";
import { parseCode } from "../p2p/link.js";
import { memorySignaller, type SignalFactory } from "../p2p/signal.js";
import { CAST, CREATOR, GRAPH_DESCRIPTION, GRAPH_NAME, NAMES, playScenario, STEPS, type Name, type Step } from "./scenario.js";

export { NAMES, type Name };

/** What each member's install says about itself, as the console shows it. The creator's is this machine's. */
const ABOUT = Object.fromEntries(CAST.map((c) => [c.name, { agent: c.agent, platform: c.name === CREATOR ? `${process.platform} ${process.arch}` : c.platform }])) as Record<Name, { agent: string; platform: string }>;
const DIR = Object.fromEntries(CAST.map((c) => [c.name, c.dir])) as Record<Name, string>;

export interface Member {
  name: Name;
  dataDir: string;
  host: Host;
  local: LocalHost;
  call<T = Record<string, any>>(tool: string, args?: Record<string, unknown>): Promise<T>;
}

export interface DemoOptions {
  /** Pause between steps of the story. */
  paceMs?: number;
  /** How long each write is held for undo before it is sent (normally 10 s). */
  holdMs?: number;
  /** How the members find each other. Default: an in-process bus, no network. */
  signal?: SignalFactory;
  /** STUN/TURN servers. Default: none, which is enough on one machine. */
  ice?: IceSource;
  /** Where the members' data folders are made. */
  tmp?: string;
  /** A line for the person watching. */
  narrate?(line: string): void;
  /** The hosts' own log lines. */
  log?(line: string): void;
}

export interface Demo {
  members: Record<Name, Member>;
  /** Resolves when the whole story has played and reached every member. */
  story: Promise<void>;
  stop(): Promise<void>;
}

export interface Narration {
  step(step: Step, index: number, total: number): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(100);
  }
}

/** Starts the four members, joined and linked, then plays the story. */
export async function startDemo(o: DemoOptions = {}): Promise<Demo> {
  const signal = o.signal ?? memorySignaller(new EventEmitter());
  const ice: IceSource = o.ice ?? [];
  const holdMs = o.holdMs ?? 1500;
  const paceMs = o.paceMs ?? 4000;
  const say = o.narrate ?? (() => undefined);
  const root = o.tmp ?? mkdtempSync(join(tmpdir(), "vine-demo-"));
  const hosts: Host[] = [];

  const start = async (name: Name, dataDir: string): Promise<Member> => {
    const host = await Host.start({ dataDir, graph: GRAPH_NAME, user: name, signal, ice, holdMs, log: o.log && ((m) => o.log!(`${name}: ${m}`)) });
    hosts.push(host);
    host.startSharing();
    const local = await LocalHost.connect(host.socket);
    return { name, dataDir, host, local, call: (tool, args = {}) => local.request("call", { tool, args }) };
  };

  // The creator starts the context (a host with an empty log creates its graph).
  const others = NAMES.filter((n) => n !== CREATOR);
  const creator = await start(CREATOR, join(root, DIR[CREATOR]));
  await creator.local.request("describe_context", { description: GRAPH_DESCRIPTION });
  say(`${CREATOR} starts a context called '${GRAPH_NAME}' and invites ${others.slice(0, -1).join(", ")} and ${others.at(-1)}.`);

  // The others join with codes, as anyone does: a full copy each, then their own host.
  const joinAs = async (name: Name): Promise<Member> => {
    const { code } = await creator.local.request<{ code: string }>("share", { label: `for ${name}`, role: "contributor" });
    const dataDir = join(root, DIR[name]);
    const welcome = await joinWithCode(parseCode(code), loadIdentity(dataDir, name), { signal, ice, about: ABOUT[name], log: o.log && ((m) => o.log!(`${name} (joining): ${m}`)) });
    if (!placeReplica(dataDir, welcome.graph.name, welcome.graph, welcome.changes)) throw new Error(`${name} could not place the copy`);
    const m = await start(name, dataDir);
    say(`${name} joins with a code and gets a full copy (${welcome.changes.length} changes).`);
    return m;
  };
  const members = { [CREATOR]: creator } as Record<Name, Member>;
  for (const n of others) members[n] = await joinAs(n);

  // Who is sharing now. A member who is offline keeps a working copy, linked to nobody.
  const offline = new Set<Name>();
  const online = () => NAMES.filter((n) => !offline.has(n));
  const active = (m: Member) => m.host.status().links.filter((l) => l.state === "active").length;
  const linked = () => online().every((n) => active(members[n]) === online().length - 1) && [...offline].every((n) => active(members[n]) === 0);

  // Everyone linked to everyone, before the story starts.
  await waitFor("the members to link up", linked, 30_000);
  say(`all ${NAMES.length} machines are linked to each other.`);

  // Arrivals, as each member's agent would hear of them.
  for (const n of NAMES) {
    members[n].local.on("event", (e: { event: string; data: any }) => {
      if (e.event === "changed" && e.data?.from) say(`  ↳ reached ${n} (from ${e.data.from})`);
      if (e.event === "digest" && n === CREATOR) for (const line of e.data?.lines ?? []) say(`  ↳ ${CREATOR}'s agent is told: ${line}`);
    });
  }

  // Every online copy the same: nothing held, and each holding as many changes as the next.
  const have = (m: Member) => m.host.status().log.changes;
  const settled = () => online().every((n) => have(members[n]) === have(members[online()[0]!]) && members[n].host.status().log.held === 0) && [...offline].every((n) => members[n].host.status().log.held === 0);

  /** A step that writes nothing: the member stops sharing, or starts again and catches up. */
  const presence = async (step: Step) => {
    const m = members[step.who];
    if (step.tool === "offline") {
      await m.local.request("unshare");
      offline.add(step.who);
      await waitFor(`${step.who} to drop off`, linked, 30_000);
      say(`  ↳ ${step.who} is offline: ${online().length} machines are still linked.`);
    } else {
      const before = have(m);
      await m.local.request("start_sharing");
      offline.delete(step.who);
      await waitFor(`${step.who} to link up again`, linked, 30_000);
      await waitFor(`${step.who} to catch up`, settled, 30_000 + holdMs);
      say(`  ↳ ${step.who} is back and caught up: ${have(m) - before} changes came in.`);
    }
    return undefined;
  };

  const story = (async () => {
    let first = true;
    await playScenario(
      (step, args) => (step.tool === "offline" || step.tool === "online" ? presence(step) : members[step.who].call(step.tool, args)),
      async (step, i) => {
        if (!first) await sleep(paceMs);
        first = false;
        // A step may answer or contradict what another member wrote: wait until that has reached its author.
        await waitFor("the last change to reach everyone", settled, 30_000 + holdMs);
        say(`${i + 1}/${STEPS.length}  ${step.who} ${step.note}${"text" in step.args ? `: ${step.tool} “${String(step.args.text)}”` : ""}`);
      },
    );
    await waitFor("the last changes to reach everyone", settled, 30_000 + holdMs);
    say("every copy now holds the same graph.");
  })();
  story.catch(() => undefined);

  return {
    members,
    story,
    stop: async () => {
      for (const n of NAMES) members[n].local.close();
      for (const h of hosts) h.stop();
    },
  };
}
