import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, MatchedHook, Register, RenderViewport, ResolveInput, TurnCompleteInput, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { Turn } from '../types'
import { describeVerb, readSettings, type Settings, summaryGroups } from './summary'
import { answeredTurnId, agentOwnerId, findCall, isFoldedText, isFoldedTool, runCalls, subagentRowTurnId } from './turn-queries'
import { addOnce, addReplyBlocks, addStreamedCall, EMPTY_TURN, type StreamPlace, endedCallChange, replyBlocks, withCallState, withoutStreamedCalls } from './turn-record'
import { DEFAULT_COLUMNS, drawAnswerLine, drawFailedCall, drawRun, drawTurnCopy, hasTurnWork } from './turn-view'

const turns = atom({ plugin: 'tidy-turns', key: 'turns' } as const, {})
const runningTurnId = atom({ plugin: 'tidy-turns', key: 'runningTurnId' } as const, null)
const isFolding = atom({ plugin: 'tidy-turns', key: 'isFolding' } as const, true)
const openTurnIds = atom({ plugin: 'tidy-turns', key: 'openTurnIds' } as const, [])
const openRunIds = atom({ plugin: 'tidy-turns', key: 'openRunIds' } as const, [])

// Claude Code's own past-tense turn verbs, as its 2.1.286 build lists them.
const VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']

const randomIndex = (length: number) => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % length

const pickVerb = () => VERBS[randomIndex(VERBS.length)] ?? 'Worked'

const debug = ($: EngineInterface, text: string) => $.ui.log(`tidy-turns: ${text}`, { to: 'debug' })

// A turn not yet stored starts empty.
const changeTurn = ($: EngineInterface, turnId: string, change: (turn: Turn) => Turn) =>
  update($, turns, all => ({ ...all, [turnId]: change(all[turnId] ?? EMPTY_TURN) }))

const addToRunningTurn = async ($: EngineInterface, change: (turn: Turn) => Turn) => {
  const turnId = await read($, runningTurnId)

  if (turnId === null) {
    return
  }

  await changeTurn($, turnId, change)
}

// The desktop app wraps each row in its own header and expander, so a hidden row
// there leaves the header over a blank body. The row hooks match the terminal only.
const TERMINAL = 'terminal'

// What a row hook draws in place of a row it folds away.
const drawHidden = ($: EngineInterface, e: ResolveInput) => {
  const { Box } = $.ui.resolve(e)

  return <Box display="none" />
}

// The width a drawing fits its lines to; DEFAULT_COLUMNS where no surface has measured.
const columnsOf = (e: { viewport?: RenderViewport }) => e.viewport?.columns ?? DEFAULT_COLUMNS

// The event and next of a ui.render hook on the rows `Row` matches. A row hook that
// reads the settings takes them as a fourth argument, from a function literal in
// register: the engine accepts only a function literal or a name as a hook.
type RowEvent<Row> = Parameters<MatchedHook<'ui.render', Row>>[1]

type RowNext<Row> = Parameters<MatchedHook<'ui.render', Row>>[2]

const toggleId = (ids: string[], id: string) => (ids.includes(id) ? ids.filter(other => other !== id) : [...ids, id])

// A click on a Worked for line opens or closes that turn's summary alone. Each
// toggle names its own atom: the engine's scan of the module reads the state it
// writes off each update call.
const toggleSummary = async ($: EngineInterface, turnId: string) => {
  await update($, openTurnIds, ids => toggleId(ids, turnId))
  $.ui.invalidate('ui.render')
}

// A click on a run's row opens it to every call, or closes it again.
const toggleRun = async ($: EngineInterface, runId: string) => {
  await update($, openRunIds, ids => toggleId(ids, runId))
  $.ui.invalidate('ui.render')
}

// True while the ctrl+o transcript shows. No event says so; the person's prompt
// row draws again with isExpanded set, so its hook records the view here (a
// drawing may not write $.state) and redraws the rows that read it.
let isDetailedView = false

