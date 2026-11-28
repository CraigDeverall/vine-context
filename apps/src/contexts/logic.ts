// What the Contexts view works out from a context's activity and snapshot:
// threads, how items relate, filters, and the prompts it hands to the agent.
//
// The Claude Code mod (plugin/hooks/register.tsx) has the same logic for its
// panel. A mod is one module with no imports of its own, so the two are kept
// alike by hand: a change to one belongs in the other.

export type Role = "reader" | "contributor" | "admin";

export type Person = {
  name: string;
  fingerprint: string;
  role: Role | null;
  you: boolean;
  creator: boolean;
  online: boolean;
  joined_at?: string;
  agent: string | null;
  platform: string | null;
};

export type Change = {
  id: string;
  kind: string;
  at: string;
  by: string;
  mine: boolean;
  summary: string;
  node: string | null;
  held: boolean;
  shared_at: string | null;
};

export type GraphNode = {
  id: string;
  key: string;
  label: "Claim" | "Question" | "Reply";
  title: string;
  ended: boolean;
  props: Record<string, unknown>;
};

export type GraphEdge = { type: string; source: string; target: string };

/** A join code waiting for its one person. */
export type Invite = { id: string; label: string | null; role: Role; code: string; created_at: string; expires_at: string };

export type ChatContext = { name: string; description: string | null; role: Role | null; writes_here: boolean };

/** What `recent` with `activity` (and `open_view`'s contexts panel) return for a chat that has a context. */
export type Activity = {
  using: string;
  you: { name: string; role: Role | null; fingerprint: string };
  sharing: boolean;
  online: string[];
  members: number;
  people: Person[];
  relays_up: number;
  changes: number;
  recent: Change[];
  /** The context this activity is about (the one the view shows). */
  context: string;
  description: string | null;
  /** This chat's contexts: usually one. */
  contexts: ChatContext[];
  /** The folder this chat started in, and the contexts new chats there start with. */
  folder: { folder: string; linked: boolean; pinned?: string[] } | null;
  your_contexts: string[];
  digest: { at: string; lines: string[] }[];
  /** An admin's open join codes, newest first (absent for other roles). */
  invites?: Invite[];
  snapshot?: { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };
};

/** What they return for a chat with no context yet. */
export type NoContext = { context: null; your_contexts: string[] };

/** One of this machine's contexts in full (`context_info` with `details`). */
export type ContextDetails = {
  name: string;
  id: string | null;
  description: string | null;
  role: Role | null;
  yours: boolean;
  created_by: string | null;
  in_chat: boolean;
  writes_here: boolean;
  sharing: boolean;
  members: number;
  /** How many of the other members are online. */
  online: number;
  /** How many items of each kind it holds, withdrawn ones included. */
  items: Record<string, number>;
  changes: number;
  held: number;
  /** Join codes waiting to be used; null unless you're an admin. */
  open_invites: number | null;
  stored_at: string;
};

export type Tab = "overview" | "questions" | "claims" | "people" | "settings";

/** What the Questions and Claims lists show: the words to match, and which part of each list. */
export type Filters = {
  text: string;
  claims: "current" | "mine" | "conflicts" | "history";
  questions: "open" | "answered" | "mine";
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A line as a person reads it: without the item ids that are there for agents. */
export const plain = (s: string) => s.replace(/\s*\b[cqr]_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, "").replace(/\breplied to:/, "replied:");
export const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A path cut from the front, so its last folders (the telling part) stay. */
export const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);
export const ago = (iso: string, now: number) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const prop = (n: GraphNode, k: string) => (typeof n.props[k] === "string" ? (n.props[k] as string) : "");

/** A question with its thread and the claims that answer it. */
export type Thread = { q: GraphNode; replies: GraphNode[]; answers: GraphNode[] };

/** Builds the questions' threads and the current claims from a snapshot. */
export function threads(nodes: GraphNode[], edges: GraphEdge[]): { open: Thread[]; answered: Thread[]; claims: GraphNode[]; withdrawn: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const live = (n: GraphNode | undefined): n is GraphNode => !!n && !n.ended;
  // A claim is current unless withdrawn or replaced by a current claim.
  const replaced = new Set(edges.filter((e) => e.type === "REPLACES" && live(byId.get(e.source))).map((e) => e.target));
  const current = (n: GraphNode | undefined): n is GraphNode => live(n) && n.label === "Claim" && !replaced.has(n.id);
  const all: Thread[] = nodes
    .filter((n) => n.label === "Question" && !n.ended)
    .map((q) => ({
      q,
      replies: edges
        .filter((e) => e.type === "REPLIES_TO" && e.target === q.id)
        .map((e) => byId.get(e.source))
        .filter(live)
        .sort((a, b) => Date.parse(prop(a, "recorded_at")) - Date.parse(prop(b, "recorded_at"))),
      answers: edges
        .filter((e) => e.type === "ANSWERS" && e.target === q.id)
        .map((e) => byId.get(e.source))
        .filter(current),
    }));
  return {
    open: all.filter((t) => !t.answers.length),
    answered: all.filter((t) => t.answers.length),
    claims: nodes.filter(current),
    withdrawn: nodes.filter((n) => n.ended).length,
  };
}

