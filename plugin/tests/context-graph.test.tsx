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
  contexts: [{ name: 'team', description: 'What the team knows about the checkout slowdown', role: 'admin', writes_here: true }],
  folder: { folder: '/work/checkout', linked: false },
  your_contexts: ['infra', 'own', 'team'],
  invites: [
    { id: 'inv_1', label: 'for Sam', role: 'contributor', code: 'p2pcg1_room.secret', created_at: iso(60_000), expires_at: iso(-23 * 3600_000) },
    { id: 'inv_2', label: null, role: 'reader', code: 'p2pcg1_room2.secret2', created_at: iso(120_000), expires_at: iso(-20 * 60_000) },
  ],
  digest: [{ at: iso(1_000), lines: ['bob replaced your claim c_old "The outage lasts 4 minutes" with c_new "The outage lasts 6 minutes".'] }],
  snapshot: {
    nodes: [
      { id: 'Claim:c_held', key: 'c_held', label: 'Claim', title: 'Mine, still held', ended: false, props: { recorded_by: 'alice', recorded_at: iso(5_000) } },
      { id: 'Claim:c_bob', key: 'c_bob', label: 'Claim', title: 'The deploy caused it', ended: false, props: { recorded_by: 'bob', recorded_at: iso(120_000) } },
      { id: 'Question:q_1', key: 'q_1', label: 'Question', title: 'Why did it start at 13:58?', ended: false, props: { recorded_by: 'carol', recorded_at: iso(60_000) } },
      { id: 'Question:q_2', key: 'q_2', label: 'Question', title: 'Which day is the team lunch?', ended: false, props: { recorded_by: 'alice', recorded_at: iso(50_000) } },
      { id: 'Reply:r_1', key: 'r_1', label: 'Reply', title: 'Thursday suits most people', ended: false, props: { recorded_by: 'bob', recorded_at: iso(40_000) } },
      { id: 'Claim:c_cache', key: 'c_cache', label: 'Claim', title: 'The cache caused it', ended: false, props: { recorded_by: 'carol', recorded_at: iso(90_000), source: 'the cache dashboard' } },
      { id: 'Claim:c_new', key: 'c_new', label: 'Claim', title: 'The outage lasted 6 minutes', ended: false, props: { recorded_by: 'bob', recorded_at: iso(30_000) } },
      { id: 'Claim:c_old', key: 'c_old', label: 'Claim', title: 'The outage lasted 4 minutes', ended: false, props: { recorded_by: 'alice', recorded_at: iso(300_000) } },
      { id: 'Claim:c_gone', key: 'c_gone', label: 'Claim', title: 'It was a DNS problem', ended: true, props: { recorded_by: 'carol', recorded_at: iso(400_000), withdrawn_by: 'carol', withdrawn_at: iso(350_000), withdraw_reason: 'ruled out' } },
      { id: 'Reply:r_0', key: 'r_0', label: 'Reply', title: 'A withdrawn reply', ended: true, props: { recorded_by: 'bob', recorded_at: iso(45_000) } },
    ],
    edges: [
      { type: 'ANSWERS', source: 'Claim:c_bob', target: 'Question:q_1' },
      { type: 'REPLIES_TO', source: 'Reply:r_1', target: 'Question:q_2' },
      { type: 'REPLIES_TO', source: 'Reply:r_0', target: 'Question:q_2' },
      { type: 'CONTRADICTS', source: 'Claim:c_cache', target: 'Claim:c_bob' },
      { type: 'REPLACES', source: 'Claim:c_new', target: 'Claim:c_old' },
      { type: 'SUPPORTS', source: 'Claim:c_held', target: 'Claim:c_bob' },
    ],
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
  props: { title: 'Context', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const RUN = { command: 'contexts', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

type Calls = { tool: string; args: any }[]

function engine(on: any, calls: Calls, prompts: string[] = [], state: unknown = ACTIVITY) {
  on('command.register', () => ({ value: { command: 'contexts' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', (_: unknown, e: any) => {
    prompts.push(`copied: ${e.text}`)
    return { value: { isCopied: true } }
  })
  on('prompt.submit', (_: unknown, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('mcp.call', (_: unknown, e: any) => {
    calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'context_activity') return { value: { content: [{ type: 'text', text: JSON.stringify(state) }], isError: false, structuredContent: state } }
    if (e.tool === 'share_context') return { value: { content: [{ type: 'text', text: '{}' }], isError: false, structuredContent: { send: 'Join my context graph: /p2p-context-graph:join p2pcg1_x.y', invite: { id: 'inv_1' } } } }
    return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
}
const acts = (calls: Calls) => calls.filter(c => c.tool !== 'context_activity')

test('the band shows loading until the server answers', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /loading/ }))?.text).toMatch(/○ loading\.+$/)
  await ui.unmount()
})

test('the band shows the chat\'s context, who is online and the latest; its name opens the Contexts view', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ key: 'band-contexts' }))?.text).toBe('team')
    const row = await ui.find({ type: 'Text', text: /online/ })
    expect(row?.text).toContain('1/2 online')
    expect(row?.text).toContain('bob replaced your claim c_old')
    await ui.unmount()
  }
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'band-contexts' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /Contexts in this chat/ })).toBeDefined()
  expect(await pane.find({ key: 'tab-questions' })).toBeUndefined()
  await pane.unmount()
})

