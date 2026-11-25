// The vine-context mod: this chat's shared contexts inside Claude Code's own UI.
//
// - A band above the prompt, in every chat: the chat's context (usually one),
//   who's online and the latest news. The context's name opens the panel's
//   Contexts view, where contexts are turned on and off for the chat.
// - A status line entry, and a toast when someone else's change or a digest arrives.
// - A panel (/contexts) with five tabs: an Overview (what needs you, what
//   changed, recent activity), the context's Questions with their threads, its
//   Claims (with conflicts and history), its People, and its Settings (this
//   chat's use of it, sharing, what it holds, deleting it). Whether it's
//   syncing, with a link to go online or offline, sits in the header. Long or
//   secondary lists show their first few behind an underlined "N more ▾". An
//   item opens on its own, with everything linked to it. Anything being edited
//   (the description, an invite, a new context, the chat's contexts, the page
//   of a context that's off for this chat, a deletion being confirmed) takes
//   the whole panel until it's done or cancelled. An answer or a correction is
//   written in the prompt box.
//
// Agents write; people steer. The panel never writes a claim itself: "Answer
// with this", "Keep this one", Look into it, Catch me up and "Save what this
// chat learned" hand the person's choice to the agent as a prompt, and the
// agent records it (see `prompts`). Answering a question and correcting a claim
// start a prompt in the prompt box instead (see `drafts`): the person writes
// their answer or correction on its last line and sends it themselves.
//
// It reads through the vine-context MCP server's `context_activity` tool,
// which never uses up the join notices meant for the agent, and acts through
// the server's ordinary tools. It polls, so there's nothing to refresh.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Activity, Change, ContextDetails, Filters, Found, GraphEdge, GraphNode, Invite, Latest, Person, Tab } from '../types'

const PANE = 'context-graph'
const POLL_MS = 4000
const TICK_MS = 400
const NOTICE_MS = 6000
/** How many items a list shows before "Show more". */
const PAGE = 20
/** How many recent changes the Overview shows before "N more". */
const RECENT = 5
/** Below this many cells across the pane's body, a row's text and its buttons stack. */
const NARROW = 46
/** From this many cells across, the Overview sets its two halves side by side. */
const WIDE = 100

/**
 * How the pane lays itself out for the room it has: `glance` for the desktop
 * app's minimized widget (clicks may not reach it), else by the body's width.
 * Height isn't used: a change of height alone doesn't redraw the pane, so the
 * body scrolls instead.
 */
export type Fit = 'glance' | 'narrow' | 'regular' | 'wide'
export const paneFit = (p: { bodyColumns?: number; placement?: string }): Fit => {
  if (p.placement === 'widget') return 'glance'
  const cols = p.bodyColumns ?? 80
  return cols < NARROW ? 'narrow' : cols >= WIDE ? 'wide' : 'regular'
}

// The header names at most this many members (you, then who's online); the People tab has everyone.
const HEADER_PEOPLE = 6
const SERVERS = ['plugin_vine-context_vine-context', 'plugin:vine-context:vine-context', 'vine-context']
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

const activity = atom({ plugin: 'vine-context', key: 'activity' } as const, null, { shape: 'activity-3' })
const latest = atom({ plugin: 'vine-context', key: 'latest' } as const, null)
const tab = atom({ plugin: 'vine-context', key: 'tab' } as const, 'overview', { shape: 'tab-3' })
const code = atom({ plugin: 'vine-context', key: 'code' } as const, null)
const notice = atom({ plugin: 'vine-context', key: 'notice' } as const, null)
const error = atom({ plugin: 'vine-context', key: 'error' } as const, null)
const confirmRemove = atom({ plugin: 'vine-context', key: 'confirmRemove' } as const, null)
const creating = atom({ plugin: 'vine-context', key: 'creating' } as const, null)
const managing = atom({ plugin: 'vine-context', key: 'managing' } as const, null)
const details = atom({ plugin: 'vine-context', key: 'details' } as const, null)
const deleting = atom({ plugin: 'vine-context', key: 'deleting' } as const, null)
const editing = atom({ plugin: 'vine-context', key: 'editing' } as const, false)
const switching = atom({ plugin: 'vine-context', key: 'switching' } as const, false)
const detail = atom({ plugin: 'vine-context', key: 'detail' } as const, null)
const renaming = atom({ plugin: 'vine-context', key: 'renaming' } as const, false)
const filters = atom({ plugin: 'vine-context', key: 'filters' } as const, { text: '', claims: 'current', questions: 'open' })
const found = atom({ plugin: 'vine-context', key: 'found' } as const, null)
const more = atom({ plugin: 'vine-context', key: 'more' } as const, 0)
const unattached = atom({ plugin: 'vine-context', key: 'unattached' } as const, null)
const viewing = atom({ plugin: 'vine-context', key: 'viewing' } as const, null)
const tick = atom({ plugin: 'vine-context', key: 'tick' } as const, 0)
const inviting = atom({ plugin: 'vine-context', key: 'inviting' } as const, null)
const folds = atom({ plugin: 'vine-context', key: 'folds' } as const, [] as string[])

type Engine = EngineInterface

/** What's typed in the new invite's note, for its Make button (the field's own submit works too). */
let inviteNote = ''
/** What's typed in the new context's two fields, for its Create button. */
let newName = ''
let newDescription = ''
/** What's typed to confirm a deletion, for its Delete button. */
let deleteText = ''

/** The tabs, each with its icon. */
const TABS: { tab: Tab; icon: string; label: string }[] = [
  { tab: 'overview', icon: '🏠', label: 'Overview' },
  { tab: 'questions', icon: '❓', label: 'Questions' },
  { tab: 'claims', icon: '📌', label: 'Claims' },
  { tab: 'people', icon: '👥', label: 'People' },
  { tab: 'settings', icon: '⚙', label: 'Settings' },
]

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** A path cut from the front, so its last folders (the telling part) stay. */
export const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s)
const ago = (iso: string, now: number) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
const prop = (n: GraphNode, k: string) => (typeof n.props[k] === 'string' ? (n.props[k] as string) : '')

/** A question with its thread and the claims that answer it, from the snapshot. */
export type Thread = { q: GraphNode; replies: GraphNode[]; answers: GraphNode[] }

/** Builds the questions' threads and the current claims from a snapshot. */
export function threads(nodes: GraphNode[], edges: GraphEdge[]): { open: Thread[]; answered: Thread[]; claims: GraphNode[]; withdrawn: number } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const live = (n: GraphNode | undefined): n is GraphNode => !!n && !n.ended
  // A claim is current unless withdrawn or replaced by a current claim.
  const replaced = new Set(edges.filter(e => e.type === 'REPLACES' && live(byId.get(e.source))).map(e => e.target))
  const current = (n: GraphNode | undefined): n is GraphNode => live(n) && n.label === 'Claim' && !replaced.has(n.id)
  const all: Thread[] = nodes
    .filter(n => n.label === 'Question' && !n.ended)
    .map(q => ({
      q,
      replies: edges
        .filter(e => e.type === 'REPLIES_TO' && e.target === q.id)
        .map(e => byId.get(e.source))
        .filter(live)
        .sort((a, b) => Date.parse(prop(a, 'recorded_at')) - Date.parse(prop(b, 'recorded_at'))),
      answers: edges
        .filter(e => e.type === 'ANSWERS' && e.target === q.id)
        .map(e => byId.get(e.source))
        .filter(current),
    }))
  return {
    open: all.filter(t => !t.answers.length),
    answered: all.filter(t => t.answers.length),
    claims: nodes.filter(current),
    withdrawn: nodes.filter(n => n.ended).length,
  }
}

/** How a snapshot's items relate: what replaced what, what contradicts what, and each item's links. */
export function relations(nodes: GraphNode[], edges: GraphEdge[]) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const byKey = new Map(nodes.map(n => [n.key, n]))
  const live = (n: GraphNode | undefined): n is GraphNode => !!n && !n.ended
  /** A claim's newer version, where a claim that still stands replaced it. */
  const replacedBy = new Map<string, GraphNode>()
  for (const e of edges) {
    const by = byId.get(e.source)
    if (e.type === 'REPLACES' && live(by)) replacedBy.set(e.target, by)
  }
  const current = (n: GraphNode | undefined): n is GraphNode => live(n) && n.label === 'Claim' && !replacedBy.has(n.id)
  const linked = (id: string, type: string, dir: 'out' | 'in') =>
    edges
      .filter(e => e.type === type && (dir === 'out' ? e.source : e.target) === id)
      .map(e => byId.get(dir === 'out' ? e.target : e.source))
      .filter((n): n is GraphNode => !!n)
  // Pairs of claims that both still stand and can't both be true, each pair once.
  const pairs = new Map<string, [GraphNode, GraphNode]>()
  for (const e of edges) {
    if (e.type !== 'CONTRADICTS') continue
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (current(a) && current(b)) pairs.set([a.id, b.id].sort().join('|'), [a, b])
  }
  const conflicts = [...pairs.values()]
  const inConflict = new Set(conflicts.flatMap(([a, b]) => [a.id, b.id]))
  /** Claims that no longer stand: replaced or withdrawn. */
  const history = nodes.filter(n => n.label === 'Claim' && !current(n))
  return { byId, byKey, replacedBy, current, linked, conflicts, inConflict, history }
}

