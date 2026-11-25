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
  folder: { folder: '/Users/alice/work/shop/services/checkout', linked: false, pinned: ['own'] },
  your_contexts: ['infra', 'own', 'team'],
  invites: [
    { id: 'inv_1', label: 'for Sam', role: 'contributor', code: 'vine1_room.secret', created_at: iso(60_000), expires_at: iso(-23 * 3600_000) },
    { id: 'inv_2', label: null, role: 'reader', code: 'vine1_room2.secret2', created_at: iso(120_000), expires_at: iso(-20 * 60_000) },
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

const DETAILS = {
  name: 'team',
  id: '0193-aaaa',
  description: 'What the team knows about the checkout slowdown',
  role: 'admin',
  yours: true,
  created_by: 'alice',
  in_chat: true,
  writes_here: true,
  sharing: true,
  members: 3,
  online: 1,
  items: { Claim: 6, Question: 2, Reply: 2 },
  changes: 7,
  held: 1,
  open_invites: 2,
  stored_at: '/data/graphs/team',
}

const BAND = {
  plugin: 'vine-context',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'vine-context',
  component: 'Pane',
  requestId: 'context-graph',
  props: { title: 'Context', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const RUN = { command: 'contexts', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

type Calls = { tool: string; args: any }[]

/** Mocks the engine and the vine-context server; a tool named in `failing` answers with that error. */
/** What the stubbed search finds close in meaning, best first, by query. */
const HITS: Record<string, string[]> = { outage: ['c_cache', 'c_new', 'c_gone'] }

function engine(on: any, calls: Calls, prompts: string[] = [], state: unknown = ACTIVITY, failing: Record<string, string> = {}) {
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
  // The prompt box: what was typed so far, and what a fill puts there (recorded as a draft).
  let box = ''
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', (_: unknown, e: any) => {
    box = e.text
    prompts.push(`draft: ${e.text}`)
    return { isFilled: true, text: box, cursor: box.length }
  })
  on('prompt.submit', (_: unknown, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('mcp.call', (_: unknown, e: any) => {
    calls.push({ tool: e.tool, args: e.args })
    if (failing[e.tool]) return { value: { content: [{ type: 'text', text: failing[e.tool] }], isError: true } }
    if (e.tool === 'context_activity') return { value: { content: [{ type: 'text', text: JSON.stringify(state) }], isError: false, structuredContent: state } }
    if (e.tool === 'context_details') {
      const d = { ...DETAILS, name: e.args.name, in_chat: e.args.name === 'team', writes_here: e.args.name === 'team' }
      return { value: { content: [{ type: 'text', text: JSON.stringify(d) }], isError: false, structuredContent: d } }
    }
    if (e.tool === 'search') {
      const rows = (HITS[e.args.query] ?? []).map(id => ({ id }))
      return { value: { content: [{ type: 'text', text: JSON.stringify(rows) }], isError: false } }
    }
    if (e.tool === 'share_context') return { value: { content: [{ type: 'text', text: '{}' }], isError: false, structuredContent: { send: 'Join my context graph: /vine-context:join vine1_x.y', invite: { id: 'inv_1' } } } }
    return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
}
const acts = (calls: Calls) => calls.filter(c => c.tool !== 'context_activity' && c.tool !== 'search')

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
    expect((await ui.find({ type: 'Text', text: /online/ }))?.text).toBe('1/2 online')
    expect((await ui.find({ type: 'Text', text: /bob replaced your claim c_old/ }))?.text).toMatch(/^· /)
    // The open button is an arrow at the right end, after who is online.
    expect((await ui.find({ key: 'open-context' }))?.text).toBe('❯')
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
  expect((await desk.find({ key: 'tab-settings' }))?.text).toMatch(/⚙ Settings$/)
  // Whether it's syncing is in the header, with the way to change it.
  expect(await desk.find({ type: 'Text', text: /⇅ Syncing/ })).toBeDefined()
  expect((await desk.find({ key: 'sync-toggle' }))?.text).toMatch(/Go offline/)
  for (const gone of ['refresh', 'add-claim', 'ask-question']) expect(await desk.find({ key: gone })).toBeUndefined()
  expect(await desk.find({ type: 'Svg' })).toBeUndefined()
  // An activity line's who-did-what lead is dim, so the claim itself reads first.
  const lead = await desk.find({ type: 'Text', text: /^📌 bob claimed: $/ })
  expect(lead?.props?.dimColor).toBe(true)

  // What needs you: the conflict, your question's replies, the open question, the waiting codes; your held write, to undo.
  expect(await desk.find({ type: 'Text', text: /1 pair of claims can’t both be true/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /1 of your questions has replies/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /1 open question, 1 with replies/ })).toBeDefined()
  // Only the first three things that need you show: the rest are behind a link.
  expect(await desk.find({ type: 'Text', text: /2 join codes are waiting/ })).toBeUndefined()
  expect((await desk.find({ key: 'fold-needs' }))?.text).toMatch(/^1 more thing ▾/)
  await desk.press({ key: 'fold-needs' })
  expect(await desk.find({ type: 'Text', text: /2 join codes are waiting/ })).toBeDefined()
  expect((await desk.find({ key: 'fold-needs' }))?.text).toMatch(/^Show fewer things ▴/)
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
  // Answering starts it in the prompt box, for the person to finish and send; the panel stays on the question.
  expect(await desk.find({ key: 'answer-input-q_2' })).toBeUndefined()
  await desk.press({ key: 'answer-in-chat-q_2' })
  expect(prompts.at(-1)).toBe("draft: Record my answer to the open question q_2: paraphrase it as a claim that stands alone, with answers: [q_2].\nQ: Which day is the team lunch?\nA: ")
  expect(await desk.find({ type: 'Text', text: /Open question/ })).toBeDefined()
  // What was already typed stays, above it.
  await desk.press({ key: 'answer-in-chat-q_2' })
  expect(prompts.at(-1)).toMatch(/A:\n\nRecord my answer to the open question q_2[\s\S]*A: $/)
  await desk.press({ key: 'close-question-view' })
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

  // Correct it: started in the prompt box, for the agent to record as a replacement. Withdraw: an admin may, for anyone's.
  await desk.press({ key: 'correct-c_bob' })
  expect(prompts.at(-1)).toMatch(/^draft: The claim c_bob is wrong or out of date\. Record what's right[\s\S]*replaces: \[c_bob\]\.\nWas: The deploy caused it\nNow: $/)
  expect(await desk.find({ key: 'withdraw-c_bob' })).toBeDefined() // still on the claim
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
  expect(prompts).toContain('copied: Join my context graph: /vine-context:join vine1_room.secret')
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
  // Each member's key and agent are behind a link; syncing is the header's, not a card here.
  expect(await desk.find({ type: 'Text', text: /^bbbb-cccc-dddd · claude-code/ })).toBeUndefined()
  await desk.press({ key: 'fold-key-bbbb-cccc-dddd' })
  expect(await desk.find({ type: 'Text', text: /bbbb-cccc-dddd · claude-code · macOS arm64/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /signalling relay/ })).toBeUndefined()
  // Your name is changed in its own step; going offline and back is the header's link.
  expect(await desk.find({ type: 'Text', text: /2 claims, 1 question · active just now/ })).toBeDefined()
  await desk.press({ key: 'rename' })
  expect(await desk.find({ key: 'invite' })).toBeUndefined()
  await desk.input({ key: 'my-name', text: 'Ally', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'set_my_name', args: { name: 'Ally' } })
  await desk.press({ key: 'sync-toggle' })
  expect(calls).toContainEqual({ tool: 'stop_sharing', args: {} })
  await desk.unmount()
})

test('the Contexts view turns contexts on and off, creates one in its own step, and pins each to the folder', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'switch' })
  expect(await desk.find({ key: 'tab-questions' })).toBeUndefined()
  expect((await desk.find({ key: 'toggle-team' }))?.text).toBe('◉ On')
  expect((await desk.find({ key: 'toggle-own' }))?.text).toBe('○ Off')
  // A long name can push the toggle to its own line, never past the card's edge.
  expect((await desk.find({ key: 'ctx-head-team' }))?.props.flexWrap).toBe('wrap')
  await desk.press({ key: 'toggle-own' })
  expect(calls).toContainEqual({ tool: 'add_context', args: { name: 'own' } })
  await desk.press({ key: 'toggle-team' })
  expect(calls).toContainEqual({ tool: 'remove_context', args: { name: 'team' } })
  // Each context has its own pin for the chat's folder, whose path keeps its end.
  // The folder shows as much of its path as the pane has room for.
  expect((await desk.find({ key: 'pin-team' }))?.text).toBe('📌 Turn on for new chats in /Users/alice/work/shop/services/checkout')
  expect((await desk.find({ key: 'pin-own' }))?.text).toBe('📌 On for new chats in /Users/alice/work/shop/services/checkout')
  expect(await desk.find({ key: 'link-folder' })).toBeUndefined()
  await desk.press({ key: 'pin-team' })
  expect(calls).toContainEqual({ tool: 'link_folder', args: { name: 'team' } })
  await desk.press({ key: 'pin-own' })
  expect(calls).toContainEqual({ tool: 'link_folder', args: { name: 'own', off: true } })

  // Creating is a step of its own, opened from above the list: name and description together.
  expect(await desk.find({ key: 'new-name' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /Got a join code/ })).toBeDefined()
  await desk.press({ key: 'create-new-context' })
  expect(await desk.find({ key: 'toggle-team' })).toBeUndefined()
  await desk.press({ key: 'create-context' })
  expect(await desk.find({ type: 'Text', text: /Give it a name/ })).toBeDefined()
  await desk.input({ key: 'new-name', text: 'Bad Name!', kind: 'change' })
  await desk.press({ key: 'create-context' })
  expect(await desk.find({ type: 'Text', text: /lower-case letters, digits and dashes, such as/ })).toBeDefined()
  await desk.input({ key: 'new-name', text: 'team', kind: 'change' })
  await desk.input({ key: 'new-description', text: 'x', kind: 'change' })
  await desk.press({ key: 'create-context' })
  expect(await desk.find({ type: 'Text', text: /already a context 'team'/ })).toBeDefined()
  await desk.input({ key: 'new-name', text: 'ops-notes', kind: 'change' })
  await desk.input({ key: 'new-description', text: '  ', kind: 'change' })
  await desk.press({ key: 'create-context' })
  expect(await desk.find({ type: 'Text', text: /Say what it’s for/ })).toBeDefined()
  expect(calls.some(c => c.args.name === 'ops-notes')).toBe(false)
  await desk.input({ key: 'new-description', text: 'Runbooks and on-call notes', kind: 'change' })
  await desk.press({ key: 'create-context' })
  expect(calls).toContainEqual({ tool: 'add_context', args: { name: 'ops-notes', description: 'Runbooks and on-call notes' } })
  expect(await desk.find({ key: 'new-name' })).toBeUndefined()

  // Cancel leaves the list as it was.
  await desk.press({ key: 'switch' })
  await desk.press({ key: 'create-new-context' })
  await desk.press({ key: 'cancel-create' })
  expect(await desk.find({ key: 'toggle-team' })).toBeDefined()
  await desk.unmount()
})

test('a context opens from the list on its tabs or its Settings tab, an off one has a page of its own, and either is deleted only once its name is typed', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'switch' })

  // Share, on a context you're an admin of: the join-code step.
  expect(await desk.find({ key: 'share-own' })).toBeUndefined() // off for this chat
  await desk.press({ key: 'share-team' })
  expect(await desk.find({ type: 'Text', text: /Invite someone to team/ })).toBeDefined()
  await desk.press({ key: 'make-code' })
  expect(calls).toContainEqual({ tool: 'share_context', args: {} })

  // A context that's on opens by its name or Open; its Settings button opens it on its Settings tab.
  await desk.press({ key: 'switch' })
  await desk.press({ key: 'name-team' })
  expect(await desk.find({ key: 'tab-overview' })).toBeDefined() // open, on the tab it was left on
  expect(calls.some(c => c.tool === 'context_details')).toBe(false)
  await desk.press({ key: 'switch' })
  expect(await desk.find({ key: 'details-team' })).toBeUndefined()
  await desk.press({ key: 'open-team' })
  expect(await desk.find({ key: 'toggle-team' })).toBeUndefined()
  expect(await desk.find({ key: 'tab-overview' })).toBeDefined()
  await desk.press({ key: 'switch' })
  await desk.press({ key: 'settings-team' })
  expect((await desk.find({ key: 'tab-settings' }))?.text).toMatch(/^▸ /)
  expect(calls).toContainEqual({ tool: 'context_details', args: { name: 'team' } })
  expect(await desk.find({ type: 'Text', text: /6 claims · 2 questions · 2 replies/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Syncing · 3 members · 1 of the others online now · 2 join codes not used yet/ })).toBeDefined()
  // Id, storage and history are behind a link.
  expect(await desk.find({ type: 'Text', text: '/data/graphs/team' })).toBeUndefined()
  await desk.press({ key: 'fold-about-team' })
  expect(await desk.find({ type: 'Text', text: '/data/graphs/team' })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /7 in all, withdrawn items included/ })).toBeDefined()
  await desk.press({ key: 'detail-offline-team' })
  expect(calls).toContainEqual({ tool: 'stop_sharing', args: { context: 'team' } })
  await desk.press({ key: 'detail-invite-team' })
  expect(await desk.find({ type: 'Text', text: /Invite someone to team/ })).toBeDefined()
  // A way out of a step leads with the ‹ caret, like Back.
  expect((await desk.find({ key: 'close-invite-step' }))?.text).toBe('‹ Cancel')
  await desk.press({ key: 'close-invite-step' })
  expect((await desk.find({ key: 'tab-settings' }))?.text).toMatch(/^▸ /)

  // A context that's off can't be opened: Settings shows its own page.
  await desk.press({ key: 'switch' })
  expect(await desk.find({ key: 'open-own' })).toBeUndefined()
  await desk.press({ key: 'settings-own' })
  expect(calls).toContainEqual({ tool: 'context_details', args: { name: 'own' } })
  expect(await desk.find({ key: 'tab-settings' })).toBeUndefined()
  expect(await desk.find({ key: 'detail-invite-own' })).toBeUndefined()

  // Deleting: says what goes, and does nothing until the name is typed exactly.
  await desk.press({ key: 'ask-delete-own' })
  expect(await desk.find({ type: 'Text', text: /can’t be undone/ })).toBeDefined()
  expect(await desk.find({ key: 'ask-delete-own' })).toBeUndefined()
  await desk.press({ key: 'delete-own' })
  expect(await desk.find({ type: 'Text', text: /Type own exactly/ })).toBeDefined()
  await desk.input({ key: 'delete-confirm-own', text: 'owm', kind: 'change' })
  await desk.press({ key: 'delete-own' })
  expect(calls.some(c => c.tool === 'delete_context')).toBe(false)
  await desk.press({ key: 'keep-context' })
  expect(await desk.find({ key: 'ask-delete-own' })).toBeDefined() // back on its details
  await desk.press({ key: 'ask-delete-own' })
  await desk.press({ key: 'delete-own' }) // what was typed before is forgotten
  expect(calls.some(c => c.tool === 'delete_context')).toBe(false)
  await desk.input({ key: 'delete-confirm-own', text: 'own', kind: 'change' })
  await desk.press({ key: 'delete-own' })
  expect(calls).toContainEqual({ tool: 'delete_context', args: { name: 'own', confirm: 'own' } })
  expect(await desk.find({ key: 'toggle-team' })).toBeDefined() // back on the list

  // Deleting from the Settings tab goes back to the Overview.
  await desk.press({ key: 'settings-team' })
  await desk.press({ key: 'ask-delete-team' })
  await desk.input({ key: 'delete-confirm-team', text: 'team', kind: 'change' })
  await desk.press({ key: 'delete-team' })
  expect(calls).toContainEqual({ tool: 'delete_context', args: { name: 'team', confirm: 'team' } })
  expect((await desk.find({ key: 'tab-overview' }))?.text).toMatch(/^▸ /)
  await desk.unmount()
})