test('the overview says what needs you, hands steering to the agent, and opens items from the activity', async ($, on) => {
  const calls: Calls = []
  const prompts: string[] = []
  engine(on, calls, prompts)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Overview is the first tab, marked; no graph, no refresh, no way to add a claim or question by hand.
  expect((await desk.find({ key: 'tab-overview' }))?.text).toMatch(/^▸ 🏠 Overview/)
  expect((await desk.find({ key: 'tab-questions' }))?.text).toMatch(/❓ Questions 1/)
  expect((await desk.find({ key: 'tab-claims' }))?.text).toMatch(/📌 Claims 4/)
  expect((await desk.find({ key: 'tab-people' }))?.text).toMatch(/👥 People 3/)
  for (const gone of ['refresh', 'add-claim', 'ask-question']) expect(await desk.find({ key: gone })).toBeUndefined()
  expect(await desk.find({ type: 'Svg' })).toBeUndefined()

  // What needs you: the conflict, your question's replies, the open question, the waiting codes; your held write, to undo.
  expect(await desk.find({ type: 'Text', text: /1 pair of claims can’t both be true/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /1 of your questions has replies/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /1 open question, 1 with replies/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /2 join codes are waiting/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /bob replaced your claim c_old/ })).toBeDefined()
  await desk.press({ key: 'undo-change-x1' })
  expect(calls).toContainEqual({ tool: 'take_back', args: { id: 'x1' } })

  await desk.press({ key: 'catch-up' })
  expect(prompts.at(-1)).toMatch(/^Catch me up on the context 'team'/)
  await desk.press({ key: 'save-chat' })
  expect(prompts.at(-1)).toMatch(/^Record what we've learned in this chat in the context 'team'/)

  // The activity opens an item on its own; Settle goes to the conflicts.
  await desk.press({ key: 'open-change-x2' })
  expect(await desk.find({ key: 'tab-overview' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /Claim in conflict/ })).toBeDefined()
  await desk.press({ key: 'close-claim-view' })
  await desk.press({ key: 'see-conflicts' })
  expect((await desk.find({ key: 'scope-conflicts' }))?.text).toMatch(/^▸ ⚡ Conflicts 1/)
  await desk.unmount()
})

test('the questions tab shows threads; a question opens on its own, where answers go to the agent', async ($, on) => {
  const calls: Calls = []
  const prompts: string[] = []
  engine(on, calls, prompts)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-questions' })
  expect((await desk.find({ key: 'scope-open' }))?.text).toBe('▸ Open 1')

  // The open question's thread: its live reply, not the withdrawn one. The answered one is under Answered.
  expect(await desk.find({ type: 'Text', text: /Thursday suits most people/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /A withdrawn reply/ })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /Why did it start/ })).toBeUndefined()
  await desk.press({ key: 'scope-answered' })
  expect(await desk.find({ type: 'Text', text: /The deploy caused it/ })).toBeDefined()
  expect(await desk.find({ key: 'answer-q_1' })).toBeUndefined()
  await desk.press({ key: 'scope-open' })

  // Filtering by words: in the question, its thread or who wrote it.
  await desk.input({ key: 'filter', text: 'nothing like this', kind: 'submit' })
  expect(await desk.find({ type: 'Text', text: /No questions match/ })).toBeDefined()
  await desk.press({ key: 'clear-filter' })
  await desk.input({ key: 'filter', text: 'thursday', kind: 'submit' })
  expect(await desk.find({ key: 'answer-q_2' })).toBeDefined()
  await desk.press({ key: 'clear-filter' })

  await desk.press({ key: 'answer-q_2' })
  expect(await desk.find({ key: 'tab-questions' })).toBeUndefined() // nothing else on the panel
  expect(await desk.find({ type: 'Text', text: /Open question/ })).toBeDefined()
  await desk.input({ key: 'answer-input-q_2', text: 'Thursday, at the cafe', kind: 'submit' })
  expect(prompts.at(-1)).toMatch(/My answer to the open question q_2 \("Which day is the team lunch\?"\): Thursday, at the cafe[\s\S]*answers: \[q_2\]/)
  expect(await desk.find({ key: 'tab-questions' })).toBeDefined() // back to the context
  await desk.press({ key: 'answer-q_2' })
  await desk.press({ key: 'answer-with-r_1' })
  expect(prompts.at(-1)).toMatch(/with bob's reply r_1: "Thursday suits most people"[\s\S]*answers: \[q_2\]/)
  await desk.press({ key: 'answer-q_2' })
  await desk.press({ key: 'investigate-q_2' })
  expect(prompts.at(-1)).toMatch(/^Look into the open question q_2/)
  expect(acts(calls)).toEqual([]) // the panel itself wrote nothing: the agent does
  await desk.unmount()
})

