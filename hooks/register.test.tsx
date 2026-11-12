import type { On, TurnStepChunk } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  ALL_ITEMS,
  SURFACES,
  TOOLING_ITEMS,
  type AppendedMessage,
  appendModelReply,
  appendText,
  callUntypedTool,
  completeSubagent,
  drawText,
  drawTool,
  finishTurn,
  heldCalls,
  isDrawnInOrder,
  isHidden,
  mountAnswer,
  mountPrompt,
  mountTool,
  runRichTurn,
  runSubagentTurn,
  runToolingTurn,
  runTurn,
  startSubagent,
  storeMissing,
  stubEngine,
  subagentMessage,
  subagentNotice,
  summaryRowText,
  type ToolCallArgs,
  toolRow,
} from './test-kit'

// The rich turn's summary rows, open, with every item on.
const RICH_TURN_ROWS = [
  ['activity', '├─ 6 tool calls · 2 reads · 1 command · 1 agent'],
  ['changes', '├─ 2 files changed'],
  ['usage', '├─ Haiku 4.5 · 1.2k tokens'],
  ['problems', '└─ 1 failed · interrupted'],
] as const

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
      const tool = await mountTool($, 't2-tool', surface)
      expect(isHidden(await tool.drawn())).toBe(false)

      await finishTurn($, 't2')

      expect(isHidden(await tool.drawn())).toBe(isFoldingSurface)
    })

    test(`puts the Worked for line above the final answer on ${surface}`, async ($, on) => {
      stubEngine(on)
      await runTurn($, 't5')
      await finishTurn($, 't5')

      const answer = await mountAnswer($, 'Found one file (t5).', surface)
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

  test('a subagent run inside a turn leaves the turn to fold to one answer', async ($, on) => {
    stubEngine(on)
    await runSubagentTurn($, 'main')

    expect(isHidden(await drawText($, 'Let me look (main).', 'terminal'))).toBe(true)
    expect(await (await mountAnswer($, 'Found one file (main).')).find({ key: 'tidy-turns:line' })).toBeDefined()
  })

  test("hides a subagent's finished notice and message, its turn's summary open or closed", async ($, on) => {
    stubEngine(on)
    await runSubagentTurn($, 'main')
    const notice = await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: subagentNotice('main') })
    const message = await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: subagentMessage('Found it (main).') })
    const stranger = await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: subagentMessage('Something else.') })

    expect(isHidden(await notice.drawn())).toBe(true)
    expect(isHidden(await message.drawn())).toBe(true)
    expect(isHidden(await stranger.drawn())).toBe(false)

    await (await mountAnswer($, 'Found one file (main).')).press({ key: 'tidy-turns:lead' })

    expect(isHidden(await notice.drawn())).toBe(true)
    expect(isHidden(await message.drawn())).toBe(true)
  })

  test("folds a subagent's message with the turn that ran it when it arrives after that turn", async ($, on) => {
    stubEngine(on)
    await $.turn.start({ text: 'look', turnId: 'early' })
    await startSubagent($, 'early-sub', 'early-agent')
    await callUntypedTool($, 'Agent', 'early-agent-call')
    await appendText($, 'early-a', 'Still looking (early).')
    await finishTurn($, 'early')
    await completeSubagent($, 'early-sub', 'early-agent', 'Found it late.')
    await $.turn.start({ text: 'Found it late.', turnId: 'late' })
    const message = await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: subagentMessage('Found it late.') })

    expect(isHidden(await message.drawn())).toBe(true)
  })

  test('shows every row while the ctrl+o transcript is open', async ($, on) => {
    stubEngine(on)
    await runTurn($, 't7')
    await finishTurn($, 't7')

    await mountPrompt($, 'list files', true)
    const tool = await mountTool($, 't7-tool')
    expect(isHidden(await tool.drawn())).toBe(false)

    await mountPrompt($, 'list files', false)
    expect(isHidden(await tool.drawn())).toBe(true)
  })

  test('opens the summary under the line as a tree, one group per row', { options: ALL_ITEMS }, async ($, on) => {
    stubEngine(on)
    await runRichTurn($, on, 's1')
    const answer = await mountAnswer($, 'Stopped (s1).')
    const row = (group: string) => summaryRowText(answer, group)

    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
    expect(await row('activity')).toBeUndefined()

    await answer.press({ key: 'tidy-turns:work' })

    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▾')
    for (const [group, text] of RICH_TURN_ROWS) {
      expect(await row(group)).toBe(text)
    }

    const drawn = JSON.stringify(await answer.drawn())
    const marks = RICH_TURN_ROWS.map(([group]) => `tidy-turns:row:${group}`)
    expect(isDrawnInOrder(drawn, marks)).toBe(true)
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
      const row = (group: string) => summaryRowText(answer, group)

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
    const row = (group: string) => summaryRowText(answer, group)

    for (const [group, text] of RICH_TURN_ROWS) {
      expect(await row(group)).toBe(text)
    }
  })

  test('shows no arrow when the turn has nothing to summarize or copy', async ($, on) => {
    stubEngine(on)

    // The answer alone: no item has a value, and there is no work to copy.
    await $.turn.start({ text: 'think', turnId: 't9' })
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

    const linesOf = async (row: Awaited<ReturnType<typeof mountTool>>) =>
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
      appendModelReply(
        $,
        uuid,
        blocks.map(block =>
          block === 'note'
            ? { type: 'text', text: 'Checking the files.' }
            : { type: 'tool_use', id: block.callId, name: block.tool ?? 'Bash', input: block.input ?? { command: 'ls' } },
        ),
      )

    const callTool = ($: Engine, id: string, tool = 'Bash') => $.tool.call({ tool, tool_use_id: id, command: 'ls' } as ToolCallArgs)

    // Runs the calls one after another, each to its end.
    const callTools = async ($: Engine, ...ids: string[]) => {
      for (const id of ids) {
        await callTool($, id)
      }
    }

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

    // A note, then call a running `first` and call b running `second`.
    const NOTE_THEN_FIRST_AND_SECOND: Block[] = ['note', { callId: 'a', input: { command: 'first' } }, { callId: 'b', input: { command: 'second' } }]

    const startTurn = async ($: Engine, on: On, blocks: Block[]) => {
      stubEngine(on)
      await $.turn.start({ text: 'list files', turnId: 'live' })
      await appendReply($, 'live-a', blocks)
    }

    // A running turn with a note, then call a, run to its end.
    const startNotedCall = async ($: Engine, on: On) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await callTool($, 'a')
    }

    const finishLiveTurn = ($: Engine) =>
      $.turn.complete({ answer: 'Done.', durationMs: 4200, isAborted: false, turnId: 'live', reason: 'answer' })

    test('draws a call after a note as one line under it, with the tool and its target', async ($, on) => {
      await startNotedCall($, on)
      const row = await mountTool($, 'a')

      expect(await linesOf(row)).toEqual(['  ⎿ Bash ls'])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
    })

    test('draws a call with no note before it as a bare line, without the ⎿', async ($, on) => {
      await startTurn($, on, [{ callId: 'a' }])
      await callTool($, 'a')

      expect(await linesOf(await mountTool($, 'a'))).toEqual(['⏺ Bash ls'])
    })

    test('names the tool and what it works on, one run per note', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a', tool: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a' } }])
      await appendReply($, 'live-b', ['note', { callId: 'b', tool: 'Grep', input: { pattern: 'todo', path: '/w' } }])
      await appendReply($, 'live-c', ['note', { callId: 'c', input: { command: 'cd /w\nls', description: 'go' } }])
      await appendReply($, 'live-d', ['note', { callId: 'd', tool: 'Skill', input: {} }])

      expect(await linesOf(await mountTool($, 'a'))).toEqual(['  ⎿ Edit ~/w/a.ts'])
      expect(await linesOf(await mountTool($, 'b'))).toEqual(['  ⎿ Grep todo'])
      expect(await linesOf(await mountTool($, 'c'))).toEqual(['  ⎿ Bash cd /w'])
      expect(await linesOf(await mountTool($, 'd'))).toEqual(['  ⎿ Skill'])
    })
    test('keeps a run of calls in one row that shows the latest, and hides the others', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }, { callId: 'b' }, { callId: 'c' }])
      await callTools($, 'a', 'b', 'c')

      expect(await linesOf(await mountTool($, 'a'))).toEqual(['  ⎿ Bash ls ▸ 3 calls'])
      expect(isHidden(await (await mountTool($, 'b')).drawn())).toBe(true)
      expect(isHidden(await (await mountTool($, 'c')).drawn())).toBe(true)
    })

    test('replaces the line with the call that is running now', async ($, on) => {
      await startTurn($, on, NOTE_THEN_FIRST_AND_SECOND)
      await callTool($, 'a')
      const release = holdCall($, 'b')
      const row = await mountTool($, 'a')

      expect(await linesOf(row)).toEqual(['  ⎿ Bash second ▸ 2 calls'])

      await release()
    })

    test('shows calls that run at once on a line each', async ($, on) => {
      await startTurn($, on, NOTE_THEN_FIRST_AND_SECOND)
      const releaseA = holdCall($, 'a')
      const releaseB = holdCall($, 'b')
      const row = await mountTool($, 'a')

      expect(await linesOf(row)).toEqual(['  ⎿ Bash first ▸ 2 calls', '    Bash second'])

      await releaseA()
      await releaseB()
    })

    test('opens on a click to every call of the run, and closes on a second', async ($, on) => {
      await startTurn($, on, NOTE_THEN_FIRST_AND_SECOND)
      await callTools($, 'a', 'b')
      const row = await mountTool($, 'a')

      await row.press({ key: 'tidy-turns:call:b' })
      expect(await linesOf(row)).toEqual(['  ⎿ Bash first ▾', '    Bash second'])

      await row.press({ key: 'tidy-turns:call:a' })
      expect(await linesOf(row)).toEqual(['  ⎿ Bash second ▸ 2 calls'])
    })

    test('starts a new row at each note', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'a' }])
      await appendReply($, 'live-b', ['note', { callId: 'b' }])
      await callTools($, 'a', 'b')

      expect(await linesOf(await mountTool($, 'a'))).toEqual(['  ⎿ Bash ls'])
      expect(await linesOf(await mountTool($, 'b'))).toEqual(['  ⎿ Bash ls'])
    })

    test('starts a new row after a message sent while the turn runs', async ($, on) => {
      await startTurn($, on, [{ callId: 'a' }])
      await $.session
        .append({
          message: { type: 'attachment', name: 'queued_command', role: 'user', content: [{ type: 'text', text: 'also check the tests' }] } as unknown as AppendedMessage,
          door: 'attachment',
          origin: { kind: 'engine' },
          uuid: 'live-user',
        })
        .catch(storeMissing)
      await appendReply($, 'live-b', [{ callId: 'b' }, { callId: 'c' }])
      await callTools($, 'a', 'b', 'c')

      expect(await linesOf(await mountTool($, 'a'))).toEqual(['⏺ Bash ls'])
      expect(await linesOf(await mountTool($, 'b'))).toEqual(['⏺ Bash ls ▸ 2 calls'])
    })

    test('counts an advisor call, which the API runs itself, in the row of the calls around it', async ($, on) => {
      stubEngine(on)
      await $.turn.start({ text: 'list files', turnId: 'live' })
      await appendModelReply($, 'live-a', [
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
        { type: 'server_tool_use', id: 'adv', name: 'advisor', input: {} },
        { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
      ])
      await callTools($, 'a', 'b')

      expect(await linesOf(await mountTool($, 'a'))).toEqual(['⏺ Bash ls ▸ 3 calls'])
      // Claude Code 2.1.322 raises no ui.render event for the advisor's row, so this
      // mount stands in for one it does not draw yet (README, Known limitations).
      expect(isHidden(await (await mountTool($, 'adv')).drawn())).toBe(true)
    })

    test('draws a failed call as a red line of its own and leaves it out of the row', async ($, on) => {
      await startTurn($, on, ['note', { callId: 'fail' }, { callId: 'b' }, { callId: 'c' }])
      await callTools($, 'fail', 'b', 'c')

      const failed = await mountTool($, 'fail')
      expect(await linesOf(failed)).toEqual([])
      expect((await failed.find({ type: 'Text', text: '  ⎿ Bash ls · failed' }))?.props.color).toBe('error')
      expect(await failed.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
      expect(await linesOf(await mountTool($, 'b'))).toEqual(['  ⎿ Bash ls ▸ 2 calls'])
      expect(isHidden(await (await mountTool($, 'c')).drawn())).toBe(true)
    })
    test('draws a call the engine marks errored or interrupted as a red line', async ($, on) => {
      await startNotedCall($, on)
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
      await callTools($, 'a', 'b')
      const row = await mountTool($, 'a')
      expect(await linesOf(row)).toHaveLength(1)

      await finishLiveTurn($)

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
      await startNotedCall($, on)
      await finishLiveTurn($)

      expect(isHidden(await (await mountGroup($, ['a'], false)).drawn())).toBe(true)
      expect(await (await mountGroup($, [undefined])).find({ type: 'Text', text: 'engine group expanded=false' })).toBeDefined()
      // A finished group with one call the plugin cannot place keeps the engine row too.
      expect(await (await mountGroup($, ['a', undefined], false)).find({ type: 'Text', text: 'engine group expanded=false' })).toBeDefined()
    })

    test('leaves the desktop to the engine rows', async ($, on) => {
      await startNotedCall($, on)
      const row = await mountTool($, 'a', 'desktop')

      expect(await linesOf(row)).toEqual([])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    })

    test('draws the engine rows while the ctrl+o transcript is open', async ($, on) => {
      await startNotedCall($, on)
      await mountPrompt($, 'list files', true)
      const row = await mountTool($, 'a')

      expect(await linesOf(row)).toEqual([])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    })

    test('draws the engine rows when the setting is off', { options: { compactLiveCalls: false } }, async ($, on) => {
      await startNotedCall($, on)
      const row = await mountTool($, 'a')

      expect(await linesOf(row)).toEqual([])
      expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
      expect(isHidden(await (await mountResult($)).drawn())).toBe(false)
    })
  })
})
