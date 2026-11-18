import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { appendModelReply, appendText, completeSubagent, finishTurn, isDrawnInOrder, mountAnswer, mountPrompt, runTurn, startSubagent, stubEngine } from './test-kit'

describe("an open turn's work", () => {
  type Block = { text: string } | { callId: string; command: string }

  const appendBlocks = ($: Engine, uuid: string, blocks: Block[]) =>
    appendModelReply(
      $,
      uuid,
      blocks.map(block =>
        'text' in block ? { type: 'text', text: block.text } : { type: 'tool_use', id: block.callId, name: 'Bash', input: { command: block.command } },
      ),
    )

  // A note over two calls, a second note over a failed call and one more, an
  // Explore subagent, then the answer. The call with "fail" in its id fails.
  const runWorkTurn = async ($: Engine, on: On) => {
    stubEngine(on)
    await $.turn.start({ text: 'look around', turnId: 'w' })
    await appendBlocks($, 'w-1', [{ text: 'First note.' }, { callId: 'w-a', command: 'first' }, { callId: 'w-b', command: 'second' }])
    await $.tool.call({ tool: 'Bash', tool_use_id: 'w-a', command: 'first' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'w-b', command: 'second' })
    await appendBlocks($, 'w-2', [{ text: 'Second note.' }, { callId: 'w-fail', command: 'false' }, { callId: 'w-c', command: 'third' }])
    await $.tool.call({ tool: 'Bash', tool_use_id: 'w-fail', command: 'false' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'w-c', command: 'third' })
    await startSubagent($, 'w-sub', 'w-agent')
    await completeSubagent($, 'w-sub', 'w-agent', 'Found it (w).\nMore detail.')
    await appendText($, 'w-3', 'All done (w).')
    await $.turn.complete({ answer: 'All done (w).', durationMs: 4200, isAborted: false, turnId: 'w', reason: 'answer' })
  }

  const openAnswer = async ($: Engine) => {
    const answer = await mountAnswer($, 'All done (w).')
    await answer.press({ key: 'tidy-turns:lead' })

    return answer
  }

  // Every summary item off, so the line has no summary rows.
  const NO_ITEMS = {
    showToolCount: false,
    showToolKinds: false,
    showSubagents: false,
    showFilesChanged: false,
    showFailures: false,
    showEndReason: false,
    showSessionTools: false,
    showTokens: false,
    showModel: false,
    showSkills: false,
    showToolSearches: false,
    showMcpCalls: false,
  }

  const textOf = async (answer: Awaited<ReturnType<typeof mountAnswer>>, key: string) => (await answer.find({ key }))?.text

  test('draws the turn below the tree in order: notes, their runs, the subagent, then the answer', async ($, on) => {
    await runWorkTurn($, on)
    const answer = await openAnswer($)

    expect(await textOf(answer, 'tidy-turns:note:0')).toBe('⏺ First note.')
    expect(await textOf(answer, 'tidy-turns:call:w-b')).toBe('  ⎿ Bash second ▸ 2 calls')
    expect(await textOf(answer, 'tidy-turns:note:1')).toBe('⏺ Second note.')
    expect(await textOf(answer, 'tidy-turns:agent-answer:0')).toBe('› Found it (w).')
    // The answer row draws the answer itself, so the copy leaves it out.
    expect(await answer.find({ key: 'tidy-turns:note:2' })).toBeUndefined()

    const drawn = JSON.stringify(await answer.drawn())
    const marks = [
      'tidy-turns:row:activity',
      'tidy-turns:note:0',
      'tidy-turns:call:w-b',
      'tidy-turns:note:1',
      'tidy-turns:failed:w-fail',
      'tidy-turns:call:w-c',
      'tidy-turns:agent-answer:0',
      'engine row',
    ]
    expect(isDrawnInOrder(drawn, marks)).toBe(true)
  })

  test('opens a run of the copy to every call on a click, and closes it on a second', async ($, on) => {
    await runWorkTurn($, on)
    const answer = await openAnswer($)

    await answer.press({ key: 'tidy-turns:call:w-b' })
    expect(await textOf(answer, 'tidy-turns:call:w-a')).toBe('  ⎿ Bash first ▾')
    expect(await textOf(answer, 'tidy-turns:call:w-b')).toBe('    Bash second')

    await answer.press({ key: 'tidy-turns:call:w-a' })
    expect(await textOf(answer, 'tidy-turns:call:w-b')).toBe('  ⎿ Bash second ▸ 2 calls')
    expect(await answer.find({ key: 'tidy-turns:call:w-a' })).toBeUndefined()
  })

  test('draws a failed call of the copy as a red line and leaves it out of its run', async ($, on) => {
    await runWorkTurn($, on)
    const answer = await openAnswer($)

    expect((await answer.find({ type: 'Text', text: '  ⎿ Bash false · failed' }))?.props.color).toBe('error')
    expect(await textOf(answer, 'tidy-turns:call:w-c')).toBe('  ⎿ Bash third')
  })

  test('closing the line removes the copy', async ($, on) => {
    await runWorkTurn($, on)
    const answer = await openAnswer($)

    await answer.press({ key: 'tidy-turns:lead' })

    expect(await answer.find({ key: 'tidy-turns:note:0' })).toBeUndefined()
    expect(await answer.find({ key: 'tidy-turns:call:w-b' })).toBeUndefined()
    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
  })

  test(
    'opens the work with every summary item off, drawing the copy and no tree',
    { options: NO_ITEMS },
    async ($, on) => {
      await runWorkTurn($, on)
      const answer = await mountAnswer($, 'All done (w).')

      expect(await textOf(answer, 'tidy-turns:work')).toBe(' ▸')

      await answer.press({ key: 'tidy-turns:lead' })

      expect(await textOf(answer, 'tidy-turns:note:0')).toBe('⏺ First note.')
      expect(JSON.stringify(await answer.drawn())).not.toContain('tidy-turns:row:')
    },
  )

  test('shows no arrow with every summary item off while folding is off, since the work already shows above', { options: NO_ITEMS }, async ($, on) => {
    await runWorkTurn($, on)
    await $.command.run({ command: 'tidy-turns', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    const answer = await mountAnswer($, 'All done (w).')

    expect(await answer.find({ type: 'Text', text: /^✻ [A-Z][a-zé]+ for 4s$/ })).toBeDefined()
    expect(await answer.find({ key: 'tidy-turns:work' })).toBeUndefined()
    expect(await answer.find({ type: 'Button' })).toBeUndefined()
  })

  test('shows the end time on the plain line of a turn with nothing to open', { options: NO_ITEMS }, async ($, on) => {
    await runWorkTurn($, on)
    await $.command.run({ command: 'tidy-turns', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    const answer = await mountAnswer($, 'All done (w).')

    expect((await answer.find({ key: 'tidy-turns:time' }))?.text).toBe('2:41 PM')
    expect((await answer.find({ type: 'Text', text: '2:41 PM' }))?.props.dimColor).toBe(true)
    expect(await answer.find({ type: 'Button' })).toBeUndefined()
    expect((await answer.find({ key: 'tidy-turns:line' }))?.props.width).toBe(76)
  })

  test('leaves the copy out while folding is off, since the rows above already show the work', async ($, on) => {
    await runWorkTurn($, on)
    await $.command.run({ command: 'tidy-turns', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    const answer = await openAnswer($)

    expect(await answer.find({ key: 'tidy-turns:row:activity' })).toBeDefined()
    expect(await answer.find({ key: 'tidy-turns:note:0' })).toBeUndefined()
  })

  test('draws the engine answer row alone while the ctrl+o transcript is open', async ($, on) => {
    await runWorkTurn($, on)
    await openAnswer($)
    await mountPrompt($, 'look around', true)
    const answer = await mountAnswer($, 'All done (w).')

    expect(await answer.find({ key: 'tidy-turns:note:0' })).toBeUndefined()
    expect(await answer.find({ key: 'tidy-turns:line' })).toBeUndefined()
    expect(await answer.find({ type: 'Text', text: 'engine row' })).toBeDefined()

    await mountPrompt($, 'look around', false)
  })
})


describe('the end time at the right of the line', () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000

  const finishedAnswer = async ($: Engine, on: On, columns?: number) => {
    stubEngine(on)
    await runTurn($, 't')
    await finishTurn($, 't')

    return mountAnswer($, 'Found one file (t).', 'terminal', columns === undefined ? undefined : { columns, rows: 30 })
  }

  test('shows the local time the answer finished, the line stretched to the right margin', async ($, on) => {
    const answer = await finishedAnswer($, on)
    const line = await answer.find({ key: 'tidy-turns:line' })

    expect((await answer.find({ key: 'tidy-turns:time' }))?.text).toBe('2:41 PM')
    expect(line?.props.width).toBe(76)
    expect(line?.props.justifyContent).toBe('space-between')
  })

  test('adds the date once the day has passed', async ($, on) => {
    const clock = stubEngine(on)
    await runTurn($, 't')
    await finishTurn($, 't')
    await clock.advance(ONE_DAY_MS)
    const answer = await mountAnswer($, 'Found one file (t).')

    expect((await answer.find({ key: 'tidy-turns:time' }))?.text).toBe('Nov 18 2:41 PM')
  })

  test('opens and closes the turn on a click, dim while closed and bright while open', async ($, on) => {
    const answer = await finishedAnswer($, on)

    expect((await answer.find({ key: 'tidy-turns:time' }))?.props.dimColor).toBe(true)

    await answer.press({ key: 'tidy-turns:time' })

    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▾')
    expect((await answer.find({ key: 'tidy-turns:time' }))?.props.dimColor).toBe(false)

    await answer.press({ key: 'tidy-turns:time' })

    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
  })

  test('drops the time on a terminal too narrow for it, so the line never wraps', async ($, on) => {
    const wide = await finishedAnswer($, on)
    const lead = (await wide.find({ key: 'tidy-turns:lead' }))?.text ?? ''
    // ✻ and a space, the lead, the arrow, one space, the time, and the right margin.
    const fitColumns = 2 + lead.length + 2 + 1 + '2:41 PM'.length + 4
    const fits = await mountAnswer($, 'Found one file (t).', 'terminal', { columns: fitColumns, rows: 30 })
    const tooNarrow = await mountAnswer($, 'Found one file (t).', 'terminal', { columns: fitColumns - 1, rows: 30 })

    expect((await fits.find({ key: 'tidy-turns:time' }))?.text).toBe('2:41 PM')
    expect(await tooNarrow.find({ key: 'tidy-turns:time' })).toBeUndefined()
    expect((await tooNarrow.find({ key: 'tidy-turns:lead' }))?.text).toBe(lead)
  })

  test('draws the line as before for a turn stored without an end time', async ($, on) => {
    // Stores each turn without endedAt, as the version before this one did.
    on('state.set', { plugin: 'tidy-turns', key: 'turns' }, (_$, e, next) =>
      next({ ...e, value: Object.fromEntries(Object.entries(e.value).map(([turnId, { endedAt: _endedAt, ...turn }]) => [turnId, turn])) }),
    )
    const answer = await finishedAnswer($, on)
    const line = await answer.find({ key: 'tidy-turns:line' })

    expect(await answer.find({ key: 'tidy-turns:time' })).toBeUndefined()
    expect(line?.props.width).toBeUndefined()
    expect(line?.text).toBe(`✻ ${(await answer.find({ key: 'tidy-turns:lead' }))?.text} ▸`)
  })
})