test('editing the description takes the whole panel; claims show conflicts and history, and open with their links', async ($, on) => {
  const calls: Calls = []
  const prompts: string[] = []
  engine(on, calls, prompts)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const p of ACTIVITY.people.filter(p => p.role)) expect(await desk.find({ type: 'Text', text: new RegExp(`● ${p.name}`) })).toBeDefined()

  await desk.press({ key: 'edit-description' })
  expect(await desk.find({ key: 'tab-claims' })).toBeUndefined()
  await desk.input({ key: 'describe', text: 'What the team knows about checkout', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'describe_context', args: { description: 'What the team knows about checkout' } })

  await desk.press({ key: 'tab-claims' })
  expect((await desk.find({ key: 'tab-claims' }))?.text).toMatch(/^▸ /)
  // The current claims: not the replaced or the withdrawn one. The conflict sits on top, each side with "Keep this one".
  expect(await desk.find({ type: 'Text', text: /The outage lasted 6 minutes/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /The outage lasted 4 minutes/ })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /These can’t both be true/ })).toBeDefined()
  await desk.press({ key: 'keep-c_bob-over-c_cache' })
  expect(prompts.at(-1)).toMatch(/The claims c_bob \("The deploy caused it"\) and c_cache \("The cache caused it"\) contradict each other\. c_bob is the one that's right[\s\S]*withdraw c_cache/)
  await desk.press({ key: 'undo-c_held' })
  expect(calls).toContainEqual({ tool: 'take_back', args: { id: 'x1' } })

  // History: what was believed before, and why it no longer stands.
  await desk.press({ key: 'scope-history' })
  expect(await desk.find({ type: 'Text', text: /replaced by c_new: The outage lasted 6 minutes/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /withdrawn by carol: ruled out/ })).toBeDefined()
  await desk.press({ key: 'scope-current' })

  // A claim on its own: what it's linked to, each of which opens; Back returns to the one before.
  await desk.press({ key: 'open-c_bob' })
  expect(await desk.find({ key: 'tab-claims' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /Can’t be true alongside/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Evidence for it/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Why did it start at 13:58/ })).toBeDefined()
  await desk.press({ key: 'open-c_cache' })
  expect(await desk.find({ type: 'Text', text: /Source: the cache dashboard/ })).toBeDefined()
  await desk.press({ key: 'close-claim-view' })
  expect(await desk.find({ type: 'Text', text: /Evidence for it/ })).toBeDefined()

  // Correct it: its own step, handed to the agent as a replacement. Withdraw: an admin may, for anyone's.
  await desk.press({ key: 'correct-c_bob' })
  expect(await desk.find({ key: 'withdraw-c_bob' })).toBeUndefined()
  await desk.input({ key: 'correct-input-c_bob', text: 'The config push caused it', kind: 'change' })
  await desk.press({ key: 'send-correction' })
  expect(prompts.at(-1)).toMatch(/The claim c_bob \("The deploy caused it"\) is wrong or out of date\. What's right: The config push caused it[\s\S]*replaces: \[c_bob\]/)
  expect(await desk.find({ key: 'tab-claims' })).toBeDefined()
  await desk.press({ key: 'open-c_bob' })
  await desk.press({ key: 'withdraw-c_bob' })
  expect(calls).toContainEqual({ tool: 'withdraw', args: { id: 'c_bob' } })
  await desk.unmount()
})

