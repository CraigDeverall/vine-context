// `vine demo`: three members in one process, joined with real codes, playing
// the example story through their own hosts and syncing over WebRTC.

import { afterAll, describe, expect, it } from "vitest";
import { startDemo, type Demo, type Member } from "../src/demo/live.js";
import { STEPS } from "../src/demo/scenario.js";
import { tempDir } from "./helpers.js";

type Row = Record<string, any>;
let demo: Demo | undefined;
afterAll(async () => demo?.stop());

const texts = async (m: Member) => ((await m.call<Row[]>("beliefs", {})) as Row[]).map((r) => r.text).sort();

describe("vine demo", () => {
  it("joins three members, plays the story, and every copy ends the same", async () => {
    const lines: string[] = [];
    demo = await startDemo({ paceMs: 0, holdMs: 150, tmp: tempDir(), narrate: (l) => lines.push(l) });
    const { alice, bob, carol } = demo.members;

    // Linked before the story: each sees the other two online.
    for (const m of [alice, bob, carol]) expect(m.host.status().links.filter((l) => l.state === "active")).toHaveLength(2);
    expect(lines.some((l) => l.includes("bob joins with a code"))).toBe(true);

    await demo.story;

    // The same beliefs everywhere, and the story's ending: the deploy claim replaced, the Redis claim gone.
    const a = await texts(alice);
    expect(a).toEqual(await texts(bob));
    expect(a).toEqual(await texts(carol));
    expect(a).toContain("Mobile retries exhausting the orders database pool caused the checkout slowdown, not the 14:05 deploy");
    expect(a).not.toContain("The 14:05 deploy of payments-api caused the checkout slowdown");
    expect(a).not.toContain("The Redis cache was down during the incident");

    // The conflict settled, one question still open, on every copy.
    for (const m of [alice, bob, carol]) {
      expect(await m.call<Row[]>("conflicts", {})).toHaveLength(0);
      const open = (await m.call<Row[]>("open_questions", {})) as Row[];
      expect(open.map((q) => q.text)).toEqual(["Should the API gateway rate-limit each client?"]);
    }

    // Every step was narrated, and alice's agent was told what bob's and carol's writes meant for her.
    expect(lines.filter((l) => /^\d+\/14 /.test(l))).toHaveLength(STEPS.length);
    expect(lines.some((l) => l.includes("alice's agent is told"))).toBe(true);
    expect(lines.some((l) => l.includes("reached bob"))).toBe(true);
  }, 90_000);
});
