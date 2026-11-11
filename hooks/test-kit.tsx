import type { On, RenderElement } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const SURFACES = ['terminal', 'desktop'] as const

export type Surface = (typeof SURFACES)[number]

export const toolRow = (tool_use_id: string) => ({
  tool_use_id,
  tool: 'Bash',
  input: { command: 'ls' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'a', stderr: '', interrupted: false },
})

export const textRow = (text: string, isFirstOfReply = false) => ({
  text,
  isFirstOfReply,
})

// The kit has no transcript store beneath session.append; the mod records before next.
export const storeMissing = (error: Error) => expect(error.message).toContain('no implementation for session.append')

// Stand-ins for the engine beneath the plugin.
// Calls a test keeps running until it settles the promise, by tool_use_id.
export const heldCalls = new Map<string, Promise<void>>()

export const stubEngine = (on: On) => {
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

export const appendText = ($: Engine, uuid: string, text: string) =>
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
export const runTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: 'list files', turnId })
  await appendText($, `${turnId}-a`, `Let me look (${turnId}).`)
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: `${turnId}-tool`,
    command: 'ls',
  })
  await appendText($, `${turnId}-b`, `Found one file (${turnId}).`)
}

export const finishTurn = ($: Engine, turnId: string) =>
  $.turn.complete({
    answer: `Found one file (${turnId}).`,
    durationMs: 4200,
    isAborted: false,
    turnId,
    reason: 'answer',
  })

// A turn with something for every summary item: two reads, three edits over two
// files, a failed command, a subagent's read, one model request, then an interrupt.
export const runRichTurn = async ($: Engine, on: On, turnId: string) => {
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

export const ALL_ITEMS = {
  showToolKinds: true,
  showSubagents: true,
  showFilesChanged: true,
  showFailures: true,
  showEndReason: true,
  showTokens: true,
  showModel: true,
}

export const mountAnswer = ($: Engine, text: string) =>
  $.ui.mount({
    plugin: 'tidy-turns',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: textRow(text),
  })

export const drawTool = async ($: Engine, id: string, surface: Surface) =>
  (
    await $.ui.mount({
      plugin: 'tidy-turns',
      surface,
      component: 'ToolUse',
      props: toolRow(id),
    })
  ).drawn()

export const drawText = async ($: Engine, text: string, surface: Surface) =>
  (
    await $.ui.mount({
      plugin: 'tidy-turns',
      surface,
      component: 'AssistantMessage',
      props: textRow(text),
    })
  ).drawn()

// A turn that writes a note, runs an Explore subagent through an Agent call, then
// answers. The subagent's run raises its own turn.start and turn.complete.
export const runSubagentTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: 'list files', turnId })
  await appendText($, `${turnId}-a`, `Let me look (${turnId}).`)
  // The kit types no agentId on turn events; a subagent's run carries one.
  const start = { text: 'explore', turnId: `${turnId}-sub`, agentId: `${turnId}-agent` }
  await $.turn.start(start as Omit<typeof start, 'agentId'>)
  const end = { answer: ` Found it (${turnId}).\n`, durationMs: 900, isAborted: false, turnId: `${turnId}-sub`, reason: 'answer', agentId: `${turnId}-agent` } as const
  await $.turn.complete(end as Omit<typeof end, 'agentId'>)
  await $.tool.call({ tool: 'Agent', tool_use_id: `${turnId}-agent-call` } as unknown as Parameters<Engine['tool']['call']>[0])
  await appendText($, `${turnId}-b`, `Found one file (${turnId}).`)
  await finishTurn($, turnId)
}

export const subagentNotice = (turnId: string) => ({
  text: 'Agent "Explore" finished',
  origin: { kind: 'task-notification' as const },
  isExpanded: false,
  task: { id: `${turnId}-agent`, status: 'completed', toolUseId: `${turnId}-agent-call`, durationMs: 900 },
})

export const subagentMessage = (text: string) => ({ text, origin: { kind: 'peer' as const }, isExpanded: false, from: { name: 'Explore' } })

export const isHidden = (tree: RenderElement) => tree.type === 'Box' && tree.props?.display === 'none'

// A turn of skill, tool search, MCP and session tool calls, and one read.
export const runToolingTurn = async ($: Engine, turnId: string) => {
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

export const TOOLING_ITEMS = { showSessionTools: true, showSkills: true, showToolSearches: true, showMcpCalls: true }
