import type { Elements } from 'claude-code'

import type { LiveCall, Turn } from '../types'
import { runCallsOf } from './turn-queries'

// The elements a drawing here needs, from the surface's table.
type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// Cells the row leaves free at the right edge; a line never reaches it.
const ROW_MARGIN = 4

export const DEFAULT_COLUMNS = 80

const MIN_LINE_LENGTH = 12

// The theme key Claude Code draws errors in.
const ERROR_RED = 'error'

// The details' hover: the text at full strength, never a block behind it.
const DETAILS_HOVER = { dimColor: false, inverse: false }

// The theme key of the orange Claude Code marks its spinner with.
const CLAUDE_ORANGE = 'claude'

// The Worked for line's hover: the whole line bold in Claude's orange, never a
// block behind it.
const LINE_HOVER = { color: CLAUDE_ORANGE, dimColor: false, bold: true, inverse: false }

// One row of a turn's summary; the problems row draws in red.
type SummaryRow = { name: string; text: string }

type AnswerLine = { lead: string; rows: SummaryRow[]; isOpen: boolean; onToggle: () => void }

// The Worked for line over a finished turn's answer, and under it the summary as a
// tree a click opens and closes. A turn with no summary has nothing to open, so no
// arrow and no click. Each row sits in a keyed Box, its own hover scope.
export const drawAnswerLine = (ui: Ui, { lead, rows, isOpen, onToggle }: AnswerLine) => {
  const line = rows.length > 0 ? drawOpenableLine(ui, { lead, isOpen, onToggle }) : <ui.Text dimColor>✻ {lead}</ui.Text>

  return (
    <ui.Box flexDirection="column" alignSelf="flex-start">
      {line}
      {isOpen && rows.map((row, index) => drawSummaryRow(ui, { row, isLast: index === rows.length - 1, onToggle }))}
    </ui.Box>
  )
}

// Closed, the line is dim. Open, it is bright and its star and tree are
// orange: a Button takes no color, so the star is a Text of its own. One
// keyed Box holds the line, so it lights as one under the pointer.
const drawOpenableLine = (ui: Ui, { lead, isOpen, onToggle }: Omit<AnswerLine, 'rows'>) => (
  <ui.Box key="tidy-turns:line">
    <ui.Text color={isOpen ? CLAUDE_ORANGE : undefined} dimColor={!isOpen} hover={LINE_HOVER}>
      ✻{' '}
    </ui.Text>
    <ui.Button key="tidy-turns:lead" plain dimColor={!isOpen} hover={LINE_HOVER} onPress={onToggle}>
      {lead}
    </ui.Button>
    <ui.Button key="tidy-turns:work" plain dimColor={!isOpen} hover={LINE_HOVER} onPress={onToggle}>
      {isOpen ? ' ▾' : ' ▸'}
    </ui.Button>
  </ui.Box>
)

type SummaryRowLine = { row: SummaryRow; isLast: boolean; onToggle: () => void }

// A click on a row closes the summary; the problems row, in red, takes no click.
const drawSummaryRow = (ui: Ui, { row, isLast, onToggle }: SummaryRowLine) => (
  <ui.Box key={`tidy-turns:row:${row.name}`}>
    <ui.Text color={CLAUDE_ORANGE}>{isLast ? '└─ ' : '├─ '}</ui.Text>
    {row.name === 'problems' ? <ui.Text color={ERROR_RED}>{row.text}</ui.Text> : drawRowText(ui, row, onToggle)}
  </ui.Box>
)

const drawRowText = (ui: Ui, row: SummaryRow, onToggle: () => void) => (
  <ui.Box key={`tidy-turns:row-text:${row.name}:scope`}>
    <ui.Button key={`tidy-turns:row-text:${row.name}`} plain dimColor hover={DETAILS_HOVER} onPress={onToggle}>
      {row.text}
    </ui.Button>
  </ui.Box>
)

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

type RunRow = { run: LiveCall[]; isOpen: boolean; onToggle: () => void; columns: number }

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
const turnSteps = (turn: Turn): Step[] => {
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
      steps.push({ kind: 'run', calls: runCallsOf(turn.calls, call.runId) })
    }
  }

  addNotesUpTo(notes.length)

  return [...steps, ...turn.agentAnswers.map((text, index): Step => ({ kind: 'agent-answer', index, text }))]
}

type TurnCopy = { turn: Turn; openRunIds: string[]; onToggleRun: (runId: string) => void; columns: number }

// A finished turn's work drawn the way it looked while it ran, for under its open
// line: the rows above the line stay hidden, so the line never moves.
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
