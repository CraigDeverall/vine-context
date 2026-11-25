// Measures what the shared graph is for: how many of a teammate's questions
// each person can answer from what they wrote themselves, against how many
// the shared graph answers.
//
// The data is the example story's signed change log (examples/data), and the
// questions are in recall-questions.ts. Two layers:
//
//   1. Worked out, no model (the default). For each person, take only the
//      changes they signed. A question counts as "right" when their own notes
//      hold what the right answer rests on, "out of date" when they hold a
//      claim that was true once and has since been replaced by someone else,
//      and "can't tell" otherwise. For the shared graph, the same test is run
//      on what the vine tools return from the example's Relate store.
//
//   2. Asked (--ask). The same notes are given to a Claude model through the
//      `claude` command, which must be logged in, and its answers are marked
//      against the key. Each person's notes, then the shared graph.
//
//   npm run bench:recall
//   npm run bench:recall -- --ask --model sonnet --json docs/measured/recall.json

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Change } from "../src/core/changes.ts";
import { packageRoot } from "../src/core/package-root.ts";
import { CAST, CREATOR, GRAPH_NAME, STEPS, type Name } from "../src/demo/scenario.ts";
import { QUESTIONS, type Question } from "./recall-questions.ts";

type Row = Record<string, any>;
type Mark = "right" | "out of date" | "wrong" | "can't tell";
const { values } = parseArgs({ options: { ask: { type: "boolean" }, model: { type: "string" }, json: { type: "string" }, store: { type: "boolean" } } });
const example = join(packageRoot(), "examples", "data");
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// ---- The story, from the signed log -----------------------------------

