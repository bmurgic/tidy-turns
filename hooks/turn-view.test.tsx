import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { appendText, drawText, drawTool, isHidden, mountAnswer, storeMissing, stubEngine, subagentMessage } from './test-kit'

describe("an open turn's work", () => {
  type Block = { text: string } | { callId: string; command: string }

  const appendBlocks = ($: Engine, uuid: string, blocks: Block[]) =>
    $.session
      .append({
        message: {
          type: 'assistant',
          role: 'assistant',
          content: blocks.map(block =>
            'text' in block
              ? { type: 'text', text: block.text }
              : { type: 'tool_use', id: block.callId, name: 'Bash', input: { command: block.command } },
          ),
        } as unknown as Parameters<Engine['session']['append']>[0]['message'],
        door: 'response',
        origin: { kind: 'model', model: 'claude-opus-5-5' },
        uuid,
      })
      .catch(storeMissing)

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
    const start = { text: 'explore', turnId: 'w-sub', agentId: 'w-agent' }
    await $.turn.start(start as Omit<typeof start, 'agentId'>)
    const end = { answer: 'Found it (w).\nMore detail.', durationMs: 900, isAborted: false, turnId: 'w-sub', reason: 'answer', agentId: 'w-agent' } as const
    await $.turn.complete(end as Omit<typeof end, 'agentId'>)
    await appendText($, 'w-3', 'All done (w).')
    await $.turn.complete({ answer: 'All done (w).', durationMs: 4200, isAborted: false, turnId: 'w', reason: 'answer' })
  }

  const openAnswer = async ($: Engine) => {
    const answer = await mountAnswer($, 'All done (w).')
    await answer.press({ key: 'tidy-turns:lead' })

    return answer
  }

  const textOf = async (answer: Awaited<ReturnType<typeof mountAnswer>>, key: string) => (await answer.find({ key }))?.text

  // Claude Code pins the transcript to the prompt, so rows that grow above the
  // line leave it, and the pointer on it, where they were.
  test('draws the turn above its line in order: notes, their runs, the subagent, the tree, the line, then the answer', async ($, on) => {
    await runWorkTurn($, on)
    const answer = await openAnswer($)

    expect(await textOf(answer, 'tidy-turns:note:0')).toBe('⏺ First note.')
    expect(await textOf(answer, 'tidy-turns:call:w-b')).toBe('  ⎿ Bash second ▸ 2 calls')
    expect(await textOf(answer, 'tidy-turns:note:1')).toBe('⏺ Second note.')
    expect(await textOf(answer, 'tidy-turns:agent-answer:0')).toBe('› Found it (w).')

    const drawn = JSON.stringify(await answer.drawn())
    const order = [
      'tidy-turns:note:0',
      'tidy-turns:call:w-b',
      'tidy-turns:note:1',
      'tidy-turns:failed:w-fail',
      'tidy-turns:call:w-c',
      'tidy-turns:agent-answer:0',
      'tidy-turns:row:activity',
      'tidy-turns:line',
      'engine row',
    ].map(mark => drawn.indexOf(mark))
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true)
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

    expect(await answer.find({ type: 'Text', text: '  ⎿ Bash false · failed' })).toBeDefined()
    expect(await textOf(answer, 'tidy-turns:call:w-c')).toBe('  ⎿ Bash third')
  })

  test('keeps the rows above the line hidden while the copy shows', async ($, on) => {
    await runWorkTurn($, on)
    await openAnswer($)
    const message = await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: subagentMessage('Found it (w).\nMore detail.') })

    expect(isHidden(await drawTool($, 'w-a', 'terminal'))).toBe(true)
    expect(isHidden(await drawText($, 'First note.', 'terminal'))).toBe(true)
    expect(isHidden(await message.drawn())).toBe(true)
  })

  test('closing the line removes the copy', async ($, on) => {
    await runWorkTurn($, on)
    const answer = await openAnswer($)

    await answer.press({ key: 'tidy-turns:lead' })

    expect(await answer.find({ key: 'tidy-turns:note:0' })).toBeUndefined()
    expect(await answer.find({ key: 'tidy-turns:call:w-b' })).toBeUndefined()
    expect((await answer.find({ key: 'tidy-turns:work' }))?.text).toBe(' ▸')
  })

  test('draws the engine answer row alone while the ctrl+o transcript is open', async ($, on) => {
    await runWorkTurn($, on)
    await openAnswer($)
    const prompt = (isExpanded: boolean) => ({ text: 'look around', origin: { kind: 'composer' as const }, isExpanded })
    await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: prompt(true) })
    const answer = await mountAnswer($, 'All done (w).')

    expect(await answer.find({ key: 'tidy-turns:note:0' })).toBeUndefined()
    expect(await answer.find({ key: 'tidy-turns:line' })).toBeUndefined()
    expect(await answer.find({ type: 'Text', text: 'engine row' })).toBeDefined()

    await $.ui.mount({ plugin: 'tidy-turns', surface: 'terminal', component: 'UserMessage', props: prompt(false) })
  })
})

