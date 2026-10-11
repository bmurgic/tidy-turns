/** One main-loop tool call, as the live view draws it. */
export type LiveCall = {
  id: string
  tool: string
  /** What the call works on, as one short line; empty when the input names nothing. */
  target: string
  /** The `id` of the first call of the run this call belongs to: the calls between two notes. */
  runId: string
  /** True when a text block of the turn came before the run, so the run sits under a note. */
  isNoted: boolean
  state: 'queued' | 'running' | 'done' | 'failed'
}

export type Turn = {
  /** Tool calls the turn's main loop made, by `tool_use_id`. */
  toolIds: string[]
  /** The tool each of those calls ran, in the same order. */
  toolNames: string[]
  /** How many of the main loop's tool calls failed or were denied. */
  failedCount: number
  /** Files the turn's edits changed, its subagents' included, each once. */
  files: string[]
  /** Subagents that made tool calls during the turn, each once. */
  agentIds: string[]
  /** Output tokens of every model request the turn made, its subagents' included. */
  outputTokens: number
  /** The model the turn's main loop last answered with. */
  model?: string
  /** Every main-loop call of the turn's replies, in the order the model made them. */
  calls: LiveCall[]
  /** True when the last block of the turn's replies was text, so the next call starts a new run. */
  isAfterText: boolean
  /** Text blocks of the turn's replies, trimmed, in the order stored. */
  texts: string[]
  /** Set by `turn.complete`; absent while the turn runs. */
  durationMs?: number
  /** The past-tense verb its Worked for line uses, picked by `turn.complete`. */
  verb?: string
  /** Why the turn ended, set by `turn.complete`. */
  endReason?: 'answer' | 'aborted' | 'refusal' | 'error'
}

export type Turns = Record<string, Turn>

declare module 'claude-code' {
  interface PluginState {
    'tidy-turns': {
      turns: Turns
      runningTurnId: string | null
      isFolding: boolean
      /** Turns whose summary is open, by turn id. */
      openTurnIds: string[]
      /** Runs of calls the person opened to every call, by run id. */
      openRunIds: string[]
    }
  }
}