test('an action that fails says why, and the next poll doesn\'t clear it', async ($, on) => {
  const calls: Calls = []
  engine(on, calls, [], ACTIVITY, { stop_sharing: 'The graph host failed to start', context_details: 'The embedder is not installed' })
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'sync-toggle' }) // fails, then polls again
  expect(await desk.find({ type: 'Text', text: /The graph host failed to start/ })).toBeDefined()
  await desk.press({ key: 'dismiss-message' })
  expect(await desk.find({ type: 'Text', text: /The graph host failed to start/ })).toBeUndefined()
  // The Settings tab says its details couldn't be read, and why, instead of loading forever.
  await desk.press({ key: 'tab-settings' })
  expect(await desk.find({ type: 'Text', text: /The embedder is not installed/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Couldn’t read its details/ })).toBeDefined()
  await desk.unmount()
})

test('long lists fold behind a link: recent activity, what changed, and a thread\'s earlier replies', async ($, on) => {
  const calls: Calls = []
  const reply = (n: number) => ({ id: `Reply:r_${n}`, key: `r_${n}`, label: 'Reply', title: `Reply number ${n}`, ended: false, props: { recorded_by: 'bob', recorded_at: iso(40_000 - n * 1000) } })
  const change = (n: number) => ({ id: `y${n}`, kind: 'reply', at: iso(n * 60_000), by: 'bob', mine: false, summary: `replied: change ${n}`, node: null, held: false, shared_at: null })
  const long = {
    ...ACTIVITY,
    recent: [1, 2, 3, 4, 5, 6, 7].map(change),
    digest: [{ at: iso(1_000), lines: ['line one', 'line two', 'line three', 'line four'] }],
    snapshot: {
      ...ACTIVITY.snapshot,
      nodes: [...ACTIVITY.snapshot.nodes, reply(2), reply(3)],
      edges: [...ACTIVITY.snapshot.edges, { type: 'REPLIES_TO', source: 'Reply:r_2', target: 'Question:q_2' }, { type: 'REPLIES_TO', source: 'Reply:r_3', target: 'Question:q_2' }],
    },
  }
  engine(on, calls, [], long)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /change 5/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /change 6/ })).toBeUndefined()
  expect((await desk.find({ key: 'fold-recent' }))?.text).toMatch(/^2 more changes ▾/)
  await desk.press({ key: 'fold-recent' })
  expect(await desk.find({ type: 'Text', text: /change 7/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: 'line four' })).toBeUndefined()
  expect((await desk.find({ key: 'fold-digest' }))?.text).toMatch(/^1 more change ▾/)
  await desk.press({ key: 'fold-digest' })
  expect(await desk.find({ type: 'Text', text: 'line four' })).toBeDefined()

  // A thread shows its latest two replies; the earlier ones come first, behind a link.
  await desk.press({ key: 'tab-questions' })
  await desk.press({ key: 'scope-mine' })
  expect(await desk.find({ type: 'Text', text: /Thursday suits most people/ })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /Reply number 3/ })).toBeDefined()
  expect((await desk.find({ key: 'fold-replies-q_2' }))?.text).toMatch(/^1 earlier reply ▾/)
  await desk.press({ key: 'fold-replies-q_2' })
  expect(await desk.find({ type: 'Text', text: /Thursday suits most people/ })).toBeDefined()
  expect((await desk.find({ key: 'fold-replies-q_2' }))?.text).toMatch(/^Show fewer replies ▴/)
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
  expect(await band.find({ type: 'Text', text: /older vine-context server\. Start a new chat/ })).toBeDefined()
  expect(await band.find({ key: 'retry' })).toBeDefined()
  await band.unmount()
})

