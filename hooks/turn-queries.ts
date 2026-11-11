// What the row hooks ask of the stored turns: which rows fold, and which turn or
// run a row belongs to. Pure, over the record turn-record.ts builds.
import type { LiveCall, Turns } from '../types'

const allCalls = (all: Turns) => Object.values(all).flatMap(turn => turn.calls)

// The calls of a run that are not failed: a failed call has a red line of its own.
export const runCallsOf = (calls: LiveCall[], runId: string) => calls.filter(call => call.runId === runId && call.state !== 'failed')

export const runCalls = (all: Turns, call: LiveCall) => runCallsOf(allCalls(all), call.runId)

export const findCall = (all: Turns, toolUseId: string) => allCalls(all).find(call => call.id === toolUseId)

const finishedTurns = (all: Turns) => Object.values(all).filter(turn => turn.durationMs !== undefined)

export const isFoldedTool = (all: Turns, toolUseId: string) => finishedTurns(all).some(turn => turn.toolIds.includes(toolUseId))

// A text block folds only when it belongs to a finished turn and is no turn's final
// answer and no part of the running turn: a block whose text repeats elsewhere stays.
export const isFoldedText = (all: Turns, text: string) => {
  const key = text.trim()
  const turnsWithText = Object.values(all).filter(turn => turn.texts.includes(key))

  return turnsWithText.length > 0 && turnsWithText.every(turn => turn.durationMs !== undefined && turn.texts.at(-1) !== key)
}

// The latest finished turn whose final answer is this text block.
export const answeredTurnId = (all: Turns, text: string) =>
  Object.entries(all).findLast(([, turn]) => turn.durationMs !== undefined && turn.texts.at(-1) === text.trim())?.[0]

// The finished turn a subagent's row belongs to: a finished notice by the call that
// started the subagent, a message from it by the answer its run ended with.
export const subagentRowTurnId = (all: Turns, row: { text: string; task?: { toolUseId?: string }; from?: unknown }) =>
  Object.entries(all).find(
    ([, turn]) =>
      turn.durationMs !== undefined &&
      ((row.task?.toolUseId !== undefined && turn.toolIds.includes(row.task.toolUseId)) ||
        (row.from !== undefined && turn.agentAnswers.includes(row.text.trim()))),
  )?.[0]

// The turn that started a subagent, so an answer that comes after the turn still finds it.
export const agentOwnerId = (all: Turns, agentId: string) =>
  Object.entries(all).find(([, turn]) => turn.spawnedAgentIds.includes(agentId))?.[0]
