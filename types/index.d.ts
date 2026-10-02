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
    }
  }
}
