// The context-graph mod: p2p-context-graph inside Claude Code's own UI.
//
// - A band above the prompt: the graph this chat uses, who's online, and the
//   latest thing someone else synced, with a button that opens the panel.
// - A status line entry, and a toast when someone else's change arrives.
// - A panel (/graph): the graph drawn as SVG, the claims and questions with
//   add, Undo and Withdraw, and the people with roles, removal and join codes.
//
// It reads through the p2p-context-graph MCP server's `graph_activity` tool,
// which never uses up the join notices meant for the agent, and acts through
// the server's ordinary tools.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Change, GraphEdge, GraphNode, Latest, Person, Tab } from '../types'

const PANE = 'context-graph'
const POLL_MS = 4000
const SERVERS = ['plugin_p2p-context-graph_p2p-context-graph', 'plugin:p2p-context-graph:p2p-context-graph', 'p2p-context-graph']

const activity = atom({ plugin: 'p2p-context-graph', key: 'activity' } as const, null, { shape: 'activity-1' })
const latest = atom({ plugin: 'p2p-context-graph', key: 'latest' } as const, null)
const tab = atom({ plugin: 'p2p-context-graph', key: 'tab' } as const, 'graph')
const code = atom({ plugin: 'p2p-context-graph', key: 'code' } as const, null)
const notice = atom({ plugin: 'p2p-context-graph', key: 'notice' } as const, null)
const error = atom({ plugin: 'p2p-context-graph', key: 'error' } as const, null)
const confirmRemove = atom({ plugin: 'p2p-context-graph', key: 'confirmRemove' } as const, null)

type Engine = EngineInterface

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const ago = (iso: string, now: number) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Lays the graph out (a small force simulation, the same every time for the same graph) and draws it as SVG. */
export function graphSvg(nodes: GraphNode[], edges: GraphEdge[], width = 640, height = 420): string {
  const shown = nodes.slice(0, 120)
  const index = new Map(shown.map((n, i) => [n.id, i]))
  const links = edges.filter(e => index.has(e.source) && index.has(e.target))
  const n = shown.length
  const pos = shown.map((_, i) => {
    const a = (2 * Math.PI * i) / Math.max(n, 1)
    return { x: width / 2 + Math.cos(a) * width * 0.3, y: height / 2 + Math.sin(a) * height * 0.3, vx: 0, vy: 0 }
  })
  for (let step = 0; step < 160; step++) {
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = pos[i]!
        const b = pos[j]!
        let dx = a.x - b.x
        let dy = a.y - b.y
        const d2 = Math.max(dx * dx + dy * dy, 1)
        const f = 1800 / d2
        dx *= f / Math.sqrt(d2)
        dy *= f / Math.sqrt(d2)
        a.vx += dx
        a.vy += dy
        b.vx -= dx
        b.vy -= dy
      }
    for (const l of links) {
      const a = pos[index.get(l.source)!]!
      const b = pos[index.get(l.target)!]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const f = (d - 90) * 0.02
      a.vx += (dx / d) * f
      a.vy += (dy / d) * f
      b.vx -= (dx / d) * f
      b.vy -= (dy / d) * f
    }
    for (const p of pos) {
      p.vx += (width / 2 - p.x) * 0.004
      p.vy += (height / 2 - p.y) * 0.004
      p.x = Math.min(width - 20, Math.max(20, p.x + p.vx * 0.5))
      p.y = Math.min(height - 16, Math.max(16, p.y + p.vy * 0.5))
      p.vx *= 0.6
      p.vy *= 0.6
    }
  }
  const dash: Record<string, string> = { SUPPORTS: '', CONTRADICTS: '6 4', REPLACES: '2 3', ANSWERS: '8 3 2 3', ABOUT: '1 3' }
  const stroke: Record<string, string> = { SUPPORTS: '#6b7a90', CONTRADICTS: '#d0453b', REPLACES: '#8a8a8a', ANSWERS: '#3a9a5b', ABOUT: '#a0a0a0' }
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif" font-size="11">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8a8a8a"/></marker></defs>`,
  ]
  for (const l of links) {
    const a = pos[index.get(l.source)!]!
    const b = pos[index.get(l.target)!]!
    parts.push(
      `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke[l.type] ?? '#888'}" stroke-width="1.4"${dash[l.type] ? ` stroke-dasharray="${dash[l.type]}"` : ''} marker-end="url(#arrow)"><title>${esc(l.type)}</title></line>`,
    )
  }
  shown.forEach((node, i) => {
    const p = pos[i]!
    const fill = node.ended ? 'none' : node.label === 'Claim' ? '#3b6fd6' : '#e07a2e'
    const edge = node.ended ? '#9a9a9a' : fill
    const by = typeof node.props.recorded_by === 'string' ? ` (${node.props.recorded_by})` : ''
    parts.push(
      `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="${fill}" stroke="${edge}" stroke-width="1.5"${node.ended ? ' stroke-dasharray="2 2"' : ''}/>` +
        `<text x="${(p.x + 10).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" fill="${node.ended ? '#9a9a9a' : '#5a5a5a'}"${node.ended ? ' text-decoration="line-through"' : ''}>${esc(short(node.title, 28))}</text>` +
        `<title>${esc(node.label)}: ${esc(node.title)}${esc(by)}</title></g>`,
    )
  })
  parts.push('</svg>')
  return parts.join('')
}