/** How a snapshot's items relate: what replaced what, what contradicts what, and each item's links. */
export function relations(nodes: GraphNode[], edges: GraphEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const live = (n: GraphNode | undefined): n is GraphNode => !!n && !n.ended;
  /** A claim's newer version, where a claim that still stands replaced it. */
  const replacedBy = new Map<string, GraphNode>();
  for (const e of edges) {
    const by = byId.get(e.source);
    if (e.type === "REPLACES" && live(by)) replacedBy.set(e.target, by);
  }
  const current = (n: GraphNode | undefined): n is GraphNode => live(n) && n.label === "Claim" && !replacedBy.has(n.id);
  const linked = (id: string, type: string, dir: "out" | "in") =>
    edges
      .filter((e) => e.type === type && (dir === "out" ? e.source : e.target) === id)
      .map((e) => byId.get(dir === "out" ? e.target : e.source))
      .filter((n): n is GraphNode => !!n);
  // Pairs of claims that both still stand and can't both be true, each pair once.
  const pairs = new Map<string, [GraphNode, GraphNode]>();
  for (const e of edges) {
    if (e.type !== "CONTRADICTS") continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (current(a) && current(b)) pairs.set([a.id, b.id].sort().join("|"), [a, b]);
  }
  const conflicts = [...pairs.values()];
  const inConflict = new Set(conflicts.flatMap(([a, b]) => [a.id, b.id]));
  /** Claims that no longer stand: replaced or withdrawn. */
  const history = nodes.filter((n) => n.label === "Claim" && !current(n));
  return { byId, byKey, replacedBy, current, linked, conflicts, inConflict, history };
}

/**
 * What the server's search (meaning plus keywords) found for the filter's text
 * in a context, best first: item ids, or null while it's looking.
 */
export type Found = { text: string; context: string; ids: string[] | null; failed?: boolean };

/** How many items a filter adds because they're close in meaning, past those that share its words. */
export const RELATED = 5;

/**
 * A list under the filter: the items that match its words, then up to RELATED
 * more that the search found close in meaning (`near`, best first), which are
 * marked so the list can say so.
 */
export function filtered<T>(items: T[], key: (x: T) => string, words: (x: T) => boolean, near: string[] | null | undefined): { list: T[]; byMeaning: Set<string> } {
  const list = items.filter(words);
  const byMeaning = new Set<string>();
  if (!near?.length) return { list, byMeaning };
  const shown = new Set(list.map(key));
  const byKey = new Map(items.map((x) => [key(x), x] as const));
  for (const id of near) {
    if (byMeaning.size >= RELATED) break;
    const x = byKey.get(id);
    if (x !== undefined && !shown.has(id)) {
      byMeaning.add(id);
      list.push(x);
    }
  }
  return { list, byMeaning };
}

/** The item ids in a search tool's rows. */
export const ids = (rows: unknown): string[] =>
  (Array.isArray(rows) ? rows : []).map((r: any) => r?.id).filter((id: unknown): id is string => typeof id === "string");

