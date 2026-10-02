import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, ToolCallInput, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { Turn, Turns } from '../types'

const turns = atom({ plugin: 'tidy-turns', key: 'turns' } as const, {})
const runningTurnId = atom({ plugin: 'tidy-turns', key: 'runningTurnId' } as const, null)
const isFolding = atom({ plugin: 'tidy-turns', key: 'isFolding' } as const, true)
const openTurnIds = atom({ plugin: 'tidy-turns', key: 'openTurnIds' } as const, [])

const EMPTY_TURN: Turn = { toolIds: [], toolNames: [], failedCount: 0, files: [], agentIds: [], outputTokens: 0, texts: [] }

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
  }))
}

// The desktop app wraps each row in its own header and expander, so a hidden row
// there leaves the header over a blank body. The row hooks match the terminal only.
const TERMINAL = 'terminal'

const finishedTurns = (all: Turns) => Object.values(all).filter(turn => turn.durationMs !== undefined)

const isFoldedTool = (all: Turns, toolUseId: string) =>
  finishedTurns(all).some(turn => turn.toolIds.includes(toolUseId))

// A text block folds only when it belongs to a finished turn and is no turn's final
// answer and no part of the running turn: a block whose text repeats elsewhere stays.
const isFoldedText = (all: Turns, text: string) => {
  const key = text.trim()
  const turnsWithText = Object.values(all).filter(turn => turn.texts.includes(key))

  return (
    turnsWithText.length > 0 &&
    turnsWithText.every(turn => turn.durationMs !== undefined && turn.texts.at(-1) !== key)
  )
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
  showToolCount: boolean
  showToolKinds: boolean
  showSubagents: boolean
  showFilesChanged: boolean
  showFailures: boolean
  showEndReason: boolean
  showTokens: boolean
  showModel: boolean
}

const readSettings = (options: PluginOptions): Settings => ({
  showToolCount: options.showToolCount !== false,
  showToolKinds: options.showToolKinds === true,
  showSubagents: options.showSubagents === true,
  showFilesChanged: options.showFilesChanged === true,
  showFailures: options.showFailures === true,
  showEndReason: options.showEndReason === true,
  showTokens: options.showTokens === true,
  showModel: options.showModel === true,
})

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// Each tool's kind, as the summary counts them; any other tool is "other".
const TOOL_KINDS: Record<string, string> = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  WebFetch: 'web lookup',
  WebSearch: 'web lookup',
  Agent: 'agent',
  Task: 'agent',
}

const KIND_PLURALS: Record<string, string> = {
  read: 'reads',
  search: 'searches',
  edit: 'edits',
  command: 'commands',
  'web lookup': 'web lookups',
  agent: 'agents',
  other: 'other',
}

// The turn's tool calls by kind, most first. With the subagent item on, the calls
// that started subagents are left to it.
const describeKinds = (toolNames: string[], isSubagentItemOn: boolean) => {
  const counts = new Map<string, number>()

  for (const name of toolNames) {
    const kind = TOOL_KINDS[name] ?? 'other'

    if (!(isSubagentItemOn && kind === 'agent')) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }

  return [...counts]
    .sort(([kindA, countA], [kindB, countB]) => countB - countA || kindA.localeCompare(kindB))
    .map(([kind, count]) => plural(count, kind, KIND_PLURALS[kind] ?? kind))
}

const formatTokens = (tokens: number) =>
  tokens < 1000 ? `${tokens} tokens` : `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k tokens`

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

type SummaryGroup = { name: 'activity' | 'changes' | 'usage' | 'problems'; text: string }

// The summary's groups in the order they show, each the turned-on items it has
// something for; a group with nothing is left out.
const summaryGroups = (turn: Turn, settings: Settings): SummaryGroup[] => {
  const calls = turn.toolIds.length
  const activity = [
    settings.showToolCount && calls > 0 ? plural(calls, 'tool call', 'tool calls') : '',
    ...(settings.showToolKinds ? describeKinds(turn.toolNames, settings.showSubagents) : []),
    settings.showSubagents && turn.agentIds.length > 0 ? plural(turn.agentIds.length, 'agent', 'agents') : '',
  ]
  const changes = [
    settings.showFilesChanged && turn.files.length > 0 ? `${plural(turn.files.length, 'file', 'files')} changed` : '',
  ]
  const usage = [
    settings.showTokens && turn.outputTokens > 0 ? formatTokens(turn.outputTokens) : '',
    settings.showModel && turn.model !== undefined ? formatModel(turn.model) : '',
  ]
  const problems = [
    settings.showFailures && turn.failedCount > 0 ? `${turn.failedCount} failed` : '',
    settings.showEndReason ? (END_REASONS[turn.endReason ?? 'answer'] ?? '') : '',
  ]
  const groups: SummaryGroup[] = [
    { name: 'activity', text: joinItems(activity) },
    { name: 'changes', text: joinItems(changes) },
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
    const result = await next(e)
    await recordToolCall($, e, result)

    return result
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined && Array.isArray(e.message.content)) {
      const texts = e.message.content
        .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text.trim() : ''))
        .filter(text => text.length > 0)

      if (texts.length > 0) {
        await addToRunningTurn($, turn => ({ ...turn, texts: [...turn.texts, ...texts] }))
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

  on('ui.render', { component: 'ToolUse', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)

    if (!(await isFoldingNow($)) || !isFoldedTool(all, e.props.tool_use_id)) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)
    debug($, `fold ToolUse ${e.props.tool} ${e.props.tool_use_id} on ${e.surface}`)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)

    if (!(await isFoldingNow($)) || !isFoldedTool(all, e.props.tool_use_id)) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup', surface: TERMINAL }, async ($, e, next) => {
    const all = await read($, turns)
    const ids = e.props.calls.map(call => call.tool_use_id)
    const isEveryIdKnown = ids.every(id => id !== undefined)
    const isFolded =
      isEveryIdKnown && ids.every(id => isFoldedTool(all, id as string))

    if (!(await isFoldingNow($)) || e.props.isExpanded || e.props.isActive || !isFolded) {
      if (!isEveryIdKnown) {
        debug($, `ToolGroup on ${e.surface} has calls without tool_use_id`)
      }

      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
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

    const clickable = (key: string, text: string) => (
      <Box key={`${key}:scope`}>
        <Button key={key} plain dimColor hover={DETAILS_HOVER} onPress={toggle}>
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