const isFoldingNow = async ($: EngineInterface) => !isDetailedView && (await read($, isFolding))

// Adds a model request's output tokens to the running turn, and the main loop's
// model, once the request's response is whole.
const recordUsage = async ($: EngineInterface, isMainLoop: boolean, result: TurnStepResult) => {
  const usage = result.usage

  if (usage === null) {
    return
  }

  await addToRunningTurn($, turn => ({
    ...turn,
    outputTokens: turn.outputTokens + usage.output_tokens,
    model: isMainLoop ? usage.model : turn.model,
  }))
}

// The pieces of one text block the step holds back; index -1 holds none.
type HeldText = { index: number; text: string }

function* releaseHeld(held: HeldText): Generator<TurnStepChunk> {
  if (held.index !== -1 && held.text.length > 0) {
    yield { kind: 'text', index: held.index, text: held.text }
  }

  held.index = -1
  held.text = ''
}

const showCommand: Hook<'session.start'> = async ($, e, next) => {
  await $.command.register({
    name: 'tidy-turns',
    description: 'Toggle folding of finished turns down to their final answer',
  })

  return next(e)
}

const toggleFolding: MatchedHook<'command.run', { command: 'tidy-turns' }> = async $ => {
  const isOn = !(await read($, isFolding))
  await update($, isFolding, () => isOn)
  $.ui.invalidate('ui.render')

  return { text: `Turn folding ${isOn ? 'on' : 'off'}.` }
}

// A subagent's run raises its own turn.start; it stays part of the main turn.
const recordTurnStart: Hook<'turn.start'> = async ($, e, next) => {
  if (e.agentId !== undefined) {
    const agentId = e.agentId
    await addToRunningTurn($, turn => ({ ...turn, spawnedAgentIds: addOnce(turn.spawnedAgentIds, agentId) }))

    return next(e)
  }

  await update($, runningTurnId, () => e.turnId)
  await update($, turns, all => ({ ...all, [e.turnId]: EMPTY_TURN }))
  debug($, `turn.start ${e.turnId}`)

  return next(e)
}

// Marks a main-loop call running while it runs, and records it once it ends.
const trackToolCall: Hook<'tool.call'> = async ($, e, next) => {
  if (e.agentId === undefined) {
    await addToRunningTurn($, turn => ({ ...turn, calls: withCallState(turn.calls, e.tool_use_id, 'running') }))
    $.ui.invalidate('ui.render')
  }

  const result = await next(e)
  await addToRunningTurn($, endedCallChange(e, result))
  $.ui.invalidate('ui.render')

  return result
}

const RESPONSE_DOOR = { door: 'response' } as const

const recordReply: MatchedHook<'session.append', typeof RESPONSE_DOOR> = async ($, e, next) => {
  if (e.agentId === undefined && Array.isArray(e.message.content)) {
    const blocks = replyBlocks(e.message.content)

    if (blocks.length > 0) {
      const projectRoot = await $.session.root().catch(() => '')
      await addToRunningTurn($, turn => addReplyBlocks(turn, blocks, projectRoot))
      $.ui.invalidate('ui.render')
    }
  }

  return next(e)
}

const recordTurnComplete: Hook<'turn.complete'> = async ($, e, next) => {
  if (e.agentId === undefined) {
    await finishRunningTurn($, e)
  } else {
    await recordSubagentAnswer($, e.agentId, e.answer.trim())
  }

  return next(e)
}

// A subagent can answer after the turn that ran it has ended.
const recordSubagentAnswer = async ($: EngineInterface, agentId: string, answer: string) => {
  const ownerId = agentOwnerId(await read($, turns), agentId)

  if (answer !== '' && ownerId !== undefined) {
    await changeTurn($, ownerId, owner => ({ ...owner, agentAnswers: [...owner.agentAnswers, answer] }))
    $.ui.invalidate('ui.render')
  }
}

