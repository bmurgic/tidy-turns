import type { On, RenderElement, TurnStepChunk } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

type Surface = (typeof SURFACES)[number]

const toolRow = (tool_use_id: string) => ({
  tool_use_id,
  tool: 'Bash',
  input: { command: 'ls' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'a', stderr: '', interrupted: false },
})

const textRow = (text: string, isFirstOfReply = false) => ({
  text,
  isFirstOfReply,
})

// The kit has no transcript store beneath session.append; the mod records before next.
const storeMissing = (error: Error) => expect(error.message).toContain('no implementation for session.append')

// Stand-ins for the engine beneath the plugin.
// Calls a test keeps running until it settles the promise, by tool_use_id.
const heldCalls = new Map<string, Promise<void>>()

const stubEngine = (on: On) => {
  heldCalls.clear()
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async (_$, e) => {
    await heldCalls.get(e.tool_use_id)

    return e.tool_use_id.includes('fail') ? { isError: true, result: 'boom' } : { result: { stdout: 'a', stderr: '', interrupted: false } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.component === 'ToolGroup' ? `engine group expanded=${e.props.isExpanded}` : 'engine row'}</Text>
  })
}

const appendText = ($: Engine, uuid: string, text: string) =>
  $.session
    .append({
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid,
    })
    .catch(storeMissing)

// One turn up to its answer: a working note, a Bash call, then the final answer.
const runTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: 'list files', turnId })
  await appendText($, `${turnId}-a`, `Let me look (${turnId}).`)
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: `${turnId}-tool`,
    command: 'ls',
  })
  await appendText($, `${turnId}-b`, `Found one file (${turnId}).`)
}

const finishTurn = ($: Engine, turnId: string) =>
  $.turn.complete({
    answer: `Found one file (${turnId}).`,
    durationMs: 4200,
    isAborted: false,
    turnId,
    reason: 'answer',
  })

// A turn with something for every summary item: two reads, three edits over two
// files, a failed command, a subagent's read, one model request, then an interrupt.
const runRichTurn = async ($: Engine, on: On, turnId: string) => {
  const usage = {
    input_tokens: 10,
    output_tokens: 1234,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-haiku-4-5-20251001',
  }

  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage,
    }
  })

  await $.turn.start({ text: 'fix it', turnId })
  await appendText($, `${turnId}-a`, `Looking (${turnId}).`)

  const stream = $.turn.step({
    turnId,
    index: 0,
    model: usage.model,
    messageCount: 1,
  })
  while (!(await stream.next()).done) {}

  await $.tool.call({
    tool: 'Read',
    tool_use_id: `${turnId}-r1`,
    file_path: '/w/a.ts',
  })
  await $.tool.call({
    tool: 'Read',
    tool_use_id: `${turnId}-r2`,
    file_path: '/w/b.ts',
  })
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: `${turnId}-e1`,
    file_path: '/w/a.ts',
    old_string: 'a',
    new_string: 'b',
  })
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: `${turnId}-e2`,
    file_path: '/w/a.ts',
    old_string: 'b',
    new_string: 'c',
  })
  await $.tool.call({
    tool: 'Write',
    tool_use_id: `${turnId}-w1`,
    file_path: '/w/b.ts',
    content: 'b',
  })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: `${turnId}-fail`,
    command: 'false',
  })
  // The kit types no agentId on a raised call; a subagent's call carries one.
  const subagentRead = {
    tool: 'Read',
    tool_use_id: `${turnId}-sub`,
    file_path: '/w/c.ts',
    agentId: 'agent-1',
  } as const
  await $.tool.call(subagentRead as Omit<typeof subagentRead, 'agentId'>)
  await appendText($, `${turnId}-b`, `Stopped (${turnId}).`)
  await $.turn.complete({
    answer: `Stopped (${turnId}).`,
    durationMs: 4200,
    isAborted: true,
    turnId,
    reason: 'aborted',
  })
}

const ALL_ITEMS = {
  showToolKinds: true,
  showSubagents: true,
  showFilesChanged: true,
  showFailures: true,
  showEndReason: true,
  showTokens: true,
  showModel: true,
}

const mountAnswer = ($: Engine, text: string) =>
  $.ui.mount({
    plugin: 'tidy-turns',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: textRow(text),
  })