const log: Change[] = readFileSync(join(example, "hosts", GRAPH_NAME, "changes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const nameOf = new Map<string, Name>();
for (const c of log) {
  if (c.kind === "create") nameOf.set(c.author, c.body.creator_name as Name);
  if (c.kind === "add_member") nameOf.set(c.body.key as string, c.body.name as Name);
}
const node = new Map<string, Change>(); // node id -> the change that made it
for (const c of log) if ((c.kind === "claim" || c.kind === "question" || c.kind === "reply") && typeof c.body.node === "string") node.set(c.body.node, c);

/** The node a scenario step made, found by its text. */
const idOf = (as: string): string => {
  const step = STEPS.find((s) => s.as === as);
  if (!step) throw new Error(`no step saved as '${as}'`);
  const hit = [...node].find(([, c]) => c.body.text === step.args.text);
  if (!hit) throw new Error(`step '${as}' is not in the example log: run npm run examples`);
  return hit[0];
};

/** Every (relation, from, to) in a set of changes: from claims' own links and from link changes. */
function links(changes: Change[]): { rel: string; from: string; to: string; by: string }[] {
  const out: { rel: string; from: string; to: string; by: string }[] = [];
  for (const c of changes) {
    if (c.kind === "claim") for (const rel of ["supports", "contradicts", "replaces", "answers"]) for (const to of arr(c.body[rel])) out.push({ rel: rel.toUpperCase(), from: c.body.node as string, to, by: c.author });
    if (c.kind === "question") for (const to of arr(c.body.about)) out.push({ rel: "ABOUT", from: c.body.node as string, to, by: c.author });
    if (c.kind === "link") out.push({ rel: String(c.body.relation), from: String(c.body.from), to: String(c.body.to), by: c.author });
  }
  return out;
}

// ---- What one person's own notes hold ----------------------------------

function own(who: Name) {
  const mine = log.filter((c) => nameOf.get(c.author) === who);
  const made = new Set(mine.filter((c) => typeof c.body.node === "string" && c.kind !== "withdraw").map((c) => c.body.node as string));
  const ls = links(mine).filter((l) => made.has(l.from));
  const withdrawn = new Set(mine.filter((c) => c.kind === "withdraw").map((c) => c.body.node as string));
  const replaced = new Set(ls.filter((l) => l.rel === "REPLACES" && made.has(l.to)).map((l) => l.to));
  const answered = new Set(ls.filter((l) => l.rel === "ANSWERS" && made.has(l.to)).map((l) => l.to));
  const current = (id: string) => made.has(id) && !withdrawn.has(id) && !replaced.has(id);
  const holds = (e: string): boolean => {
    const [kind, a, b] = e.includes(":") ? e.split(":") : ["claim", e];
    if (kind === "claim") return current(idOf(a!));
    if (kind === "withdrawn") return made.has(idOf(a!)) && withdrawn.has(idOf(a!));
    if (kind === "open") return made.has(idOf(a!)) && !answered.has(idOf(a!));
    if (kind === "conflict") return current(idOf(a!)) && current(idOf(b!)) && ls.some((l) => l.rel === "CONTRADICTS" && [idOf(a!), idOf(b!)].includes(l.from) && [idOf(a!), idOf(b!)].includes(l.to));
    throw new Error(`unknown evidence '${e}'`);
  };
  return { mine, made, ls, withdrawn, replaced, current, holds };
}

const mark = (q: Question, holds: (e: string) => boolean): Mark => (q.right.every(holds) ? "right" : (q.stale ?? []).some((s) => holds(s.claim)) ? "out of date" : "can't tell");

// ---- What the shared graph holds: the vine tools, on the example store ---

async function shared() {
  const dir = mkdtempSync(join(tmpdir(), "vine-recall-"));
  cpSync(example, dir, { recursive: true });
  process.env.VINE_AUTO_SHARE = "off";
  const { Host } = await import("../src/host/host.ts");
  const { LocalHost } = await import("../src/host/client.ts");
  const host = await Host.start({ dataDir: dir, graph: GRAPH_NAME, user: CREATOR });
  const local = await LocalHost.connect(host.socket);
  const call = <T>(tool: string, args: Row = {}) => local.request<T>("call", { tool, args });
  const beliefs = await call<Row[]>("beliefs", { limit: 200 });
  const open = await call<Row[]>("open_questions", { limit: 200 });
  const conflicts = await call<Row[]>("conflicts", {});
  const threads = [];
  for (const q of open) threads.push(await call<Row>("thread", { question: q.id }));
  local.close();
  host.stop();
  const believed = new Set(beliefs.map((b) => b.id as string));
  const stillOpen = new Set(open.map((q) => q.id as string));
  const disputed = JSON.stringify(conflicts);
  const holds = (e: string): boolean => {
    const [kind, a, b] = e.includes(":") ? e.split(":") : ["claim", e];
    if (kind === "claim") return believed.has(idOf(a!));
    if (kind === "withdrawn") return !believed.has(idOf(a!));
    if (kind === "open") return stillOpen.has(idOf(a!));
    if (kind === "conflict") return disputed.includes(idOf(a!)) && disputed.includes(idOf(b!));
    throw new Error(`unknown evidence '${e}'`);
  };
  return { holds, dir, text: JSON.stringify({ current_claims: beliefs, open_questions: threads, unsettled_conflicts: conflicts }, null, 1) };
}

// ---- Asking a model ------------------------------------------------------

const when = (c: Change) => new Date(c.at).toUTCString().slice(5, 22);

/** One person's notes as they would stand without a shared graph: what they wrote, and what they did to their own items. */
function notes(who: Name): string {
  const o = own(who);
  const lines: string[] = [];
  for (const c of o.mine) {
    const b = c.body;
    const mineToo = (rel: string) => o.ls.filter((l) => l.from === b.node && l.rel === rel && o.made.has(l.to)).map((l) => `"${node.get(l.to)!.body.text}"`);
    if (c.kind === "claim") {
      let line = `[${when(c)}] I recorded: ${b.text}`;
      if (b.source) line += ` (source: ${b.source})`;
      for (const [rel, words] of [["REPLACES", "This replaces my earlier note"], ["CONTRADICTS", "This contradicts my note"], ["ANSWERS", "This answers my question"], ["SUPPORTS", "This supports my note"]] as const) for (const t of mineToo(rel)) line += ` ${words} ${t}.`;
      lines.push(line);
    } else if (c.kind === "question") lines.push(`[${when(c)}] I asked: ${b.text}`);
    else if (c.kind === "reply") lines.push(`[${when(c)}] I said, in a discussion: ${b.text}`);
    else if (c.kind === "withdraw" && o.made.has(b.node as string)) lines.push(`[${when(c)}] I withdrew my note "${node.get(b.node as string)!.body.text}". Reason: ${b.reason}`);
  }
  return lines.join("\n");
}

const LETTERS = "ABCD";
const SYSTEM = "You answer questions about a project using only the notes you are given. Do not use anything you know from elsewhere, and do not guess.";

function ask(material: string, what: string, model: string): (number | null)[] {
  const prompt = `${what}\n\n<notes>\n${material}\n</notes>\n\nAnswer each question below with the letter of the one option the notes support as true now. If the notes do not say, or you cannot tell from them, answer X. Reply with one JSON object and nothing else, like {"1":"B","2":"X"}.\n\n${QUESTIONS.map((q, i) => `${i + 1}. ${q.text}\n${q.options.map((o, j) => `   ${LETTERS[j]}. ${o}`).join("\n")}`).join("\n\n")}`;
  const cwd = mkdtempSync(join(tmpdir(), "vine-ask-")); // an empty folder: no project instructions, no memory
  try {
    const out = execFileSync("claude", ["-p", "--model", model, "--tools", "", "--system-prompt", SYSTEM, "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"], { input: prompt, cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const res = JSON.parse(out) as { result: string; is_error?: boolean };
    if (res.is_error) throw new Error(res.result);
    const got = JSON.parse(res.result.slice(res.result.indexOf("{"), res.result.lastIndexOf("}") + 1)) as Record<string, string>;
    return QUESTIONS.map((_, i) => {
      const at = LETTERS.indexOf(String(got[String(i + 1)] ?? "X").trim().toUpperCase());
      return at < 0 ? null : at;
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const markAnswer = (q: Question, a: number | null): Mark => (a === null ? "can't tell" : a === q.answer ? "right" : (q.stale ?? []).some((s) => s.option === a) ? "out of date" : "wrong");

// ---- Run ----------------------------------------------------------------

const tally = (marks: Mark[]) => ({ right: marks.filter((m) => m === "right").length, out_of_date: marks.filter((m) => m === "out of date").length, wrong: marks.filter((m) => m === "wrong").length, cant_tell: marks.filter((m) => m === "can't tell").length });
const people = CAST.map((c) => c.name);
const sh = await shared();
const worked: Record<string, Mark[]> = {};
for (const p of people) worked[p] = QUESTIONS.map((q) => mark(q, own(p).holds));
worked["the shared graph"] = QUESTIONS.map((q) => mark(q, sh.holds));

const report: Row = { questions: QUESTIONS.length, worked_out: Object.fromEntries(Object.entries(worked).map(([k, v]) => [k, tally(v)])) };
const table = (title: string, rows: Record<string, Mark[]>) => {
  console.log(`\n${title}\n${"from".padEnd(22)}right  out of date  wrong  can't tell`);
  for (const [k, v] of Object.entries(rows)) {
    const t = tally(v);
    console.log(`${k.padEnd(22)}${String(t.right).padStart(5)}${String(t.out_of_date).padStart(13)}${String(t.wrong).padStart(7)}${String(t.cant_tell).padStart(12)}`);
  }
};
table(`Worked out from the signed log (${QUESTIONS.length} questions)`, worked);

if (values.ask) {
  const model = values.model ?? "sonnet";
  const asked: Record<string, Mark[]> = {};
  const answers: Row = {};
  for (const p of people) {
    const a = ask(notes(p), `These are ${p}'s own notes from the project, oldest first. ${p} has no other source.`, model);
    answers[p] = a.map((x) => (x === null ? "X" : LETTERS[x]));
    asked[p] = QUESTIONS.map((q, i) => markAnswer(q, a[i]!));
  }
  const a = ask(sh.text, "This is what the team's shared graph holds now, as its tools return it: the claims that are current (replaced and withdrawn ones are left out), the questions still open with their threads, and the conflicts nobody has settled.", model);
  answers["the shared graph"] = a.map((x) => (x === null ? "X" : LETTERS[x]));
  asked["the shared graph"] = QUESTIONS.map((q, i) => markAnswer(q, a[i]!));
  table(`Asked of a Claude model (${model}), given the same notes`, asked);
  report.asked = { model, at: new Date().toISOString(), tallies: Object.fromEntries(Object.entries(asked).map(([k, v]) => [k, tally(v)])), answers, key: QUESTIONS.map((q) => LETTERS[q.answer]) };
}

rmSync(sh.dir, { recursive: true, force: true });
if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 1) + "\n");
const s = tally(worked["the shared graph"]!);
process.exit(s.right === QUESTIONS.length ? 0 : 1);