const finishRunningTurn = async ($: EngineInterface, e: TurnCompleteInput) => {
  const verb = pickVerb()
  await changeTurn($, e.turnId, turn => ({ ...withoutStreamedCalls(turn), durationMs: e.durationMs, verb, endReason: e.reason }))
  await update($, runningTurnId, () => null)

  const turn = (await read($, turns))[e.turnId]
  const lastText = turn?.texts.at(-1) ?? ''
  debug(
    $,
    `turn.complete ${e.turnId} reason=${e.reason} tools=${turn?.toolIds.length} texts=${turn?.texts.length} ` +
      `answerMatchesLastText=${e.answer.trim() === lastText}`,
  )
}

// Records a main-loop call the model has begun to write, before the engine draws
// its row, so the row joins the run above at once instead of showing below it
// bare until the reply is stored.
const recordStreamedCall = async ($: EngineInterface, id: string, tool: string, place: StreamPlace) => {
  await addToRunningTurn($, turn => addStreamedCall(turn, id, tool, place))
  $.ui.invalidate('ui.render')
  debug($, `streamed call ${tool} ${id} hasText=${place.hasText} isAfterCall=${place.isAfterCall}`)
}

// A piece of a note to the person: visible text, or thinking with text, which
// Opus 5.5 writes as a note that Claude Code draws marked · summary. Hidden
// thinking streams blank.
const isNoteChunk = (chunk: TurnStepChunk) => (chunk.kind === 'text' || chunk.kind === 'thinking') && chunk.text.trim() !== ''

// Holds each text block's pieces and lets it out whole, when the next chunk of
// another kind arrives or the response ends, so a message appears done at once.
// On the main loop it records each call as it begins, and first drops the calls
// an earlier response began whose reply never came.
const releaseWholeTextBlocks: Hook<'turn.step'> = async function* ($, e, next) {
  const isMainLoop = e.agentId === undefined
  const held: HeldText = { index: -1, text: '' }
  const place: StreamPlace = { hasText: false, isAfterCall: false }

  if (isMainLoop) {
    await addToRunningTurn($, withoutStreamedCalls)
  }

  const stream = next(e)

  for (;;) {
    const step = await stream.next()

    if (step.done) {
      yield* releaseHeld(held)
      await recordUsage($, isMainLoop, step.value)

      return step.value
    }

    const chunk = step.value

    if (isNoteChunk(chunk)) {
      place.hasText = true
      place.isAfterCall = false
    }

    if (chunk.kind === 'text') {
      if (chunk.index !== held.index) {
        yield* releaseHeld(held)
        held.index = chunk.index
      }

      held.text += chunk.text
      continue
    }

    yield* releaseHeld(held)

    if (isMainLoop && chunk.kind === 'tool') {
      await recordStreamedCall($, chunk.id, chunk.name, { ...place })
      place.hasText = false
      place.isAfterCall = true
    }

    yield chunk
  }
}

const USER_MESSAGE_ROW = { component: 'UserMessage', surface: TERMINAL } as const

// Records whether the ctrl+o transcript shows. A subagent's finished notice and its
// message to the main loop belong to the turn that ran it: they fold with the turn
// and stay hidden while its summary is open, since the copy under the line shows
// the message there.
const hideSubagentRows: MatchedHook<'ui.render', typeof USER_MESSAGE_ROW> = async ($, e, next) => {
  if (e.props.origin.kind === 'composer' && e.props.isExpanded !== isDetailedView) {
    isDetailedView = e.props.isExpanded
    debug($, `detailed view ${isDetailedView ? 'open' : 'closed'}`)
    $.ui.invalidate('ui.render')
  }

  if (isDetailedView || !(await read($, isFolding))) {
    return next(e)
  }

  const turnId = subagentRowTurnId(await read($, turns), e.props)

  if (turnId === undefined) {
    return next(e)
  }

  return drawHidden($, e)
}

const TOOL_USE_ROW = { component: 'ToolUse', surface: TERMINAL } as const

