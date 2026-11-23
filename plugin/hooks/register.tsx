// The vine-context mod: this chat's shared contexts inside Claude Code's own UI.
//
// - A band above the prompt, in every chat: the chat's context (usually one),
//   who's online and the latest news. The context's name opens the panel's
//   Contexts view, where contexts are turned on and off for the chat.
// - A status line entry, and a toast when someone else's change or a digest arrives.
// - A panel (/contexts) with four tabs: an Overview (what needs you, what
//   changed, recent activity), the context's Questions with their threads, its
//   Claims (with conflicts and history), and its People. An item opens on its
//   own, with everything linked to it. Anything being edited (the description,
//   an answer, a correction, an invite, a new context, the chat's contexts,
//   one context's details, a deletion being confirmed) takes the whole panel
//   until it's done or cancelled.
//
// Agents write; people steer. The panel never writes a claim itself: Answer,
// "Answer with this", Correct, "Keep this one", Look into it, Catch me up and
// "Save what this chat learned" hand the person's words to the agent as a
// prompt, and the agent records them (see `prompts`).
//
// It reads through the vine-context MCP server's `context_activity` tool,
// which never uses up the join notices meant for the agent, and acts through
// the server's ordinary tools. It polls, so there's nothing to refresh.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Activity, Change, Compose, ContextDetails, Filters, GraphEdge, GraphNode, Invite, Latest, Person, Tab } from '../types'

const PANE = 'context-graph'
const POLL_MS = 4000
const TICK_MS = 400
const NOTICE_MS = 6000
/** How many items a list shows before "Show more". */
const PAGE = 20
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
const composing = atom({ plugin: 'vine-context', key: 'composing' } as const, null)
const renaming = atom({ plugin: 'vine-context', key: 'renaming' } as const, false)
const filters = atom({ plugin: 'vine-context', key: 'filters' } as const, { text: '', claims: 'current', questions: 'open' })
const more = atom({ plugin: 'vine-context', key: 'more' } as const, 0)
const unattached = atom({ plugin: 'vine-context', key: 'unattached' } as const, null)
const viewing = atom({ plugin: 'vine-context', key: 'viewing' } as const, null)
const tick = atom({ plugin: 'vine-context', key: 'tick' } as const, 0)
const inviting = atom({ plugin: 'vine-context', key: 'inviting' } as const, null)

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

/** What the agent is asked from the panel's other buttons: the person steers, the agent records. */
export const prompts = {
  catchUp: (context: string) =>
    `Catch me up on the context '${context}': what changed lately and who changed it, which questions are still open, and any claims that contradict each other. Keep it short, and end with what needs me.`,
  saveChat: (context: string) =>
    `Record what we've learned in this chat in the context '${context}'. Search it first, so you link to what's already there instead of repeating it. Add a claim for each finding and a question for each thing we still don't know, then tell me what you recorded, with the ids.`,
  investigate: (q: GraphNode, context?: string) =>
    `Look into the open question ${q.key} ("${short(q.title, 200)}")${context ? ` in the context '${context}'` : ''}. Search the context for what's already known about it, find out what you can, and reply on its thread with what you find. If that settles it, record a claim that answers it.`,
  correct: (claim: GraphNode, text: string, context?: string) =>
    `The claim ${claim.key} ("${short(claim.title, 200)}")${context ? ` in the context '${context}'` : ''} is wrong or out of date. What's right: ${text}\n\n` +
    `Record it: paraphrase it as a claim that stands alone, and add it with replaces: [${claim.key}]${context ? ` (context: ${context})` : ''}.`,
  settle: (keep: GraphNode, drop: GraphNode, context?: string) =>
    `The claims ${keep.key} ("${short(keep.title, 200)}") and ${drop.key} ("${short(drop.title, 200)}") contradict each other${context ? ` in the context '${context}'` : ''}. ${keep.key} is the one that's right.\n\n` +
    `Settle it so only one stands: withdraw ${drop.key} with that as the reason if you may, otherwise record a claim that replaces it (replaces: [${drop.key}])${context ? ` (context: ${context})` : ''}. Then tell me what you did.`,
}