test('the create, details and delete steps draw in the terminal too', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  await $.session.start(START)
  await $.command.run(RUN)
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'switch' })
  await term.press({ key: 'create-new-context' })
  expect(await term.find({ key: 'new-description' })).toBeDefined()
  await term.press({ key: 'cancel-create' })
  await term.press({ key: 'settings-team' })
  expect(await term.find({ type: 'Text', text: /6 claims/ })).toBeDefined()
  await term.press({ key: 'ask-delete-team' })
  expect(await term.find({ type: 'Text', text: /2 other members keep their own copy/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /You made this context/ })).toBeDefined()
  await term.press({ key: 'keep-context' })
  expect(await term.find({ key: 'ask-delete-team' })).toBeDefined()
  expect(acts(calls).some(c => c.tool === 'delete_context')).toBe(false)
  await term.unmount()
})

/** The pane at a width, or minimized to the desktop app's widget. */
const sized = (bodyColumns: number, placement: 'dock' | 'inline' | 'widget' = 'dock') => ({ ...PANE, props: { ...PANE.props, bodyColumns, placement } })

test('a narrow pane stacks each row’s buttons under its text, and the details’ labels over their values', async ($, on) => {
  engine(on, [])
  await $.session.start(START)
  await $.command.run(RUN)
  const narrow = await $.ui.mount({ ...sized(30), surface: 'desktop' })
  expect((await narrow.find({ key: 'act-x2' }))?.props.flexDirection).toBe('column')
  expect((await narrow.find({ key: 'held-x1' }))?.props.flexDirection).toBe('column')
  // Stacked, the buttons are all still there and still work.
  expect(await narrow.find({ key: 'open-change-x2' })).toBeDefined()
  await narrow.press({ key: 'tab-settings' })
  expect((await narrow.find({ key: 'detail-Your role' }))?.props.flexDirection).toBe('column')
  // The folder keeps only the end of its path that fits.
  expect((await narrow.find({ key: 'pin-detail-team' }))?.text).toBe('📌 Turn on for new chats in …es/checkout')
  await narrow.unmount()

  const roomy = await $.ui.mount({ ...sized(90), surface: 'desktop' })
  expect((await roomy.find({ key: 'detail-Your role' }))?.props.flexDirection).toBe('row')
  await roomy.press({ key: 'tab-overview' })
  expect((await roomy.find({ key: 'act-x2' }))?.props.flexDirection).toBe('row')
  await roomy.unmount()
})