const drawTool = async ($: Engine, id: string, surface: Surface) =>
  (
    await $.ui.mount({
      plugin: 'tidy-turns',
      surface,
      component: 'ToolUse',
      props: toolRow(id),
    })
  ).drawn()

const drawText = async ($: Engine, text: string, surface: Surface) =>
  (
    await $.ui.mount({
      plugin: 'tidy-turns',
      surface,
      component: 'AssistantMessage',
      props: textRow(text),
    })
  ).drawn()

const isHidden = (tree: RenderElement) => tree.type === 'Box' && tree.props?.display === 'none'

// A turn of skill, tool search, MCP and session tool calls, and one read.
const runToolingTurn = async ($: Engine, turnId: string) => {
  // The kit types only this build's built-in tools; an MCP tool's name is the server's.
  const call = (tool: string, id: string) =>
    $.tool.call({ tool, tool_use_id: `${turnId}-${id}` } as unknown as Parameters<Engine['tool']['call']>[0])

  await $.turn.start({ text: 'tidy up', turnId })
  await appendText($, `${turnId}-a`, `Looking (${turnId}).`)
  await call('Read', 'read')
  await call('Skill', 'skill')
  await call('ToolSearch', 'search-1')
  await call('ToolSearch', 'search-2')
  await call('mcp__context7__query-docs', 'mcp')
  await call('Monitor', 'monitor')
  await call('SendMessage', 'message-1')
  await call('SendMessage', 'message-2')
  await appendText($, `${turnId}-b`, `Tidied (${turnId}).`)
  await $.turn.complete({ answer: `Tidied (${turnId}).`, durationMs: 4200, isAborted: false, turnId, reason: 'answer' })
}

const TOOLING_ITEMS = { showSessionTools: true, showSkills: true, showToolSearches: true, showMcpCalls: true }