// A finished turn's calls fold away. The calls of the running turn between two
// notes share one row, which shows the call running now and opens on a click to
// every call. A call that failed or was cut short gets a red line of its own, so
// a problem never hides in the row; its output is never drawn.
const drawToolUse = async ($: EngineInterface, e: RowEvent<typeof TOOL_USE_ROW>, next: RowNext<typeof TOOL_USE_ROW>, settings: Settings) => {
  const all = await read($, turns)

  if (!(await isFoldingNow($))) {
    return next(e)
  }

  const ui = $.ui.resolve(e)
  const columns = columnsOf(e)

  if (isFoldedTool(all, e.props.tool_use_id)) {
    debug($, `fold ToolUse ${e.props.tool} ${e.props.tool_use_id} on ${e.surface}`)

    return drawHidden($, e)
  }

  const call = findCall(all, e.props.tool_use_id)

  if (call?.isStreamed === true) {
    debug($, `draw ToolUse ${call.tool} ${call.id} while the model writes it`)
  }

  if (!settings.compactLiveCalls || call === undefined) {
    return next(e)
  }

  if (call.state === 'failed' || e.props.isErrored || e.props.isInterrupted) {
    return drawFailedCall(ui, call, e.props.isInterrupted ? ' · interrupted' : ' · failed', columns)
  }

  const run = runCalls(all, call)

  if (run[0]?.id !== call.id) {
    return drawHidden($, e)
  }

  const isOpen = (await read($, openRunIds)).includes(call.runId)

  return drawRun(ui, { run, isOpen, onToggle: () => toggleRun($, call.runId), columns })
}

// The one line stands for the call, so its output draws nothing: the result, an
// error's text included, and the hint under a running call, such as "ctrl+b to run
// in background".
const isCallOutputHidden = async ($: EngineInterface, toolUseId: string, settings: Settings) => {
  const all = await read($, turns)

  if (!(await isFoldingNow($))) {
    return false
  }

  return isFoldedTool(all, toolUseId) || settings.compactLiveCalls
}

const TOOL_RESULT_ROW = { component: 'ToolResult', surface: TERMINAL } as const

const hideToolResult = async ($: EngineInterface, e: RowEvent<typeof TOOL_RESULT_ROW>, next: RowNext<typeof TOOL_RESULT_ROW>, settings: Settings) => {
  if (await isCallOutputHidden($, e.props.tool_use_id, settings)) {
    return drawHidden($, e)
  }

  return next(e)
}

const TOOL_PROGRESS_ROW = { component: 'ToolProgress', surface: TERMINAL } as const

const hideToolProgress = async ($: EngineInterface, e: RowEvent<typeof TOOL_PROGRESS_ROW>, next: RowNext<typeof TOOL_PROGRESS_ROW>, settings: Settings) => {
  if (await isCallOutputHidden($, e.props.tool_use_id, settings)) {
    return drawHidden($, e)
  }

  return next(e)
}

const TOOL_GROUP_ROW = { component: 'ToolGroup', surface: TERMINAL } as const

// A run of reads and searches folds into one count line; a live run opens into
// one ToolUse row per call, so each gets its own line. A finished turn's run
// folds away. A run with a call the plugin cannot place keeps the engine's row.
const drawToolGroup = async ($: EngineInterface, e: RowEvent<typeof TOOL_GROUP_ROW>, next: RowNext<typeof TOOL_GROUP_ROW>, settings: Settings) => {
  const all = await read($, turns)
  const knownIds = e.props.calls.flatMap(call => (call.tool_use_id === undefined ? [] : [call.tool_use_id]))
  const isEveryIdKnown = knownIds.length === e.props.calls.length
  const isFolded = isEveryIdKnown && knownIds.every(id => isFoldedTool(all, id))

  if (!isEveryIdKnown) {
    debug($, `ToolGroup on ${e.surface} has calls without tool_use_id`)
  }

  if (!(await isFoldingNow($)) || e.props.isExpanded) {
    return next(e)
  }

  if (isFolded && !e.props.isActive) {
    return drawHidden($, e)
  }

  if (isEveryIdKnown && !isFolded && settings.compactLiveCalls) {
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  }

  return next(e)
}