/** Whether an item matches the filter's words: all of them, anywhere in its text, author, source or id. */
export function matches(n: GraphNode, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${n.title} ${prop(n, "recorded_by")} ${prop(n, "source")} ${n.key}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * What a button says to the agent, in the person's name, where the app shows
 * the views but can't run their tools: the request as the person would put it.
 * It appears in the chat as their own message, so it reads like one.
 */
export function asks(tool: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" && args[k] ? String(args[k]) : "");
  const name = s("name");
  const ctx = s("context");
  const there = ctx ? ` in the context '${ctx}'` : "";
  const of = ctx ? ` the context '${ctx}'` : " this chat's context";
  switch (tool) {
    case "open_view":
      if (args.view === "explorer") return s("at") ? `Open the context explorer as it was at ${s("at")}.` : "Open the context explorer.";
      return args.view === "console" ? "Open the Vine console." : "Open this chat's contexts.";
    case "use_context":
      if (args.mode === "remove") return `Stop using the context '${name}' in this chat.`;
      if (args.mode === "add") {
        if (s("description")) return `Create a context called '${name}' and add it to this chat. It's for: ${s("description")}`;
        return args.write_here ? `Record new items in the context '${name}' unless another of this chat's contexts fits better.` : `Add the context '${name}' to this chat.`;
      }
      return s("description") ? `Create a context called '${name}' and use it in this chat. It's for: ${s("description")}` : `Use the context '${name}' in this chat.`;
    case "link_folder":
      return args.off ? `Stop starting new chats in this folder with the context '${name}'.` : `Start new chats in this folder with the context '${name}'.`;
    case "update_context":
      if (s("my_name")) return `Change my name in Vine Context to '${s("my_name")}'.`;
      if (s("rename_to")) return `Rename${of} to '${s("rename_to")}' on this machine.`;
      return `Change the description of${of} to: ${s("purpose")}`;
    case "delete_context":
      return `Delete this machine's copy of the context '${name}' for good. I typed its name to confirm.`;
    case "share_context":
      return `Make a join code${s("label") ? ` for ${s("label")}` : ""}${s("role") ? ` with the role ${s("role")}` : ""}${there}.`;
    case "manage_member":
      if (args.action === "revoke_invite") return `Cancel the join code ${s("invite")}${there}.`;
      if (args.action === "set_role") return `Change ${name}'s role to ${s("role")}${there}.`;
      return `Remove ${name} from${of}.`;
    case "sharing":
      return args.action === "off" ? `Go offline with${of}.` : `Go back online with${of}.`;
    case "withdraw":
      return args.undo_only ? `Take back the change ${s("id")}${there}, before it's sent to the other members.` : `Withdraw ${s("id")}${there}.`;
    default:
      return `Run the Vine Context tool ${tool}${Object.keys(args).length ? ` with ${JSON.stringify(args)}` : ""}.`;
  }
}

/** What the agent is asked from the view's buttons: the person steers, the agent records. */
export const prompts = {
  catchUp: (context: string) =>
    `Catch me up on the context '${context}': what changed lately and who changed it, which questions are still open, and any claims that contradict each other. Keep it short, and end with what needs me.`,
  saveChat: (context: string) =>
    `Record what we've learned in this chat in the context '${context}'. Search it first, so you link to what's already there instead of repeating it. Add a claim for each finding and a question for each thing we still don't know, then tell me what you recorded, with the ids.`,
  investigate: (q: GraphNode, context?: string) =>
    `Look into the open question ${q.key} ("${short(q.title, 200)}")${context ? ` in the context '${context}'` : ""}. Search the context for what's already known about it, find out what you can, and reply on its thread with what you find. If that settles it, record a claim that answers it.`,
  correct: (claim: GraphNode, text: string, context?: string) =>
    `The claim ${claim.key} ("${short(claim.title, 200)}")${context ? ` in the context '${context}'` : ""} is wrong or out of date. What's right: ${text}\n\n` +
    `Record it: paraphrase it as a claim that stands alone, and add it with replaces: [${claim.key}]${context ? ` (context: ${context})` : ""}.`,
  settle: (keep: GraphNode, drop: GraphNode, context?: string) =>
    `The claims ${keep.key} ("${short(keep.title, 200)}") and ${drop.key} ("${short(drop.title, 200)}") contradict each other${context ? ` in the context '${context}'` : ""}. ${keep.key} is the one that's right.\n\n` +
    `Settle it so only one stands: withdraw ${drop.key} with that as the reason if you may, otherwise record a claim that replaces it (replaces: [${drop.key}])${context ? ` (context: ${context})` : ""}. Then tell me what you did.`,
};

/** What the agent is asked when the person answers a question, or picks a reply as the answer. */
export function answerPrompt(q: GraphNode, answer: { text: string } | { reply: GraphNode }, context?: string): string {
  const question = `the open question ${q.key} ("${short(q.title, 200)}")${context ? ` in the context '${context}'` : ""}`;
  const where = context ? ` (context: ${context})` : "";
  if ("text" in answer)
    return `My answer to ${question}: ${answer.text}\n\nRecord it: paraphrase it as a claim that stands alone, and add it with answers: [${q.key}]${where}.`;
  const r = answer.reply;
  return (
    `Answer ${question} with ${prop(r, "recorded_by") || "its"}'s reply ${r.key}: "${short(r.title, 400)}"\n\n` +
    `Paraphrase it as a claim that stands alone and record it with answers: [${q.key}], with source "reply ${r.key}"${where}.`
  );
}

/** What's wrong with a new context's name and description, or null. */
export function newContextProblem(name: string, description: string, existing: string[]): string | null {
  if (!name) return "Give it a name.";
  if (!NAME_RE.test(name)) return 'A context name is lower-case letters, digits and dashes, such as "checkout-incident".';
  if (existing.includes(name)) return `There's already a context '${name}' on this machine: turn it on in the list.`;
  if (!description.trim()) return "Say what it’s for: every member’s agent reads that to decide what belongs there.";
  return null;
}

/** The message to send someone with their join code. */
export const sendLine = (code: string) => `Join my context graph: /vine-context:join ${code}`;
