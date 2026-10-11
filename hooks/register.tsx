import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, ToolCallInput, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { LiveCall, Turn, Turns } from '../types'

const turns = atom({ plugin: 'tidy-turns', key: 'turns' } as const, {})
const runningTurnId = atom({ plugin: 'tidy-turns', key: 'runningTurnId' } as const, null)
const isFolding = atom({ plugin: 'tidy-turns', key: 'isFolding' } as const, true)
const openTurnIds = atom({ plugin: 'tidy-turns', key: 'openTurnIds' } as const, [])
const openRunIds = atom({ plugin: 'tidy-turns', key: 'openRunIds' } as const, [])

const EMPTY_TURN: Turn = { toolIds: [], toolNames: [], failedCount: 0, files: [], agentIds: [], outputTokens: 0, calls: [], isAfterText: false, texts: [] }

// Claude Code's own past-tense turn verbs, as its 2.1.286 build lists them.
const VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']

const randomIndex = (length: number) => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % length

const pickVerb = () => VERBS[randomIndex(VERBS.length)] ?? 'Worked'

const debug = ($: EngineInterface, text: string) => $.ui.log(`tidy-turns: ${text}`, { to: 'debug' })

const addToRunningTurn = async ($: EngineInterface, change: (turn: Turn) => Turn) => {
  const turnId = await read($, runningTurnId)

  if (turnId === null) {
    return
  }

  await update($, turns, all => ({ ...all, [turnId]: change(all[turnId] ?? EMPTY_TURN) }))
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

// A file as `~/project/name`: the folder the session's project root sits in, or for
// a file outside the project the folder the file sits in, then the file's name.
const fileLabel = (path: string, projectRoot: string) => {
  const segments = path.split('/').filter(segment => segment !== '')
  const name = segments.at(-1) ?? path
  const isInProject = !path.startsWith('/') || (projectRoot !== '' && path.startsWith(`${projectRoot}/`))
  const folder = isInProject ? projectRoot.split('/').filter(segment => segment !== '').at(-1) : segments.at(-2)

  return folder === undefined ? name : `~/${folder}/${name}`
}

// Absolute paths inside a command or pattern, in the style of fileLabel: the project
// root as `~/project`, and any other home folder as `~`.
const HOME_FOLDER = /\/(?:Users|home)\/[^/\s"']+/g

const shortenPaths = (text: string, projectRoot: string) => {
  const project = projectRoot.split('/').filter(segment => segment !== '').at(-1)
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

// Cells the row leaves free at the right edge; a line never reaches it.
const ROW_MARGIN = 4

const DEFAULT_COLUMNS = 80

const MIN_LINE_LENGTH = 12

// A line cut with a … so it and its suffix fit in one row of the terminal, never wrapping.
const fitLine = (line: string, suffix: string, columns: number) => {
  const room = Math.max(columns - ROW_MARGIN - suffix.length, MIN_LINE_LENGTH)

  return `${line.length > room ? `${line.slice(0, room - 1)}…` : line}${suffix}`
}

// The calls of a run that are not failed: a failed call has a red line of its own.
const runCalls = (all: Turns, call: LiveCall) =>
  Object.values(all)
    .flatMap(turn => turn.calls)
    .filter(other => other.runId === call.runId && other.state !== 'failed')

const findCall = (all: Turns, toolUseId: string) =>
  Object.values(all)
    .flatMap(turn => turn.calls)
    .find(call => call.id === toolUseId)

// The calls a run's row shows: all of them once opened; closed, the ones running
// now, or the latest call to start when none is.
const shownCalls = (run: LiveCall[], isOpen: boolean) => {
  const running = run.filter(call => call.state === 'running')
  const latest = run.findLast(call => call.state !== 'queued') ?? run[0]

  if (isOpen) {
    return run
  }

  return running.length > 0 ? running : latest === undefined ? [] : [latest]
}

// A call's line: after a note it hangs under it with ⎿, and with none before it
// the line is its own, led by the reply bullet. Later lines of a row line up under the first.
const describeCall = (call: LiveCall, isFirstLine: boolean) => {
  const lead = call.isNoted ? (isFirstLine ? '  ⎿ ' : '    ') : isFirstLine ? '⏺ ' : '  '

  return `${lead}${[call.tool, call.target].filter(part => part !== '').join(' ')}`
}

// Records one tool call into the running turn once it ends: the main loop's calls by
// id, tool and outcome, a subagent's by its id, and the file any edit that worked changed.
const recordToolCall = async ($: EngineInterface, e: ToolCallInput, result: ToolCallResult) => {
  const isMainLoop = e.agentId === undefined
  const isFailedCall = isFailed(result)
  const file = isFailedCall ? undefined : editedFile(e)

  await addToRunningTurn($, turn => ({
    ...turn,
    toolIds: isMainLoop ? [...turn.toolIds, e.tool_use_id] : turn.toolIds,
    toolNames: isMainLoop ? [...turn.toolNames, e.tool] : turn.toolNames,
    failedCount: turn.failedCount + (isMainLoop && isFailedCall ? 1 : 0),
    agentIds: e.agentId === undefined ? turn.agentIds : addOnce(turn.agentIds, e.agentId),
    files: file === undefined ? turn.files : addOnce(turn.files, file),
    calls: isMainLoop ? withCallState(turn.calls, e.tool_use_id, isFailedCall ? 'failed' : 'done') : turn.calls,
  }))
}

const withCallState = (calls: LiveCall[], id: string, state: LiveCall['state']) =>
  calls.map(call => (call.id === id ? { ...call, state } : call))

// One block of a model reply, in the order the model wrote it.
type ReplyBlock = { kind: 'text'; text: string } | { kind: 'call'; id: string; tool: string; input: unknown }

// The turn with a reply's blocks added. A call starts a new run unless the call
// before it came with no text between; a run is under a note when any text came
// before it in the turn.
const addReplyBlocks = (turn: Turn, blocks: ReplyBlock[], projectRoot: string): Turn => {
  const texts = [...turn.texts]
  const calls = [...turn.calls]
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
      state: 'queued',
    })
    isAfterText = false
  }

  return { ...turn, texts, calls, isAfterText }
}

