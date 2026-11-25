// The example story, in one place: three people (alice, bob, carol) planning
// the office Christmas party, 17 to 19 Nov 2026. A contradiction appears and
// is settled, a mistaken claim is withdrawn, two questions are answered, and
// a third gets a reply in its thread but stays open.
//
// Two things play it: `scripts/make-examples.ts` writes it, backdated, into
// the example store that ships with the package, and `vine demo` runs it live
// through three replicating hosts. The project site tells the same story.

export interface Step {
  who: "alice" | "bob" | "carol";
  /** When it happened in the story: day of November 2026 and time, UTC. */
  day: number;
  time: string;
  tool: string;
  /** Tool arguments. A string "@name" (alone or in a list) is the id of the step that was saved as `name`. */
  args: Record<string, unknown>;
  /** Saves this step's result id under this name, for later steps. */
  as?: string;
  /** What to tell a watcher, in plain words. */
  note: string;
}

export const GRAPH_NAME = "party";
export const GRAPH_DESCRIPTION = "The office Christmas party 2026: who is coming, where it is, what it costs, and what we still have to decide";

export const STEPS: Step[] = [
  {
    who: "alice", day: 17, time: "09:10", tool: "add_claim", as: "headcount",
    args: { text: "48 people are coming to the Christmas party, from the RSVP sheet that closed on 14 Nov", source: "RSVP sheet (closed 14 Nov)", about_from: "2026-11-14", about_to: "2026-11-14" },
    note: "records that 48 people are coming, from the RSVP sheet",
  },
  { who: "alice", day: 17, time: "09:15", tool: "ask_question", as: "whichVenue", args: { text: "Which venue can take all of us on a Friday in December?", about: ["@headcount"] }, note: "asks which venue can take all of them on a Friday" },
  {
    who: "bob", day: 17, time: "11:30", tool: "add_claim", as: "riverside",
    args: { text: "The Riverside Room can take the whole party on Friday 12 Dec", source: "phone call with the Riverside Room", about_from: "2026-12-12", about_to: "2026-12-12" },
    note: "claims the Riverside Room can take the whole party on Friday 12 Dec",
  },
  {
    who: "carol", day: 17, time: "14:05", tool: "add_claim",
    args: { text: "The Riverside Room's licence caps it at 40 seated, eight short of our 48", source: "Riverside Room premises licence, on the council's register", supports: ["@headcount"], contradicts: ["@riverside"] },
    note: "finds the Riverside Room's licence caps it at 40 seated. That contradicts bob, and the graph now holds a conflict",
  },
  { who: "bob", day: 17, time: "15:20", tool: "add_claim", as: "budget", args: { text: "The budget is £2,400, which is £50 a head for 48", source: "finance: events budget 2026" }, note: "records the budget: £2,400, which is £50 a head" },
  { who: "alice", day: 17, time: "15:40", tool: "ask_question", as: "coversHire", args: { text: "Does the budget cover a venue hire fee as well as food?", about: ["@budget"] }, note: "asks whether that covers a venue hire fee as well as food" },
  {
    who: "carol", day: 18, time: "10:00", tool: "add_claim", as: "orangery",
    args: { text: "The Orangery holds 60 and is free on Friday 19 Dec", source: "the Orangery's bookings page", about_from: "2026-12-19", about_to: "2026-12-19" },
    note: "finds the Orangery holds 60 and is free on Friday 19 Dec",
  },
  {
    who: "carol", day: 18, time: "10:20", tool: "add_claim", as: "waiver",
    args: { text: "The Orangery waives its hire fee at a £1,800 minimum spend on food and drink, which fits the £2,400 budget", source: "the Orangery's events pack", supports: ["@budget"], answers: ["@coversHire"] },
    note: "claims the Orangery waives its hire fee at a £1,800 minimum spend, which fits the budget. That answers alice's second question",
  },
  { who: "carol", day: 18, time: "10:21", tool: "link", args: { from: "@orangery", relation: "SUPPORTS", to: "@waiver" }, note: "links the Orangery's availability as support for that" },
  { who: "bob", day: 18, time: "12:05", tool: "add_claim", as: "lastYear", args: { text: "Last year's party cost £3,100" }, note: "claims last year's party cost £3,100" },
  { who: "bob", day: 18, time: "12:30", tool: "withdraw", args: { id: "@lastYear", reason: "Wrong party: that was the summer party" }, note: "withdraws it: that was the summer party. It stays in the history, marked as ended" },
  {
    who: "bob", day: 18, time: "16:45", tool: "add_claim",
    args: { text: "The party is at the Orangery on Friday 19 Dec, not the Riverside Room", about_from: "2026-12-19", about_to: "2026-12-19", replaces: ["@riverside"], supports: ["@waiver"], answers: ["@whichVenue"] },
    note: "replaces his Riverside claim: the party is at the Orangery on 19 Dec. The conflict settles, and alice's first question is answered",
  },
  { who: "alice", day: 19, time: "09:00", tool: "ask_question", as: "partners", args: { text: "Should partners be invited, and is there budget for them?" }, note: "asks whether partners should be invited, and whether there is budget for them" },
  {
    who: "carol", day: 19, time: "09:40", tool: "reply",
    args: { question: "@partners", text: "Finance can't stretch to partners this year. A January drinks evening for partners might work; I'll ask." },
    note: "replies in the thread: not within this year's budget, but a January drinks evening might work. A reply is a message, not an answer, so the question stays open",
  },
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
