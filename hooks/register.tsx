import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderViewport, ResolveInput, ToolCallInput, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { LiveCall, Turn, Turns } from '../types'
import { describeVerb, readSettings, summaryGroups } from './summary'
import { DEFAULT_COLUMNS, drawAnswerLine, drawFailedCall, drawRun, drawTurnCopy } from './turn-view'

const turns = atom({ plugin: 'tidy-turns', key: 'turns' } as const, {})
const runningTurnId = atom({ plugin: 'tidy-turns', key: 'runningTurnId' } as const, null)
const isFolding = atom({ plugin: 'tidy-turns', key: 'isFolding' } as const, true)
const openTurnIds = atom({ plugin: 'tidy-turns', key: 'openTurnIds' } as const, [])
const openRunIds = atom({ plugin: 'tidy-turns', key: 'openRunIds' } as const, [])

const EMPTY_TURN: Turn = { toolIds: [], toolNames: [], failedCount: 0, files: [], agentIds: [], spawnedAgentIds: [], agentAnswers: [], outputTokens: 0, calls: [], isAfterText: false, texts: [] }

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

const addOnce = (list: string[], item: string) => (list.includes(item) ? list : [...list, item])

const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

// The file an edit changed, read off the call's arguments; none for any other tool.
const editedFile = (e: ToolCallInput) => {
  if (!EDIT_TOOLS.includes(e.tool)) {
    return undefined
  }

  const input: Record<string, unknown> = { ...e }
  const path = input.file_path ?? input.notebook_path

  return typeof path === 'string' ? path : undefined
}

const isFailed = (result: ToolCallResult) => result.deny !== undefined || result.isError === true

// The input field that says what a call works on, in the order they are tried: a
// Bash call has a command and a description, and the command is the one to show.
const TARGET_FIELDS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'skill']

const MAX_TARGET_LENGTH = 200

const PATH_FIELDS = ['file_path', 'notebook_path']

const pathSegments = (path: string) => path.split('/').filter(segment => segment !== '')

// A file as `~/project/name`: the folder the session's project root sits in, or for
// a file outside the project the folder the file sits in, then the file's name.
const fileLabel = (path: string, projectRoot: string) => {
  const segments = pathSegments(path)
  const name = segments.at(-1) ?? path
  const isInProject = !path.startsWith('/') || (projectRoot !== '' && path.startsWith(`${projectRoot}/`))
  const folder = isInProject ? pathSegments(projectRoot).at(-1) : segments.at(-2)

  return folder === undefined ? name : `~/${folder}/${name}`
}