const replyBlocks = (content: unknown[]): ReplyBlock[] =>
  content.flatMap((block): ReplyBlock[] => {
    const { type, text, id, name, input } = block as Record<string, unknown>

    if (type === 'text' && typeof text === 'string' && text.trim().length > 0) {
      return [{ kind: 'text', text: text.trim() }]
    }

    return type === 'tool_use' && typeof id === 'string' && typeof name === 'string' ? [{ kind: 'call', id, tool: name, input }] : []
  })

// The desktop app wraps each row in its own header and expander, so a hidden row
// there leaves the header over a blank body. The row hooks match the terminal only.
const TERMINAL = 'terminal'

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

const formatDuration = (durationMs: number) => {
  const seconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

// Which summary items the person turned on, from the manifest's userConfig.
type Settings = {
  compactLiveCalls: boolean
  showToolCount: boolean
  showToolKinds: boolean
  showSubagents: boolean
  showFilesChanged: boolean
  showFailures: boolean
  showEndReason: boolean
  showSessionTools: boolean
  showTokens: boolean
  showModel: boolean
  showSkills: boolean
  showToolSearches: boolean
  showMcpCalls: boolean
}

const readSettings = (options: PluginOptions): Settings => ({
  compactLiveCalls: options.compactLiveCalls !== false,
  showToolCount: options.showToolCount !== false,
  showToolKinds: options.showToolKinds !== false,
  showSubagents: options.showSubagents !== false,
  showFilesChanged: options.showFilesChanged !== false,
  showFailures: options.showFailures !== false,
  showEndReason: options.showEndReason !== false,
  showSessionTools: options.showSessionTools !== false,
  showTokens: options.showTokens !== false,
  showModel: options.showModel !== false,
  showSkills: options.showSkills !== false,
  showToolSearches: options.showToolSearches !== false,
  showMcpCalls: options.showMcpCalls !== false,
})

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// A kind of tool call, as the summary counts it. A kind with an item of its own
// is counted there while that item is on, and among the kinds while it is off.
type Kind = { one: string; many: string; item?: keyof Settings }

const kind = (one: string, many: string, item?: keyof Settings): Kind => ({ one, many, item })

const SKILL = kind('skill', 'skills', 'showSkills')
const TOOL_SEARCH = kind('tool search', 'tool searches', 'showToolSearches')
const MCP_CALL = kind('MCP call', 'MCP calls', 'showMcpCalls')
const OTHER = kind('other', 'other')

const session = (one: string, many: string) => kind(one, many, 'showSessionTools')
const SCHEDULE = session('schedule', 'schedules')
const PLAN_MODE = session('plan mode', 'plan modes')
const WORKTREE = session('worktree', 'worktrees')
const PLUGIN_LOOKUP = session('plugin lookup', 'plugin lookups')

// Each tool's kind. An MCP tool, named mcp__<server>__<tool>, is an MCP call;
// any other tool not listed is "other".
const TOOL_KINDS: Record<string, Kind> = {
  Read: kind('read', 'reads'),
  Grep: kind('search', 'searches'),
  Glob: kind('search', 'searches'),
  LS: kind('search', 'searches'),
  Edit: kind('edit', 'edits', 'showFilesChanged'),
  MultiEdit: kind('edit', 'edits', 'showFilesChanged'),
  Write: kind('edit', 'edits', 'showFilesChanged'),
  NotebookEdit: kind('edit', 'edits', 'showFilesChanged'),
  Bash: kind('command', 'commands'),
  BashOutput: kind('command', 'commands'),
  KillShell: kind('command', 'commands'),
  WebFetch: kind('web lookup', 'web lookups'),
  WebSearch: kind('web lookup', 'web lookups'),
  Agent: kind('agent', 'agents', 'showSubagents'),
  Task: kind('agent', 'agents', 'showSubagents'),
  Skill: SKILL,
  ToolSearch: TOOL_SEARCH,
  ListMcpResourcesTool: MCP_CALL,
  ReadMcpResourceTool: MCP_CALL,
  ReadMcpResourceDirTool: MCP_CALL,
  Monitor: session('monitor', 'monitors'),
  TaskStop: session('task stop', 'task stops'),
  SendMessage: session('message', 'messages'),
  ListAgents: session('agent list', 'agent lists'),
  Workflow: session('workflow', 'workflows'),
  CronCreate: SCHEDULE,
  CronDelete: SCHEDULE,
  CronList: SCHEDULE,
  EnterPlanMode: PLAN_MODE,
  ExitPlanMode: PLAN_MODE,
  EnterWorktree: WORKTREE,
  ExitWorktree: WORKTREE,
  PushNotification: session('notification', 'notifications'),
  RemoteTrigger: session('remote trigger', 'remote triggers'),
  SendUserFile: session('file sent', 'files sent'),
  TodoWrite: session('todo update', 'todo updates'),
  AskUserQuestion: session('question', 'questions'),
  ListPlugins: PLUGIN_LOOKUP,
  SearchPlugins: PLUGIN_LOOKUP,
  SuggestPluginInstall: PLUGIN_LOOKUP,
  ListSkills: PLUGIN_LOOKUP,
  SearchSkills: PLUGIN_LOOKUP,
  SuggestSkills: PLUGIN_LOOKUP,
}

const kindOf = (toolName: string) => TOOL_KINDS[toolName] ?? (toolName.startsWith('mcp__') ? MCP_CALL : OTHER)

// The turn's tool calls of the kinds `isCounted` picks, by kind, most first.
const describeKinds = (toolNames: string[], isCounted: (kind: Kind) => boolean) => {
  const counts = new Map<string, { kind: Kind; count: number }>()

  for (const name of toolNames) {
    const toolKind = kindOf(name)

    if (isCounted(toolKind)) {
      const count = (counts.get(toolKind.one)?.count ?? 0) + 1
      counts.set(toolKind.one, { kind: toolKind, count })
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.kind.one.localeCompare(b.kind.one))
    .map(({ kind: { one, many }, count }) => plural(count, one, many))
}

const countKind = (toolNames: string[], wanted: Kind) => {
  const count = toolNames.filter(name => kindOf(name) === wanted).length

  return count === 0 ? '' : plural(count, wanted.one, wanted.many)
}

const formatTokens = (count: number) => (count < 1000 ? `${count} tokens` : `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k tokens`)

// "claude-haiku-4-5-20251001" reads as "Haiku 4.5"; a name of another shape as given.
const formatModel = (model: string) => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-|$)/.exec(model)

  if (match === null) {
    return model
  }

  const family = match[1] ?? ''
  const version = match[3] === undefined ? match[2] : `${match[2]}.${match[3]}`

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
}