// Module state: starts over on a reload (the values in $.state stay).
let server: string | undefined
let poll: { cancel(): void } | undefined
let seen: Set<string> | undefined
let wantSnapshot = false

/** Calls a tool on the p2p-context-graph server, finding its name on first use. */
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
  throw last instanceof Error ? last : new Error('The p2p-context-graph MCP server is not connected.')
}

async function refresh($: Engine) {
  try {
    const a = (await call($, 'graph_activity', { limit: 40, snapshot: wantSnapshot })) as Activity
    await update($, activity, () => a)
    await update($, error, () => null)
    const others = a.recent.filter(c => !c.mine && !c.held)
    if (seen) {
      const fresh = others.filter(c => !seen!.has(c.id) && ['claim', 'question', 'add_member', 'withdraw', 'remove_member'].includes(c.kind))
      for (const c of fresh.slice(0, 3)) $.ui.toast(`${c.by} ${short(c.summary, 90)}`)
    }
    seen = new Set(a.recent.map(c => c.id))
    const top = others.find(c => c.kind !== 'create')
    await update($, latest, (): Latest | null => (top ? { by: top.by, summary: top.summary, at: top.at } : null))
    const away = a.members - 1
    $.ui.status(`graph ${a.graph}${a.sharing ? (away ? ` · ${a.online.length}/${away} online` : '') : ' · offline'}`)
  } catch (e) {
    await update($, error, () => (e as Error).message)
  }
}

/** Runs a tool from a button or field, then refreshes; errors show in the panel. */
async function act($: Engine, tool: string, args: Record<string, unknown>, done?: string) {
  try {
    const r = await call($, tool, args)
    await update($, notice, () => done ?? null)
    if (tool === 'share_graph' && r && typeof r === 'object' && 'send' in r) await update($, code, () => String((r as { send: string }).send))
  } catch (e) {
    await update($, error, () => (e as Error).message)
  }
  await refresh($)
}