test('a wide pane sets what needs you beside the recent activity', async ($, on) => {
  engine(on, [])
  await $.session.start(START)
  await $.command.run(RUN)
  for (const [cols, direction] of [
    [90, 'column'],
    [120, 'row'],
  ] as const) {
    const ui = await $.ui.mount({ ...sized(cols), surface: 'desktop' })
    expect((await ui.find({ key: 'overview' }))?.props.flexDirection).toBe(direction)
    expect(await ui.find({ key: 'overview-now' })).toBeDefined()
    expect(await ui.find({ key: 'overview-recent' })).toBeDefined()
    await ui.unmount()
  }
})

test('minimized to a widget, the pane is a glance with nothing to press, and expanding it brings the view back', async ($, on) => {
  engine(on, [])
  await $.session.start(START)
  await $.command.run(RUN)
  const widget = await $.ui.mount({ ...sized(30, 'widget'), surface: 'desktop' })
  expect(await widget.find({ key: 'glance' })).toBeDefined()
  expect(await widget.find({ type: 'Button' })).toBeUndefined()
  expect(await widget.find({ type: 'Text', text: /^● team$/ })).toBeDefined()
  expect((await widget.find({ type: 'Text', text: /online/ }))?.text).toBe('1 other online · ❓ 1 open · ⚡ 1 conflict · 1 not sent yet')
  expect((await widget.find({ key: 'glance-latest' }))?.text).toBe('you claimed: Mine, still held')
  await widget.unmount()

  const docked = await $.ui.mount({ ...sized(60), surface: 'desktop' })
  expect(await docked.find({ key: 'glance' })).toBeUndefined()
  expect((await docked.find({ key: 'tab-overview' }))?.text).toMatch(/^▸ /)
  await docked.unmount()
})