const END_REASONS: Record<string, string> = { aborted: 'interrupted', refusal: 'refused', error: 'errored' }

type SummaryGroup = { name: 'activity' | 'changes' | 'session' | 'usage' | 'problems'; text: string }

// The summary's groups in the order they show, each the turned-on items it has
// something for; a group with nothing is left out.
const summaryGroups = (turn: Turn, settings: Settings): SummaryGroup[] => {
  const calls = turn.toolIds.length
  const activity = [
    settings.showToolCount && calls > 0 ? plural(calls, 'tool call', 'tool calls') : '',
    // A kind whose own item is on is counted there instead.
    ...(settings.showToolKinds ? describeKinds(turn.toolNames, toolKind => toolKind.item === undefined || !settings[toolKind.item]) : []),
    settings.showSubagents && turn.agentIds.length > 0 ? plural(turn.agentIds.length, 'agent', 'agents') : '',
  ]
  const changes = [settings.showFilesChanged && turn.files.length > 0 ? `${plural(turn.files.length, 'file', 'files')} changed` : '']
  const sessionTools = settings.showSessionTools ? describeKinds(turn.toolNames, toolKind => toolKind.item === 'showSessionTools') : []
  const usage = [
    settings.showModel && turn.model !== undefined ? formatModel(turn.model) : '',
    settings.showTokens && turn.outputTokens > 0 ? formatTokens(turn.outputTokens) : '',
    settings.showSkills ? countKind(turn.toolNames, SKILL) : '',
    settings.showToolSearches ? countKind(turn.toolNames, TOOL_SEARCH) : '',
    settings.showMcpCalls ? countKind(turn.toolNames, MCP_CALL) : '',
  ]
  const problems = [
    settings.showFailures && turn.failedCount > 0 ? `${turn.failedCount} failed` : '',
    settings.showEndReason ? (END_REASONS[turn.endReason ?? 'answer'] ?? '') : '',
  ]
  const groups: SummaryGroup[] = [
    { name: 'activity', text: joinItems(activity) },
    { name: 'changes', text: joinItems(changes) },
    { name: 'session', text: joinItems(sessionTools) },
    { name: 'usage', text: joinItems(usage) },
    { name: 'problems', text: joinItems(problems) },
  ]

  return groups.filter(group => group.text !== '')
}

