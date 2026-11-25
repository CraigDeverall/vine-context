// `vine demo`: four members in one process, joined with real codes, playing
// the example story through their own hosts and syncing over WebRTC. One of
// them goes offline part way through, writes to his own copy, and catches up.

import { afterAll, describe, expect, it } from "vitest";
import { startDemo, type Demo, type Member } from "../src/demo/live.js";
import { CREATOR, NAMES, STEPS } from "../src/demo/scenario.js";
import { tempDir } from "./helpers.js";

type Row = Record<string, any>;
let demo: Demo | undefined;
afterAll(async () => demo?.stop());

const texts = async (m: Member) => ((await m.call<Row[]>("beliefs", {})) as Row[]).map((r) => r.text).sort();

describe("vine demo", () => {
  it("joins four members, plays the story with one of them offline for part of it, and every copy ends the same", async () => {
    const lines: string[] = [];
    demo = await startDemo({ paceMs: 0, holdMs: 150, tmp: tempDir(), narrate: (l: string) => lines.push(l) });
    const all = NAMES.map((n) => demo!.members[n]);

    // Linked before the story: each sees the other three online.
    for (const m of all) expect(m.host.status().links.filter((l) => l.state === "active")).toHaveLength(3);
    expect(lines.some((l) => l.includes("Craigslist joins with a code"))).toBe(true);

    await demo.story;

    // The same beliefs everywhere, and the story's ending: each replaced or withdrawn claim gone from the current view.
    const a = await texts(all[0]!);
    for (const m of all) expect(await texts(m)).toEqual(a);
    expect(a.some((t) => t.startsWith("Every member keeps a full copy of the graph"))).toBe(true);
    expect(a.some((t) => t.startsWith("One machine hosts the graph"))).toBe(false);
    expect(a.some((t) => t.startsWith("The semantic embedder is the default"))).toBe(true);
    expect(a.some((t) => t.includes("hash-256 stays the default"))).toBe(false);
    expect(a.some((t) => t.startsWith("A team can install its own model pack"))).toBe(false);
    expect(a.some((t) => t.includes("a payment failed"))).toBe(false);

    for (const m of all) {
      // One conflict settled (why CI was blocked), one left open (the judging weights).
      const conflicts = (await m.call<Row[]>("conflicts", {})) as Row[];
      expect(conflicts).toHaveLength(1);
      expect(JSON.stringify(conflicts)).toContain("weighted equally");
      // Three questions still open; the one Craig asked while offline reached everyone and was answered.
      const open = ((await m.call<Row[]>("open_questions", {})) as Row[]).map((q) => q.text).sort();
      expect(open).toHaveLength(3);
      expect(open.some((t) => t.startsWith("Who records the two-minute demo video"))).toBe(true);
      expect(open.some((t) => t.startsWith("Why did CI never start"))).toBe(false);
      expect(await m.call<Row[]>("beliefs", {})).toHaveLength(a.length);
    }

    // Every step was narrated; Craig went offline and came back to news of what the others' writes meant for him.
    expect(lines.filter((l) => new RegExp(`^\\d+/${STEPS.length} `).test(l))).toHaveLength(STEPS.length);
    expect(lines.some((l) => l.includes(`${CREATOR} is offline: 3 machines are still linked`))).toBe(true);
    expect(lines.some((l) => l.includes(`${CREATOR} is back and caught up`))).toBe(true);
    expect(lines.some((l) => l.includes(`${CREATOR}'s agent is told`))).toBe(true);
    expect(lines.some((l) => l.includes("reached Craiginator"))).toBe(true);
  }, 180_000);
});
