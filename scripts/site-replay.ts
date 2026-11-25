// Prints the replay data for the project site (the vine-context-site repo's
// app.js) from the example story, so the site and `vine demo` tell the same
// one. Positions and short labels are set here; everything else comes from
// src/demo/scenario.ts.
//
//   npx tsx scripts/site-replay.ts > replay-data.js

import { STEPS, isPresence, storyTime } from "../src/demo/scenario.ts";

// Five columns by subject: the rules, CI and npm, the design, joining, search and the example.
const [A, B, C, D, E] = [105, 320, 535, 750, 965];
const row = (n: number) => 60 + n * 100;
const PLACE: Record<string, [number, number, string, string]> = {
  "reply:video": [A, row(0), "Not me. My arms don't", "reach the keyboard"],
  video: [A, row(1), "Who records the", "demo video?"],
  deadline: [A, row(2), "Entries close Fri 11 Dec;", "judges must run it unaided"],
  copyFirst: [A, row(3), "Query a copy: relate", "rewrites a store's files"],
  weights: [A, row(4), "Judging is out of 100;", "connected context is 30"],
  equal: [A, row(5), "The rules say five criteria,", "weighted equally"],
  whichWeights: [A, row(6), "Which judging", "weights hold?"],

  payment: [B, row(0), "CI is blocked because", "a payment failed"],
  public: [B, row(1), "Repo made public; CI green", "on three systems"],
  budget: [B, row(2), "No payment failed: the free", "CI allowance is used up"],
  whyNoCi: [B, row(3), "Why did CI never start", "on pull request 33?"],
  oneCommand: [B, row(4), "Can a judge install it", "with one command today?"],
  placeholder: [B, row(5), "npm has only a", "0.0.1 placeholder"],
  published: [B, row(6), "0.1.0 is on npm;", "vine doctor passes"],

  howShare: [C, row(0), "How do agents share one", "single-writer Relate graph?"],
  oneHost: [C, row(1), "One machine hosts the", "graph and is its only writer"],
  replicated: [C, row(2), "Every member keeps a full", "copy, synced peer to peer"],
  hostAway: [C, row(3), "What if the host's", "laptop is shut?"],
  "reply:hostAway": [C, row(4), "They wait. It has worked", "for 66 million years"],
  nostr: [C, row(6), "Machines meet through Nostr", "relays that see ciphertext"],

  devices: [D, row(0), "Do one person's two", "machines count as one?"],
  joinCodes: [D, row(1), "A join code is for one", "person; no fingerprint check"],
  oneLink: [D, row(2), "Joining: one reusable link,", "then a fingerprint check"],
  fixedKinds: [D, row(3), "A few fixed kinds of change,", "so no merge rules"],
  packs: [D, row(5), "A team can install its", "own model packs"],
  rename: [D, row(6), "It is now Vine Context;", "codes start vine1_"],

  hash: [E, row(0), "Search uses hash-256,", "to keep the install small"],
  optIn: [E, row(1), "A semantic embedder", "can be switched on"],
  semantic: [E, row(2), "Semantic search is", "the default"],
  party: [E, row(4), "The example story is the", "office Christmas party"],
  us: [E, row(5), "The example story", "is this one"],
  field: [E, row(6), "83 entries; none syncs", "peer to peer"],
};
// Links that would run over a node between their ends bow the other way.
const BEND: Record<string, number> = { "hostAway>oneHost": -1.4, "replicated>howShare": 1.4, "budget>payment": -1.4, "whichWeights>weights": -1.4, "published>oneCommand": -1.4 };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const moment = (iso: string) => `${DAYS[new Date(iso).getUTCDay()]} ${Number(iso.slice(8, 10))} Nov, ${iso.slice(11, 16)}`;
const ref = (v: unknown) => String(v).slice(1);
const list = (v: unknown) => (Array.isArray(v) ? v.map(ref) : []);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const items: object[] = [];
const links: object[] = [];
const events: [string, string][] = [];
const moments: string[] = [];
STEPS.forEach((s, at) => {
  moments.push(moment(storyTime(s)));
  events.push([s.who, `${s.note}.`]);
  if (isPresence(s)) return;
  const a = s.args;
  const link = (from: string, to: string, rel: string) => links.push({ from, to, rel, at, ...(BEND[`${from}>${to}`] ? { bend: BEND[`${from}>${to}`] } : {}) });
  if (s.tool === "withdraw") {
    (items.find((i: any) => i.id === ref(a.id)) as any).ended = at;
    return;
  }
  if (s.tool === "link") return void link(ref(a.from), ref(a.to), String(a.relation).toLowerCase().replace("_", " "));
  const id = s.tool === "reply" ? `reply:${ref(a.question)}` : s.as!;
  const p = PLACE[id];
  if (!p) throw new Error(`no place for '${id}'`);
  items.push({ id, kind: s.tool === "add_claim" ? "claim" : s.tool === "ask_question" ? "question" : "reply", who: s.who, at, x: p[0], y: p[1], label: [p[2], p[3]], text: a.text });
  if (s.tool === "reply") link(id, ref(a.question), "replies to");
  for (const [k, rel] of [["about", "about"], ["supports", "supports"], ["contradicts", "contradicts"], ["replaces", "replaces"], ["answers", "answers"]] as const) for (const to of list(a[k])) link(id, to, rel);
});
const unused = Object.keys(PLACE).filter((k) => !items.some((i: any) => i.id === k));
if (unused.length) throw new Error(`placed but not in the story: ${unused}`);

const rows = (xs: unknown[]) => xs.map((x) => `    ${JSON.stringify(x)},`).join("\n");
console.log(`  // Made by scripts/site-replay.ts in the vine-context repo, from src/demo/scenario.ts. Don't edit by hand.
  const MOMENTS = ${JSON.stringify(moments)};

  const ITEMS = [
${rows(items)}
  ];

  const LINKS = [
${rows(links)}
  ];

  // What happened at each moment, in plain words.
  const EVENTS = [
${rows(events.map(([w, t]) => [w, t]))}
  ];
`);
void cap;