const joinItems = (items: string[]) => items.filter(item => item !== '').join(' · ')

const describeVerb = (turn: Turn) => `${turn.verb ?? 'Worked'} for ${formatDuration(turn.durationMs ?? 0)}`

// A click on a Worked for line opens or closes that turn's summary alone.
const toggleSummary = async ($: EngineInterface, turnId: string) => {
  await update($, openTurnIds, ids => (ids.includes(turnId) ? ids.filter(id => id !== turnId) : [...ids, turnId]))
  $.ui.invalidate('ui.render')
}

// A click on a run's row opens it to every call, or closes it again.
const toggleRun = async ($: EngineInterface, runId: string) => {
  await update($, openRunIds, ids => (ids.includes(runId) ? ids.filter(id => id !== runId) : [...ids, runId]))
  $.ui.invalidate('ui.render')
}

// The theme key Claude Code draws errors in, for the problems group.
const ERROR_RED = 'error'

// The details' hover: the text at full strength, never a block behind it.
const DETAILS_HOVER = { dimColor: false, inverse: false }

// The theme key of the orange Claude Code marks its spinner with.
const CLAUDE_ORANGE = 'claude'

// The Worked for line's hover: the whole line bold in Claude's orange, never a
// block behind it.
const LINE_HOVER = { color: CLAUDE_ORANGE, dimColor: false, bold: true, inverse: false }

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

  on('turn.start', async ($, e, next) => {
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

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const verb = pickVerb()
    await update($, turns, all => ({
      ...all,
      [e.turnId]: { ...(all[e.turnId] ?? EMPTY_TURN), durationMs: e.durationMs, verb, endReason: e.reason },
    }))
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

  on('ui.render', { component: 'UserMessage', surface: TERMINAL }, ($, e, next) => {
    if (e.props.origin.kind === 'composer' && e.props.isExpanded !== isDetailedView) {
      isDetailedView = e.props.isExpanded
      debug($, `detailed view ${isDetailedView ? 'open' : 'closed'}`)
      $.ui.invalidate('ui.render')
    }

    return next(e)
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

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? DEFAULT_COLUMNS

    if (isFoldedTool(all, e.props.tool_use_id)) {
      debug($, `fold ToolUse ${e.props.tool} ${e.props.tool_use_id} on ${e.surface}`)

      return <Box display="none" />
    }

    const call = findCall(all, e.props.tool_use_id)

    if (!settings.compactLiveCalls || call === undefined) {
      return next(e)
    }

    if (call.state === 'failed' || e.props.isErrored || e.props.isInterrupted) {
      return (
        <Box marginTop={call.isNoted ? 0 : 1}>
          <Text color={ERROR_RED}>{fitLine(describeCall(call, true), e.props.isInterrupted ? ' · interrupted' : ' · failed', columns)}</Text>
        </Box>
      )
    }

    const run = runCalls(all, call)

    if (run[0]?.id !== call.id) {
      return <Box display="none" />
    }

    const isOpen = (await read($, openRunIds)).includes(call.runId)
    const toggle = () => toggleRun($, call.runId)
    // A run under a note sits against it; one with no note is set off by a blank line.
    const note = run.length === 1 ? '' : isOpen ? ' ▾' : ` ▸ ${run.length} calls`

    return (
      <Box flexDirection="column" alignSelf="flex-start" marginTop={call.isNoted ? 0 : 1}>
        {shownCalls(run, isOpen).map((shown, index) => (
          <Box key={`tidy-turns:call:${shown.id}:scope`}>
            <Button key={`tidy-turns:call:${shown.id}`} plain dimColor hover={DETAILS_HOVER} onPress={toggle}>
              <Text>{fitLine(describeCall(shown, index === 0), index === 0 ? note : '', columns)}</Text>
            </Button>
          </Box>
        ))}
      </Box>
    )
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

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  // The hint under a running call, such as "ctrl+b to run in background", is output
  // the one line leaves out.
  on('ui.render', { component: 'ToolProgress', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)

    if (!(await isFoldingNow($)) || !(settings.compactLiveCalls || isFoldedTool(all, e.props.tool_use_id))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  // A run of reads and searches folds into one count line; a live run opens into
  // one ToolUse row per call, so each gets its own line. A finished turn's run
  // folds away. A run with a call the plugin cannot place keeps the engine's row.
  on('ui.render', { component: 'ToolGroup', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)
    const ids = e.props.calls.map(call => call.tool_use_id)
    const isEveryIdKnown = ids.every(id => id !== undefined)
    const isFolded = isEveryIdKnown && ids.every(id => isFoldedTool(all, id as string))

    if (!isEveryIdKnown) {
      debug($, `ToolGroup on ${e.surface} has calls without tool_use_id`)
    }

    if (!(await isFoldingNow($)) || e.props.isExpanded) {
      return next(e)
    }

    if (isFolded && !e.props.isActive) {
      const { Box } = $.ui.resolve(e)

      return <Box display="none" />
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

    const isFolded = await read($, isFolding)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (isFolded && isFoldedText(all, e.props.text)) {
      return <Box display="none" />
    }

    const turnId = answeredTurnId(all, e.props.text)
    const turn = turnId === undefined ? undefined : all[turnId]

    if (turnId === undefined || turn === undefined) {
      return next(e)
    }

    // The summary sits under the line as a tree a click opens and closes; the
    // work stays folded. A turn with no summary has nothing to open, so no arrow
    // and no click. Each row sits in a keyed Box, its own hover scope.
    const isOpen = (await read($, openTurnIds)).includes(turnId)
    const toggle = () => toggleSummary($, turnId)
    const groups = summaryGroups(turn, settings)
    const canOpen = groups.length > 0

    const clickable = (id: string, text: string) => (
      <Box key={`${id}:scope`}>
        <Button key={id} plain dimColor hover={DETAILS_HOVER} onPress={toggle}>
          {text}
        </Button>
      </Box>
    )

    // Closed, the line is dim. Open, it is bright and its star and tree are
    // orange: a Button takes no color, so the star is a Text of its own. One
    // keyed Box holds the line, so it lights as one under the pointer.
    const header = canOpen ? (
      <Box key="tidy-turns:line">
        <Text color={isOpen ? CLAUDE_ORANGE : undefined} dimColor={!isOpen} hover={LINE_HOVER}>
          ✻{' '}
        </Text>
        <Button key="tidy-turns:lead" plain dimColor={!isOpen} hover={LINE_HOVER} onPress={toggle}>
          {describeVerb(turn)}
        </Button>
        <Button key="tidy-turns:work" plain dimColor={!isOpen} hover={LINE_HOVER} onPress={toggle}>
          {isOpen ? ' ▾' : ' ▸'}
        </Button>
      </Box>
    ) : (
      <Text dimColor>✻ {describeVerb(turn)}</Text>
    )

    const summary = (
      <Box flexDirection="column" alignSelf="flex-start">
        {header}
        {isOpen &&
          groups.map((group, index) => (
            <Box key={`tidy-turns:row:${group.name}`}>
              <Text color={CLAUDE_ORANGE}>{index === groups.length - 1 ? '└─ ' : '├─ '}</Text>
              {group.name === 'problems' ? (
                <Text color={ERROR_RED}>{group.text}</Text>
              ) : (
                clickable(`tidy-turns:row-text:${group.name}`, group.text)
              )}
            </Box>
          ))}
      </Box>
    )

    return (
      <Box flexDirection="column" marginTop={1}>
        {summary}
        {await next(e)}
      </Box>
    )
  })

  // The Worked for line sits above the answer instead. Terminal only: the desktop
  // draws its own turn footer and raises no TurnDuration.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (!(await isFoldingNow($))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })
}
