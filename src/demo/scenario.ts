// The example story, in one place: four people building this project, Vine
// Context, for the Relate by Neo4j hackathon, 15 to 25 Nov 2026. The decisions,
// pivots and incidents are the ones the project really went through (the
// repo's history and its plan notes have them). The cast is made up: all four
// are versions of the one Craig who built it with his agents, and who said
// what, and Craig's flight, are invented.
//
// What it shows: a design replaced (one host and writer, then a full copy for
// everyone), a claim replaced twice (the search embedder), a claim withdrawn,
// a conflict settled (why CI was blocked) and one left open (the judging
// weights), a member writing while offline and catching up, questions answered
// and questions still open with replies in their threads.
//
// Two things play it: `scripts/make-examples.ts` writes it, backdated, into
// the example store that ships with the package, and `vine demo` runs it live
// through four replicating hosts. The project site tells the same story.

export type Name = "Craig" | "Craigslist" | "Craigosaurus Rex" | "Craiginator";

/** The cast, in joining order. The first creates the context and is its admin. */
export const CAST: { name: Name; dir: string; agent: string; platform: string; role: string }[] = [
  { name: "Craig", dir: "craig", agent: "claude-code", platform: "darwin arm64", role: "the original: starts the context and sends the invites" },
  { name: "Craigslist", dir: "craigslist", agent: "codex", platform: "linux x64", role: "reads the rules and keeps the checklist" },
  { name: "Craigosaurus Rex", dir: "rex", agent: "claude-code", platform: "win32 x64", role: "the architect, fond of how things used to be done" },
  { name: "Craiginator", dir: "craiginator", agent: "codex", platform: "linux x64", role: "runs CI, the embedder and the numbers" },
];
export const NAMES: Name[] = CAST.map((c) => c.name);
export const CREATOR: Name = "Craig";

export interface Step {
  who: Name;
  /** When it happened in the story: day of November 2026 and time, UTC. */
  day: number;
  time: string;
  /** A tool to call, or "offline" / "online": the member stops or starts sharing, and nothing is written. */
  tool: string;
  /** Tool arguments. A string "@name" (alone or in a list) is the id of the step that was saved as `name`. */
  args: Record<string, unknown>;
  /** Saves this step's result id under this name, for later steps. */
  as?: string;
  /** What to tell a watcher, in plain words. */
  note: string;
}

/** A step that writes nothing: the member goes offline or comes back. */
export const isPresence = (s: Step): boolean => s.tool === "offline" || s.tool === "online";

export const GRAPH_NAME = "vine-entry";
export const GRAPH_DESCRIPTION = "Building Vine Context for the Relate by Neo4j hackathon: what we decided, what we changed our minds about, what broke, and what is still open";

const C = "Craig", L = "Craigslist", R = "Craigosaurus Rex", T = "Craiginator";

