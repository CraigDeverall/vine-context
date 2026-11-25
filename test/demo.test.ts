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

    // The same beliefs everywhere, and the story's ending: the Riverside claim replaced, last year's cost withdrawn.
    const a = await texts(alice);
    expect(a).toEqual(await texts(bob));
    expect(a).toEqual(await texts(carol));
    expect(a).toContain("The party is at the Orangery on Friday 19 Dec, not the Riverside Room");
    expect(a).not.toContain("The Riverside Room can take the whole party on Friday 12 Dec");
    expect(a).not.toContain("Last year's party cost £2,300, so £2,400 is plenty");

    // The conflict settled, one question still open (replied to, not answered), on every copy.
    for (const m of [alice, bob, carol]) {
      expect(await m.call<Row[]>("conflicts", {})).toHaveLength(0);
      const open = (await m.call<Row[]>("open_questions", {})) as Row[];
      expect(open.map((q) => q.text)).toEqual(["Should partners be invited, and is there budget for them?"]);
      const thread = (await m.call<Row>("thread", { question: open[0]!.id })) as Row;
      expect(JSON.stringify(thread)).toContain("January drinks evening");
      expect(await m.call<Row[]>("beliefs", {})).toHaveLength(6);
    }

    // Every step was narrated, and alice's agent was told what bob's and carol's writes meant for her.
    expect(lines.filter((l) => new RegExp(`^\\d+/${STEPS.length} `).test(l))).toHaveLength(STEPS.length);
    expect(lines.some((l) => l.includes("alice's agent is told"))).toBe(true);
    expect(lines.some((l) => l.includes("reached bob"))).toBe(true);
  }, 90_000);
});
