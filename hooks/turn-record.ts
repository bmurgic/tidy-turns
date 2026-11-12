// How the events of a turn change its stored record. Pure: the hooks in
// register.tsx read and write the record, and these say what changes.
import type { ToolCallInput, ToolCallResult } from 'claude-code'

import type { LiveCall, Turn } from '../types'
import { callTarget } from './call-target'

export const EMPTY_TURN: Turn = { toolIds: [], toolNames: [], failedCount: 0, files: [], agentIds: [], spawnedAgentIds: [], agentAnswers: [], outputTokens: 0, calls: [], isAfterText: false, texts: [] }

export const addOnce = (list: string[], item: string) => (list.includes(item) ? list : [...list, item])

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

// The change one ended tool call makes to the running turn: the main loop's calls by
// id, tool and outcome, a subagent's by its id, and the file any edit that worked changed.
export const endedCallChange = (e: ToolCallInput, result: ToolCallResult) => {
  const isFailedCall = isFailed(result)
  const file = isFailedCall ? undefined : editedFile(e)

  return (turn: Turn) => withEditedFile(withEndedCall(turn, e, isFailedCall), file)
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

export const withCallState = (calls: LiveCall[], id: string, state: LiveCall['state']) =>
  calls.map(call => (call.id === id ? { ...call, state } : call))

// One block of a model reply, in the order the model wrote it.
type ReplyBlock = { kind: 'text'; text: string } | { kind: 'call'; id: string; tool: string; input: unknown; isServerRun: boolean }

// Where a call sits: it starts a new run unless the call before it came with no
// text between, and it is under a note when any text came before it in the turn.
const placedCall = (previous: LiveCall | undefined, isAfterText: boolean, textCount: number, call: Pick<LiveCall, 'id' | 'tool' | 'target' | 'state'>): LiveCall => ({
  ...call,
  runId: previous === undefined || isAfterText ? call.id : previous.runId,
  isNoted: textCount > 0,
  textsBefore: textCount,
})

// What the response so far says about where a call it begins goes: a text block
// came before it, or the call before it came in the same response with no text
// between. The turn may hold neither yet, and may hold a text that came later.
export type StreamPlace = { hasText: boolean; isAfterCall: boolean }

// The turn with a call the model has begun to write and no reply yet holds. Its
// target is unknown until the reply comes. A call right after another of the same
// response joins its run, whatever text the turn stored in the meantime.
export const addStreamedCall = (turn: Turn, id: string, tool: string, place: StreamPlace): Turn => {
  const isStored = turn.calls.some(call => call.id === id)
  const textCount = turn.texts.length + (place.hasText && !turn.isAfterText ? 1 : 0)
  const isNewRun = !place.isAfterCall && (turn.isAfterText || place.hasText)
  const call = { ...placedCall(turn.calls.at(-1), isNewRun, textCount, { id, tool, target: '', state: 'queued' }), isStreamed: true }

  return isStored ? turn : { ...turn, calls: [...turn.calls, call], isAfterText: false }
}

// The turn without the calls the model began whose reply never came, such as a
// response cut off or retried.
export const withoutStreamedCalls = (turn: Turn): Turn =>
  turn.calls.some(call => call.isStreamed) ? { ...turn, calls: turn.calls.filter(call => !call.isStreamed) } : turn

// The turn with a reply's blocks added. A call already there from the stream
// keeps its place and state and gains its target. A call the API ran itself,
// such as the advisor, fires no tool.call, so it is done and counted here, in
// the reply that holds it.
export const addReplyBlocks = (turn: Turn, blocks: ReplyBlock[], projectRoot: string): Turn => {
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

    const at = calls.findIndex(call => call.id === block.id)
    const streamed = calls[at]
    const target = callTarget(block.input, projectRoot)

    if (streamed === undefined) {
      calls.push(placedCall(calls.at(-1), isAfterText, texts.length, { id: block.id, tool: block.tool, target, state: block.isServerRun ? 'done' : 'queued' }))
    } else {
      const placed = placedCall(calls[at - 1], isAfterText, texts.length, { id: block.id, tool: block.tool, target, state: streamed.state })
      calls[at] = { ...placed, runId: streamed.runId }
    }

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

export const replyBlocks = (content: unknown[]): ReplyBlock[] =>
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