export const STEPS: Step[] = [
  // Sun 15 Nov: the brief, and the first design.
  {
    who: C, day: 15, time: "09:00", tool: "add_claim", as: "deadline",
    args: { text: "Entries for the Relate hackathon close on Fri 11 Dec 2026 at 6:00 PM PST, and judges must be able to clone ours, run it and see the graph without asking us anything", source: "https://relate.devpost.com/", about_from: "2026-12-11", about_to: "2026-12-11" },
    note: "records the deadline, and that judges must be able to run it unaided",
  },
  {
    who: C, day: 15, time: "09:10", tool: "add_claim", as: "weights",
    args: { text: "Judging is out of 100: creativity 10, Relate and connected context 30, functionality 25, usefulness 20, documentation 15", source: "relate.devpost.com overview page, read 15 Nov" },
    note: "records the judging weights from the overview page",
  },
  { who: C, day: 15, time: "09:40", tool: "ask_question", as: "howShare", args: { text: "How do several people's agents share one Relate graph, when a Relate store takes one writer at a time?" }, note: "asks how several people's agents can share one Relate graph" },
  {
    who: R, day: 15, time: "10:30", tool: "add_claim", as: "oneHost",
    args: { text: "One machine hosts the graph and is its only writer; everyone else's agent sends its tool calls to that host over WebRTC. One writer means no merge rules and no CRDT", source: "plan notes, 15 Nov", answers: ["@howShare"] },
    note: "answers: one machine hosts the graph and is its only writer",
  },
  {
    who: T, day: 15, time: "14:10", tool: "add_claim", as: "nostr",
    args: { text: "Machines find each other through public Nostr relays, using ephemeral events sealed with a key made from the group's secret, so a relay only ever sees ciphertext", source: "signalling spike, 15 Nov" },
    note: "records how machines find each other: Nostr relays that only see ciphertext",
  },

  // Mon 16 Nov: join codes, the embedder, model packs.
  {
    who: R, day: 16, time: "09:30", tool: "add_claim", as: "oneLink",
    args: { text: "Joining uses one reusable link for the whole group, and the host approves each joiner after the two compare key fingerprints", source: "plan notes, 15 Nov" },
    note: "claims joining uses one reusable link, with a fingerprint check",
  },
  {
    who: C, day: 16, time: "11:15", tool: "add_claim", as: "joinCodes",
    args: { text: "A join code is for one person: the first install to use it is let in and the code is bound to its key. The approval step and fingerprint check are gone, because people compared fingerprints over the same channel the code came through", source: "plan notes, 16 Nov", replaces: ["@oneLink"] },
    note: "replaces it: one code per person, and no fingerprint check",
  },
  {
    who: T, day: 16, time: "15:00", tool: "add_claim", as: "hash",
    args: { text: "Search uses the offline hash-256 embedder: a real sentence model would add about 100 MB and a download on first run, which works against 'clone, run, see it'", source: "plan notes, 16 Nov" },
    note: "records the search embedder: hash-256, to keep the install small",
  },
  {
    who: R, day: 16, time: "16:20", tool: "add_claim", as: "packs",
    args: { text: "A team can install its own model pack, such as a decision log, beside Claims and Questions", source: "milestone 3, 16 Nov" },
    note: "claims a team can install its own model packs",
  },

  // Tue 17 Nov: the pivot.
  { who: L, day: 17, time: "09:00", tool: "ask_question", as: "hostAway", args: { text: "What happens to everyone else when the host's laptop is shut?", about: ["@oneHost"] }, note: "asks what happens to everyone else when the host's laptop is shut" },
  {
    who: R, day: 17, time: "09:25", tool: "reply",
    args: { question: "@hostAway", text: "They wait for the host. One writer, one authority: it has worked for 66 million years." },
    note: "replies in the thread: they wait. A reply is a message, not an answer, so the question stays open",
  },
  {
    who: C, day: 17, time: "11:00", tool: "add_claim", as: "replicated",
    args: { text: "Every member keeps a full copy of the graph, built from a log of signed changes, and online members swap what each is missing over a WebRTC mesh. It works offline, and while the person who created it is away", source: "docs/REPLICATION.md", replaces: ["@oneHost"], answers: ["@hostAway", "@howShare"] },
    note: "replaces the one-host design: every member keeps a full copy, synced peer to peer. Both questions are answered",
  },
  {
    who: T, day: 17, time: "11:40", tool: "add_claim", as: "fixedKinds",
    args: { text: "With one fixed model, every change is one of a few fixed kinds (a claim, a question, a reply, a link, a withdrawal), so copies need no merge rules and there is still no CRDT", source: "docs/REPLICATION.md", supports: ["@replicated"] },
    note: "supports it: with one fixed model, copies need no merge rules",
  },
  {
    who: R, day: 17, time: "16:00", tool: "withdraw", args: { id: "@packs", reason: "Model packs were removed with the move to replicated graphs: one fixed model is what keeps merging simple" },
    note: "withdraws his model packs claim. Nothing is deleted: it stays in the history, marked as ended",
  },

  // Sat 21 to Mon 23 Nov: the rename, the embedder again, and the rules re-read.
  {
    who: C, day: 21, time: "10:00", tool: "add_claim", as: "rename",
    args: { text: "The project is called Vine Context (it was p2p-context-graph): the package is vine-context, the command is vine, and join codes start vine1_", source: "https://github.com/CraigDeverall/vine-context/pull/3" },
    note: "records the rename to Vine Context",
  },
  {
    who: T, day: 22, time: "10:30", tool: "add_claim", as: "optIn",
    args: { text: "A semantic embedder (bge-small, run on the CPU by a Rust addon) can be switched on; hash-256 stays the default and the fallback", source: "plan notes, 22 Nov", replaces: ["@hash"] },
    note: "replaces the embedder claim: a semantic one can be switched on",
  },
  {
    who: L, day: 23, time: "09:00", tool: "add_claim", as: "equal",
    args: { text: "The official rules list five criteria weighted equally: creativity, usefulness, completeness, clarity, and effective use of connected context", source: "https://relate.devpost.com/rules, read 23 Nov", contradicts: ["@weights"] },
    note: "re-reads the rules: five criteria, weighted equally. That contradicts the 100 points recorded on day one, and the graph now holds a conflict",
  },
  { who: L, day: 23, time: "09:10", tool: "ask_question", as: "whichWeights", args: { text: "Which judging weights hold: the 100 points on the overview page, or the equal weights in the rules?", about: ["@weights", "@equal"] }, note: "asks which weights hold. Nobody can tell yet, so the conflict stays open" },
  { who: C, day: 24, time: "17:30", tool: "ask_question", as: "oneCommand", args: { text: "Can a judge install it with one command today?", about: ["@deadline"] }, note: "asks whether a judge can install it with one command today" },

  // Wed 25 Nov: Craig is offline, and two things break.
  { who: C, day: 25, time: "08:00", tool: "offline", args: {}, note: "shuts his laptop for a flight. He created the context, and the other three carry on without him" },
  { who: C, day: 25, time: "08:20", tool: "ask_question", as: "whyNoCi", args: { text: "Why did CI never start on pull request 33?" }, note: "asks a question from the plane. It is written to his own copy and waits there" },
  {
    who: T, day: 25, time: "09:00", tool: "add_claim", as: "payment",
    args: { text: "GitHub Actions won't start on the repo because a payment failed", source: "the Actions tab's billing notice" },
    note: "claims CI is blocked because a payment failed",
  },
  {
    who: L, day: 25, time: "09:40", tool: "add_claim", as: "budget",
    args: { text: "No payment failed: the free plan's included Actions compute for the month is used up, and the spending budget is $0", source: "the account's billing page", contradicts: ["@payment"] },
    note: "finds no payment failed: the included compute is used up. That contradicts Craiginator, a second conflict",
  },
  {
    who: T, day: 25, time: "10:15", tool: "add_claim", as: "public",
    args: { text: "The repo was made public on 25 Nov, since hosted runners are free for public repos, and CI then passed on Ubuntu, macOS and Windows", source: "https://github.com/CraigDeverall/vine-context/actions/runs/45588928751", about_from: "2026-11-25", about_to: "2026-11-25", replaces: ["@payment"], supports: ["@budget"] },
    note: "gives way and replaces his claim: the repo is now public and CI is green on three systems. That conflict settles",
  },
  {
    who: L, day: 25, time: "10:34", tool: "add_claim", as: "placeholder",
    args: { text: "npm has only a 0.0.1 placeholder for vine-context, so the README's `npx vine-context setup` gives a judge nothing that works", source: "https://github.com/CraigDeverall/vine-context/pull/40", answers: ["@oneCommand"] },
    note: "answers Craig's question from the day before: no, npm only has a placeholder",
  },
  {
    who: T, day: 25, time: "11:00", tool: "add_claim", as: "semantic",
    args: { text: "The semantic embedder is the default: bge-small when its package is installed and runs on this machine, else hash-256, and `vine doctor` says which", source: "plan notes, 25 Nov", replaces: ["@optIn"] },
    note: "replaces the embedder claim a second time: semantic search is now the default",
  },
  { who: C, day: 25, time: "12:30", tool: "online", args: {}, note: "lands and opens his laptop. His copy sends his question, takes in the morning's changes, and his agent is told what they mean for him" },
  { who: L, day: 25, time: "12:40", tool: "link", args: { from: "@budget", relation: "ANSWERS", to: "@whyNoCi" }, note: "sees Craig's question arrive and links the billing finding as its answer" },
  {
    who: T, day: 25, time: "12:50", tool: "add_claim", as: "published",
    args: { text: "vine-context 0.1.0 is on npm: installed into an empty folder it brings the embedder package for the machine, and `vine doctor` passes every check", source: "https://github.com/CraigDeverall/vine-context/releases/tag/v0.1.0", replaces: ["@placeholder"], answers: ["@oneCommand"] },
    note: "replaces the placeholder claim: 0.1.0 is on npm, so the answer to Craig's question is now yes",
  },
  {
    who: L, day: 25, time: "15:00", tool: "add_claim", as: "copyFirst",
    args: { text: "Running the relate command on a store rewrites the store's files, so the README tells judges to query a copy of the example", source: "README.md, Where the data lives", supports: ["@deadline"] },
    note: "records a Relate gotcha: query a copy of the store, not the store",
  },
  {
    who: R, day: 25, time: "16:00", tool: "add_claim", as: "party",
    args: { text: "The example story is three colleagues planning the office Christmas party", source: "https://github.com/CraigDeverall/vine-context/pull/20" },
    note: "records the example story: three colleagues planning the office Christmas party",
  },

  // Later on Wed 25 Nov: the field, and what is left.
  {
    who: C, day: 25, time: "18:10", tool: "add_claim", as: "field",
    args: { text: "On 25 Nov the hackathon gallery had 83 entries. About 16 are shared or lasting memory for agents, and none of them syncs peer to peer between machines", source: "https://relate.devpost.com/project-gallery", about_from: "2026-11-25", about_to: "2026-11-25" },
    note: "records the field: 83 entries, and none syncs peer to peer",
  },
  {
    who: C, day: 25, time: "18:40", tool: "add_claim", as: "us",
    args: { text: "The example story is this one: the team building Vine Context, with every decision taken from the real build", source: "src/demo/scenario.ts", replaces: ["@party"], supports: ["@field"] },
    note: "replaces the example story with this one. You are looking at it",
  },
  { who: C, day: 25, time: "18:50", tool: "ask_question", as: "video", args: { text: "Who records the two-minute demo video?", about: ["@deadline"] }, note: "asks who records the demo video" },
  {
    who: R, day: 25, time: "18:55", tool: "reply",
    args: { question: "@video", text: "Not me. My arms don't reach the keyboard." },
    note: "replies in the thread: not him. Still a reply, not an answer",
  },
  { who: T, day: 25, time: "19:00", tool: "ask_question", as: "devices", args: { text: "Should one person's two machines count as one member? Today each install has its own key, so they show as two", about: ["@joinCodes"] }, note: "asks whether one person's two machines should count as one member. It stays open" },
];

/** The step's moment in the story, as an ISO timestamp. */
export const storyTime = (s: Step): string => `2026-11-${String(s.day).padStart(2, "0")}T${s.time}:00.000Z`;

/** Fills in "@name" references from the ids of earlier steps. */
export function resolveArgs(args: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  const one = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("@")) {
      const id = ids.get(v.slice(1));
      if (!id) throw new Error(`scenario: no step saved as ${v}`);
      return id;
    }
    return Array.isArray(v) ? v.map(one) : v;
  };
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, one(v)]));
}

/**
 * Plays the story through `call`, which runs one tool as one person and
 * returns its result (with an `id` for writes that make something).
 */
export async function playScenario(call: (step: Step, args: Record<string, unknown>) => Promise<{ id?: string } | undefined | void>, onStep?: (step: Step, index: number) => void | Promise<void>): Promise<void> {
  const ids = new Map<string, string>();
  for (const [i, step] of STEPS.entries()) {
    await onStep?.(step, i);
    const r = await call(step, resolveArgs(step.args, ids));
    if (step.as) {
      if (!r?.id) throw new Error(`scenario: step ${i} (${step.tool}) gave no id to save as ${step.as}`);
      ids.set(step.as, r.id);
    }
  }
}