test('the people tab confirms a removal on its own, and invites to this context', async ($, on) => {
  const calls: Calls = []
  const prompts: string[] = []
  engine(on, calls, prompts)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-people' })
  await desk.press({ key: 'remove-cccc-dddd-eeee' })
  expect(await desk.find({ type: 'Text', text: /Remove carol\?/ })).toBeDefined()
  expect(await desk.find({ key: 'invite' })).toBeUndefined()
  await desk.press({ key: 'confirm-cccc-dddd-eeee' })
  expect(calls).toContainEqual({ tool: 'remove_peer', args: { name: 'carol' } })
  // The open join codes, each to copy or cancel; making one is its own step.
  expect(await desk.find({ type: 'Text', text: /2 waiting/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /For Sam · contributor · expires in 23h/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /No note · reader · expires soon/ })).toBeDefined()
  expect(await desk.find({ key: 'make-code' })).toBeUndefined()
  await desk.press({ key: 'copy-inv_1' })
  expect(prompts).toContain('copied: Join my context graph: /p2p-context-graph:join p2pcg1_room.secret')
  await desk.press({ key: 'cancel-inv_2' })
  expect(calls).toContainEqual({ tool: 'revoke_invite', args: { id: 'inv_2' } })
  await desk.press({ key: 'invite' })
  expect(await desk.find({ type: 'Text', text: /Invite someone to team/ })).toBeDefined()
  expect(await desk.find({ key: 'rename' })).toBeUndefined()
  await desk.select({ key: 'invite-role', value: 'reader' })
  await desk.input({ key: 'invite-note', text: 'Dan', kind: 'change' })
  await desk.press({ key: 'make-code' })
  expect(calls).toContainEqual({ tool: 'share_context', args: { label: 'Dan', role: 'reader' } })
  expect(await desk.find({ type: 'Text', text: /new: send it now/ })).toBeDefined()
  await desk.press({ key: 'invite' })
  await desk.input({ key: 'invite-note', text: '', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'share_context', args: {} })
  // Your name is changed in its own step; going offline and back is a button.
  expect(await desk.find({ type: 'Text', text: /2 claims, 1 question · active just now/ })).toBeDefined()
  await desk.press({ key: 'rename' })
  expect(await desk.find({ key: 'invite' })).toBeUndefined()
  await desk.input({ key: 'my-name', text: 'Ally', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'set_my_name', args: { name: 'Ally' } })
  await desk.press({ key: 'go-offline' })
  expect(calls).toContainEqual({ tool: 'stop_sharing', args: {} })
  await desk.unmount()
})

test('the Contexts view turns contexts on and off, starts one in its own step, and links the folder', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'switch' })
  expect(await desk.find({ key: 'tab-questions' })).toBeUndefined()
  expect((await desk.find({ key: 'toggle-team' }))?.text).toBe('◉ On')
  expect((await desk.find({ key: 'toggle-own' }))?.text).toBe('○ Off')
  await desk.press({ key: 'toggle-own' })
  expect(calls).toContainEqual({ tool: 'add_context', args: { name: 'own' } })
  await desk.press({ key: 'toggle-team' })
  expect(calls).toContainEqual({ tool: 'remove_context', args: { name: 'team' } })
  await desk.press({ key: 'link-folder' })
  expect(calls).toContainEqual({ tool: 'link_folder', args: {} })

  await desk.input({ key: 'new-name', text: 'Bad Name!', kind: 'submit' })
  expect(await desk.find({ type: 'Text', text: /lower-case letters/ })).toBeDefined()
  await desk.input({ key: 'new-name', text: 'ops-notes', kind: 'submit' })
  expect(await desk.find({ key: 'toggle-team' })).toBeUndefined() // the description step stands alone
  await desk.input({ key: 'new-description', text: 'Runbooks and on-call notes', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'add_context', args: { name: 'ops-notes', description: 'Runbooks and on-call notes' } })
  await desk.unmount()
})