test('the filter adds what the search finds close in meaning, after what shares its words, in History too', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-claims' })
  await desk.input({ key: 'filter', text: 'outage', kind: 'submit' })
  expect(calls).toContainEqual({ tool: 'search', args: { query: 'outage', kind: 'any', limit: 50, include_ended: true } })
  // Both outage claims share the word; the search adds the cache claim, marked, and not the deploy claim it didn't find.
  expect(await desk.find({ type: 'Text', text: /Showing claims matching “outage”, then 1 close in meaning/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /The cache caused it/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /· close in meaning/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /The deploy caused it/ })).toBeUndefined()
  // History keeps the filter and finds the withdrawn claim by meaning alone.
  await desk.press({ key: 'scope-history' })
  expect(await desk.find({ type: 'Text', text: /It was a DNS problem/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /then 1 close in meaning/ })).toBeDefined()
})

test('the filter falls back to words when the search fails', async ($, on) => {
  const calls: Calls = []
  engine(on, calls, [], ACTIVITY, { search: 'no such tool' })
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-claims' })
  await desk.input({ key: 'filter', text: 'outage', kind: 'submit' })
  // Asked once with include_ended, then again without it, as an older server would need.
  expect(calls.filter(c => c.tool === 'search').map(c => 'include_ended' in c.args)).toEqual([true, false])
  expect(await desk.find({ type: 'Text', text: /search by meaning isn’t available, so only words match/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /The outage lasted 6 minutes/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /The cache caused it/ })).toBeUndefined()
})

test('with many members, the header names you and who is online first, and the rest are a link to People', async ($, on) => {
  const calls: Calls = []
  const extra = Array.from({ length: 17 }, (_, i) => ({ name: `member${i + 1}`, fingerprint: `ffff-0000-${String(i).padStart(4, '0')}`, role: 'contributor', you: false, creator: false, online: i === 16, agent: null, platform: null }))
  const crowd = { ...ACTIVITY, people: [...extra, ...ACTIVITY.people], members: 20 }
  engine(on, calls, [], crowd)
  await $.session.start(START)
  await $.command.run(RUN)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // You and the two online come first, whatever order they arrive in; the 14 left over fold behind the link.
  for (const name of ['alice', 'bob', 'member17']) expect(await desk.find({ type: 'Text', text: new RegExp(`● ${name}\\b`) })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /● member10\b/ })).toBeUndefined()
  expect((await desk.find({ key: 'who-more' }))?.text).toBe('+14 more')
  await desk.press({ key: 'who-more' })
  expect((await desk.find({ key: 'tab-people' }))?.text).toMatch(/^▸ 👥 People/)
})
