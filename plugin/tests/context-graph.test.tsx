import { expect, test } from 'claude-code/testing'

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

const ACTIVITY = {
  using: "your graph 'team'",
  graph: 'team',
  created_by: 'alice',
  you: { name: 'alice', role: 'admin', fingerprint: 'aaaa-bbbb-cccc' },
  sharing: true,
  online: ['bob'],
  members: 3,
  people: [
    { name: 'alice', fingerprint: 'aaaa-bbbb-cccc', role: 'admin', you: true, creator: true, online: true, agent: null, platform: null },
    { name: 'bob', fingerprint: 'bbbb-cccc-dddd', role: 'contributor', you: false, creator: false, online: true, agent: 'claude-code', platform: 'macOS arm64' },
    { name: 'carol', fingerprint: 'cccc-dddd-eeee', role: 'reader', you: false, creator: false, online: false, agent: null, platform: null },
  ],
  relays_up: 3,
  changes: 7,
  recent: [
    { id: 'x1', kind: 'claim', at: iso(5_000), by: 'alice', mine: true, summary: 'claimed: Mine, still held', node: 'c_held', held: true, shared_at: iso(-5_000) },
    { id: 'x2', kind: 'claim', at: iso(120_000), by: 'bob', mine: false, summary: 'claimed: The deploy caused it', node: 'c_bob', held: false, shared_at: null },
  ],
  context: 'team',
  description: 'What the team knows about the checkout slowdown',
  attached: [
    { name: 'team', description: 'What the team knows about the checkout slowdown', writes_here: true },
    { name: 'infra', description: 'How our infrastructure is set up', writes_here: false },
  ],
  your_contexts: ['infra', 'own', 'team'],
  digest: [{ at: iso(1_000), lines: ['bob replaced your claim c_old "The outage lasts 4 minutes" with c_new "The outage lasts 6 minutes".'] }],
  snapshot: {
    nodes: [
      { id: 'Claim:c_held', key: 'c_held', label: 'Claim', title: 'Mine, still held', ended: false, props: { recorded_by: 'alice', recorded_at: iso(5_000) } },
      { id: 'Claim:c_bob', key: 'c_bob', label: 'Claim', title: 'The deploy caused it', ended: false, props: { recorded_by: 'bob', recorded_at: iso(120_000) } },
      { id: 'Question:q_1', key: 'q_1', label: 'Question', title: 'Why did it start at 13:58?', ended: false, props: { recorded_by: 'carol', recorded_at: iso(60_000) } },
    ],
    edges: [{ type: 'ANSWERS', source: 'Claim:c_bob', target: 'Question:q_1' }],
    truncated: false,
  },
}

const BAND = {
  plugin: 'p2p-context-graph',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'p2p-context-graph',
  component: 'Pane',
  requestId: 'context-graph',
  props: { title: 'Context graph', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

function engine(on: any, calls: { tool: string; args: any }[]) {
  on('command.register', () => ({ value: { command: 'context' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('mcp.call', (_: unknown, e: any) => {
    calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'context_activity') return { value: { content: [{ type: 'text', text: JSON.stringify(ACTIVITY) }], isError: false, structuredContent: ACTIVITY } }
    if (e.tool === 'share_context') return { value: { content: [{ type: 'text', text: '{}' }], isError: false, structuredContent: { send: 'Join my context graph: /p2p-context-graph:join p2pcg1_x.y' } } }
    return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
}

test('the band shows the graph, who is online and the latest from someone else', async ($, on) => {
  const calls: { tool: string; args: any }[] = []
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'context', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /team/ })
    expect(row?.text).toContain('1/2 online')
    expect(row?.text).toContain('+ infra')
    expect(row?.text).toContain('bob replaced your claim c_old')
    await ui.unmount()
  }
  expect(calls.some(c => c.tool === 'context_activity')).toBe(true)
})

test('the panel draws the graph on desktop, lists items with Undo and Withdraw, and manages people', async ($, on) => {
  const calls: { tool: string; args: any }[] = []
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'context', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.press({ key: 'tab-items' })
  expect(await desk.find({ key: 'undo-c_held' })).toBeDefined()
  expect(await desk.find({ key: 'withdraw-c_bob' })).toBeDefined() // an admin may withdraw anyone's
  await desk.press({ key: 'undo-c_held' })
  expect(calls).toContainEqual({ tool: 'take_back', args: { id: 'x1', context: 'team' } })
  await desk.input({ key: 'add-claim', text: 'A new claim', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'add_claim', args: { text: 'A new claim', context: 'team' } })

  await desk.press({ key: 'tab-people' })
  await desk.press({ key: 'remove-cccc-dddd-eeee' })
  await desk.press({ key: 'confirm-cccc-dddd-eeee' })
  expect(calls).toContainEqual({ tool: 'remove_peer', args: { name: 'carol', context: 'team' } })
  await desk.input({ key: 'invite', text: 'for dan', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'share_context', args: { label: 'for dan', context: 'team' } })

  // The Contexts tab attaches another context on this machine, and saves the set for the folder.
  await desk.press({ key: 'tab-contexts' })
  await desk.press({ key: 'attach-own' })
  expect(calls).toContainEqual({ tool: 'attach_context', args: { name: 'own' } })
  await desk.press({ key: 'save-folder' })
  expect(calls.some(c => c.tool === 'save_folder_contexts')).toBe(true)
  await desk.unmount()

  // The terminal has no Svg: it says where the picture shows instead.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'tab-graph' })
  expect((await term.find({ type: 'Text', text: /desktop/ }))?.text).toMatch(/Claude Code desktop/)
  await term.unmount()
})