test('with several contexts, the band lists them and the panel shows one at a time, naming it in its actions', async ($, on) => {
  const calls: Calls = []
  const two = { ...ACTIVITY, contexts: [...ACTIVITY.contexts, { name: 'infra', description: 'How our infrastructure is set up', role: 'admin', writes_here: false }] }
  engine(on, calls, [], two)
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ key: 'band-contexts' }))?.text).toBe('team +infra')
  await band.unmount()
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ key: 'view-infra' })).toBeDefined()
  await desk.press({ key: 'tab-claims' })
  await desk.press({ key: 'undo-c_held' })
  expect(calls).toContainEqual({ tool: 'take_back', args: { id: 'x1', context: 'team' } })
  await desk.press({ key: 'view-infra' })
  expect(calls.some(c => c.tool === 'context_activity' && c.args.context === 'infra')).toBe(true)
  await desk.unmount()
})

test('with no context in the chat, the band says so and Choose opens the Contexts view', async ($, on) => {
  const calls: Calls = []
  engine(on, calls, [], { using: 'no context', context: null, contexts: [], your_contexts: ['infra', 'team'], next: 'Ask the person' })
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /No context/ })).toBeDefined()
  await band.press({ key: 'choose-context' })
  await band.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'toggle-team' })
  expect(calls).toContainEqual({ tool: 'use_context', args: { name: 'team' } })
  await desk.unmount()
})

test('every view draws in the terminal too, and a reader gets no way to write', async ($, on) => {
  const calls: Calls = []
  const reader = { ...ACTIVITY, you: { ...ACTIVITY.you, role: 'reader' }, invites: undefined, sharing: false, online: [] }
  engine(on, calls, [], reader)
  await $.session.start(START)
  await $.command.run(RUN)
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Offline shows on the Overview, with the way back.
  expect(await term.find({ type: 'Text', text: /You’re offline/ })).toBeDefined()
  await term.press({ key: 'go-online' })
  expect(calls).toContainEqual({ tool: 'start_sharing', args: {} })
  expect(await term.find({ key: 'save-chat' })).toBeUndefined()
  for (const tab of ['questions', 'claims', 'people', 'overview']) {
    await term.press({ key: `tab-${tab}` })
    expect((await term.find({ key: `tab-${tab}` }))?.text).toMatch(/^▸ /)
  }
  expect(await term.find({ key: 'invite' })).toBeUndefined()
  await term.press({ key: 'tab-questions' })
  expect(await term.find({ key: 'answer-q_2' })).toBeUndefined()
  await term.press({ key: 'open-q_2' })
  expect(await term.find({ key: 'answer-input-q_2' })).toBeUndefined()
  expect(await term.find({ key: 'investigate-q_2' })).toBeUndefined()
  await term.press({ key: 'close-question-view' })
  await term.press({ key: 'tab-claims' })
  expect(await term.find({ key: 'keep-c_bob-over-c_cache' })).toBeUndefined()
  await term.press({ key: 'open-c_cache' })
  expect(await term.find({ key: 'correct-c_cache' })).toBeUndefined()
  expect(await term.find({ key: 'withdraw-c_cache' })).toBeUndefined()
  await term.unmount()
})

test('the band says what is wrong, instead of loading forever, when the server keeps failing', async ($, on) => {
  on('command.register', () => ({ value: { command: 'contexts' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Tool context_activity not found' }], isError: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start(START)
  await $.command.run(RUN)
  await $.command.run(RUN)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /loading/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /older p2p-context-graph server\. Start a new chat/ })).toBeDefined()
  expect(await band.find({ key: 'retry' })).toBeDefined()
  await band.unmount()
})
