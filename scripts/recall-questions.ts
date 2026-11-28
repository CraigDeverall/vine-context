// Eighteen questions a teammate would ask about the example story, each with
// one right answer. `right` and `stale` name the scenario steps (their `as`
// names) that the answers rest on, so a script can work out who is able to
// answer what, without asking a model:
//
//   - a claim's name: that claim, still current;
//   - "withdrawn:<name>": that claim, withdrawn;
//   - "open:<name>": that question, still open;
//   - "conflict:<a>:<b>": those two claims, in an unsettled conflict.
//
// `stale` lists claims that were true once and point at a wrong option now.

export interface Question {
  text: string;
  options: string[];
  /** Index into `options`. */
  answer: number;
  right: string[];
  stale?: { claim: string; option: number }[];
}

export const QUESTIONS: Question[] = [
  {
    text: "When do entries for the hackathon close?",
    options: ["Mon 30 Nov 2026", "Fri 11 Dec 2026 at 6:00 PM PST", "Fri 18 Dec 2026 at noon UTC", "Thu 31 Dec 2026"],
    answer: 1,
    right: ["deadline"],
  },
  {
    text: "Which machine can write to a shared graph?",
    options: ["Only the one machine that hosts it", "A central server run by the project", "Every member's machine, each to its own full copy", "Whichever machine holds a lock"],
    answer: 2,
    right: ["replicated"],
    stale: [{ claim: "oneHost", option: 0 }],
  },
  {
    text: "The person who created a context shuts their laptop. What can the others do?",
    options: ["Carry on reading and writing, and sync with each other", "Read, but not write", "Nothing until the creator is back", "Carry on only if they are on the same network"],
    answer: 0,
    right: ["replicated"],
    stale: [{ claim: "oneHost", option: 2 }],
  },
  {
    text: "How does a new person join a context?",
    options: ["With one reusable link for the whole group, then a fingerprint check", "With an account on the project's website", "With a join code made for that one person, and no fingerprint check", "By being on the same local network"],
    answer: 2,
    right: ["joinCodes"],
    stale: [{ claim: "oneLink", option: 0 }],
  },
  {
    text: "Which embedder does search use by default?",
    options: ["hash-256, always", "hash-256, with a semantic one that can be switched on", "A hosted embedding API", "bge-small when its package is installed and runs on the machine, else hash-256"],
    answer: 3,
    right: ["semantic"],
    stale: [
      { claim: "hash", option: 0 },
      { claim: "optIn", option: 1 },
    ],
  },
  {
    text: "Can a team install its own model pack, such as a decision log?",
    options: ["Yes", "No: model packs were removed, and there is one fixed model", "Yes, but only the admin", "Only with the semantic embedder"],
    answer: 1,
    right: ["withdrawn:packs"],
    stale: [{ claim: "packs", option: 0 }],
  },
  {
    text: "What is the project called, and how do its join codes start?",
    options: ["p2p-context-graph, p2pcg1_", "Vine Context, vine1_", "Relate Mesh, rm1_", "Vine Context, p2pcg1_"],
    answer: 1,
    right: ["rename"],
  },
  {
    text: "Is the team agreed on how the entry will be judged?",
    options: ["Yes: out of 100, with Relate and connected context worth 30", "Yes: five criteria weighted equally", "No: the overview page gives 100 points and the rules give equal weights, and nobody has settled which holds", "Yes: by public vote"],
    answer: 2,
    right: ["conflict:equal:weights"],
    stale: [{ claim: "weights", option: 0 }],
  },
  {
    text: "Why did CI never start on pull request 33?",
    options: ["A payment failed", "The workflow file had an error", "The month's included Actions compute was used up and the spending budget was $0", "GitHub's runners were down"],
    answer: 2,
    right: ["budget"],
    stale: [{ claim: "payment", option: 0 }],
  },
  {
    text: "Is CI running now?",
    options: ["No, Actions is still blocked", "Yes: the repo was made public, and CI passed on Ubuntu, macOS and Windows", "Yes, on a self-hosted runner", "Yes, on Linux only"],
    answer: 1,
    right: ["public"],
    stale: [
      { claim: "payment", option: 0 },
      { claim: "budget", option: 0 },
    ],
  },
  {
    text: "Can a judge install it from npm with one command today?",
    options: ["No: npm has only a 0.0.1 placeholder", "Yes: 0.1.0 is on npm and `vine doctor` passes", "No: it must be built from a clone", "Yes, but only on macOS"],
    answer: 1,
    right: ["published"],
    stale: [{ claim: "placeholder", option: 0 }],
  },
  {
    text: "How do machines find each other, and what can the service in the middle read?",
    options: ["Through a server the project runs, which reads everything", "Through public Nostr relays, which only see ciphertext", "Through local network discovery only", "Through a cloud database of members"],
    answer: 1,
    right: ["nostr"],
  },
  {
    text: "Why do copies of a graph need no merge rules?",
    options: ["Because one machine is the only writer", "Because a CRDT merges them", "Because every change is one of a few fixed kinds, under one fixed model", "Because the admin settles each difference by hand"],
    answer: 2,
    right: ["fixedKinds"],
    stale: [{ claim: "oneHost", option: 0 }],
  },
  {
    text: "What should a judge do before running the relate command on the example store?",
    options: ["Nothing", "Stop the vine host", "Copy the store and query the copy, because the command rewrites the store's files", "Run `vine doctor`"],
    answer: 2,
    right: ["copyFirst"],
  },
  {
    text: "What is the example story about?",
    options: ["Three colleagues planning the office Christmas party", "A production incident", "The team building Vine Context for the hackathon", "A product launch"],
    answer: 2,
    right: ["us"],
    stale: [{ claim: "party", option: 0 }],
  },
  {
    text: "How many entries were in the hackathon gallery on 25 Nov, and do any of them sync peer to peer between machines?",
    options: ["83, and none of them does", "83, and about 16 do", "16, and none of them does", "About 40, and several do"],
    answer: 0,
    right: ["field"],
  },
  {
    text: "Who is recording the demo video?",
    options: ["Craig", "Craigosaurus Rex", "Craiginator", "Nobody yet: it is an open question"],
    answer: 3,
    right: ["open:video"],
  },
  {
    text: "Someone uses Vine on two machines. How many members do they count as?",
    options: ["One: their devices are linked", "Two: each install has its own key, and whether to link them is an open question", "One per context", "It depends on their role"],
    answer: 1,
    right: ["open:devices"],
  },
];
