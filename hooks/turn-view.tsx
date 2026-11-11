import type { Elements } from 'claude-code'

import type { LiveCall, Turn } from '../types'

// The elements a drawing here needs, from the surface's table.
type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// Cells the row leaves free at the right edge; a line never reaches it.
const ROW_MARGIN = 4

export const DEFAULT_COLUMNS = 80

const MIN_LINE_LENGTH = 12

// The theme key Claude Code draws errors in.
export const ERROR_RED = 'error'

// The details' hover: the text at full strength, never a block behind it.
export const DETAILS_HOVER = { dimColor: false, inverse: false }

// The theme key of the orange Claude Code marks its spinner with.
export const CLAUDE_ORANGE = 'claude'

// A line cut with a … so it and its suffix fit in one row of the terminal, never wrapping.
const fitLine = (line: string, suffix: string, columns: number) => {
  const room = Math.max(columns - ROW_MARGIN - suffix.length, MIN_LINE_LENGTH)

  return `${line.length > room ? `${line.slice(0, room - 1)}…` : line}${suffix}`
}

// The calls a run's row shows: all of them once opened; closed, the ones running
// now, or the latest call to start when none is.
const shownCalls = (run: LiveCall[], isOpen: boolean) => {
  const running = run.filter(call => call.state === 'running')
  const latest = run.findLast(call => call.state !== 'queued') ?? run[0]

  if (isOpen) {
    return run
  }

  if (running.length > 0) {
    return running
  }

  return latest === undefined ? [] : [latest]
}

// A call's line: after a note it hangs under it with ⎿, and with none before it
// the line is its own, led by the reply bullet. Later lines of a row line up under the first.
const describeCall = (call: LiveCall, isFirstLine: boolean) => {
  const notedLead = isFirstLine ? '  ⎿ ' : '    '
  const bareLead = isFirstLine ? '⏺ ' : '  '

  return `${call.isNoted ? notedLead : bareLead}${[call.tool, call.target].filter(part => part !== '').join(' ')}`
}

// A call that failed or was cut short: a red line of its own, so a problem never
// hides in a run's row.
export const drawFailedCall = (ui: Ui, call: LiveCall, suffix: string, columns: number) => (
  <ui.Box key={`tidy-turns:failed:${call.id}`} marginTop={call.isNoted ? 0 : 1}>
    <ui.Text color={ERROR_RED}>{fitLine(describeCall(call, true), suffix, columns)}</ui.Text>
  </ui.Box>
)

// What follows a run's first line: nothing for one call, an open mark, or the count.
const runNote = (callCount: number, isOpen: boolean) => {
  if (callCount === 1) {
    return ''
  }

  return isOpen ? ' ▾' : ` ▸ ${callCount} calls`
}

type RunRow ={ run: LiveCall[]; isOpen: boolean; onToggle: () => void; columns: number }

// The calls between two notes as one row: closed, the call running now and a
// count; a click opens it to every call. A run under a note sits against it; one
// with no note is set off by a blank line. Each line sits in a keyed Box, its own hover scope.
export const drawRun = (ui: Ui, { run, isOpen, onToggle, columns }: RunRow) => {
  const first = run[0]
  const note = runNote(run.length, isOpen)

  return (
    <ui.Box key={`tidy-turns:run:${first?.runId}`} flexDirection="column" alignSelf="flex-start" marginTop={first?.isNoted === false ? 1 : 0}>
      {shownCalls(run, isOpen).map((shown, index) => (
        <ui.Box key={`tidy-turns:call:${shown.id}:scope`}>
          <ui.Button key={`tidy-turns:call:${shown.id}`} plain dimColor hover={DETAILS_HOVER} onPress={onToggle}>
            <ui.Text>{fitLine(describeCall(shown, index === 0), index === 0 ? note : '', columns)}</ui.Text>
          </ui.Button>
        </ui.Box>
      ))}
    </ui.Box>
  )
}

// One piece of a finished turn's work, in the order it happened.
type Step =
  | { kind: 'note'; index: number; text: string }
  | { kind: 'run'; calls: LiveCall[] }
  | { kind: 'failed'; call: LiveCall }
  | { kind: 'agent-answer'; index: number; text: string }

// The turn's notes, runs, and failed calls in the order they came, then what its
// subagents answered. The last text is the answer, which the row draws itself.
// A run shows where its first call that did not fail came; a failed call where it came.
export const turnSteps = (turn: Turn): Step[] => {
  const notes = turn.texts.slice(0, -1)
  const steps: Step[] = []
  const placedRunIds = new Set<string>()
  let nextNote = 0

  const addNotesUpTo = (count: number) => {
    for (; nextNote < Math.min(count, notes.length); nextNote += 1) {
      steps.push({ kind: 'note', index: nextNote, text: notes[nextNote] as string })
    }
  }

  for (const call of turn.calls) {
    addNotesUpTo(call.textsBefore)

    if (call.state === 'failed') {
      steps.push({ kind: 'failed', call })
    } else if (!placedRunIds.has(call.runId)) {
      placedRunIds.add(call.runId)
      steps.push({ kind: 'run', calls: turn.calls.filter(other => other.runId === call.runId && other.state !== 'failed') })
    }
  }

  addNotesUpTo(notes.length)

  return [...steps, ...turn.agentAnswers.map((text, index): Step => ({ kind: 'agent-answer', index, text }))]
}

type TurnCopy = { turn: Turn; openRunIds: string[]; onToggleRun: (runId: string) => void; columns: number }

// A finished turn's work drawn the way it looked while it ran, for over its open
// line. The turn's own rows stay hidden, so the work shows once.
export const drawTurnCopy = (ui: Ui, { turn, openRunIds, onToggleRun, columns }: TurnCopy) => (
  <ui.Box key="tidy-turns:copy" flexDirection="column">
    {turnSteps(turn).map(step => {
      switch (step.kind) {
        case 'note':
          return (
            <ui.Box key={`tidy-turns:note:${step.index}`} marginTop={1}>
              <ui.Text>⏺ {step.text}</ui.Text>
            </ui.Box>
          )
        case 'run': {
          const runId = step.calls[0]?.runId ?? ''

          return drawRun(ui, { run: step.calls, isOpen: openRunIds.includes(runId), onToggle: () => onToggleRun(runId), columns })
        }
        case 'failed':
          return drawFailedCall(ui, step.call, ' · failed', columns)
        case 'agent-answer':
          return (
            <ui.Box key={`tidy-turns:agent-answer:${step.index}`} marginTop={1}>
              <ui.Text dimColor>{fitLine(`› ${step.text.split('\n')[0] ?? ''}`, '', columns)}</ui.Text>
            </ui.Box>
          )
      }
    })}
  </ui.Box>
)