const ASSISTANT_MESSAGE_ROW = { component: 'AssistantMessage', surface: TERMINAL } as const

// A finished turn's notes fold away. Its answer draws under the Worked for line and
// the summary, and while the summary is open, under the copy of the turn's work.
const drawAnswer = async ($: EngineInterface, e: RowEvent<typeof ASSISTANT_MESSAGE_ROW>, next: RowNext<typeof ASSISTANT_MESSAGE_ROW>, settings: Settings) => {
  const all = await read($, turns)

  // The ctrl+o transcript draws every row as the engine does.
  if (isDetailedView) {
    return next(e)
  }

  const isFoldingOn = await read($, isFolding)
  const ui = $.ui.resolve(e)

  if (isFoldingOn && isFoldedText(all, e.props.text)) {
    return drawHidden($, e)
  }

  const turnId = answeredTurnId(all, e.props.text)
  const turn = turnId === undefined ? undefined : all[turnId]

  if (turnId === undefined || turn === undefined) {
    return next(e)
  }

  // The rows above the line stay folded while its summary is open.
  const isOpen = (await read($, openTurnIds)).includes(turnId)
  const summary = drawAnswerLine(ui, {
    lead: describeVerb(turn),
    rows: summaryGroups(turn, settings),
    hasWork: isFoldingOn && hasTurnWork(turn),
    isOpen,
    onToggle: () => toggleSummary($, turnId),
  })

  // Open, the turn's work draws under the tree, the way it looked while it ran.
  // With folding off its rows still show above, so there is nothing to copy.
  const copy = isOpen && isFoldingOn
    ? drawTurnCopy(ui, {
        turn,
        openRunIds: await read($, openRunIds),
        onToggleRun: runId => toggleRun($, runId),
        columns: columnsOf(e),
      })
    : null

  return (
    <ui.Box flexDirection="column" marginTop={1}>
      {summary}
      {copy}
      {await next(e)}
    </ui.Box>
  )
}

// No surface: the desktop draws its own turn footer and raises no TurnDuration.
const TURN_DURATION_ROW = { component: 'TurnDuration' } as const

// The Worked for line sits above the answer instead.
const hideTurnDuration: MatchedHook<'ui.render', typeof TURN_DURATION_ROW> = async ($, e, next) => {
  if (!(await isFoldingNow($))) {
    return next(e)
  }

  return drawHidden($, e)
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', showCommand)
  // Inline, so the engine's pre-load scan reads it as the module's own command.
  on('command.run', { command: 'tidy-turns' }, toggleFolding)
  on('turn.start', recordTurnStart)
  on('tool.call', trackToolCall)
  on('session.append', RESPONSE_DOOR, recordReply)

  // A message sent while the turn runs arrives as a queued_command attachment. It
  // ends the run before it, so the next call opens a new row below the message
  // instead of joining the one above.
  for (const door of ['prompt', 'attachment'] as const) {
    on('session.append', { door }, async ($, e, next) => {
      if (e.agentId === undefined && (door === 'prompt' || e.message.name === 'queued_command')) {
        await addToRunningTurn($, turn => ({ ...turn, isAfterText: true }))
      }

      return next(e)
    })
  }

  on('turn.complete', recordTurnComplete)
  on('turn.step', releaseWholeTextBlocks)
  on('ui.render', USER_MESSAGE_ROW, hideSubagentRows)
  on('ui.render', TOOL_USE_ROW, ($, e, next) => drawToolUse($, e, next, settings))
  on('ui.render', TOOL_RESULT_ROW, ($, e, next) => hideToolResult($, e, next, settings))
  on('ui.render', TOOL_PROGRESS_ROW, ($, e, next) => hideToolProgress($, e, next, settings))
  on('ui.render', TOOL_GROUP_ROW, ($, e, next) => drawToolGroup($, e, next, settings))
  on('ui.render', ASSISTANT_MESSAGE_ROW, ($, e, next) => drawAnswer($, e, next, settings))
  on('ui.render', TURN_DURATION_ROW, hideTurnDuration)
}
