import type { PluginOptions } from 'claude-code'

import type { Turn } from '../types'

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

export const readSettings = (options: PluginOptions): Settings => ({
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
  advisor: session('advisor call', 'advisor calls'),
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

export type SummaryGroup = { name: 'activity' | 'changes' | 'session' | 'usage' | 'problems'; text: string }

// The summary's groups in the order they show, each the turned-on items it has
// something for; a group with nothing is left out.
export const summaryGroups = (turn: Turn, settings: Settings): SummaryGroup[] => {
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

export const describeVerb = (turn: Turn) => `${turn.verb ?? 'Worked'} for ${formatDuration(turn.durationMs ?? 0)}`