// Absolute paths inside a command or pattern, in the style of fileLabel: the project
// root as `~/project`, and any other home folder as `~`.
const HOME_FOLDER = /\/(?:Users|home)\/[^/\s"']+/g

const shortenPaths = (text: string, projectRoot: string) => {
  const project = pathSegments(projectRoot).at(-1)
  const withProject = projectRoot === '' || project === undefined ? text : text.replaceAll(projectRoot, `~/${project}`)

  return withProject.replace(HOME_FOLDER, '~')
}

// What a call works on, as one short line: the first line of the field
// TARGET_FIELDS picks, cut to MAX_TARGET_LENGTH; empty when the input has none.
const callTarget = (input: unknown, projectRoot: string) => {
  if (typeof input !== 'object' || input === null) {
    return ''
  }

  const fields: Record<string, unknown> = { ...input }
  const field = TARGET_FIELDS.find(name => typeof fields[name] === 'string')
  const value = field === undefined ? '' : String(fields[field])
  const isPath = field !== undefined && PATH_FIELDS.includes(field)
  const firstLine = isPath ? fileLabel(value, projectRoot) : shortenPaths(value.split('\n')[0]?.trim() ?? '', projectRoot)

  return firstLine.length > MAX_TARGET_LENGTH ? `${firstLine.slice(0, MAX_TARGET_LENGTH - 1)}…` : firstLine
}

const allCalls = (all: Turns) => Object.values(all).flatMap(turn => turn.calls)

// The calls of a run that are not failed: a failed call has a red line of its own.
const runCalls = (all: Turns, call: LiveCall) => allCalls(all).filter(other => other.runId === call.runId && other.state !== 'failed')

const findCall = (all: Turns, toolUseId: string) => allCalls(all).find(call => call.id === toolUseId)

// Records one tool call into the running turn once it ends: the main loop's calls by
// id, tool and outcome, a subagent's by its id, and the file any edit that worked changed.
const recordToolCall = async ($: EngineInterface, e: ToolCallInput, result: ToolCallResult) => {
  const isFailedCall = isFailed(result)
  const file = isFailedCall ? undefined : editedFile(e)

  await addToRunningTurn($, turn => withEditedFile(withEndedCall(turn, e, isFailedCall), file))
}

const withEndedCall = (turn: Turn, e: ToolCallInput, isFailedCall: boolean): Turn => {
  if (e.agentId !== undefined) {
    return { ...turn, agentIds: addOnce(turn.agentIds, e.agentId) }
  }

  const state = isFailedCall ? 'failed' : 'done'

  return {
    ...turn,
    toolIds: [...turn.toolIds, e.tool_use_id],
    toolNames: [...turn.toolNames, e.tool],
    failedCount: isFailedCall ? turn.failedCount + 1 : turn.failedCount,
    calls: withCallState(turn.calls, e.tool_use_id, state),
  }
}

const withEditedFile = (turn: Turn, file: string | undefined): Turn =>
  file === undefined ? turn : { ...turn, files: addOnce(turn.files, file) }

const withCallState = (calls: LiveCall[], id: string, state: LiveCall['state']) =>
  calls.map(call => (call.id === id ? { ...call, state } : call))

// One block of a model reply, in the order the model wrote it.
type ReplyBlock = { kind: 'text'; text: string } | { kind: 'call'; id: string; tool: string; input: unknown; isServerRun: boolean }

// The turn with a reply's blocks added. A call starts a new run unless the call
// before it came with no text between; a run is under a note when any text came
// before it in the turn. A call the API ran itself, such as the advisor, fires no
// tool.call, so it is done and counted here, in the reply that holds it.
const addReplyBlocks = (turn: Turn, blocks: ReplyBlock[], projectRoot: string): Turn => {
  const texts = [...turn.texts]
  const calls = [...turn.calls]
  const serverCalls = blocks.flatMap(block => (block.kind === 'call' && block.isServerRun ? [block] : []))
  let isAfterText = turn.isAfterText

  for (const block of blocks) {
    if (block.kind === 'text') {
      texts.push(block.text)
      isAfterText = true
      continue
    }

    const previous = calls.at(-1)
    const isNewRun = previous === undefined || isAfterText
    calls.push({
      id: block.id,
      tool: block.tool,
      target: callTarget(block.input, projectRoot),
      runId: isNewRun ? block.id : previous.runId,
      isNoted: texts.length > 0,
      textsBefore: texts.length,
      state: block.isServerRun ? 'done' : 'queued',
    })
    isAfterText = false
  }

  return {
    ...turn,
    texts,
    calls,
    isAfterText,
    toolIds: [...turn.toolIds, ...serverCalls.map(block => block.id)],
    toolNames: [...turn.toolNames, ...serverCalls.map(block => block.tool)],
  }
}

const replyBlocks = (content: unknown[]): ReplyBlock[] =>
  content.flatMap((block): ReplyBlock[] => {
    const { type, text, id, name, input } = block as Record<string, unknown>

    if (type === 'text' && typeof text === 'string' && text.trim().length > 0) {
      return [{ kind: 'text', text: text.trim() }]
    }

    const isServerRun = type === 'server_tool_use'

    return (type === 'tool_use' || isServerRun) && typeof id === 'string' && typeof name === 'string'
      ? [{ kind: 'call', id, tool: name, input, isServerRun }]
      : []
  })

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

const finishedTurns = (all: Turns) => Object.values(all).filter(turn => turn.durationMs !== undefined)

const isFoldedTool = (all: Turns, toolUseId: string) => finishedTurns(all).some(turn => turn.toolIds.includes(toolUseId))

// A text block folds only when it belongs to a finished turn and is no turn's final
// answer and no part of the running turn: a block whose text repeats elsewhere stays.
const isFoldedText = (all: Turns, text: string) => {
  const key = text.trim()
  const turnsWithText = Object.values(all).filter(turn => turn.texts.includes(key))

  return turnsWithText.length > 0 && turnsWithText.every(turn => turn.durationMs !== undefined && turn.texts.at(-1) !== key)
}

// The latest finished turn whose final answer is this text block.
const answeredTurnId = (all: Turns, text: string) =>
  Object.entries(all).findLast(([, turn]) => turn.durationMs !== undefined && turn.texts.at(-1) === text.trim())?.[0]

// The finished turn a subagent's row belongs to: a finished notice by the call that
// started the subagent, a message from it by the answer its run ended with.
const subagentRowTurnId = (all: Turns, row: { text: string; task?: { toolUseId?: string }; from?: unknown }) =>
  Object.entries(all).find(
    ([, turn]) =>
      turn.durationMs !== undefined &&
      ((row.task?.toolUseId !== undefined && turn.toolIds.includes(row.task.toolUseId)) ||
        (row.from !== undefined && turn.agentAnswers.includes(row.text.trim()))),
  )?.[0]

const toggleId = (ids: string[], id: string) => (ids.includes(id) ? ids.filter(other => other !== id) : [...ids, id])

// A click on a Worked for line opens or closes that turn's summary alone.
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

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tidy-turns',
      description: 'Toggle folding of finished turns down to their final answer',
    })

    return next(e)
  })

  on('command.run', { command: 'tidy-turns' }, async $ => {
    const isOn = !(await read($, isFolding))
    await update($, isFolding, () => isOn)
    $.ui.invalidate('ui.render')

    return { text: `Turn folding ${isOn ? 'on' : 'off'}.` }
  })

  // A subagent's run raises its own turn.start; it stays part of the main turn.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await addToRunningTurn($, turn => ({ ...turn, spawnedAgentIds: addOnce(turn.spawnedAgentIds, agentId) }))

      return next(e)
    }

    await update($, runningTurnId, () => e.turnId)
    await update($, turns, all => ({ ...all, [e.turnId]: EMPTY_TURN }))
    debug($, `turn.start ${e.turnId}`)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      await addToRunningTurn($, turn => ({ ...turn, calls: withCallState(turn.calls, e.tool_use_id, 'running') }))
      $.ui.invalidate('ui.render')
    }

    const result = await next(e)
    await recordToolCall($, e, result)
    $.ui.invalidate('ui.render')

    return result
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined && Array.isArray(e.message.content)) {
      const blocks = replyBlocks(e.message.content)

      if (blocks.length > 0) {
        const projectRoot = await $.session.root().catch(() => '')
        await addToRunningTurn($, turn => addReplyBlocks(turn, blocks, projectRoot))
        $.ui.invalidate('ui.render')
      }
    }

    return next(e)
  })

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

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const answer = e.answer.trim()

      // A subagent can answer after the turn that ran it has ended.
      const agentId = e.agentId
      const ownerId = Object.entries(await read($, turns)).find(([, turn]) => turn.spawnedAgentIds.includes(agentId))?.[0]

      if (answer !== '' && ownerId !== undefined) {
        await changeTurn($, ownerId, owner => ({ ...owner, agentAnswers: [...owner.agentAnswers, answer] }))
        $.ui.invalidate('ui.render')
      }

      return next(e)
    }

    const verb = pickVerb()
    await changeTurn($, e.turnId, turn => ({ ...turn, durationMs: e.durationMs, verb, endReason: e.reason }))
    await update($, runningTurnId, () => null)

    const turn = (await read($, turns))[e.turnId]
    const lastText = turn?.texts.at(-1) ?? ''
    debug(
      $,
      `turn.complete ${e.turnId} reason=${e.reason} tools=${turn?.toolIds.length} texts=${turn?.texts.length} ` +
        `answerMatchesLastText=${e.answer.trim() === lastText}`,
    )

    return next(e)
  })

  // Holds each text block's pieces and lets it out whole, when the next chunk of
  // another kind arrives or the response ends, so a message appears done at once.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    const held: HeldText = { index: -1, text: '' }

    for (;;) {
      const step = await stream.next()

      if (step.done) {
        yield* releaseHeld(held)
        await recordUsage($, e.agentId === undefined, step.value)

        return step.value
      }

      const chunk = step.value

      if (chunk.kind === 'text') {
        if (chunk.index !== held.index) {
          yield* releaseHeld(held)
          held.index = chunk.index
        }

        held.text += chunk.text
        continue
      }

      yield* releaseHeld(held)
      yield chunk
    }
  })

  // A subagent's finished notice and its message to the main loop belong to the
  // turn that ran it: they fold with the turn and stay hidden while its summary is
  // open, since the copy under the line shows the message there.
  on('ui.render', { component: 'UserMessage', surface: TERMINAL }, async ($, e, next) => {
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
  })

  // A finished turn's calls fold away. The calls of the running turn between two
  // notes share one row, which shows the call running now and opens on a click to
  // every call. A call that failed or was cut short gets a red line of its own, so
  // a problem never hides in the row; its output is never drawn.
  on('ui.render', { component: 'ToolUse', surface: TERMINAL }, async ($, e, next) => {
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
  })

  // The one line stands for the call, so its result draws nothing, an error's
  // text included.
  on('ui.render', { component: 'ToolResult', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)

    if (!(await isFoldingNow($))) {
      return next(e)
    }

    if (!isFoldedTool(all, e.props.tool_use_id) && !settings.compactLiveCalls) {
      return next(e)
    }

    return drawHidden($, e)
  })

  // The hint under a running call, such as "ctrl+b to run in background", is output
  // the one line leaves out.
  on('ui.render', { component: 'ToolProgress', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)

    if (!(await isFoldingNow($)) || !(settings.compactLiveCalls || isFoldedTool(all, e.props.tool_use_id))) {
      return next(e)
    }

    return drawHidden($, e)
  })

  // A run of reads and searches folds into one count line; a live run opens into
  // one ToolUse row per call, so each gets its own line. A finished turn's run
  // folds away. A run with a call the plugin cannot place keeps the engine's row.
  on('ui.render', { component: 'ToolGroup', surface: TERMINAL }, async ($, e, next) => {
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
  })

  on('ui.render', { component: 'AssistantMessage', surface: TERMINAL }, async ($, e, next) => {
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
  })

  // The Worked for line sits above the answer instead. Terminal only: the desktop
  // draws its own turn footer and raises no TurnDuration.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (!(await isFoldingNow($))) {
      return next(e)
    }

    return drawHidden($, e)
  })
}