/** Whether an item matches the filter's words: all of them, anywhere in its text, author, source or id. */
export function matches(n: GraphNode, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${n.title} ${prop(n, 'recorded_by')} ${prop(n, 'source')} ${n.key}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

/** How many items a filter adds because they're close in meaning, past those that share its words. */
export const RELATED = 5

/**
 * A list under the filter: the items that match its words, then up to RELATED
 * more that the search found close in meaning (`near`, best first), which are
 * marked so the list can say so.
 */
export function filtered<T>(items: T[], key: (x: T) => string, words: (x: T) => boolean, near: string[] | null | undefined): { list: T[]; byMeaning: Set<string> } {
  const list = items.filter(words)
  const byMeaning = new Set<string>()
  if (!near?.length) return { list, byMeaning }
  const shown = new Set(list.map(key))
  const byKey = new Map(items.map(x => [key(x), x] as const))
  for (const id of near) {
    if (byMeaning.size >= RELATED) break
    const x = byKey.get(id)
    if (x !== undefined && !shown.has(id)) {
      byMeaning.add(id)
      list.push(x)
    }
  }
  return { list, byMeaning }
}

/**
 * Asks the server's search for what the filter's text is close to, in the
 * context the panel shows, ended items included so History can use it too.
 * A server from before `include_ended` is asked again without it.
 */
async function findRelated($: Engine, text: string, context: string, ctx: Record<string, unknown>) {
  if (!text) return update($, found, () => null)
  await update($, found, () => ({ text, context, ids: null }))
  const ask = { query: text, kind: 'any', limit: 50, ...ctx }
  const settle = (next: Found) => update($, found, (v: Found | null) => (v?.text === text && v.context === context ? next : v))
  try {
    const rows = await call($, 'search', { ...ask, include_ended: true }).catch(() => call($, 'search', ask))
    const ids = (Array.isArray(rows) ? rows : []).map((r: any) => r?.id).filter((id: unknown): id is string => typeof id === 'string')
    await settle({ text, context, ids })
  } catch {
    await settle({ text, context, ids: [], failed: true })
  }
}

/** What the agent is asked from the panel's other buttons: the person steers, the agent records. */
export const prompts = {
  catchUp: (context: string) =>
    `Catch me up on the context '${context}': what changed lately and who changed it, which questions are still open, and any claims that contradict each other. Keep it short, and end with what needs me.`,
  saveChat: (context: string) =>
    `Record what we've learned in this chat in the context '${context}'. Search it first, so you link to what's already there instead of repeating it. Add a claim for each finding and a question for each thing we still don't know, then tell me what you recorded, with the ids.`,
  investigate: (q: GraphNode, context?: string) =>
    `Look into the open question ${q.key} ("${short(q.title, 200)}")${context ? ` in the context '${context}'` : ''}. Search the context for what's already known about it, find out what you can, and reply on its thread with what you find. If that settles it, record a claim that answers it.`,
  settle: (keep: GraphNode, drop: GraphNode, context?: string) =>
    `The claims ${keep.key} ("${short(keep.title, 200)}") and ${drop.key} ("${short(drop.title, 200)}") contradict each other${context ? ` in the context '${context}'` : ''}. ${keep.key} is the one that's right.\n\n` +
    `Settle it so only one stands: withdraw ${drop.key} with that as the reason if you may, otherwise record a claim that replaces it (replaces: [${drop.key}])${context ? ` (context: ${context})` : ''}. Then tell me what you did.`,
}

/**
 * What the prompt box is started with to answer a question or correct a claim:
 * what the agent is to do, the item, and a last line for the person to finish
 * in their own words before they send it.
 */
export const drafts = {
  answer: (q: GraphNode, context?: string) =>
    `Record my answer to the open question ${q.key}${context ? ` in the context '${context}'` : ''}: paraphrase it as a claim that stands alone, with answers: [${q.key}].\n` +
    `Q: ${short(q.title, 300)}\nA: `,
  correct: (claim: GraphNode, context?: string) =>
    `The claim ${claim.key}${context ? ` in the context '${context}'` : ''} is wrong or out of date. Record what's right: paraphrase it as a claim that stands alone, with replaces: [${claim.key}].\n` +
    `Was: ${short(claim.title, 300)}\nNow: `,
}

/** What the agent is asked when the person picks a reply as a question's answer. */
export function answerPrompt(q: GraphNode, answer: { reply: GraphNode }, context?: string): string {
  const question = `the open question ${q.key} ("${short(q.title, 200)}")${context ? ` in the context '${context}'` : ''}`
  const where = context ? ` (context: ${context})` : ''
  const r = answer.reply
  return (
    `Answer ${question} with ${prop(r, 'recorded_by') || 'its'}'s reply ${r.key}: "${short(r.title, 400)}"\n\n` +
    `Paraphrase it as a claim that stands alone and record it with answers: [${q.key}], with source "reply ${r.key}"${where}.`
  )
}

// Module state: starts over on a reload (the values in $.state stay).
let server: string | undefined
let poll: { cancel(): void } | undefined
let loading: { cancel(): void } | undefined
let seen: Set<string> | undefined
let seenDigest: string | undefined
let wantSnapshot = false
/** How many times in a row the server hasn't answered: after a few, the band stops saying "loading". */
let failures = 0
const GIVE_UP_AFTER = 3
let noticeTimer: { cancel(): void } | undefined
/** The items opened one after another, so Back returns to the one before. */
let trail: string[] = []

/** Calls a tool on the vine-context server, finding its name on first use. */
async function call($: Engine, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const names = server ? [server] : SERVERS
  let last: unknown
  for (const name of names) {
    try {
      const r = await $.mcp.call(name, tool, args)
      server = name
      const text = r.content.map(c => ('text' in c && typeof c.text === 'string' ? c.text : '')).find(t => t && !t.startsWith('News: ')) ?? ''
      if (r.isError) throw new Error(text || `${tool} failed`)
      if (r.structuredContent !== undefined) return r.structuredContent
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } catch (e) {
      last = e
      if (server) throw e
    }
  }
  throw last instanceof Error ? last : new Error('The vine-context MCP server is not connected.')
}

/**
 * Whether the error showing came from the poll (the server not answering). The
 * next answer clears only that kind: an error from something the person did
 * stays until they dismiss it or their next action works.
 */
let errorFromPoll = false

/** Shows an error in the panel (and, from the poll while nothing has loaded, the band). */
async function fail($: Engine, message: string, fromPoll = false) {
  errorFromPoll = fromPoll
  await update($, error, () => message)
}

/** Clears the error showing. */
async function clearError($: Engine) {
  errorFromPoll = false
  await update($, error, () => null)
}

/** Why the server didn't answer, in words that say what to do about it. */
export function trouble(message: string): string {
  if (/context_activity|context_details|delete_context|unknown tool|not found|no such tool/i.test(message))
    return 'This chat is still running an older vine-context server. Start a new chat (or restart this one) to pick up the new one.'
  if (/not connected|no server|disconnected|closed/i.test(message)) return 'The vine-context server isn’t connected in this chat. Check it’s enabled, then start a new chat.'
  return message
}

/** The server answered, or clearly won't: the band's "loading…" stops. */
function loaded() {
  loading?.cancel()
  loading = undefined
}

async function refresh($: Engine) {
  try {
    const which = await read($, viewing)
    const r = (await call($, 'context_activity', { limit: 40, snapshot: wantSnapshot, ...(which ? { context: which } : {}) })) as Activity | { context: null; your_contexts: string[] }
    loaded()
    failures = 0
    if (errorFromPoll) await clearError($)
    if (r.context === null) {
      // No context in this chat (there's no default): the band and panel offer to choose one.
      await update($, unattached, () => r.your_contexts)
      await update($, activity, () => null)
      await update($, latest, () => null)
      await update($, viewing, () => null)
      $.ui.status('no context')
      return
    }
    const a = r as Activity
    await update($, unattached, () => null)
    await update($, activity, () => a)
    if (which && which !== a.context) await update($, viewing, () => null) // it was taken out of the chat
    const others = a.recent.filter(c => !c.mine && !c.held)
    if (seen) {
      const fresh = others.filter(c => !seen!.has(c.id) && ['claim', 'question', 'reply', 'add_member', 'withdraw', 'remove_member'].includes(c.kind))
      for (const c of fresh.slice(0, 3)) $.ui.toast(`${c.by} ${short(c.summary, 90)}`)
    }
    seen = new Set(a.recent.map(c => c.id))
    // What others' changes meant for you (the sync digest): its first line as a toast.
    const d = a.digest?.at(-1)
    if (d && seenDigest !== undefined && d.at !== seenDigest && d.lines[0]) $.ui.toast(`${a.context}: ${short(d.lines[0], 110)}`)
    seenDigest = d?.at ?? ''
    const top = others.find(c => c.kind !== 'create')
    await update($, latest, (): Latest | null => (top ? { by: top.by, summary: top.summary, at: top.at } : null))
    const away = a.members - 1
    const more = a.contexts.length > 1 ? ` +${a.contexts.length - 1}` : ''
    $.ui.status(`context ${a.contexts.find(c => c.writes_here)?.name ?? a.context}${more}${a.sharing ? (away ? ` · ${a.online.length}/${away} online` : '') : ' · offline'}`)
  } catch (e) {
    // A new chat's server takes a moment to connect, so the first failures still read as loading.
    if (++failures >= GIVE_UP_AFTER) loaded()
    await fail($, trouble((e as Error).message), true)
  }
}

/** Shows a line in the panel for a few seconds (or clears it). */
async function say($: Engine, text: string | null) {
  noticeTimer?.cancel()
  noticeTimer = undefined
  await update($, notice, () => text)
  if (text) noticeTimer = $.clock.after(NOTICE_MS, () => void update($, notice, () => null))
}

/** Opens an item on its own (a claim or a question), remembering where from. */
async function openItem($: Engine, key: string | null) {
  if (key) trail.push(key)
  else trail = []
  await update($, detail, () => key)
}

/** A way out of a step (Cancel, Done, Back) leads with a ‹ caret, so it reads as going back. */
const caret = (label: string) => (label.startsWith('‹') ? label : `‹ ${label}`)

/** Back from an item: to the one opened before it, else to the list. */
async function backItem($: Engine) {
  trail.pop()
  await update($, detail, () => trail.at(-1) ?? null)
}

/** Runs a tool from a button or field, then refreshes; errors show in the panel. */
async function act($: Engine, tool: string, args: Record<string, unknown>, done?: string) {
  try {
    const r = await call($, tool, args)
    await clearError($)
    await say($, done ?? null)
    // A new join code (from Invite): marked in the People tab's list.
    const made = r && typeof r === 'object' ? (r as { invite?: { id?: string } }).invite?.id : undefined
    if (made) await update($, code, () => made)
  } catch (e) {
    await fail($, (e as Error).message)
  }
  await refresh($)
  await loadDetails($)
}

/** The context whose details the panel shows: an off context's page, else the open context's Settings tab. */
async function detailsOf($: Engine): Promise<string | null> {
  const m = await read($, managing)
  if (m) return m
  if ((await read($, tab)) !== 'settings' || (await read($, switching))) return null
  return (await read($, activity))?.context ?? null
}

/** The context whose details were last asked for by drawing the Settings tab, so a failing read isn't asked again on every redraw. */
let askedDetails: string | undefined

/** Reads the details of the context being shown (again, after a change). */
async function loadDetails($: Engine) {
  const name = await detailsOf($)
  if (!name) return
  try {
    const d = (await call($, 'context_details', { name })) as ContextDetails
    if ((await detailsOf($)) === name) await update($, details, () => d)
  } catch (e) {
    await fail($, trouble((e as Error).message))
  }
}

/** Opens the page of a context that's off for this chat (or, with null, goes back to the list). */
async function manage($: Engine, name: string | null) {
  await update($, details, () => null)
  await update($, managing, () => name)
  if (name) await loadDetails($)
}

/** What's wrong with a new context's name and description, or null. */
export function newContextProblem(name: string, description: string, existing: string[]): string | null {
  if (!name) return 'Give it a name.'
  if (!NAME_RE.test(name)) return 'A context name is lower-case letters, digits and dashes, such as "checkout-incident".'
  if (existing.includes(name)) return `There's already a context '${name}' on this machine: turn it on in the list.`
  if (!description.trim()) return 'Say what it’s for: every member’s agent reads that to decide what belongs there.'
  return null
}

/**
 * Starts a prompt in the prompt box for the person to finish and send: what they
 * had typed stays, above it. The panel stays on the item, to read while writing.
 */
async function draft($: Engine, text: string, what: string) {
  try {
    const box = await $.prompt.read()
    const kept = box.text.replace(/\s+$/, '')
    const r = await $.prompt.fill({ text: kept ? `${kept}\n\n${text}` : text })
    if (r.isFilled) await clearError($).then(() => say($, `Your ${what} is started in the prompt box: finish its last line, then press Enter to send it to your agent.`))
    else await fail($, r.refusal === 'dialog' ? 'Close the open dialog first: the prompt box can’t take text while it’s up.' : 'The prompt box couldn’t take the text here.')
  } catch (e) {
    await fail($, (e as Error).message)
  }
}

/** Hands the person's words to the agent, as their own prompt: it shows in the chat, so the panel says nothing more. */
async function ask($: Engine, text: string) {
  await openItem($, null)
  await say($, null)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (e) {
    await fail($, (e as Error).message)
  }
}

/** Opens the panel: on the chat's contexts (to turn them on and off), or on a context. */
async function openPane($: Engine, contexts = false) {
  wantSnapshot = true
  await update($, switching, () => contexts)
  // The panel opens on the list or the context, never on a step left half done.
  await update($, creating, () => null)
  await update($, deleting, () => null)
  await update($, folds, () => [])
  askedDetails = undefined
  await manage($, null)
  if (contexts) await openItem($, null)
  await refresh($)
  // `focus` also brings the panel's tab to the front when it's already open behind another.
  return $.ui.open({ id: PANE, title: 'Context', focus: true, closeOnEscape: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'contexts', description: "Open this chat's context: what needs you, its questions and threads, claims, people, and the chat's contexts" })
    poll?.cancel()
    loading?.cancel()
    seen = undefined
    failures = 0
    await clearError($) // a reload forgets where the last error came from, so it starts clear
    await update($, tick, () => 0)
    // "loading." "loading.." "loading..." until the server first answers.
    loading = $.clock.every(TICK_MS, () => void update($, tick, n => (n + 1) % 3))
    poll = $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'contexts' }, async $ => {
    const r = await openPane($)
    return { text: r.isPlaced ? 'Context panel opened.' : `The panel couldn't open here: ${r.reason}` }
  })

  // The band above the prompt: always there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const none = await read($, unattached)
    const a = await read($, activity)
    if (!none && !a) {
      // The MCP server hasn't answered yet: a new chat's first seconds.
      const n = await read($, tick)
      const err = await read($, error)
      if (failures < GIVE_UP_AFTER || !err)
        return (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>○ loading{'.'.repeat(n + 1)}</Text>
          </Box>
        )
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="warning">○</Text>
          <Text dimColor>{short(err, 150)}</Text>
          <Button key="retry" label="Retry" onPress={() => void refresh($)} />
        </Box>
      )
    }
    if (!a)
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor>○</Text>
          <Text>
            No context
            <Text dimColor> · your agent will ask which this chat is for</Text>
          </Text>
          <Button key="choose-context" label="Choose" onPress={() => void openPane($, true)} />
        </Box>
      )
    const l = await read($, latest)
    const now = await $.clock.now()
    const away = a.members - 1
    const d = a.digest?.at(-1)
    const main = a.contexts.find(c => c.writes_here)?.name ?? a.context
    // The latest news: what others' changes meant for you if that's newest, else the latest change from someone else.
    const news = d && (!l || d.at >= l.at) ? `${short(d.lines[0] ?? '', 70)} (${ago(d.at, now)})` : l ? `${l.by} ${short(l.summary, 60)} (${ago(l.at, now)})` : ''
    const more = a.contexts.filter(c => c.name !== main).map(c => ` +${c.name}`).join('')
    return (
      <Box flexDirection="row" gap={1} alignItems="center" width="100%">
        <Text color={a.sharing ? 'green' : undefined} dimColor={!a.sharing}>
          ●
        </Text>
        <Button key="band-contexts" label={`${main}${more}`} plain onPress={() => void openPane($, true)} />
        {/* The news takes the free room, so who's here and the open arrow sit at the right end. */}
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {news ? `· ${news}` : ''}
          </Text>
        </Box>
        <Text dimColor>{a.sharing ? (away ? `${a.online.length}/${away} online` : 'just you') : 'offline'}</Text>
        <Button key="open-context" label="❯" onPress={() => void openPane($)} />
      </Box>
    )
  })


  // The panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as Record<string, any>
    const { Box, Text, Button, Input, Select, Code } = els
    const a = await read($, activity)
    const err = await read($, error)
    // The terminal draws borders as box characters: cards there would be heavy, so it gets plain rows.
    const graphical = e.surface !== 'terminal'
    const cols = e.props.bodyColumns ?? 80
    const fit = paneFit(e.props)
    const narrow = fit === 'narrow'
    /**
     * Text with its buttons beside it, at the right; stacked under it when the
     * pane is narrow, so neither is squeezed to a sliver.
     */
    const split = (key: string, main: unknown, side: unknown, align: 'center' | 'flex-start' = 'flex-start') => {
      const actions = [side].flat().filter(Boolean)
      const buttons = actions.length > 0 && (
        <Box flexDirection="row" gap="xs" flexWrap="wrap" flexShrink={0} alignItems="center">
          {actions}
        </Box>
      )
      return narrow ? (
        <Box key={key} flexDirection="column" gap="xs">
          <Box flexDirection="column">{main}</Box>
          {buttons}
        </Box>
      ) : (
        <Box key={key} flexDirection="row" gap={1} justifyContent="space-between" alignItems={align}>
          <Box flexDirection="column" flexShrink={1}>
            {main}
          </Box>
          {buttons}
        </Box>
      )
    }
    const card = (key: string, children: unknown, tone?: string) =>
      graphical ? (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor={tone ?? 'subtle'} paddingX={1} paddingY="xs" gap="xs">
          {children}
        </Box>
      ) : (
        <Box key={key} flexDirection="column">
          {children}
        </Box>
      )
    const heading = (text: string, count?: number | string) => (
      <Text size="heading" weight="semibold" bold>
        {text}
        {count !== undefined && <Text dimColor weight="regular"> {count}</Text>}
      </Text>
    )
    const meta = (text: string) => (
      <Text size="footnote" dimColor wrap="wrap">
        {text}
      </Text>
    )
    /** One of a row of choices: the chosen one stands out. */
    const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
      <Button key={key} label={`${active ? '▸ ' : ''}${label}`} variant={active ? 'primary' : 'secondary'} dimColor={!active} onPress={onPress} />
    )
    const note = await read($, notice)
    const made = await read($, code)
    const none = await read($, unattached)

    // Minimized to a widget on the desktop app: what reads at a glance, with
    // nothing to press, since clicks may not reach it. Expanding it brings back
    // whatever view was open.
    if (fit === 'glance') {
      const s = a?.snapshot
      const th = s ? threads(s.nodes, s.edges) : undefined
      const rl = s ? relations(s.nodes, s.edges) : undefined
      const unsent = a ? a.recent.filter((c: Change) => c.held && c.mine).length : 0
      const others = a ? a.people.filter((p: Person) => p.role && p.online && !p.you).length : 0
      const facts = a
        ? [
            a.sharing ? `${others} other${others === 1 ? '' : 's'} online` : 'Offline',
            th && th.open.length ? `❓ ${th.open.length} open` : '',
            rl && rl.conflicts.length ? `⚡ ${rl.conflicts.length} conflict${rl.conflicts.length === 1 ? '' : 's'}` : '',
            unsent ? `${unsent} not sent yet` : '',
          ].filter(Boolean)
        : []
      const last = a?.recent[0]
      return (
        <Box key="glance" flexDirection="column" gap="xs" paddingX={graphical ? 1 : 0}>
          <Text weight="semibold" bold wrap="wrap">
            <Text color={none || !a ? undefined : a.sharing ? 'success' : 'warning'}>● </Text>
            {none ? 'No context in this chat' : (a?.context ?? 'Context')}
          </Text>
          <Text size="footnote" dimColor wrap="wrap">
            {none ? 'Open the panel to turn one on.' : a ? facts.join(' · ') : (err ?? 'Loading…')}
          </Text>
          {!none && last && (
            <Box key="glance-latest">
              <Text size="footnote" wrap="wrap">
                <Text weight="semibold" bold>
                  {last.mine ? 'you' : last.by}
                </Text>{' '}
                {short(last.summary, 80)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }
    const dismiss = () => void clearError($).then(() => say($, null))
    const messages =
      err || note
        ? card(
            err ? 'error' : 'notice',
            <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
              <Box flexShrink={1}>
                <Text color={err ? 'error' : 'success'} wrap="wrap">
                  {err ?? note}
                </Text>
              </Box>
              <Button key="dismiss-message" label="×" plain dimColor onPress={dismiss} />
            </Box>,
            err ? 'error' : 'success',
          )
        : null
    /** A view that takes the whole panel: a title, what it's about, its body, and a way out. */
    const modal = (key: string, title: string, about: string | null, body: unknown, close?: { label: string; onPress: () => void }) => (
      <Box key={key} flexDirection="column" gap="md" paddingX={graphical ? 1 : 0}>
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
            <Box flexShrink={1}>
              <Text size="title" weight="semibold" bold wrap="wrap">
                {title}
              </Text>
            </Box>
            {close && <Button key={`close-${key}`} label={caret(close.label)} variant="secondary" dimColor onPress={close.onPress} />}
          </Box>
          {about && <Text wrap="wrap">{about}</Text>}
        </Box>
        {messages}
        {body}
      </Box>
    )

    /** A label over a field as wide as the panel, with a line of help under it. */
    const field = (label: string, input: unknown, help?: string) => (
      <Box flexDirection="column" gap="xs" width="100%" alignItems="stretch">
        <Text weight="semibold" bold>
          {label}
        </Text>
        {input}
        {help && meta(help)}
      </Box>
    )
    const opened: string[] = await read($, folds)
    const flip = (id: string) => void update($, folds, (v: string[]) => (v.includes(id) ? v.filter(x => x !== id) : [...v, id]))
    /** An underlined link that opens and closes what it's about. */
    const foldLink = (id: string, open: boolean, label: string) => (
      <Box key={`fold-row-${id}`} flexDirection="row">
        <Button key={`fold-${id}`} plain dimColor onPress={() => flip(id)}>
          <Text underline>{label}</Text>
          {open ? ' ▴' : ' ▾'}
        </Button>
      </Box>
    )
    /**
     * A list that shows only its first few items, with a link for the rest (and
     * one to fold them away again). With `latest`, the few are the last ones and
     * the link comes first, as for the earlier replies in a thread.
     */
    const folded = <T,>(id: string, list: T[], first: number, what: string, one: string, render: (x: T, i: number) => unknown, latest = false) => {
      const hidden = list.length - first
      if (hidden <= 0) return list.map(render)
      const open = opened.includes(id)
      const shown = open ? list : latest ? list.slice(-first) : list.slice(0, first)
      const link = foldLink(id, open, open ? `Show fewer ${what}` : `${hidden} ${latest ? 'earlier' : 'more'} ${hidden === 1 ? one : what}`)
      return latest ? [link, ...shown.map(render)] : [...shown.map(render), link]
    }
    /** Extra detail behind an underlined link, closed until asked for. */
    const reveal = (id: string, label: string, hide: string, body: unknown) =>
      opened.includes(id) ? (
        <Box key={`reveal-${id}`} flexDirection="column" gap="xs">
          {foldLink(id, true, hide)}
          {body}
        </Box>
      ) : (
        foldLink(id, false, label)
      )
    const here = none ?? a?.your_contexts ?? []
    const using = a?.contexts ?? []
    const inChat = (n: string) => using.find(c => c.name === n)
    const loadedDetails = await read($, details)
    /** Shows one of the chat's contexts: the panel leaves the list for it. */
    const show = (n: string) =>
      update($, viewing, () => n)
        .then(() => refresh($))
        .then(() => manage($, null))
        .then(() => update($, switching, () => false))
    /** Opens one of the chat's contexts on its Settings tab. */
    const settingsTab = (n: string) =>
      show(n)
        .then(() => update($, more, () => 0))
        .then(() => update($, tab, () => 'settings' as Tab))
        .then(() => {
          askedDetails = n
          return loadDetails($)
        })
    /** Turns a context on or off for this chat. */
    const toggle = (n: string) =>
      void (inChat(n)
        ? act($, 'remove_context', { name: n }, `'${n}' is off for this chat. It stays on this machine.`)
        : act($, using.length ? 'add_context' : 'use_context', { name: n }, `'${n}' is on for this chat.`))
    /** Starts the join-code step for one of the chat's contexts: the panel moves to it, and the code lands in its People tab. */
    const share = (n: string) => {
      inviteNote = ''
      return show(n).then(() => update($, inviting, () => 'contributor' as Invite['role']))
    }
    const writeHere = (n: string) => void act($, 'add_context', { name: n, write_here: true }, `New items go to '${n}' unless another fits better.`)

    /** A context's pin: whether new chats started in this chat's folder (or below it) start with it. */
    const pin = (n: string, where: string) => {
      const f = a?.folder
      if (!f) return null
      const pinned = (f.pinned ?? []).includes(n)
      return (
        <Button
          key={`pin-${where}${n}`}
          plain
          dimColor={!pinned}
          onPress={() =>
            void act($, 'link_folder', pinned ? { name: n, off: true } : { name: n }, pinned ? `New chats in this folder no longer start with '${n}'.` : `New chats in this folder start with '${n}'.`)
          }
        >
          {pinned ? '📌 On for new chats in ' : '📌 Turn on for new chats in '}
          <Text size="footnote" dimColor>
            {tail(f.folder, Math.max(12, Math.min(48, cols - 18)))}
          </Text>
        </Button>
      )
    }

    /**
     * A context's settings: how this chat uses it, its sharing, what it holds,
     * and deleting it. The open context's Settings tab, and the page of one
     * that's off for this chat (`inTab` false), where only some of it can be changed.
     */
    const settings = (n: string, inTab: boolean) => {
      const c = inChat(n)
      const d = loadedDetails && loadedDetails.name === n ? loadedDetails : null
      const isAdmin = (d?.role ?? c?.role) === 'admin'
      const severalOn = using.length > 1
      const sharing = d?.sharing ?? (inTab ? a?.sharing : undefined)
      const relays = inTab ? a?.relays_up : undefined
      // A label column beside its value; narrow, the label sits over it instead.
      const row = (label: string, value: unknown) =>
        narrow ? (
          <Box key={`detail-${label}`} flexDirection="column">
            <Text size="footnote" dimColor>
              {label}
            </Text>
            <Text wrap="wrap">{value}</Text>
          </Box>
        ) : (
          <Box key={`detail-${label}`} flexDirection="row" gap={1}>
            <Box width={12} flexShrink={0}>
              <Text dimColor>{label}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text wrap="wrap">{value}</Text>
            </Box>
          </Box>
        )
      const count = (k: string, one: string, plural: string) => `${d?.items[k] ?? 0} ${(d?.items[k] ?? 0) === 1 ? one : plural}`
      /** No one else has joined, so there is nobody to sync with. */
      const alone = d?.members === 1
      return (
        <Box key={`settings-${n}`} flexDirection="column" gap="md">
          <Box flexDirection="column" gap="xs">
            {heading('This chat')}
            <Box flexDirection="row" gap="xs" justifyContent="space-between" alignItems="center">
              <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
                <Button key={`detail-toggle-${n}`} label={c ? '◉ On' : '○ Off'} variant={c ? 'primary' : 'secondary'} dimColor={!c} onPress={() => toggle(n)} />
                {c && severalOn && !c.writes_here && <Button key={`detail-write-${n}`} label="✎ Write here" variant="secondary" onPress={() => writeHere(n)} />}
              </Box>
              {c && !inTab && <Button key={`detail-open-${n}`} label="Open ›" variant="secondary" onPress={() => void show(n)} />}
            </Box>
            {meta(
              c
                ? severalOn
                  ? c.writes_here
                    ? 'Your agent looks things up in this context, and records new items in it unless another context clearly fits better.'
                    : 'Your agent looks things up in this context, and records a new item in it only when the item fits its description.'
                  : 'This chat uses this context: your agent looks things up in it and records new claims and questions in it. Turning it off only affects this chat. Your copy stays on this machine.'
                : 'This chat isn’t using this context. Turn it on to open it here, share it or change its settings.',
            )}
            {pin(n, 'detail-')}
          </Box>
          <Box flexDirection="column" gap="xs">
            {heading('Sharing')}
            {sharing === undefined ? (
              <Text dimColor>Loading…</Text>
            ) : (
              <Text wrap="wrap">
                <Text color={sharing ? 'success' : 'warning'}>● </Text>
                {!sharing ? 'Offline' : alone ? 'Only you so far' : 'Syncing'}
                <Text dimColor>
                  {!sharing && alone ? ' · only you so far' : ''}
                  {d && !alone ? ` · ${d.members} members · ${d.online} of the others online now` : ''}
                  {d?.open_invites ? ` · ${d.open_invites} join code${d.open_invites === 1 ? '' : 's'} not used yet` : ''}
                </Text>
              </Text>
            )}
            {meta(
              sharing === false
                ? 'Your copy keeps working. What you write is sent when you’re back online.'
                : relays === 0
                  ? 'This machine can’t reach the servers that help members find each other, so nothing syncs right now.'
                  : alone
                    ? d?.open_invites
                      ? 'Nobody has joined yet. Syncing starts when someone uses a join code you sent.'
                      : 'Nobody else is in this context yet. Invite someone to share it with them.'
                    : 'Every member keeps a full copy. Changes travel directly between your machines whenever you’re both online.',
            )}
            {c && (
              <Box flexDirection="row" gap="xs" flexWrap="wrap">
                {isAdmin && (
                  <Button
                    key={`detail-invite-${n}`}
                    label="+ Invite someone"
                    variant="primary"
                    onPress={() => {
                      inviteNote = ''
                      return inTab ? update($, inviting, () => 'contributor' as Invite['role']) : share(n)
                    }}
                  />
                )}
                {sharing !== undefined &&
                  (sharing ? (
                    <Button key={`detail-offline-${n}`} label="Go offline" variant="secondary" dimColor onPress={() => void act($, 'stop_sharing', { context: n }, `'${n}' is offline: not syncing until you go online again.`)} />
                  ) : (
                    <Button key={`detail-online-${n}`} label="Go online" variant="secondary" onPress={() => void act($, 'start_sharing', { context: n }, `'${n}' is back online: syncing with the other members.`)} />
                  ))}
              </Box>
            )}
            {c && !isAdmin && meta('Only an admin can invite people.')}
          </Box>
          <Box flexDirection="column" gap="xs">
            {heading('About')}
            {d ? (
              <Box flexDirection="column" gap="xs">
                <Box flexDirection="column">
                  {row('Your role', d.role ?? 'removed (you keep your copy to read)')}
                  {row('Made by', d.yours ? 'you' : (d.created_by ?? 'unknown'))}
                  {row('Holds', `${count('Claim', 'claim', 'claims')} · ${count('Question', 'question', 'questions')} · ${count('Reply', 'reply', 'replies')}`)}
                  {d.held > 0 && row('Not yet sent', `${d.held} just written, still only on this machine`)}
                </Box>
                {reveal(
                  `about-${n}`,
                  'Id, storage and history',
                  'Hide id, storage and history',
                  <Box key={`about-more-${n}`} flexDirection="column">
                    {row('Changes', `${d.changes} in all, withdrawn items included`)}
                    {row('Id', d.id ?? 'none')}
                    {row('Stored at', d.stored_at)}
                  </Box>,
                )}
              </Box>
            ) : (
              <Text dimColor>{err ? 'Couldn’t read its details.' : 'Loading…'}</Text>
            )}
          </Box>
          <Box flexDirection="column" gap="xs">
            {heading('Delete')}
            {meta('Deletes this machine’s copy for good. Other members keep theirs. You’ll be asked to confirm.')}
            <Box flexDirection="row">
              <Button
                key={`ask-delete-${n}`}
                label="Delete from this machine…"
                variant="secondary"
                dimColor
                onPress={() => {
                  deleteText = ''
                  return update($, deleting, () => ({ name: n, error: null }))
                }}
              />
            </Box>
          </Box>
        </Box>
      )
    }

    // Confirming a deletion, from the Settings tab or an off context's page:
    // only that. Nothing goes until the name is typed.
    const doomed = await read($, deleting)
    if (doomed && here.includes(doomed.name)) {
      const n = doomed.name
      const known = loadedDetails && loadedDetails.name === n ? loadedDetails : null
      const close = () => {
        deleteText = ''
        void update($, deleting, () => null)
      }
      const confirm = (typed: string) => {
        if (typed.trim() !== n) return update($, deleting, () => ({ name: n, error: `Type ${n} exactly to delete it. Nothing was deleted.` }))
        deleteText = ''
        return update($, deleting, () => null)
          .then(() => manage($, null))
          .then(() => update($, viewing, () => null))
          .then(() => update($, tab, () => 'overview' as Tab))
          .then(() => act($, 'delete_context', { name: n, confirm: n }, `'${n}' was deleted from this machine.`))
      }
      const items = known ? Object.values(known.items).reduce((x, y) => x + y, 0) : null
      const others = known ? known.members - (known.role ? 1 : 0) : null
      return modal(
        'delete-step',
        `Delete ${n}?`,
        `This permanently deletes this machine’s copy of '${n}'${items !== null ? `: its ${items} item${items === 1 ? '' : 's'}, their history` : ': its claims, questions and replies, their history'}, the join codes made here, and every chat’s and folder’s link to it. It can’t be undone.`,
        <Box flexDirection="column" gap="md">
          {card(
            'delete-effects',
            <Box flexDirection="column" gap="xs">
              {others === null ? (
                <Text wrap="wrap">Other members keep their own copies. If you’re its only member, it’s gone for good.</Text>
              ) : others > 0 ? (
                <Text wrap="wrap">
                  {others} other member{others === 1 ? ' keeps their' : 's keep their'} own copy, and nothing is deleted for them. To get it back you’d need a new join code from one of its admins.
                </Text>
              ) : (
                <Text color="warning" wrap="wrap">
                  You’re its only member, so this is the only copy: once deleted, it’s gone for good.
                </Text>
              )}
              {known?.yours && others !== null && others > 0 && (
                <Text color="warning" wrap="wrap">
                  You made this context. The other members keep syncing with each other, but the join codes you made stop working.
                </Text>
              )}
              {inChat(n) && meta('To only stop using it in this chat, turn it off instead: it stays on this machine.')}
            </Box>,
            'warning',
          )}
          {field(
            `Type ${n} to confirm`,
            <Input key={`delete-confirm-${n}`} placeholder={n} autoFocus onInput={(v: string) => (deleteText = v)} onSubmit={(v: string) => confirm(v)} />,
          )}
          {doomed.error && (
            <Text color="error" wrap="wrap">
              {doomed.error}
            </Text>
          )}
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            <Button key="keep-context" label="Keep it" variant="primary" onPress={close} />
            <Button key={`delete-${n}`} label="Delete permanently" variant="secondary" onPress={() => confirm(deleteText)} />
          </Box>
        </Box>,
        { label: 'Cancel', onPress: close },
      )
    }

    // A new context: its name and what it's for, together. Only that.
    const creatingNow = await read($, creating)
    if (creatingNow) {
      const close = () => void update($, creating, () => null)
      const create = () => {
        const name = newName.trim().toLowerCase().replace(/\s+/g, '-')
        const description = newDescription.trim()
        const problem = newContextProblem(name, description, here)
        if (problem) return update($, creating, () => ({ error: problem }))
        newName = ''
        newDescription = ''
        return update($, creating, () => null)
          .then(() => update($, switching, () => false))
          .then(() => update($, viewing, () => name))
          .then(() => act($, a ? 'add_context' : 'use_context', { name, description }, `Created '${name}'${a ? ' and added it to this chat' : ''}. No one is invited yet: use Invite someone when you want to let a person in.`))
      }
      return modal(
        'new-context-step',
        'Create a new context',
        'A context holds what a group knows, as claims and questions, shared with the people you invite.',
        <Box flexDirection="column" gap="md">
          {field(
            'Name',
            <Input
              key="new-name"
              placeholder="e.g. checkout-incident"
              autoFocus
              onInput={(v: string) => (newName = v)}
              onSubmit={(v: string) => {
                newName = v
                return create()
              }}
            />,
            'Short: lower-case letters, digits and dashes.',
          )}
          {field(
            'What is it for?',
            <Input
              key="new-description"
              placeholder="What goes in it, in a sentence or two"
              rows={4}
              onInput={(v: string) => (newDescription = v)}
              onSubmit={(v: string) => {
                newDescription = v
                return create()
              }}
            />,
            'Every member’s agent reads this to decide what belongs there. You can change it later.',
          )}
          {creatingNow.error && (
            <Text color="error" wrap="wrap">
              {creatingNow.error}
            </Text>
          )}
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            <Button key="create-context" label="Create" variant="primary" onPress={() => create()} />
            <Button key="cancel-create" label="‹ Cancel" variant="secondary" dimColor onPress={close} />
          </Box>
          {meta('It’s yours: you’re its admin, and it’s added to this chat. Invite people from its People tab, or with Share in the list.')}
        </Box>,
        { label: 'Cancel', onPress: close },
      )
    }

    // The chat's contexts, each with a switch: on means this chat uses it.
    if (none !== null || (await read($, switching))) {
      const many = using.length > 1

      // A context that's off for this chat: what it's for and its settings. One
      // that's on opens instead, with these on its Settings tab.
      const managed = await read($, managing)
      if (managed && here.includes(managed)) {
        const n = managed
        const c = inChat(n)
        const d = loadedDetails && loadedDetails.name === n ? loadedDetails : null
        const description = d ? d.description : (c?.description ?? null)
        return modal(
          'context-details',
          n,
          null,
          <Box flexDirection="column" gap="md">
            <Box flexDirection="column" gap="xs">
              {heading('What it’s for')}
              {description ? (
                <Text wrap="wrap">{description}</Text>
              ) : (
                <Text italic dimColor wrap="wrap">
                  No description yet, so agents won’t know what belongs here.
                </Text>
              )}
            </Box>
            {settings(n, false)}
          </Box>,
          { label: '‹ Contexts', onPress: () => void manage($, null) },
        )
      }

      return modal(
        'contexts',
        'Contexts in this chat',
        none
          ? here.length
            ? 'This chat has no context yet, so your agent will ask which it’s for. Turn one on, or create one.'
            : 'A context holds what a group knows, as claims and questions, shared with the people you invite. Create one for this chat, or join one with a code someone sent you.'
          : many
            ? 'Your agent reads all of these, and puts each new item in the one whose description fits. ✎ marks where it writes when none clearly does.'
            : 'Most chats use one context. Turn another on to use it too: your agent then picks the right one for each item.',
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row">
              <Button
                key="create-new-context"
                label="+ Create new context"
                variant="primary"
                onPress={() => {
                  newName = ''
                  newDescription = ''
                  return update($, creating, () => ({ error: null }))
                }}
              />
            </Box>
            {meta('Got a join code? Paste it to your agent, or run /vine-context:join with it.')}
          </Box>
          {here.map(n => {
            const c = inChat(n)
            return card(
              `ctx-${n}`,
              <Box flexDirection="column" gap="xs">
                {/* Wraps so a long name pushes the toggle onto its own line instead of past the card's edge. */}
                <Box key={`ctx-head-${n}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="center" flexWrap="wrap">
                  <Box flexDirection="row" gap="xs" alignItems="center" flexShrink={1} flexWrap="wrap">
                    <Button key={`name-${n}`} label={n} plain onPress={() => (c ? show(n) : manage($, n))} />
                    <Text>
                      {c && <Text dimColor>· {c.role ?? 'removed'}</Text>}
                      {c && many && c.writes_here ? <Text color="suggestion"> ✎ writes here</Text> : ''}
                    </Text>
                  </Box>
                  <Button key={`toggle-${n}`} label={c ? '◉ On' : '○ Off'} variant={c ? 'primary' : 'secondary'} dimColor={!c} onPress={() => toggle(n)} />
                </Box>
                {c && (
                  <Text size="footnote" dimColor italic={!c.description} wrap="wrap">
                    {c.description ?? 'No description yet'}
                  </Text>
                )}
                <Box flexDirection="row" gap="xs" justifyContent="space-between" alignItems="center">
                  <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
                    <Button key={`settings-${n}`} label="Settings" variant="secondary" dimColor onPress={() => (c ? settingsTab(n) : manage($, n))} />
                    {c?.role === 'admin' && <Button key={`share-${n}`} label="Share" variant="secondary" dimColor onPress={() => share(n)} />}
                    {c && many && !c.writes_here && <Button key={`write-${n}`} label="✎ Write here" variant="secondary" dimColor onPress={() => writeHere(n)} />}
                  </Box>
                  {c && <Button key={`open-${n}`} label="Open ›" variant="secondary" onPress={() => show(n)} />}
                </Box>
                {pin(n, '')}
              </Box>,
              c ? 'suggestion' : undefined,
            )
          })}
          {a?.folder && here.length > 0 && meta('📌 A pinned context is on in every new chat started in that folder, or below it. It’s kept on this machine: nothing is written into the folder.')}
        </Box>,
        none ? undefined : { label: 'Done', onPress: () => void update($, switching, () => false) },
      )
    }

    if (!a)
      return (
        <Box flexDirection="column" padding={1} gap="sm">
          <Text bold>Context</Text>
          <Text dimColor wrap="wrap">
            {err ?? 'Loading the context…'}
          </Text>
        </Box>
      )
    const many = a.contexts.length > 1
    /** The context a panel action is about: named only when the chat has several (the tools take `context` then). */
    const ctx = many ? { context: a.context } : {}
    const named = many ? a.context : undefined
    const admin = a.you.role === 'admin'
    const invites: Invite[] = admin ? (a.invites ?? []) : []
    const canWrite = a.you.role === 'admin' || a.you.role === 'contributor'
    const snap = a.snapshot
    const t = snap ? threads(snap.nodes, snap.edges) : undefined
    const rel = snap ? relations(snap.nodes, snap.edges) : undefined
    const now = await $.clock.now()
    const heldByNode = new Map(a.recent.filter((c: Change) => c.held && c.node).map((c: Change) => [c.node!, c]))
    const isMine = (n: GraphNode) => prop(n, 'recorded_by') === a.you.name
    const byline = (n: GraphNode) => {
      const by = prop(n, 'recorded_by') || '?'
      const at = prop(n, 'recorded_at')
      return `${by === a.you.name ? 'you' : by}${at ? ` · ${ago(at, now)}` : ''}`
    }
    const held = (n: GraphNode) => (heldByNode.has(n.key) ? <Text color="warning"> · still only on this machine</Text> : '')
    const undo = (n: GraphNode) => {
      const change = heldByNode.get(n.key)
      return change ? <Button key={`undo-${n.key}`} label="Undo" variant="primary" onPress={() => void act($, 'take_back', { id: change.id, ...ctx }, 'Taken back. It never left this machine.')} /> : null
    }
    /** Withdraw, for its author or an admin, once it has been shared (before that, Undo). */
    const withdraw = (n: GraphNode) =>
      !heldByNode.has(n.key) && !n.ended && canWrite && (isMine(n) || admin) ? (
        <Button
          key={`withdraw-${n.key}`}
          label="Withdraw"
          variant="secondary"
          dimColor
          onPress={() => void openItem($, null).then(() => act($, 'withdraw', { id: n.key, ...ctx }, 'Withdrawn. It stays in the history.'))}
        />
      ) : null

    // Editing the description: only that.
    if (await read($, editing))
      return modal(
        'describe-step',
        `Describe ${a.context}`,
        'What goes in it, and what doesn’t. It syncs to every member, and their agents use it to decide what belongs here.',
        field(
          `What is '${a.context}' for?`,
          <Input
            key="describe"
            value={a.description ?? ''}
            placeholder="What goes in it, in a sentence or two"
            submitLabel="Save"
            rows={4}
            autoFocus
            onSubmit={(v: string) => {
              void update($, editing, () => false)
              if (v.trim() && v.trim() !== a.description) void act($, 'describe_context', { description: v.trim(), ...ctx }, 'Saved. Every member’s agent sees it.')
            }}
          />,
        ),
        { label: 'Cancel', onPress: () => void update($, editing, () => false) },
      )

    // Changing your name: only that.
    if (await read($, renaming))
      return modal(
        'rename-step',
        'Your name',
        `Everyone sees you as ${a.you.name}. Each person names themselves: the name travels with your key, to every context on this machine, and every member sees the change.`,
        <Input
          key="my-name"
          label="The name you’d like others to see"
          value={a.you.name}
          submitLabel="Rename"
          autoFocus
          onSubmit={(v: string) => {
            void update($, renaming, () => false)
            if (v.trim() && v.trim() !== a.you.name) void act($, 'set_my_name', { name: v.trim() }, `You're now ${v.trim()} in every context on this machine.`)
          }}
        />,
        { label: 'Cancel', onPress: () => void update($, renaming, () => false) },
      )

    // Making a join code: who it's for and their role, then back to the list, where it waits to be sent.
    const invitingRole = admin ? await read($, inviting) : null
    if (invitingRole) {
      const close = () => void update($, inviting, () => null)
      const make = (text: string) => {
        inviteNote = ''
        close()
        void update($, tab, () => 'people' as Tab)
        void act($, 'share_context', { ...(text.trim() ? { label: text.trim() } : {}), ...(invitingRole !== 'contributor' ? { role: invitingRole } : {}), ...ctx }, 'Join code made. Copy it and send it privately, to that one person.')
      }
      return modal(
        'invite-step',
        `Invite someone to ${a.context}`,
        'A join code lets one person in: whoever uses it first. Send it to them privately. It expires in 24 hours if no one uses it.',
        <Box flexDirection="column" gap="sm">
          {Select && (
            <Select
              key="invite-role"
              label="They can"
              value={invitingRole}
              options={[
                { key: 'contributor', value: 'contributor', label: 'Read and add (contributor)' },
                { key: 'reader', value: 'reader', label: 'Only read (reader)' },
                { key: 'admin', value: 'admin', label: 'Read, add and invite (admin)' },
              ]}
              onSelect={(r: string) => void update($, inviting, () => r as Invite['role'])}
            />
          )}
          {field(
            'Who is it for? (optional)',
            <Input
              key="invite-note"
              placeholder="e.g. Sam: shown when they join, so a code used by someone else stands out"
              autoFocus
              onInput={(v: string) => (inviteNote = v)}
              onSubmit={make}
            />,
          )}
          <Box flexDirection="row">
            <Button key="make-code" label="Make join code" variant="primary" onPress={() => make(inviteNote)} />
          </Box>
          {meta('This machine answers the code, so it must be online when they use it. Everyone in the context is told who joined.')}
        </Box>,
        { label: 'Cancel', onPress: close },
      )
    }

    // Confirming a removal: only that.
    const pending = await read($, confirmRemove)
    const leaving = pending ? a.people.find((p: Person) => p.fingerprint === pending) : undefined
    if (leaving)
      return modal(
        'remove-step',
        `Remove ${leaving.name}?`,
        `Every member’s machine stops syncing with ${leaving.name} and refuses their later changes. What they wrote stays, and they keep the copy they already had.`,
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          <Button
            key={`confirm-${leaving.fingerprint}`}
            label={`Remove ${leaving.name}`}
            variant="primary"
            onPress={() => {
              void update($, confirmRemove, () => null)
              void act($, 'remove_peer', { name: leaving.name, ...ctx }, `${leaving.name} was removed. They keep the copy they already had.`)
            }}
          />
        </Box>,
        { label: 'Cancel', onPress: () => void update($, confirmRemove, () => null) },
      )

    // One item on its own: a question with its thread, or a claim with everything linked to it.
    const openKey = await read($, detail)
    const item = openKey && rel ? rel.byKey.get(openKey) : undefined
    if (item && rel && t) {
      const back = { label: trail.length > 1 ? '‹ Back' : '‹ Back to the list', onPress: () => void backItem($) }
      /** A linked item: its text, who and when, and a way to open it. */
      const related = (label: string, tone: string | undefined, n: GraphNode) =>
        split(
          `rel-${label}-${n.key}`,
          <>
            <Text wrap="wrap" strikethrough={n.label === 'Claim' && !rel.current(n)} dimColor={n.ended}>
              <Text color={tone} dimColor={!tone}>
                {label}{' '}
              </Text>
              {short(n.title, 300)}
            </Text>
            <Text size="footnote" dimColor>
              {byline(n)} · {n.key}
            </Text>
          </>,
          <Button key={`open-${n.key}`} label="Open ›" variant="secondary" dimColor onPress={() => void openItem($, n.key)} />,
        )
      const group = (title: string, label: string, tone: string | undefined, list: GraphNode[]) =>
        list.length > 0 && (
          <Box key={`group-${title}`} flexDirection="column" gap="xs">
            {heading(title, list.length)}
            {list.map(n => related(label, tone, n))}
          </Box>
        )
      const copy = (text: string) => (press: UiPressArgument) => void $.ui.copy({ text, surface: press.surface }).then(r => r.isCopied && $.ui.toast('Copied.'))

      if (item.label === 'Question') {
        const th = [...t.open, ...t.answered].find(x => x.q.id === item.id)
        const answered = !!th?.answers.length
        const about = rel.linked(item.id, 'ABOUT', 'out')
        const asked = rel.linked(item.id, 'ABOUT', 'in')
        return modal(
          'question-view',
          item.ended ? 'Withdrawn question' : answered ? 'Answered question' : 'Open question',
          item.title,
          <Box flexDirection="column" gap="sm">
            <Text size="footnote" dimColor>
              asked by {byline(item)} · {item.key}
              {held(item)}
            </Text>
            {group('It’s about', '→', undefined, about)}
            {th && th.replies.length > 0 && (
              <Box flexDirection="column" gap="xs">
                {heading('Thread', th.replies.length)}
                {th.replies.map(r =>
                  split(
                    `ar-${r.key}`,
                    <>
                      <Text wrap="wrap">
                        <Text dimColor>↳ </Text>
                        {short(r.title, 600)}
                      </Text>
                      <Text size="footnote" dimColor>
                        {byline(r)}
                        {held(r)}
                      </Text>
                    </>,
                    [
                      undo(r),
                      !answered && !item.ended && canWrite && (
                        <Button key={`answer-with-${r.key}`} label="Answer with this" variant="secondary" dimColor onPress={() => void ask($, answerPrompt(item, { reply: r }, named))} />
                      ),
                    ],
                  ),
                )}
              </Box>
            )}
            {th && group('Answer', '✓', 'success', th.answers)}
            {group('Questions about this one', '?', 'warning', asked)}
            <Box flexDirection="row" gap="xs" flexWrap="wrap">
              {!answered && !item.ended && canWrite && <Button key={`answer-in-chat-${item.key}`} label="✎ Answer in the chat" variant="primary" onPress={() => draft($, drafts.answer(item, named), 'answer')} />}
              {!answered && !item.ended && canWrite && <Button key={`investigate-${item.key}`} label="Ask my agent to look into it" variant="secondary" onPress={() => void ask($, prompts.investigate(item, named))} />}
              <Button key={`copy-${item.key}`} label="Copy" variant="secondary" dimColor onPress={copy(`${item.title} (${item.key})`)} />
              {undo(item)}
              {withdraw(item)}
            </Box>
            {!answered && !item.ended && meta('Agents reply on the thread. Answer in the chat starts your answer in the prompt box: finish it and send it, and your agent records it as a claim that answers the question.')}
          </Box>,
          back,
        )
      }

      const newer = rel.replacedBy.get(item.id)
      const state = item.ended ? 'Withdrawn claim' : newer ? 'Replaced claim' : rel.inConflict.has(item.id) ? 'Claim in conflict' : 'Claim'
      const from = prop(item, 'about_from')
      const to = prop(item, 'about_to')
      const contradicts = [...rel.linked(item.id, 'CONTRADICTS', 'out'), ...rel.linked(item.id, 'CONTRADICTS', 'in')].filter((n, i, all) => all.findIndex(x => x.id === n.id) === i)
      return modal(
        'claim-view',
        state,
        null,
        <Box flexDirection="column" gap="sm">
          <Text wrap="wrap" strikethrough={!rel.current(item)}>
            {item.title}
          </Text>
          <Box flexDirection="column">
            <Text size="footnote" dimColor>
              recorded by {byline(item)} · {item.key}
              {held(item)}
            </Text>
            {prop(item, 'source') && meta(`Source: ${prop(item, 'source')}`)}
            {(from || to) && meta(`About ${from && to ? `${from.slice(0, 10)} to ${to.slice(0, 10)}` : from ? `${from.slice(0, 10)} onwards` : `up to ${to.slice(0, 10)}`}`)}
            {item.ended && (
              <Text size="footnote" color="warning" wrap="wrap">
                Withdrawn{prop(item, 'withdrawn_by') ? ` by ${prop(item, 'withdrawn_by')}` : ''}
                {prop(item, 'withdrawn_at') ? ` · ${ago(prop(item, 'withdrawn_at'), now)}` : ''}
                {prop(item, 'withdraw_reason') ? `: ${prop(item, 'withdraw_reason')}` : ''}
              </Text>
            )}
          </Box>
          {newer && group('Replaced by', '↑', 'success', [newer])}
          {group('Can’t be true alongside', '⚡', 'warning', contradicts)}
          {group('Answers', '?', undefined, rel.linked(item.id, 'ANSWERS', 'out'))}
          {group('Evidence for it', '+', 'success', rel.linked(item.id, 'SUPPORTS', 'in'))}
          {group('It’s evidence for', '→', undefined, rel.linked(item.id, 'SUPPORTS', 'out'))}
          {group('Earlier versions', '↓', undefined, rel.linked(item.id, 'REPLACES', 'out'))}
          {group('Questions about it', '?', 'warning', rel.linked(item.id, 'ABOUT', 'in'))}
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            {rel.current(item) && canWrite && !heldByNode.has(item.key) && (
              <Button key={`correct-${item.key}`} label="✎ Correct it in the chat" variant="primary" onPress={() => draft($, drafts.correct(item, named), 'correction')} />
            )}
            <Button key={`copy-${item.key}`} label="Copy" variant="secondary" dimColor onPress={copy(`${item.title} (${item.key})`)} />
            {undo(item)}
            {withdraw(item)}
          </Box>
          {rel.current(item) && canWrite && meta('Correct it when it’s wrong or out of date: it starts in the prompt box, and once you send it the new claim replaces this one, which stays in the history. Withdraw it when it should never have been recorded.')}
        </Box>,
        back,
      )
    }

    const stored = await read($, tab)
    const current: Tab = TABS.some(x => x.tab === stored) ? stored : 'overview'
    const f: Filters = await read($, filters)
    const extra = await read($, more)
    /** Another tab starts from the top, without the last tab's filter words. */
    const setTab = (x: Tab) =>
      void update($, more, () => 0)
        .then(() => {
          if (x === 'settings') askedDetails = undefined
        })
        .then(() => (x === current ? undefined : update($, filters, (v: Filters): Filters => ({ ...v, text: '' }))))
        .then(() => update($, tab, () => x))
    // Returned, so whoever presses waits for the search too.
    const setFilter = (patch: Partial<Filters>) =>
      update($, more, () => 0)
        .then(() => update($, filters, (v: Filters): Filters => ({ ...v, ...patch })))
        .then(() => (patch.text !== undefined ? findRelated($, patch.text, a.context, ctx) : undefined))
    const members = a.people.filter((p: Person) => p.role)
    const rank = (p: Person) => (p.you ? 0 : p.online ? 1 : 2)
    const shown = [...members].sort((x, y) => rank(x) - rank(y)).slice(0, HEADER_PEOPLE)
    const unshown = members.length - shown.length
    const unshownOnline = members.filter((p: Person) => p.online).length - shown.filter((p: Person) => p.online).length
    const counts: Record<Tab, number | undefined> = { overview: undefined, questions: t?.open.length, claims: t?.claims.length, people: members.length, settings: undefined }
    const goOnline = <Button key="go-online" label="Go online" variant="primary" onPress={() => void act($, 'start_sharing', { ...ctx }, 'Back online: syncing with the other members.')} />

    const header = (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
          {/* Whether it's syncing, with the way to change it: who's online is listed under the description. */}
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} flexWrap="wrap">
            <Text size="footnote" color={a.sharing ? 'success' : 'warning'}>
              {a.sharing ? '⇅ Syncing' : '● Offline'}
              {a.sharing && a.relays_up === 0 ? <Text color="warning"> · no relay reachable</Text> : ''}
            </Text>
            <Button
              key="sync-toggle"
              plain
              dimColor
              onPress={() =>
                void act($, a.sharing ? 'stop_sharing' : 'start_sharing', { ...ctx }, a.sharing ? 'Offline: not syncing until you go online again.' : 'Back online: syncing with the other members.')
              }
            >
              <Text size="footnote" underline>
                {a.sharing ? 'Go offline' : 'Go online'}
              </Text>
            </Button>
          </Box>
          <Button key="switch" label={many ? `⇄ ${a.contexts.length} contexts` : '⇄ Contexts'} plain dimColor onPress={() => void update($, switching, () => true)} />
        </Box>
        <Text size="title" weight="semibold" bold wrap="wrap">
          {a.context}
        </Text>
        {many && (
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            {a.contexts.map(c => (
              <Button
                key={`view-${c.name}`}
                label={`${c.name}${c.writes_here ? ' ✎' : ''}`}
                variant={c.name === a.context ? 'primary' : 'secondary'}
                dimColor={c.name !== a.context}
                onPress={() => void update($, viewing, () => c.name).then(() => refresh($))}
              />
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap="xs" alignItems="flex-start">
          <Box flexShrink={1}>
            {a.description ? (
              <Text wrap="wrap">{a.description}</Text>
            ) : (
              <Text italic dimColor wrap="wrap">
                No description yet{admin ? '' : ': an admin can add one'}, so agents won’t know what belongs here.
              </Text>
            )}
          </Box>
          {admin && <Button key="edit-description" label="✎" plain dimColor onPress={() => void update($, editing, () => true)} />}
        </Box>
        <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
          {shown.map((p: Person) => (
            <Box key={`who-${p.fingerprint}`} hover={{ scope: `who-${p.fingerprint}` }}>
              <Text size="footnote" dimColor={!p.online} hover={{ underline: true }}>
                <Text color={p.online ? 'success' : undefined}>●</Text> {p.name}
                {p.you ? ' (you)' : ''}
                {!graphical ? ` ${p.role}` : ''}
              </Text>
            </Box>
          ))}
          {unshown > 0 && <Button key="who-more" label={`+${unshown} more${unshownOnline ? ` · ${unshownOnline} online` : ''}`} plain dimColor onPress={() => setTab('people')} />}
        </Box>
        {graphical &&
          shown.map((p: Person) => (
            <Box key={`who-card-${p.fingerprint}`} display="none" hover={{ scope: `who-${p.fingerprint}`, display: 'flex' }}>
              <Text size="footnote" dimColor>
                {p.name} · {p.role}
                {p.creator ? ' · made this context' : ''} · {p.online ? 'online now' : 'offline'} · key {p.fingerprint}
                {p.agent ? ` · ${p.agent}` : ''}
                {p.platform ? ` · ${p.platform}` : ''}
              </Text>
            </Box>
          ))}
        <Box flexDirection="row" gap="xs" marginTop="sm" flexWrap="wrap">
          {TABS.map(x => chip(`tab-${x.tab}`, `${x.icon} ${x.label}${counts[x.tab] !== undefined ? ` ${counts[x.tab]}` : ''}`, current === x.tab, () => setTab(x.tab)))}
        </Box>
        {messages}
      </Box>
    )

    /** The search behind the filter's text, once it has answered for this text in this context. */
    const search = f.text ? await read($, found) : null
    const near = search && search.text === f.text && search.context === a.context ? search : null
    /** The filter box above a list, and what it's filtering by: its words, and how many more are close in meaning. */
    const filterBox = (what: string, byMeaning: number) => (
      <Box flexDirection="column" gap="xs" width="100%" alignItems="stretch">
        <Input key="filter" value={f.text} placeholder={`Search ${what} by meaning, words, a person or an id`} submitLabel="Search" onSubmit={(v: string) => setFilter({ text: v.trim() })} />
        {f.text && (
          <Box flexDirection="row" gap="xs" alignItems="center" flexWrap="wrap">
            <Text size="footnote" dimColor wrap="wrap">
              Showing {what} matching “{short(f.text, 40)}”
              {!near || near.ids === null
                ? ' · looking for ones close in meaning…'
                : near.failed
                  ? ' · search by meaning isn’t available, so only words match'
                  : byMeaning
                    ? `, then ${byMeaning} close in meaning`
                    : ''}
            </Text>
            <Button key="clear-filter" label="× Clear" plain dimColor onPress={() => setFilter({ text: '' })} />
          </Box>
        )}
      </Box>
    )
    /** The first page of a list, and a button for the rest. */
    const paged = <T,>(list: T[]) => list.slice(0, PAGE + extra)
    const showMore = (total: number) =>
      total > PAGE + extra && (
        <Box key="show-more-row" flexDirection="row">
          <Button key="show-more" plain dimColor onPress={() => void update($, more, (n: number) => n + PAGE)}>
            <Text underline>{`Show ${Math.min(PAGE, total - PAGE - extra)} more of ${total}`}</Text>
          </Button>
        </Box>
      )

    let body
    if (current === 'settings') {
      // The open context's details, read when the tab is first drawn for it (and again after each change).
      if ((!loadedDetails || loadedDetails.name !== a.context) && askedDetails !== a.context) {
        askedDetails = a.context
        void loadDetails($)
      }
      body = settings(a.context, true)
    } else if (!snap || !t || !rel) body = <Text dimColor>Loading…</Text>
    else if (current === 'overview') {
      const heldMine = a.recent.filter((c: Change) => c.held && c.mine)
      const waiting = t.open.filter(th => th.replies.length)
      const mineOpen = t.open.filter(th => isMine(th.q) && th.replies.length)
      const digest = a.digest?.at(-1)
      const feed = a.recent
      // The "you claimed:" part of an activity line is who-did-what metadata: drawn dim so the claim itself reads first.
      const lead = (c: Change) => {
        const i = /^(claim|question|reply|describe)$/.test(c.kind) ? c.summary.indexOf(': ') : -1
        return i < 0 ? { head: '', body: c.summary } : { head: c.summary.slice(0, i + 2), body: c.summary.slice(i + 2) }
      }
      const ICON: Record<string, string> = { claim: '📌', question: '❓', reply: '↳', link: '🔗', withdraw: '✕', add_member: '👋', remove_member: '🚪', set_role: '🔑', rename: '✎', describe: '✎', create: '✦' }
      const need = (key: string, tone: string, text: unknown, button: unknown) => card(`need-${key}`, split(`need-row-${key}`, <Text wrap="wrap">{text}</Text>, button, 'center'), tone)
      const needs = [
        !a.sharing && need('offline', 'warning', 'You’re offline: what you write stays on this machine, and you don’t see what others add, until you’re back.', goOnline),
        a.sharing && a.relays_up === 0 && need('relays', 'warning', 'No signalling relay is reachable, so the other members can’t find this machine right now.', null),
        rel.conflicts.length > 0 &&
          need(
            'conflicts',
            'warning',
            `⚡ ${rel.conflicts.length} pair${rel.conflicts.length === 1 ? '' : 's'} of claims can’t both be true. Someone needs to say which stands.`,
            <Button key="see-conflicts" label="Settle" variant="primary" onPress={() => void update($, filters, (v: Filters): Filters => ({ ...v, text: '', claims: 'conflicts' })).then(() => setTab('claims'))} />,
          ),
        mineOpen.length > 0 &&
          need(
            'replies',
            'suggestion',
            `↳ ${mineOpen.length} of your questions ${mineOpen.length === 1 ? 'has' : 'have'} replies: ${short(mineOpen[0]!.q.title, 80)}`,
            <Button key="see-replies" label="Read" variant="primary" onPress={() => void openItem($, mineOpen[0]!.q.key)} />,
          ),
        t.open.length > 0 &&
          need(
            'questions',
            'subtle',
            `❓ ${t.open.length} open question${t.open.length === 1 ? '' : 's'}${waiting.length ? `, ${waiting.length} with replies` : ''}.`,
            <Button key="see-questions" label="See" variant="secondary" onPress={() => void update($, filters, (v: Filters): Filters => ({ ...v, text: '', questions: 'open' })).then(() => setTab('questions'))} />,
          ),
        admin && !a.description && need('describe', 'suggestion', 'This context has no description, so agents can’t tell what belongs in it.', <Button key="need-describe" label="Describe" variant="primary" onPress={() => void update($, editing, () => true)} />),
        admin &&
          members.length === 1 &&
          !invites.length &&
          need(
            'alone',
            'suggestion',
            'It’s just you here so far.',
            <Button key="need-invite" label="Invite someone" variant="primary" onPress={() => ((inviteNote = ''), void update($, inviting, () => 'contributor' as Invite['role']))} />,
          ),
        invites.length > 0 && need('invites', 'subtle', `${invites.length} join code${invites.length === 1 ? ' is' : 's are'} waiting to be used.`, <Button key="see-invites" label="See" variant="secondary" onPress={() => setTab('people')} />),
      ].filter(Boolean)
      const attention = (
        <Box key="overview-now" flexDirection="column" gap="sm" {...(fit === 'wide' ? { width: '50%', flexGrow: 1, flexShrink: 1 } : {})}>
          {heldMine.length > 0 &&
            card(
              'held',
              <Box flexDirection="column" gap="xs">
                <Text color="warning">Just written, still only on this machine:</Text>
                {heldMine.map((c: Change) =>
                  split(
                    `held-${c.id}`,
                    <Text wrap="wrap">{short(c.summary, 140)}</Text>,
                    <Button key={`undo-change-${c.id}`} label="Undo" variant="primary" onPress={() => void act($, 'take_back', { id: c.id, ...ctx }, 'Taken back. It never left this machine.')} />,
                    'center',
                  ),
                )}
              </Box>,
              'warning',
            )}
          {heading('Needs you', needs.length || undefined)}
          {needs.length ? folded('needs', needs, 3, 'things', 'thing', x => x) : card('all-clear', <Text color="success">✓ Nothing needs you right now.</Text>, 'success')}
          {digest && digest.lines.length > 0 && (
            <Box flexDirection="column" gap="xs">
              {heading('What changed for you')}
              {card(
                'digest',
                <Box flexDirection="column" gap="xs">
                  {folded('digest', digest.lines, 3, 'changes', 'change', (line, i) => (
                    <Text key={`digest-${i}`} wrap="wrap">
                      {line}
                    </Text>
                  ))}
                  {meta(ago(digest.at, now))}
                </Box>,
                'suggestion',
              )}
            </Box>
          )}
          {heading('Ask your agent')}
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            <Button key="catch-up" label="Catch me up" variant="secondary" onPress={() => void ask($, prompts.catchUp(a.context))} />
            {canWrite && <Button key="save-chat" label="Save what this chat learned" variant="secondary" onPress={() => void ask($, prompts.saveChat(a.context))} />}
          </Box>
        </Box>
      )
      const happened = (
        <Box key="overview-recent" flexDirection="column" gap="sm" {...(fit === 'wide' ? { width: '50%', flexGrow: 1, flexShrink: 1 } : {})}>
          {heading('Recent activity')}
          {!feed.length && meta('Nothing yet. What your agent and the other members’ agents record shows up here.')}
          {folded('recent', feed, RECENT, 'changes', 'change', (c: Change) =>
            split(
              `act-${c.id}`,
              <>
                <Text wrap="wrap">
                  <Text dimColor>
                    {ICON[c.kind] ?? '·'} {c.mine ? 'you' : c.by} {lead(c).head}
                  </Text>
                  {short(lead(c).body, 200)}
                </Text>
                <Text size="footnote" dimColor>
                  {ago(c.at, now)}
                  {c.held ? <Text color="warning"> · still only on this machine</Text> : ''}
                </Text>
              </>,
              c.node && rel.byKey.has(c.node) && <Button key={`open-change-${c.id}`} label="Open ›" variant="secondary" dimColor onPress={() => void openItem($, c.node)} />,
            ),
          )}
          {meta(
            `${t.claims.length} claim${t.claims.length === 1 ? '' : 's'} · ${t.open.length} open and ${t.answered.length} answered question${t.answered.length === 1 ? '' : 's'} · ${rel.history.length} replaced or withdrawn · ${a.changes} changes in all${snap.truncated ? ' · showing the latest items only' : ''}`,
          )}
        </Box>
      )
      // Wide, what needs you sits beside what happened; otherwise one above the other.
      body =
        fit === 'wide' ? (
          <Box key="overview" flexDirection="row" gap={2} alignItems="flex-start">
            {attention}
            {happened}
          </Box>
        ) : (
          <Box key="overview" flexDirection="column" gap="sm">
            {attention}
            {happened}
          </Box>
        )
    } else if (current === 'questions') {
      const scopes = {
        open: t.open,
        answered: t.answered,
        mine: [...t.open, ...t.answered].filter(th => isMine(th.q)),
      }
      const scope = f.questions in scopes ? f.questions : 'open'
      const { list, byMeaning } = filtered(
        scopes[scope],
        th => th.q.key,
        th => matches(th.q, f.text) || th.replies.some(r => matches(r, f.text)) || th.answers.some(c => matches(c, f.text)),
        near?.ids,
      )
      const question = (th: Thread) => {
        const q = th.q
        const answered = th.answers.length > 0
        return card(
          `q-${q.key}`,
          <Box flexDirection="column" gap="xs">
            {split(
              `q-row-${q.key}`,
              <>
                <Text wrap="wrap" weight="semibold" bold>
                  {!graphical && <Text color="warning">? </Text>}
                  {short(q.title, 300)}
                </Text>
                <Text size="footnote" dimColor>
                  asked by {byline(q)}
                  {th.replies.length ? ` · ${th.replies.length} repl${th.replies.length === 1 ? 'y' : 'ies'}` : ''}
                  {byMeaning.has(q.key) ? ' · close in meaning' : ''}
                  {held(q)}
                </Text>
              </>,
              [
                undo(q),
                answered || !canWrite ? (
                  <Button key={`open-${q.key}`} label="Open ›" variant="secondary" dimColor onPress={() => void openItem($, q.key)} />
                ) : (
                  <Button key={`answer-${q.key}`} label="Answer" variant="primary" onPress={() => void openItem($, q.key)} />
                ),
              ],
            )}
            {folded(
              `replies-${q.key}`,
              th.replies,
              2,
              'replies',
              'reply',
              r => (
                <Box key={`r-${r.key}`} flexDirection="column" paddingLeft={2}>
                  <Text wrap="wrap">
                    <Text dimColor>↳ </Text>
                    {short(r.title, 240)}
                  </Text>
                  <Text size="footnote" dimColor>
                    {byline(r)}
                    {held(r)}
                  </Text>
                </Box>
              ),
              true,
            )}
            {th.answers.map(c => (
              <Box key={`a-${c.key}`} flexDirection="column" paddingLeft={2}>
                <Text wrap="wrap">
                  <Text color="success">✓ </Text>
                  {short(c.title, 300)}
                </Text>
                <Text size="footnote" dimColor>
                  answered by {byline(c)}
                </Text>
              </Box>
            ))}
          </Box>,
          heldByNode.has(q.key) ? 'warning' : answered ? 'success' : undefined,
        )
      }
      body = (
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            {chip('scope-open', `Open ${t.open.length}`, scope === 'open', () => setFilter({ questions: 'open' }))}
            {chip('scope-answered', `Answered ${t.answered.length}`, scope === 'answered', () => setFilter({ questions: 'answered' }))}
            {chip('scope-mine', `Mine ${scopes.mine.length}`, scope === 'mine', () => setFilter({ questions: 'mine' }))}
          </Box>
          {filterBox('questions', byMeaning.size)}
          {!list.length &&
            card(
              'empty',
              <Text dimColor wrap="wrap">
                {f.text
                  ? 'No questions match.'
                  : scope === 'open'
                    ? t.answered.length
                      ? '✓ Every question has an answer.'
                      : 'No questions yet. When your agent records something the group needs to find out, it shows up here with its thread.'
                    : scope === 'answered'
                      ? 'No question has been answered yet.'
                      : 'You haven’t asked anything here yet.'}
              </Text>,
            )}
          {paged(list).map(question)}
          {showMore(list.length)}
          {meta('Agents ask and reply. Answer gives your agent your answer, and it records it as a claim.')}
        </Box>
      )
    } else if (current === 'claims') {
      const scopes = {
        current: t.claims,
        mine: t.claims.filter(isMine),
        conflicts: t.claims.filter(n => rel.inConflict.has(n.id)),
        history: rel.history,
      }
      const scope = f.claims in scopes ? f.claims : 'current'
      const { list, byMeaning } = filtered(scopes[scope], n => n.key, n => matches(n, f.text), near?.ids)
      const pairs = scope === 'history' ? [] : rel.conflicts.filter(([x, y]) => matches(x, f.text) || matches(y, f.text))
      const side = (keep: GraphNode, drop: GraphNode) =>
        split(
          `side-${keep.key}`,
          <>
            <Text wrap="wrap">{short(keep.title, 300)}</Text>
            <Text size="footnote" dimColor>
              {byline(keep)} · {keep.key}
            </Text>
          </>,
          [
            canWrite && <Button key={`keep-${keep.key}-over-${drop.key}`} label="Keep this one" variant="secondary" onPress={() => void ask($, prompts.settle(keep, drop, named))} />,
            <Button key={`open-${keep.key}-vs-${drop.key}`} label="Open ›" variant="secondary" dimColor onPress={() => void openItem($, keep.key)} />,
          ],
        )
      const badges = (n: GraphNode) => {
        const evidence = rel.linked(n.id, 'SUPPORTS', 'in').filter(rel.current).length
        return [
          rel.linked(n.id, 'ANSWERS', 'out').length ? 'answers a question' : '',
          evidence ? `${evidence} in support` : '',
          rel.linked(n.id, 'REPLACES', 'out').length ? 'updated' : '',
          prop(n, 'source') ? short(prop(n, 'source'), 50) : '',
        ]
          .filter(Boolean)
          .map(x => ` · ${x}`)
          .join('')
      }
      body = (
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="row" gap="xs" flexWrap="wrap">
            {chip('scope-current', `Current ${t.claims.length}`, scope === 'current', () => setFilter({ claims: 'current' }))}
            {chip('scope-mine', `Mine ${scopes.mine.length}`, scope === 'mine', () => setFilter({ claims: 'mine' }))}
            {(rel.conflicts.length > 0 || scope === 'conflicts') && chip('scope-conflicts', `⚡ Conflicts ${rel.conflicts.length}`, scope === 'conflicts', () => setFilter({ claims: 'conflicts' }))}
            {chip('scope-history', `History ${rel.history.length}`, scope === 'history', () => setFilter({ claims: 'history' }))}
          </Box>
          {filterBox('claims', byMeaning.size)}
          {pairs.map(([x, y]) =>
            card(
              `conflict-${x.key}-${y.key}`,
              <Box flexDirection="column" gap="xs">
                <Text color="warning" weight="semibold" bold>
                  ⚡ These can’t both be true
                </Text>
                {side(x, y)}
                <Text size="footnote" dimColor>
                  — or —
                </Text>
                {side(y, x)}
              </Box>,
              'warning',
            ),
          )}
          {scope === 'conflicts' && !pairs.length && card('empty', <Text color="success">✓ No claims contradict each other.</Text>, 'success')}
          {scope !== 'conflicts' &&
            !list.length &&
            card(
              'empty',
              <Text dimColor wrap="wrap">
                {f.text
                  ? 'No claims match.'
                  : scope === 'current'
                    ? 'No claims yet. What your agent records as true shows up here. Try “Save what this chat learned” on the Overview.'
                    : scope === 'mine'
                      ? 'None of the current claims are yours.'
                      : 'Nothing has been replaced or withdrawn.'}
              </Text>,
            )}
          {scope !== 'conflicts' &&
            paged(list).map(n => {
              const newer = rel.replacedBy.get(n.id)
              return card(
                `c-${n.key}`,
                split(
                  `c-row-${n.key}`,
                  <>
                    <Text wrap="wrap" strikethrough={scope === 'history'} dimColor={scope === 'history'}>
                      {!graphical && <Text color="suggestion">• </Text>}
                      {rel.inConflict.has(n.id) && <Text color="warning">⚡ </Text>}
                      {short(n.title, 300)}
                    </Text>
                    <Text size="footnote" dimColor wrap="wrap">
                      {byline(n)}
                      {byMeaning.has(n.key) ? ' · close in meaning' : ''}
                      {scope === 'history'
                        ? n.ended
                          ? ` · withdrawn${prop(n, 'withdrawn_by') ? ` by ${prop(n, 'withdrawn_by')}` : ''}${prop(n, 'withdraw_reason') ? `: ${short(prop(n, 'withdraw_reason'), 80)}` : ''}`
                          : newer
                            ? ` · replaced by ${newer.key}: ${short(newer.title, 80)}`
                            : ''
                        : badges(n)}
                      {held(n)}
                    </Text>
                  </>,
                  [undo(n), <Button key={`open-${n.key}`} label="Open ›" variant="secondary" dimColor onPress={() => void openItem($, n.key)} />],
                ),
                heldByNode.has(n.key) ? 'warning' : rel.inConflict.has(n.id) ? 'warning' : undefined,
              )
            })}
          {scope !== 'conflicts' && showMore(list.length)}
          {scope === 'history' && meta('Nothing is deleted: replaced and withdrawn claims stay, so anyone can see what the group believed before.')}
        </Box>
      )
    } else {
      const gone = a.people.filter((p: Person) => !p.role)
      const wrote = (p: Person) => {
        const mine = snap.nodes.filter(n => !n.ended && prop(n, 'recorded_by') === p.name)
        const n = (label: string) => mine.filter(x => x.label === label).length
        const parts = [
          [n('Claim'), 'claim'],
          [n('Question'), 'question'],
          [n('Reply'), 'repl'],
        ]
          .filter(([count]) => count)
          .map(([count, word]) => `${count} ${word}${word === 'repl' ? (count === 1 ? 'y' : 'ies') : count === 1 ? '' : 's'}`)
        const last = a.recent.find((c: Change) => c.by === p.name)
        return `${p.joined_at ? `joined ${ago(p.joined_at, now)}` : ''}${parts.length ? ` · ${parts.join(', ')}` : ' · nothing recorded yet'}${last ? ` · active ${ago(last.at, now)}` : ''}`.replace(/^ · /, '')
      }
      const person = (p: Person) =>
        card(
          `person-${p.fingerprint}`,
          split(
            `person-row-${p.fingerprint}`,
            <>
              <Text wrap="wrap">
                <Text color={p.online ? 'success' : undefined} dimColor={!p.online}>
                  ●
                </Text>{' '}
                <Text weight="semibold" bold dimColor={!p.role}>
                  {p.name}
                </Text>
                <Text dimColor>
                  {p.you ? ' (you)' : ''} · {p.role ?? 'removed'}
                  {p.creator ? ' · made this context' : ''}
                  {p.role ? (p.online ? ' · online' : ' · offline') : ''}
                </Text>
              </Text>
              {meta(wrote(p))}
              {reveal(
                `key-${p.fingerprint}`,
                'Key and agent',
                'Hide key and agent',
                <Text key={`key-text-${p.fingerprint}`} size="footnote" dimColor mono wrap="wrap">
                  {p.fingerprint}
                  {p.agent ? ` · ${p.agent}` : ''}
                  {p.platform ? ` · ${p.platform}` : ''}
                </Text>,
              )}
            </>,
            [
              p.you && <Button key="rename" label="✎ Rename" variant="secondary" dimColor onPress={() => void update($, renaming, () => true)} />,
              admin && !p.creator && !p.you && p.role && Select && (
                <Select
                  key={`role-${p.fingerprint}`}
                  value={p.role}
                  options={['reader', 'contributor', 'admin'].map(r => ({ key: r, value: r, label: r }))}
                  onSelect={(r: string) => r !== p.role && void act($, 'set_peer_role', { name: p.name, role: r, ...ctx }, `${p.name} is now ${r}.`)}
                />
              ),
              admin && !p.creator && !p.you && p.role && (
                <Button key={`remove-${p.fingerprint}`} label="Remove" variant="secondary" dimColor onPress={() => void update($, confirmRemove, () => p.fingerprint)} />
              ),
            ],
            'center',
          ),
          p.you ? 'suggestion' : undefined,
        )
      body = (
        <Box flexDirection="column" gap="sm">
          {heading('Members', members.length)}
          {members.map(person)}
          {admin &&
            card(
              'invite-card',
              <Box flexDirection="column" gap="sm">
                {split(
                  'invite-head',
                  <Text weight="semibold" bold>
                    Join codes
                    <Text dimColor weight="regular"> {invites.length ? `${invites.length} waiting` : 'none waiting'}</Text>
                  </Text>,
                  <Button
                    key="invite"
                    label="+ Invite someone"
                    variant="primary"
                    onPress={() => {
                      inviteNote = ''
                      void update($, inviting, () => 'contributor' as Invite['role'])
                    }}
                  />,
                  'center',
                )}
                {invites.length === 0
                  ? meta('Each code lets one person in: whoever uses it first. Codes stay here until they’re used, cancelled or expire.')
                  : invites.map((i: Invite) => {
                      const send = `Join my context graph: /vine-context:join ${i.code}`
                      const left = Math.max(0, Date.parse(i.expires_at) - now)
                      const hours = Math.round(left / 3600_000)
                      return (
                        <Box key={`inv-${i.id}`} flexDirection="column" gap="xs">
                          {split(
                            `inv-row-${i.id}`,
                            <Text wrap="wrap">
                              <Text weight="semibold" bold>
                                {i.label ? `For ${i.label.replace(/^for\s+/i, '')}` : 'No note'}
                              </Text>
                              <Text dimColor>
                                {' '}
                                · {i.role} · {hours >= 1 ? `expires in ${hours}h` : 'expires soon'}
                              </Text>
                              {i.id === made && <Text color="success"> · new: send it now</Text>}
                            </Text>,
                            [
                              <Button
                                key={`copy-${i.id}`}
                                label="Copy"
                                variant="secondary"
                                onPress={(press: UiPressArgument) => void $.ui.copy({ text: send, surface: press.surface }).then(r => r.isCopied && $.ui.toast('Copied: send it privately, to that one person.'))}
                              />,
                              <Button key={`cancel-${i.id}`} label="Cancel" variant="secondary" dimColor onPress={() => void act($, 'revoke_invite', { id: i.id, ...ctx }, 'Cancelled: that code no longer works.')} />,
                            ],
                            'center',
                          )}
                          {Code ? <Code source={send} /> : <Text>{send}</Text>}
                        </Box>
                      )
                    })}
                {!a.sharing && invites.length > 0 && <Text color="warning">You’re offline, so these codes won’t work until you go online.</Text>}
              </Box>,
              'suggestion',
            )}
          {gone.length > 0 && heading('Removed', gone.length)}
          {gone.map(person)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="md" paddingX={graphical ? 1 : 0}>
        {header}
        {body}
      </Box>
    )
  })
}