async function openPane($: Engine) {
  wantSnapshot = true
  await refresh($)
  return $.ui.open({ id: PANE, title: 'Context graph', closeOnEscape: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'graph', description: 'Open the context graph panel: the graph, its claims and questions, and its people' })
    poll?.cancel()
    seen = undefined
    poll = $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'graph' }, async $ => {
    const r = await openPane($)
    return { text: r.isPlaced ? 'Context graph panel opened.' : `The panel couldn't open here: ${r.reason}` }
  })

  // The band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const a = await read($, activity)
    if (e.props.hasSurvey || !a) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const l = await read($, latest)
    const now = await $.clock.now()
    const away = a.members - 1
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={a.sharing ? 'green' : undefined} dimColor={!a.sharing}>
          ●
        </Text>
        <Text>
          {a.graph}
          <Text dimColor>
            {a.created_by && a.created_by !== a.you.name ? ` (${a.created_by}'s)` : ''}
            {a.sharing ? (away ? ` · ${a.online.length}/${away} online` : ' · just you') : ' · offline'}
            {l ? ` · ${l.by} ${short(l.summary, 60)} (${ago(l.at, now)})` : ''}
          </Text>
        </Text>
        <Button key="open-graph" label="Open" onPress={() => void openPane($)} />
      </Box>
    )
  })

  // The panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as Record<string, any>
    const { Box, Text, Button, Input, Select, Code } = els
    const a = await read($, activity)
    const err = await read($, error)
    if (!a) return <Text dimColor>{err ? `Can't reach p2p-p2p-context-graph: ${err}` : 'Loading the context graph…'}</Text>
    const current = await read($, tab)
    const now = await $.clock.now()
    const admin = a.you.role === 'admin'
    const canWrite = a.you.role === 'admin' || a.you.role === 'contributor'
    const heldByNode = new Map(a.recent.filter((c: Change) => c.held && c.node).map((c: Change) => [c.node!, c]))
    const tabButton = (t: Tab, label: string) => (
      <Button key={`tab-${t}`} label={current === t ? `[${label}]` : label} onPress={() => void update($, tab, () => t)} />
    )

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>
          {a.using}
          <Text dimColor>
            {' '}
            · you are {a.you.name} ({a.you.role ?? 'removed'}) · {a.sharing ? `${a.online.length} online` : 'offline'} · {a.changes} changes
          </Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          {tabButton('graph', 'Graph')}
          {tabButton('items', 'Claims and questions')}
          {tabButton('people', 'People')}
          <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
        </Box>
        {err && <Text color="red">{err}</Text>}
      </Box>
    )

    const snap = a.snapshot
    let body
    if (current === 'graph') {
      // The terminal has no Svg element (it would draw only the alt text): say where the picture shows.
      const Svg = e.surface === 'terminal' ? undefined : els.Svg
      if (!snap) body = <Text dimColor>Loading the graph…</Text>
      else if (!snap.nodes.length) body = <Text dimColor>Nothing in this graph yet.</Text>
      else if (!Svg) body = <Text dimColor>The picture shows in Claude Code desktop and VS Code. "Claims and questions" lists them here.</Text>
      else {
        const width = Math.min(900, Math.max(360, (e.props.bodyColumns ?? 80) * 8))
        body = (
          <Box flexDirection="column">
            <Svg source={graphSvg(snap.nodes, snap.edges, width, Math.round(width * 0.62))} alt={`The graph: ${snap.nodes.length} items and ${snap.edges.length} links`} isInteractive />
            <Text dimColor>
              blue: claim · orange: question · dashed circle: withdrawn · red dashes: contradicts · green: answers{snap.truncated ? ' · newest items only' : ''}
            </Text>
          </Box>
        )
      }
    } else if (current === 'items') {
      const items = (snap?.nodes ?? []).filter((n: GraphNode) => !n.ended)
      const ended = (snap?.nodes ?? []).length - items.length
      const note = await read($, notice)
      body = (
        <Box flexDirection="column" gap={1}>
          {canWrite && (
            <Box flexDirection="column">
              <Input key="add-claim" placeholder="Add a claim: one statement you believe is true" submitLabel="add" onSubmit={(v: string) => v.trim() && void act($, 'add_claim', { text: v.trim() }, 'Added. Undo works for 10 seconds.')} />
              <Input key="ask-question" placeholder="Ask a question the group needs to answer" submitLabel="ask" onSubmit={(v: string) => v.trim() && void act($, 'ask_question', { text: v.trim() }, 'Asked. Undo works for 10 seconds.')} />
            </Box>
          )}
          {note && <Text dimColor>{note}</Text>}
          {items.length === 0 && <Text dimColor>No current claims or questions.</Text>}
          {items.slice(0, 60).map((n: GraphNode) => {
            const held = heldByNode.get(n.key)
            const by = typeof n.props.recorded_by === 'string' ? n.props.recorded_by : '?'
            const mine = n.props.author === undefined ? by === a.you.name : by === a.you.name
            const at = typeof n.props.recorded_at === 'string' ? n.props.recorded_at : ''
            return (
              <Box key={`item-${n.key}`} flexDirection="row" gap={1} justifyContent="space-between">
                <Text>
                  <Text color={n.label === 'Claim' ? 'blue' : 'yellow'}>{n.label === 'Claim' ? 'claim' : 'question'}</Text> {short(n.title, 140)}
                  <Text dimColor>
                    {' '}
                    · {by}
                    {at ? ` · ${ago(at, now)}` : ''}
                    {held ? ' · on this machine' : ''}
                  </Text>
                </Text>
                {held ? (
                  <Button key={`undo-${n.key}`} label="Undo" onPress={() => void act($, 'take_back', { id: held.id }, 'Taken back. It never left this machine.')} />
                ) : (
                  canWrite &&
                  (mine || admin) && <Button key={`withdraw-${n.key}`} label="Withdraw" onPress={() => void act($, 'withdraw', { id: n.key }, 'Withdrawn. It stays in the history.')} />
                )}
              </Box>
            )
          })}
          {ended > 0 && <Text dimColor>{ended} withdrawn item(s) stay in the history (see the graph).</Text>}
        </Box>
      )
    } else {
      const pending = await read($, confirmRemove)
      const line = await read($, code)
      body = (
        <Box flexDirection="column" gap={1}>
          {a.people.map((p: Person) => (
            <Box key={`person-${p.fingerprint}`} flexDirection="row" gap={1} justifyContent="space-between">
              <Text>
                <Text color={p.online ? 'green' : undefined} dimColor={!p.online}>
                  ●
                </Text>{' '}
                {p.name}
                <Text dimColor>
                  {' '}
                  · {p.role ?? 'removed'} · {p.fingerprint}
                  {p.creator ? ' · made this graph' : ''}
                  {p.you ? ' · you' : ''}
                  {p.agent ? ` · ${p.agent}` : ''}
                  {p.platform ? ` · ${p.platform}` : ''}
                </Text>
              </Text>
              {admin && !p.creator && !p.you && p.role && (
                <Box flexDirection="row" gap={1}>
                  {Select && (
                    <Select
                      key={`role-${p.fingerprint}`}
                      value={p.role}
                      options={['reader', 'contributor', 'admin'].map(r => ({ key: r, value: r, label: r }))}
                      onSelect={(r: string) => r !== p.role && void act($, 'set_peer_role', { name: p.name, role: r }, `${p.name} is now ${r}.`)}
                    />
                  )}
                  {pending === p.fingerprint ? (
                    <Button
                      key={`confirm-${p.fingerprint}`}
                      label="Really remove"
                      onPress={() => {
                        void update($, confirmRemove, () => null)
                        void act($, 'remove_peer', { name: p.name }, `${p.name} was removed. They keep the copy they already had.`)
                      }}
                    />
                  ) : (
                    <Button key={`remove-${p.fingerprint}`} label="Remove" onPress={() => void update($, confirmRemove, () => p.fingerprint)} />
                  )}
                </Box>
              )}
            </Box>
          ))}
          {admin && (
            <Box flexDirection="column">
              <Input key="invite" placeholder="Invite someone: who is it for? (Enter makes a join code)" submitLabel="make code" onSubmit={(v: string) => void act($, 'share_graph', v.trim() ? { label: v.trim() } : {}, 'Send this line privately, to that one person:')} />
              {line && (Code ? <Code source={line} /> : <Text>{line}</Text>)}
            </Box>
          )}
          {a.your_graphs.length > 1 && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text dimColor>Switch this chat to:</Text>
              {a.your_graphs
                .filter((g: string) => g !== a.graph)
                .map((g: string) => (
                  <Button key={`use-${g}`} label={g} onPress={() => void act($, 'use_graph', { name: g }, `This chat now uses '${g}'.`)} />
                ))}
            </Box>
          )}
          <Text dimColor>
            {a.sharing ? `Syncing: ${a.relays_up} signalling relay(s) reachable.` : 'Offline: not syncing with the other members.'}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {body}
      </Box>
    )
  })
}