/** What the agent is asked when the person answers a question, or picks a reply as the answer. */
export function answerPrompt(q: GraphNode, answer: { text: string } | { reply: GraphNode }, context?: string): string {
  const question = `the open question ${q.key} ("${short(q.title, 200)}")${context ? ` in the context '${context}'` : ''}`
  const where = context ? ` (context: ${context})` : ''
  if ('text' in answer)
    return `My answer to ${question}: ${answer.text}\n\nRecord it: paraphrase it as a claim that stands alone, and add it with answers: [${q.key}]${where}.`
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
/** What's typed in the correction box, for its Send button. */
let composeText = ''

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
    await update($, error, () => null)
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
    await update($, error, () => trouble((e as Error).message))
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

/** Back from an item: to the one opened before it, else to the list. */
async function backItem($: Engine) {
  trail.pop()
  await update($, detail, () => trail.at(-1) ?? null)
}

/** Runs a tool from a button or field, then refreshes; errors show in the panel. */
async function act($: Engine, tool: string, args: Record<string, unknown>, done?: string) {
  try {
    const r = await call($, tool, args)
    await say($, done ?? null)
    // A new join code (from Invite, or a new context's first): marked in the People tab's list.
    const made = r && typeof r === 'object' ? (r as { invite?: { id?: string } }).invite?.id : undefined
    if (made) await update($, code, () => made)
  } catch (e) {
    await update($, error, () => (e as Error).message)
  }
  await refresh($)
  await loadDetails($)
}

/** Reads the details of the context being managed (again, after a change). */
async function loadDetails($: Engine) {
  const name = await read($, managing)
  if (!name) return
  try {
    const d = (await call($, 'context_details', { name })) as ContextDetails
    if ((await read($, managing)) === name) await update($, details, () => d)
  } catch (e) {
    await update($, error, () => trouble((e as Error).message))
  }
}

/** Opens one context's details (or, with null, goes back to the list). */
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

/** Hands the person's words to the agent, as their own prompt: it shows in the chat, so the panel says nothing more. */
async function ask($: Engine, text: string) {
  await update($, composing, () => null)
  await openItem($, null)
  await say($, null)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (e) {
    await update($, error, () => (e as Error).message)
  }
}

/** Opens the panel: on the chat's contexts (to turn them on and off), or on a context. */
async function openPane($: Engine, contexts = false) {
  wantSnapshot = true
  await update($, switching, () => contexts)
  // The panel opens on the list or the context, never on a step left half done.
  await update($, creating, () => null)
  await update($, deleting, () => null)
  await manage($, null)
  if (contexts) await openItem($, null)
  await refresh($)
  return $.ui.open({ id: PANE, title: 'Context', closeOnEscape: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'contexts', description: "Open this chat's context: what needs you, its questions and threads, claims, people, and the chat's contexts" })
    poll?.cancel()
    loading?.cancel()
    seen = undefined
    failures = 0
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
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color={a.sharing ? 'green' : undefined} dimColor={!a.sharing}>
          ●
        </Text>
        <Button key="band-contexts" label={`${main}${more}`} plain onPress={() => void openPane($, true)} />
        <Text dimColor>
          {a.sharing ? (away ? `${a.online.length}/${away} online` : 'just you') : 'offline'}
          {news ? ` · ${news}` : ''}
        </Text>
        <Button key="open-context" label="Open" onPress={() => void openPane($)} />
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
    const dismiss = () => void update($, error, () => null).then(() => say($, null))
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
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text size="title" weight="semibold" bold>
              {title}
            </Text>
            {close && <Button key={`close-${key}`} label={close.label} variant="secondary" dimColor onPress={close.onPress} />}
          </Box>
          {about && <Text wrap="wrap">{about}</Text>}
        </Box>
        {messages}
        {body}
      </Box>
    )

    /** A label over a field as wide as the panel, with a line of help under it. */
    const field = (label: string, input: unknown, help?: string) => (
      <Box flexDirection="column" gap="xs">
        <Text weight="semibold" bold>
          {label}
        </Text>
        {input}
        {help && meta(help)}
      </Box>
    )
    const here = none ?? a?.your_contexts ?? []
    const using = a?.contexts ?? []
    const inChat = (n: string) => using.find(c => c.name === n)
    /** Turns a context on or off for this chat. */
    const toggle = (n: string) =>
      void (inChat(n)
        ? act($, 'remove_context', { name: n }, `'${n}' is off for this chat. It stays on this machine.`)
        : act($, using.length ? 'add_context' : 'use_context', { name: n }, `'${n}' is on for this chat.`))
    /** Starts the join-code step for one of the chat's contexts: the panel moves to it, and the code lands in its People tab. */
    const share = (n: string) => {
      inviteNote = ''
      return update($, viewing, () => n)
        .then(() => refresh($))
        .then(() => manage($, null))
        .then(() => update($, switching, () => false))
        .then(() => update($, inviting, () => 'contributor' as Invite['role']))
    }

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
          {pinned ? '📌 Pinned to ' : '📌 Pin to '}
          <Text size="footnote" dimColor>
            {tail(f.folder, 32)}
          </Text>
        </Button>
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
          .then(() => act($, a ? 'add_context' : 'use_context', { name, description }, `Created '${name}'${a ? ' and added it to this chat' : ''}. Its first join code is under People.`))
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
          <Box flexDirection="row" gap="xs">
            <Button key="create-context" label="Create" variant="primary" onPress={() => create()} />
            <Button key="cancel-create" label="Cancel" variant="secondary" dimColor onPress={close} />
          </Box>
          {meta('It’s yours: you’re its admin, and it’s added to this chat. Invite people from its People tab, or with Share in the list.')}
        </Box>,
        { label: 'Cancel', onPress: close },
      )
    }

    // The chat's contexts, each with a switch: on means this chat uses it.
    if (none !== null || (await read($, switching))) {
      const many = using.length > 1

      // Confirming a deletion: only that. Nothing goes until the name is typed.
      const doomed = await read($, deleting)
      if (doomed && here.includes(doomed.name)) {
        const n = doomed.name
        const d = await read($, details)
        const known = d && d.name === n ? d : null
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
            <Box flexDirection="row" gap="xs">
              <Button key="keep-context" label="Keep it" variant="primary" onPress={close} />
              <Button key={`delete-${n}`} label="Delete permanently" variant="secondary" onPress={() => confirm(deleteText)} />
            </Box>
          </Box>,
          { label: 'Cancel', onPress: close },
        )
      }

      // One context's details and settings.
      const managed = await read($, managing)
      if (managed && here.includes(managed)) {
        const n = managed
        const c = inChat(n)
        const loadedDetails = await read($, details)
        const d = loadedDetails && loadedDetails.name === n ? loadedDetails : null
        const isAdmin = (d?.role ?? c?.role) === 'admin'
        const description = d ? d.description : (c?.description ?? null)
        const row = (label: string, value: unknown) => (
          <Box key={`detail-${label}`} flexDirection="row" gap={1}>
            <Box width={12} flexShrink={0}>
              <Text dimColor>{label}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text wrap="wrap">{value}</Text>
            </Box>
          </Box>
        )
        const count = (k: string, one: string, many: string) => `${d?.items[k] ?? 0} ${(d?.items[k] ?? 0) === 1 ? one : many}`
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
              {isAdmin && c && (
                <Box flexDirection="row">
                  <Button
                    key={`describe-${n}`}
                    label="✎ Edit description"
                    variant="secondary"
                    onPress={() =>
                      update($, viewing, () => n)
                        .then(() => refresh($))
                        .then(() => manage($, null))
                        .then(() => update($, switching, () => false))
                        .then(() => update($, editing, () => true))
                    }
                  />
                </Box>
              )}
            </Box>
            <Box flexDirection="column" gap="xs">
              {heading('This chat')}
              <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
                <Button key={`detail-toggle-${n}`} label={c ? '◉ On' : '○ Off'} variant={c ? 'primary' : 'secondary'} dimColor={!c} onPress={() => toggle(n)} />
                {c && many && !c.writes_here && (
                  <Button key={`detail-write-${n}`} label="✎ Write here" variant="secondary" onPress={() => void act($, 'add_context', { name: n, write_here: true }, `New items go to '${n}' unless another fits better.`)} />
                )}
                {c && (
                  <Button
                    key={`detail-open-${n}`}
                    label="Open"
                    variant="secondary"
                    onPress={() =>
                      update($, viewing, () => n)
                        .then(() => refresh($))
                        .then(() => manage($, null))
                        .then(() => update($, switching, () => false))
                    }
                  />
                )}
              </Box>
              {meta(
                c
                  ? many
                    ? c.writes_here
                      ? 'Your agent reads it, and writes here when no other context clearly fits.'
                      : 'Your agent reads it, and writes here when its description fits.'
                    : 'Your agent reads and writes here.'
                  : 'Off for this chat. Turn it on to use it here, and to share it or change its settings.',
              )}
              {pin(n, 'detail-')}
            </Box>
            <Box flexDirection="column" gap="xs">
              {heading('Sharing')}
              {d ? (
                <Text wrap="wrap">
                  <Text color={d.sharing ? 'success' : 'warning'}>● </Text>
                  {d.sharing ? 'Syncing' : 'Offline'}
                  <Text dimColor>
                    {' '}
                    · {d.members} member{d.members === 1 ? '' : 's'}
                    {d.members > 1 ? ` · ${d.online} of the others online` : ''}
                    {d.open_invites ? ` · ${d.open_invites} join code${d.open_invites === 1 ? '' : 's'} waiting` : ''}
                  </Text>
                </Text>
              ) : (
                <Text dimColor>Loading…</Text>
              )}
              {c && (
                <Box flexDirection="row" gap="xs" flexWrap="wrap">
                  {isAdmin && <Button key={`detail-share-${n}`} label="+ Share" variant="primary" onPress={() => share(n)} />}
                  {d &&
                    (d.sharing ? (
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
                <Box flexDirection="column">
                  {row('Your role', d.role ?? 'removed (you keep your copy to read)')}
                  {row('Made by', d.yours ? 'you' : (d.created_by ?? 'unknown'))}
                  {row('Holds', `${count('Claim', 'claim', 'claims')} · ${count('Question', 'question', 'questions')} · ${count('Reply', 'reply', 'replies')} · ${d.changes} change${d.changes === 1 ? '' : 's'} in all`)}
                  {d.held > 0 && row('Not yet sent', `${d.held} just written, still only on this machine`)}
                  {row('Id', d.id ?? 'none')}
                  {row('Stored at', d.stored_at)}
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
                <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
                  <Box flexDirection="row" gap="xs" alignItems="center" flexShrink={1} flexWrap="wrap">
                    <Button key={`name-${n}`} label={n} plain onPress={() => manage($, n)} />
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
                <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
                  <Button key={`details-${n}`} label="Details" variant="secondary" dimColor onPress={() => manage($, n)} />
                  {c?.role === 'admin' && <Button key={`share-${n}`} label="Share" variant="secondary" dimColor onPress={() => share(n)} />}
                  {c && many && !c.writes_here && (
                    <Button key={`write-${n}`} label="✎ Write here" variant="secondary" dimColor onPress={() => void act($, 'add_context', { name: n, write_here: true }, `New items go to '${n}' unless another fits better.`)} />
                  )}
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

    // Correcting a claim: only the claim and what's right instead. The agent records it.
    const compose = await read($, composing)
    const composeOn = compose && rel ? rel.byKey.get(compose.key) : undefined
    if (compose && composeOn) {
      const close = () => void update($, composing, () => null)
      const send = (v: string) => {
        composeText = ''
        if (v.trim()) void ask($, prompts.correct(composeOn, v.trim(), named))
      }
      return modal(
        'correct-step',
        'Correct this claim',
        composeOn.title,
        <Box flexDirection="column" gap="sm">
          {meta(`${byline(composeOn)} · ${composeOn.key}`)}
          {field(
            'What’s right instead?',
            <Input
              key={`correct-input-${composeOn.key}`}
              placeholder="In your own words: your agent records it as a claim that replaces this one"
              rows={4}
              autoFocus
              onInput={(v: string) => (composeText = v)}
              onSubmit={send}
            />,
          )}
          <Box flexDirection="row">
            <Button key="send-correction" label="Send to agent" variant="primary" onPress={() => send(composeText)} />
          </Box>
          {meta('The old claim stays in the history, marked as replaced, so anyone can see what was believed before.')}
        </Box>,
        { label: 'Cancel', onPress: close },
      )
    }

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
          <Input
            key="invite-note"
            label="Who is it for? (optional)"
            placeholder="e.g. Sam: shown when they join, so a code used by someone else stands out"
            autoFocus
            onInput={(v: string) => (inviteNote = v)}
            onSubmit={make}
          />
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
        <Box flexDirection="row" gap="xs">
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
      const related = (label: string, tone: string | undefined, n: GraphNode) => (
        <Box key={`rel-${label}-${n.key}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
          <Box flexDirection="column" flexShrink={1}>
            <Text wrap="wrap" strikethrough={n.label === 'Claim' && !rel.current(n)} dimColor={n.ended}>
              <Text color={tone} dimColor={!tone}>
                {label}{' '}
              </Text>
              {short(n.title, 300)}
            </Text>
            <Text size="footnote" dimColor>
              {byline(n)} · {n.key}
            </Text>
          </Box>
          <Button key={`open-${n.key}`} label="Open" variant="secondary" dimColor onPress={() => void openItem($, n.key)} />
        </Box>
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
                {th.replies.map(r => (
                  <Box key={`ar-${r.key}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
                    <Box flexDirection="column" flexShrink={1}>
                      <Text wrap="wrap">
                        <Text dimColor>↳ </Text>
                        {short(r.title, 600)}
                      </Text>
                      <Text size="footnote" dimColor>
                        {byline(r)}
                        {held(r)}
                      </Text>
                    </Box>
                    <Box flexDirection="row" gap="xs">
                      {undo(r)}
                      {!answered && !item.ended && canWrite && (
                        <Button key={`answer-with-${r.key}`} label="Answer with this" variant="secondary" dimColor onPress={() => void ask($, answerPrompt(item, { reply: r }, named))} />
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
            {th && group('Answer', '✓', 'success', th.answers)}
            {group('Questions about this one', '?', 'warning', asked)}
            {!answered && !item.ended && canWrite && (
              field(
                'Your answer',
                <Input
                  key={`answer-input-${item.key}`}
                  placeholder="In your own words: your agent records it as a claim that answers this"
                  submitLabel="Send to agent"
                  rows={4}
                  autoFocus
                  onSubmit={(v: string) => v.trim() && void ask($, answerPrompt(item, { text: v.trim() }, named))}
                />,
              )
            )}
            <Box flexDirection="row" gap="xs" flexWrap="wrap">
              {!answered && !item.ended && canWrite && <Button key={`investigate-${item.key}`} label="Ask my agent to look into it" variant="secondary" onPress={() => void ask($, prompts.investigate(item, named))} />}
              <Button key={`copy-${item.key}`} label="Copy" variant="secondary" dimColor onPress={copy(`${item.title} (${item.key})`)} />
              {undo(item)}
              {withdraw(item)}
            </Box>
            {!answered && !item.ended && meta('Agents reply on the thread. Your answer goes to your agent, which records it as a claim that answers the question.')}
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
              <Button key={`correct-${item.key}`} label="Correct it" variant="primary" onPress={() => ((composeText = ''), void update($, composing, (): Compose => ({ kind: 'correct', key: item.key })))} />
            )}
            <Button key={`copy-${item.key}`} label="Copy" variant="secondary" dimColor onPress={copy(`${item.title} (${item.key})`)} />
            {undo(item)}
            {withdraw(item)}
          </Box>
          {rel.current(item) && canWrite && meta('Correct it when it’s wrong or out of date: the new claim replaces this one, which stays in the history. Withdraw it when it should never have been recorded.')}
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
        .then(() => (x === current ? undefined : update($, filters, (v: Filters): Filters => ({ ...v, text: '' }))))
        .then(() => update($, tab, () => x))
    const setFilter = (patch: Partial<Filters>) => void update($, more, () => 0).then(() => update($, filters, (v: Filters): Filters => ({ ...v, ...patch })))
    const members = a.people.filter((p: Person) => p.role)
    const counts: Record<Tab, number | undefined> = { overview: undefined, questions: t?.open.length, claims: t?.claims.length, people: members.length }
    const goOnline = <Button key="go-online" label="Go online" variant="primary" onPress={() => void act($, 'start_sharing', { ...ctx }, 'Back online: syncing with the other members.')} />

    const header = (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          {/* Who's online is listed under the description: only being offline is said up here. */}
          {a.sharing ? (
            <Text> </Text>
          ) : (
            <Text size="footnote" color="warning">
              ● offline
            </Text>
          )}
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
          {members.map((p: Person) => (
            <Box key={`who-${p.fingerprint}`} hover={{ scope: `who-${p.fingerprint}` }}>
              <Text size="footnote" dimColor={!p.online} hover={{ underline: true }}>
                <Text color={p.online ? 'success' : undefined}>●</Text> {p.name}
                {p.you ? ' (you)' : ''}
                {!graphical ? ` ${p.role}` : ''}
              </Text>
            </Box>
          ))}
        </Box>
        {graphical &&
          members.map((p: Person) => (
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

    /** The filter box above a list, and what it's filtering by. */
    const filterBox = (what: string) => (
      <Box flexDirection="column" gap="xs">
        <Input key="filter" value={f.text} placeholder={`Filter ${what} by words, a person or an id`} submitLabel="Filter" onSubmit={(v: string) => setFilter({ text: v.trim() })} />
        {f.text && (
          <Box flexDirection="row" gap="xs" alignItems="center">
            <Text size="footnote" dimColor>
              Showing {what} matching “{short(f.text, 40)}”
            </Text>
            <Button key="clear-filter" label="× Clear" plain dimColor onPress={() => setFilter({ text: '' })} />
          </Box>
        )}
      </Box>
    )
    /** The first page of a list, and a button for the rest. */
    const paged = <T,>(list: T[]) => list.slice(0, PAGE + extra)
    const showMore = (total: number) =>
      total > PAGE + extra && <Button key="show-more" label={`Show ${Math.min(PAGE, total - PAGE - extra)} more of ${total}`} variant="secondary" dimColor onPress={() => void update($, more, (n: number) => n + PAGE)} />

    let body
    if (!snap || !t || !rel) body = <Text dimColor>Loading…</Text>
    else if (current === 'overview') {
      const heldMine = a.recent.filter((c: Change) => c.held && c.mine)
      const waiting = t.open.filter(th => th.replies.length)
      const mineOpen = t.open.filter(th => isMine(th.q) && th.replies.length)
      const digest = a.digest?.at(-1)
      const feed = a.recent
      const ICON: Record<string, string> = { claim: '📌', question: '❓', reply: '↳', link: '🔗', withdraw: '✕', add_member: '👋', remove_member: '🚪', set_role: '🔑', rename: '✎', describe: '✎', create: '✦' }
      const need = (key: string, tone: string, text: unknown, button: unknown) =>
        card(
          `need-${key}`,
          <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
            <Box flexShrink={1}>
              <Text wrap="wrap">{text}</Text>
            </Box>
            {button}
          </Box>,
          tone,
        )
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
      body = (
        <Box flexDirection="column" gap="sm">
          {heldMine.length > 0 &&
            card(
              'held',
              <Box flexDirection="column" gap="xs">
                <Text color="warning">Just written, still only on this machine:</Text>
                {heldMine.map((c: Change) => (
                  <Box key={`held-${c.id}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
                    <Box flexShrink={1}>
                      <Text wrap="wrap">{short(c.summary, 140)}</Text>
                    </Box>
                    <Button key={`undo-change-${c.id}`} label="Undo" variant="primary" onPress={() => void act($, 'take_back', { id: c.id, ...ctx }, 'Taken back. It never left this machine.')} />
                  </Box>
                ))}
              </Box>,
              'warning',
            )}
          {heading('Needs you', needs.length || undefined)}
          {needs.length ? needs : card('all-clear', <Text color="success">✓ Nothing needs you right now.</Text>, 'success')}
          {digest && digest.lines.length > 0 && (
            <Box flexDirection="column" gap="xs">
              {heading('What changed for you')}
              {card(
                'digest',
                <Box flexDirection="column" gap="xs">
                  {digest.lines.slice(0, 6).map((line, i) => (
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
          {heading('Recent activity')}
          {!feed.length && meta('Nothing yet. What your agent and the other members’ agents record shows up here.')}
          {paged(feed).map((c: Change) => (
            <Box key={`act-${c.id}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="wrap">
                  <Text dimColor>{ICON[c.kind] ?? '·'} </Text>
                  <Text weight="semibold" bold>
                    {c.mine ? 'you' : c.by}
                  </Text>{' '}
                  {short(c.summary, 200)}
                </Text>
                <Text size="footnote" dimColor>
                  {ago(c.at, now)}
                  {c.held ? <Text color="warning"> · still only on this machine</Text> : ''}
                </Text>
              </Box>
              {c.node && rel.byKey.has(c.node) && <Button key={`open-change-${c.id}`} label="Open" variant="secondary" dimColor onPress={() => void openItem($, c.node)} />}
            </Box>
          ))}
          {showMore(feed.length)}
          {meta(
            `${t.claims.length} claim${t.claims.length === 1 ? '' : 's'} · ${t.open.length} open and ${t.answered.length} answered question${t.answered.length === 1 ? '' : 's'} · ${rel.history.length} replaced or withdrawn · ${a.changes} changes in all${snap.truncated ? ' · showing the latest items only' : ''}`,
          )}
        </Box>
      )
    } else if (current === 'questions') {
      const scopes = {
        open: t.open,
        answered: t.answered,
        mine: [...t.open, ...t.answered].filter(th => isMine(th.q)),
      }
      const scope = f.questions in scopes ? f.questions : 'open'
      const list = scopes[scope].filter(th => matches(th.q, f.text) || th.replies.some(r => matches(r, f.text)) || th.answers.some(c => matches(c, f.text)))
      const question = (th: Thread) => {
        const q = th.q
        const answered = th.answers.length > 0
        const shown = th.replies.slice(-2)
        return card(
          `q-${q.key}`,
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="wrap" weight="semibold" bold>
                  {!graphical && <Text color="warning">? </Text>}
                  {short(q.title, 300)}
                </Text>
                <Text size="footnote" dimColor>
                  asked by {byline(q)}
                  {th.replies.length ? ` · ${th.replies.length} repl${th.replies.length === 1 ? 'y' : 'ies'}` : ''}
                  {held(q)}
                </Text>
              </Box>
              <Box flexDirection="row" gap="xs">
                {undo(q)}
                {answered || !canWrite ? (
                  <Button key={`open-${q.key}`} label="Open" variant="secondary" dimColor onPress={() => void openItem($, q.key)} />
                ) : (
                  <Button key={`answer-${q.key}`} label="Answer" variant="primary" onPress={() => void openItem($, q.key)} />
                )}
              </Box>
            </Box>
            {th.replies.length > shown.length && (
              <Box paddingLeft={2}>
                <Text size="footnote" dimColor>
                  ↳ {th.replies.length - shown.length} earlier repl{th.replies.length - shown.length === 1 ? 'y' : 'ies'}
                </Text>
              </Box>
            )}
            {shown.map(r => (
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
            ))}
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
          {filterBox('questions')}
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
      const list = scopes[scope].filter(n => matches(n, f.text))
      const pairs = scope === 'history' ? [] : rel.conflicts.filter(([x, y]) => matches(x, f.text) || matches(y, f.text))
      const side = (keep: GraphNode, drop: GraphNode) => (
        <Box key={`side-${keep.key}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
          <Box flexDirection="column" flexShrink={1}>
            <Text wrap="wrap">{short(keep.title, 300)}</Text>
            <Text size="footnote" dimColor>
              {byline(keep)} · {keep.key}
            </Text>
          </Box>
          <Box flexDirection="row" gap="xs">
            {canWrite && <Button key={`keep-${keep.key}-over-${drop.key}`} label="Keep this one" variant="secondary" onPress={() => void ask($, prompts.settle(keep, drop, named))} />}
            <Button key={`open-${keep.key}-vs-${drop.key}`} label="Open" variant="secondary" dimColor onPress={() => void openItem($, keep.key)} />
          </Box>
        </Box>
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
          {filterBox('claims')}
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
                <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
                  <Box flexDirection="column" flexShrink={1}>
                    <Text wrap="wrap" strikethrough={scope === 'history'} dimColor={scope === 'history'}>
                      {!graphical && <Text color="suggestion">• </Text>}
                      {rel.inConflict.has(n.id) && <Text color="warning">⚡ </Text>}
                      {short(n.title, 300)}
                    </Text>
                    <Text size="footnote" dimColor wrap="wrap">
                      {byline(n)}
                      {scope === 'history'
                        ? n.ended
                          ? ` · withdrawn${prop(n, 'withdrawn_by') ? ` by ${prop(n, 'withdrawn_by')}` : ''}${prop(n, 'withdraw_reason') ? `: ${short(prop(n, 'withdraw_reason'), 80)}` : ''}`
                          : newer
                            ? ` · replaced by ${newer.key}: ${short(newer.title, 80)}`
                            : ''
                        : badges(n)}
                      {held(n)}
                    </Text>
                  </Box>
                  <Box flexDirection="row" gap="xs">
                    {undo(n)}
                    <Button key={`open-${n.key}`} label="Open" variant="secondary" dimColor onPress={() => void openItem($, n.key)} />
                  </Box>
                </Box>,
                heldByNode.has(n.key) ? 'warning' : rel.inConflict.has(n.id) ? 'warning' : undefined,
              )
            })}
          {scope !== 'conflicts' && showMore(list.length)}
          {scope === 'history' && meta('Nothing is deleted: replaced and withdrawn claims stay, so anyone can see what the group believed before.')}
        </Box>
      )
    } else {
      const online = a.people.filter((p: Person) => p.online).length
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
          <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
            <Box flexDirection="column" flexShrink={1}>
              <Text>
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
              <Text size="footnote" dimColor mono>
                {p.fingerprint}
                {p.agent ? ` · ${p.agent}` : ''}
                {p.platform ? ` · ${p.platform}` : ''}
              </Text>
            </Box>
            <Box flexDirection="row" gap="xs" alignItems="center">
              {p.you && <Button key="rename" label="✎ Rename" variant="secondary" dimColor onPress={() => void update($, renaming, () => true)} />}
              {admin && !p.creator && !p.you && p.role && Select && (
                <Select
                  key={`role-${p.fingerprint}`}
                  value={p.role}
                  options={['reader', 'contributor', 'admin'].map(r => ({ key: r, value: r, label: r }))}
                  onSelect={(r: string) => r !== p.role && void act($, 'set_peer_role', { name: p.name, role: r, ...ctx }, `${p.name} is now ${r}.`)}
                />
              )}
              {admin && !p.creator && !p.you && p.role && (
                <Button key={`remove-${p.fingerprint}`} label="Remove" variant="secondary" dimColor onPress={() => void update($, confirmRemove, () => p.fingerprint)} />
              )}
            </Box>
          </Box>,
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
                <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                  <Text weight="semibold" bold>
                    Join codes
                    <Text dimColor weight="regular"> {invites.length ? `${invites.length} waiting` : 'none waiting'}</Text>
                  </Text>
                  <Button
                    key="invite"
                    label="+ Invite someone"
                    variant="primary"
                    onPress={() => {
                      inviteNote = ''
                      void update($, inviting, () => 'contributor' as Invite['role'])
                    }}
                  />
                </Box>
                {invites.length === 0
                  ? meta('Each code lets one person in: whoever uses it first. Codes stay here until they’re used, cancelled or expire.')
                  : invites.map((i: Invite) => {
                      const send = `Join my context graph: /vine-context:join ${i.code}`
                      const left = Math.max(0, Date.parse(i.expires_at) - now)
                      const hours = Math.round(left / 3600_000)
                      return (
                        <Box key={`inv-${i.id}`} flexDirection="column" gap="xs">
                          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                            <Text>
                              <Text weight="semibold" bold>
                                {i.label ? `For ${i.label.replace(/^for\s+/i, '')}` : 'No note'}
                              </Text>
                              <Text dimColor>
                                {' '}
                                · {i.role} · {hours >= 1 ? `expires in ${hours}h` : 'expires soon'}
                              </Text>
                              {i.id === made && <Text color="success"> · new: send it now</Text>}
                            </Text>
                            <Box flexDirection="row" gap="xs">
                              <Button
                                key={`copy-${i.id}`}
                                label="Copy"
                                variant="secondary"
                                onPress={(press: UiPressArgument) => void $.ui.copy({ text: send, surface: press.surface }).then(r => r.isCopied && $.ui.toast('Copied: send it privately, to that one person.'))}
                              />
                              <Button key={`cancel-${i.id}`} label="Cancel" variant="secondary" dimColor onPress={() => void act($, 'revoke_invite', { id: i.id, ...ctx }, 'Cancelled: that code no longer works.')} />
                            </Box>
                          </Box>
                          {Code ? <Code source={send} /> : <Text>{send}</Text>}
                        </Box>
                      )
                    })}
                {!a.sharing && invites.length > 0 && <Text color="warning">You’re offline, so these codes won’t work until you go online.</Text>}
              </Box>,
              'suggestion',
            )}
          {card(
            'sync-card',
            <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
              <Box flexDirection="column" flexShrink={1}>
                <Text>
                  <Text weight="semibold" bold>
                    {a.sharing ? 'Syncing' : 'Offline'}
                  </Text>
                  <Text dimColor>{a.sharing ? ` · ${online} online · ${a.relays_up} signalling relay${a.relays_up === 1 ? '' : 's'} reachable` : ' · not syncing with the other members'}</Text>
                </Text>
                {meta(
                  a.sharing
                    ? a.relays_up === 0
                      ? 'No relay is reachable, so the others can’t find this machine right now.'
                      : 'Every member keeps a full copy. Changes travel directly between your machines whenever you’re both online.'
                    : 'Your copy keeps working. What you write is sent when you’re back online.',
                )}
              </Box>
              {a.sharing ? (
                <Button key="go-offline" label="Go offline" variant="secondary" dimColor onPress={() => void act($, 'stop_sharing', { ...ctx }, 'Offline: not syncing until you go online again.')} />
              ) : (
                goOnline
              )}
            </Box>,
            a.sharing ? undefined : 'warning',
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