describe('tidy-turns', () => {
  for (const surface of SURFACES) {
    // The desktop wraps rows in its own chrome, so the mod folds on the terminal only.
    const isFoldingSurface = surface === 'terminal'

    test(`folds a finished turn's work on ${surface}`, async ($, on) => {
      stubEngine(on)
      await runTurn($, 't1')

      expect(isHidden(await drawTool($, 't1-tool', surface))).toBe(false)

      await finishTurn($, 't1')

      expect(isHidden(await drawTool($, 't1-tool', surface))).toBe(isFoldingSurface)
      expect(isHidden(await drawText($, 'Let me look (t1).', surface))).toBe(isFoldingSurface)
      expect(isHidden(await drawText($, 'Found one file (t1).', surface))).toBe(false)
    })

    test(`redraws a row mounted before the turn finished on ${surface}`, async ($, on) => {
      stubEngine(on)
      await runTurn($, 't2')
      const tool = await $.ui.mount({
        plugin: 'tidy-turns',
        surface,
        component: 'ToolUse',
        props: toolRow('t2-tool'),
      })
      expect(isHidden(await tool.drawn())).toBe(false)

      await finishTurn($, 't2')

      expect(isHidden(await tool.drawn())).toBe(isFoldingSurface)
    })

    test(`puts the Worked for line above the final answer on ${surface}`, async ($, on) => {
      stubEngine(on)
      await runTurn($, 't5')
      await finishTurn($, 't5')

      const answer = await $.ui.mount({
        plugin: 'tidy-turns',
        surface,
        component: 'AssistantMessage',
        props: textRow('Found one file (t5).'),
      })
      const lead = await answer.find({ type: 'Button', text: /^[A-Z][a-zé]+ for 4s$/ })
      const line = await answer.find({ key: 'tidy-turns:line' })
      const details = await answer.find({ type: 'Button', text: ' ▸' })
      const body = await answer.find({ type: 'Text', text: 'engine row' })

      expect(lead !== undefined).toBe(isFoldingSurface)
      expect(line?.text).toBe(isFoldingSurface ? `✻ ${lead?.text} ▸` : undefined)
      expect(details !== undefined).toBe(isFoldingSurface)
      expect(body !== undefined).toBe(true)
    })

    test(`keeps earlier turns folded while a new turn runs on ${surface}`, async ($, on) => {
      stubEngine(on)
      await runTurn($, 't3')
      await finishTurn($, 't3')
      await runTurn($, 't4')

      expect(isHidden(await drawTool($, 't3-tool', surface))).toBe(isFoldingSurface)
      expect(isHidden(await drawText($, 'Let me look (t3).', surface))).toBe(isFoldingSurface)
      expect(isHidden(await drawTool($, 't4-tool', surface))).toBe(false)
      expect(isHidden(await drawText($, 'Let me look (t4).', surface))).toBe(false)
    })
  }

  test('hides the engine turn line under the answer on terminal', async ($, on) => {
    stubEngine(on)
    const footer = await $.ui.mount({
      plugin: 'tidy-turns',
      surface: 'terminal',
      component: 'TurnDuration',
      props: { word: 'Baked', durationMs: 4200 },
    })

    expect(isHidden(await footer.drawn())).toBe(true)
  })

  test('shows every row while the ctrl+o transcript is open', async ($, on) => {
    stubEngine(on)
    await runTurn($, 't7')
    await finishTurn($, 't7')
    const prompt = (isExpanded: boolean) => ({
      text: 'list files',
      origin: { kind: 'composer' as const },
      isExpanded,
    })

    await $.ui.mount({
      plugin: 'tidy-turns',
      surface: 'terminal',
      component: 'UserMessage',
      props: prompt(true),
    })
    const tool = await $.ui.mount({
      plugin: 'tidy-turns',
      surface: 'terminal',
      component: 'ToolUse',
      props: toolRow('t7-tool'),
    })
    expect(isHidden(await tool.drawn())).toBe(false)

    await $.ui.mount({
      plugin: 'tidy-turns',
      surface: 'terminal',
      component: 'UserMessage',
      props: prompt(false),
    })
    expect(isHidden(await tool.drawn())).toBe(true)
  })

  test('opens the summary under the line as a tree, one group per row', { options: ALL_ITEMS }, async ($, on) => {
    stubEngine(on)
    await runRichTurn($, on, 's1')
    const answer = await mountAnswer($, 'Stopped (s1).')
    const row = async (group: string) => (await answer.find({ key: `tidy-turns:row:${group}` }))?.text

    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
    expect(await row('activity')).toBeUndefined()

    await answer.press({ key: 'tidy-turns:work' })

    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▾')
    expect(await row('activity')).toBe('├─ 6 tool calls · 2 reads · 1 command · 1 agent')
    expect(await row('changes')).toBe('├─ 2 files changed')
    expect(await row('usage')).toBe('├─ Haiku 4.5 · 1.2k tokens')
    expect(await row('problems')).toBe('└─ 1 failed · interrupted')

    const drawn = JSON.stringify(await answer.drawn())
    const order = ['activity', 'changes', 'usage', 'problems'].map(group => drawn.indexOf(`tidy-turns:row:${group}`))
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true)
  })

  test(
    'counts edits among the kinds only while files changed is off',
    { options: { ...ALL_ITEMS, showFilesChanged: false } },
    async ($, on) => {
      stubEngine(on)
      await runRichTurn($, on, 's6')
      const answer = await mountAnswer($, 'Stopped (s6).')
      await answer.press({ key: 'tidy-turns:work' })

      expect((await answer.find({ key: 'tidy-turns:row:activity' }))?.text).toBe(
        '├─ 6 tool calls · 3 edits · 2 reads · 1 command · 1 agent',
      )
      expect(await answer.find({ key: 'tidy-turns:row:changes' })).toBeUndefined()
    },
  )

  test(
    'puts session tools on a row of their own, and skills, tool searches and MCP calls with usage',
    { options: { ...ALL_ITEMS, ...TOOLING_ITEMS } },
    async ($, on) => {
      stubEngine(on)
      await runToolingTurn($, 'k1')
      const answer = await mountAnswer($, 'Tidied (k1).')
      await answer.press({ key: 'tidy-turns:work' })
      const row = async (group: string) => (await answer.find({ key: `tidy-turns:row:${group}` }))?.text

      expect(await row('activity')).toBe('├─ 8 tool calls · 1 read')
      expect(await row('session')).toBe('├─ 2 messages · 1 monitor')
      expect(await row('usage')).toBe('└─ 1 skill · 2 tool searches · 1 MCP call')

      const drawn = JSON.stringify(await answer.drawn())
      expect(
        drawn.indexOf('tidy-turns:row:changes') === -1 && drawn.indexOf('tidy-turns:row:session') < drawn.indexOf('tidy-turns:row:usage'),
      ).toBe(true)
    },
  )

  test(
    'counts skill, tool search, MCP and session tool calls among the kinds while their items are off',
    { options: { ...ALL_ITEMS, showSessionTools: false, showSkills: false, showToolSearches: false, showMcpCalls: false } },
    async ($, on) => {
      stubEngine(on)
      await runToolingTurn($, 'k2')
      const answer = await mountAnswer($, 'Tidied (k2).')
      await answer.press({ key: 'tidy-turns:work' })

      expect((await answer.find({ key: 'tidy-turns:row:activity' }))?.text).toBe(
        '└─ 8 tool calls · 2 messages · 2 tool searches · 1 MCP call · 1 monitor · 1 read · 1 skill',
      )
      expect(await answer.find({ key: 'tidy-turns:row:session' })).toBeUndefined()
    },
  )

  test('skips a group the turn has nothing for, and ends the tree on the last row', { options: ALL_ITEMS }, async ($, on) => {
    stubEngine(on)
    await runTurn($, 's2')
    await finishTurn($, 's2')
    const answer = await mountAnswer($, 'Found one file (s2).')
    await answer.press({ key: 'tidy-turns:work' })

    expect((await answer.find({ key: 'tidy-turns:row:activity' }))?.text).toBe('└─ 1 tool call · 1 command')
    expect(await answer.find({ key: 'tidy-turns:row:changes' })).toBeUndefined()
    expect(await answer.find({ key: 'tidy-turns:row:problems' })).toBeUndefined()
    expect(await answer.find({ key: 'tidy-turns:row:usage' })).toBeUndefined()
  })

  test('opens to one row per group by default', async ($, on) => {
    stubEngine(on)
    await runRichTurn($, on, 's3')
    const answer = await mountAnswer($, 'Stopped (s3).')
    await answer.press({ key: 'tidy-turns:work' })
    const row = async (group: string) => (await answer.find({ key: `tidy-turns:row:${group}` }))?.text

    expect(await row('activity')).toBe('├─ 6 tool calls · 2 reads · 1 command · 1 agent')
    expect(await row('changes')).toBe('├─ 2 files changed')
    expect(await row('usage')).toBe('├─ Haiku 4.5 · 1.2k tokens')
    expect(await row('problems')).toBe('└─ 1 failed · interrupted')
  })

  test('shows no arrow when the turn has nothing to summarize', async ($, on) => {
    stubEngine(on)

    // A note then the answer, no tool calls: the note folds, but no item has a value.
    await $.turn.start({ text: 'think', turnId: 't9' })
    await appendText($, 't9-a', 'Thinking it over (t9).')
    await appendText($, 't9-b', 'Here it is (t9).')
    await $.turn.complete({
      answer: 'Here it is (t9).',
      durationMs: 4200,
      isAborted: false,
      turnId: 't9',
      reason: 'answer',
    })
    const bare = await mountAnswer($, 'Here it is (t9).')

    expect(await bare.find({ type: 'Text', text: /^✻ [A-Z][a-zé]+ for 4s$/ })).toBeDefined()
    expect(await bare.find({ type: 'Button' })).toBeUndefined()
  })

  test('clicking the line opens and closes the summary, and leaves the work folded', async ($, on) => {
    stubEngine(on)
    await runTurn($, 't8')
    await finishTurn($, 't8')
    const answer = await mountAnswer($, 'Found one file (t8).')

    await answer.press({ key: 'tidy-turns:lead' })

    expect((await answer.find({ key: 'tidy-turns:row:activity' }))?.text).toBe('└─ 1 tool call · 1 command')
    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▾')
    expect(isHidden(await drawTool($, 't8-tool', 'terminal'))).toBe(true)
    expect(isHidden(await drawText($, 'Let me look (t8).', 'terminal'))).toBe(true)

    await answer.press({ key: 'tidy-turns:row-text:activity' })

    expect(await answer.find({ key: 'tidy-turns:row:activity' })).toBeUndefined()
    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
  })

  test('clicking one turn opens its summary alone', async ($, on) => {
    stubEngine(on)
    await runTurn($, 'p1')
    await finishTurn($, 'p1')
    await runTurn($, 'p2')
    await finishTurn($, 'p2')
    const first = await mountAnswer($, 'Found one file (p1).')
    const second = await mountAnswer($, 'Found one file (p2).')

    await first.press({ key: 'tidy-turns:lead' })

    expect((await first.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▾')
    expect(await first.find({ key: 'tidy-turns:row:activity' })).toBeDefined()
    expect((await second.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
    expect(await second.find({ key: 'tidy-turns:row:activity' })).toBeUndefined()
  })

  test('releases each text block whole once it ends, not piece by piece', async ($, on) => {
    on('turn.step', async function* (_$, e) {
      yield { kind: 'text', index: 0, text: 'Checking ' }
      yield { kind: 'text', index: 0, text: 'now.' }
      yield { kind: 'tool', index: 1, id: 'step-tool', name: 'Bash' }
      yield { kind: 'input', index: 1, json: '{"command":"ls"}' }
      yield { kind: 'text', index: 2, text: 'Done ' }
      yield { kind: 'text', index: 2, text: 'one.' }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'Checking now.Done one.',
        toolUses: [],
        stopReason: 'end_turn',
        usage: null,
      }
    })

    const seen: TurnStepChunk[] = []
    const stream = $.turn.step({
      turnId: 'step-turn',
      index: 0,
      model: 'claude-opus-5-5',
      messageCount: 1,
    })
    let step = await stream.next()

    while (!step.done) {
      seen.push(step.value)
      step = await stream.next()
    }

    expect(seen.map(chunk => (chunk.kind === 'text' ? `text:${chunk.text}` : chunk.kind))).toEqual([
      'text:Checking now.',
      'tool',
      'input',
      'text:Done one.',
      'stop',
    ])
    expect(step.value.answer).toBe('Checking now.Done one.')
  })

  describe('a running turn', () => {
    type Block = 'note' | { callId: string; tool?: string; input?: Record<string, unknown> }

    const mountCall = ($: Engine, id: string, surface: Surface = 'terminal') =>
      $.ui.mount({ plugin: 'tidy-turns', surface, component: 'ToolUse', props: toolRow(id) })

    const linesOf = async (row: Awaited<ReturnType<typeof mountCall>>) =>
      (await row.findAll({ type: 'Button' })).map(button => button.text)

    const mountResult = ($: Engine, isErrored = false) =>
      $.ui.mount({
        plugin: 'tidy-turns',
        surface: 'terminal',
        component: 'ToolResult',
        props: { tool_use_id: 'a', tool: 'Bash', output: { stdout: 'a' }, isErrored },
      })

    const groupCall = (tool_use_id: string | undefined) => ({
      tool_use_id,
      tool: 'Read',
      input: { file_path: '/w/a.ts' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    })

    const mountGroup = ($: Engine, ids: Array<string | undefined>, isActive = true) =>
      $.ui.mount({
        plugin: 'tidy-turns',
        surface: 'terminal',
        component: 'ToolGroup',
        props: { calls: ids.map(groupCall), isActive, isExpanded: false },
      })

    // One assistant message of the running turn, its blocks in the order the model wrote them.
    const appendReply = ($: Engine, uuid: string, blocks: Block[]) =>
      $.session
        .append({
          message: {
            type: 'assistant',
            role: 'assistant',
            content: blocks.map(block =>
              block === 'note'
                ? { type: 'text', text: 'Checking the files.' }
                : { type: 'tool_use', id: block.callId, name: block.tool ?? 'Bash', input: block.input ?? { command: 'ls' } },
            ),
          } as unknown as Parameters<Engine['session']['append']>[0]['message'],
          door: 'response',
          origin: { kind: 'model', model: 'claude-opus-5-5' },
          uuid,
        })
        .catch(storeMissing)

    const callTool = ($: Engine, id: string, tool = 'Bash') =>
      $.tool.call({ tool, tool_use_id: id, command: 'ls' } as Parameters<Engine['tool']['call']>[0])

    // Keeps the call running until the returned function is called.
    const holdCall = ($: Engine, id: string) => {
      let release = () => {}
      heldCalls.set(id, new Promise<void>(resolve => (release = resolve)))
      const call = callTool($, id)

      return async () => {
        release()
        await call
      }
    }

    const startTurn = async ($: Engine, on: On, blocks: Block[]) => {
      stubEngine(on)
      await $.turn.start({ text: 'list files', turnId: 'live' })
      await appendReply($, 'live-a', blocks)
    }

    const finishTurn = ($: Engine) =>
      $.turn.complete({ answer: 'Done.', durationMs: 4200, isAborted: false, turnId: 'live', reason: 'answer' })

    test('draws a call after a note as one line under it, with the tool and its target', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
      const row = await mountCall($, 'a')

      expect(await linesOf(row)).toEqual(['  ⎿ Bash ls'])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
    })

    test('draws a call with no note before it as a bare line, without the ⎿', async ($, on) => {
      await startTurn($, on, [{ callId: 'a' }])
      await callTool($, 'a')

      expect(await linesOf(await mountCall($, 'a'))).toEqual(['⏺ Bash ls'])
    })

    test('names the tool and what it works on, one run per note', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a', tool: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a' } }])
      await appendReply($, 'live-b', ['note', { callId: 'b', tool: 'Grep', input: { pattern: 'todo', path: '/w' } }])
      await appendReply($, 'live-c', ['note', { callId: 'c', input: { command: 'cd /w\nls', description: 'go' } }])
      await appendReply($, 'live-d', ['note', { callId: 'd', tool: 'Skill', input: {} }])

      expect(await linesOf(await mountCall($, 'a'))).toEqual(['  ⎿ Edit ~/w/a.ts'])
      expect(await linesOf(await mountCall($, 'b'))).toEqual(['  ⎿ Grep todo'])
      expect(await linesOf(await mountCall($, 'c'))).toEqual(['  ⎿ Bash cd /w'])
      expect(await linesOf(await mountCall($, 'd'))).toEqual(['  ⎿ Skill'])
    })
    test('keeps a run of calls in one row that shows the latest, and hides the others', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }, { callId: 'b' }, { callId: 'c' }])
      await callTool($, 'a')
      await callTool($, 'b')
      await callTool($, 'c')

      expect(await linesOf(await mountCall($, 'a'))).toEqual(['  ⎿ Bash ls ▸ 3 calls'])
      expect(isHidden(await (await mountCall($, 'b')).drawn())).toBe(true)
      expect(isHidden(await (await mountCall($, 'c')).drawn())).toBe(true)
    })

    test('replaces the line with the call that is running now', async ($, on) => {
      await startTurn($, on, [
        'note',
        { callId: 'a', input: { command: 'first' } },
        { callId: 'b', input: { command: 'second' } },
      ])
      await callTool($, 'a')
      const release = holdCall($, 'b')
      const row = await mountCall($, 'a')

      expect(await linesOf(row)).toEqual(['  ⎿ Bash second ▸ 2 calls'])

      await release()
    })

    test('shows calls that run at once on a line each', async ($, on) => {
      await startTurn($, on, [
        'note',
        { callId: 'a', input: { command: 'first' } },
        { callId: 'b', input: { command: 'second' } },
      ])
      const releaseA = holdCall($, 'a')
      const releaseB = holdCall($, 'b')
      const row = await mountCall($, 'a')

      expect(await linesOf(row)).toEqual(['  ⎿ Bash first ▸ 2 calls', '    Bash second'])

      await releaseA()
      await releaseB()
    })

    test('opens on a click to every call of the run, and closes on a second', async ($, on) => {
      await startTurn($, on, [
        'note',
        { callId: 'a', input: { command: 'first' } },
        { callId: 'b', input: { command: 'second' } },
      ])
      await callTool($, 'a')
      await callTool($, 'b')
      const row = await mountCall($, 'a')

      await row.press({ key: 'tidy-turns:call:b' })
      expect(await linesOf(row)).toEqual(['  ⎿ Bash first ▾', '    Bash second'])

      await row.press({ key: 'tidy-turns:call:a' })
      expect(await linesOf(row)).toEqual(['  ⎿ Bash second ▸ 2 calls'])
    })

    test('starts a new row at each note', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await appendReply($, 'live-b', ['note', { callId: 'b' }])
      await callTool($, 'a')
      await callTool($, 'b')

      expect(await linesOf(await mountCall($, 'a'))).toEqual(['  ⎿ Bash ls'])
      expect(await linesOf(await mountCall($, 'b'))).toEqual(['  ⎿ Bash ls'])
    })

    test('starts a new row after a message sent while the turn runs', async ($, on) => {
      await startTurn($, on, [{ callId: 'a' }])
      await $.session
        .append({
          message: { type: 'attachment', name: 'queued_command', role: 'user', content: [{ type: 'text', text: 'also check the tests' }] } as unknown as Parameters<
            Engine['session']['append']
          >[0]['message'],
          door: 'attachment',
          origin: { kind: 'engine' },
          uuid: 'live-user',
        })
        .catch(storeMissing)
      await appendReply($, 'live-b', [{ callId: 'b' }, { callId: 'c' }])
      await callTool($, 'a')
      await callTool($, 'b')
      await callTool($, 'c')

      expect(await linesOf(await mountCall($, 'a'))).toEqual(['⏺ Bash ls'])
      expect(await linesOf(await mountCall($, 'b'))).toEqual(['⏺ Bash ls ▸ 2 calls'])
    })

    test('counts an advisor call, which the API runs itself, in the row of the calls around it', async ($, on) => {
      stubEngine(on)
      await $.turn.start({ text: 'list files', turnId: 'live' })
      await $.session
        .append({
          message: {
            type: 'assistant',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
              { type: 'server_tool_use', id: 'adv', name: 'advisor', input: {} },
              { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
            ],
          } as unknown as Parameters<Engine['session']['append']>[0]['message'],
          door: 'response',
          origin: { kind: 'model', model: 'claude-opus-5-5' },
          uuid: 'live-a',
        })
        .catch(storeMissing)
      await callTool($, 'a')
      await callTool($, 'b')

      expect(await linesOf(await mountCall($, 'a'))).toEqual(['⏺ Bash ls ▸ 3 calls'])
      expect(isHidden(await (await mountCall($, 'adv')).drawn())).toBe(true)
    })

    test('draws a failed call as a red line of its own and leaves it out of the row', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'fail' }, { callId: 'b' }, { callId: 'c' }])
      await callTool($, 'fail')
      await callTool($, 'b')
      await callTool($, 'c')

      const failed = await mountCall($, 'fail')
      expect(await linesOf(failed)).toEqual([])
      expect(await failed.find({ type: 'Text', text: '  ⎿ Bash ls · failed' })).toBeDefined()
      expect(await failed.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
      expect(await linesOf(await mountCall($, 'b'))).toEqual(['  ⎿ Bash ls ▸ 2 calls'])
      expect(isHidden(await (await mountCall($, 'c')).drawn())).toBe(true)
    })
    test('draws a call the engine marks errored or interrupted as a red line', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
      const draw = (overrides: object) =>
        $.ui.mount({
          plugin: 'tidy-turns',
          surface: 'terminal',
          component: 'ToolUse',
          props: { ...toolRow('a'), ...overrides },
        })

      expect(await (await draw({ isErrored: true })).find({ type: 'Text', text: '  ⎿ Bash ls · failed' })).toBeDefined()
      expect(await (await draw({ isInterrupted: true })).find({ type: 'Text', text: '  ⎿ Bash ls · interrupted' })).toBeDefined()
    })
    test('folds the row away with the turn', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }, { callId: 'b' }])
      await callTool($, 'a')
      await callTool($, 'b')
      const row = await mountCall($, 'a')
      expect(await linesOf(row)).toHaveLength(1)

      await finishTurn($)

      expect(isHidden(await row.drawn())).toBe(true)
    })

    test('hides the result block of a call, an error included', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])

      expect(isHidden(await (await mountResult($)).drawn())).toBe(true)
      expect(isHidden(await (await mountResult($, true)).drawn())).toBe(true)
    })
    test('opens a live group of calls into one row each', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      const group = await mountGroup($, ['a'])

      expect(await group.find({ type: 'Text', text: 'engine group expanded=true' })).toBeDefined()
    })

    test('leaves a group of a finished turn folded and a group it cannot place alone', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
      await finishTurn($)

      expect(isHidden(await (await mountGroup($, ['a'], false)).drawn())).toBe(true)
      expect(await (await mountGroup($, [undefined])).find({ type: 'Text', text: 'engine group expanded=false' })).toBeDefined()
    })

    test('leaves the desktop to the engine rows', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
      const row = await mountCall($, 'a', 'desktop')

      expect(await linesOf(row)).toEqual([])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    })

    test('draws the engine rows while the ctrl+o transcript is open', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
      await $.ui.mount({
        plugin: 'tidy-turns',
        surface: 'terminal',
        component: 'UserMessage',
        props: { text: 'list files', origin: { kind: 'composer' as const }, isExpanded: true },
      })
      const row = await mountCall($, 'a')

      expect(await linesOf(row)).toEqual([])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    })

    test('draws the engine rows when the setting is off', { options: { compactLiveCalls: false } }, async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
      const row = await mountCall($, 'a')

      expect(await linesOf(row)).toEqual([])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
      expect(isHidden(await (await mountResult($)).drawn())).toBe(false)
    })
  })
})
