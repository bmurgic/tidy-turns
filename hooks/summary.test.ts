import { describe, expect, test } from 'claude-code/testing'

import { describeEndTime } from './summary'

// An instant in the machine's local time zone, so each case holds in any zone.
const at = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month, day, hour, minute).getTime()

const LATE_NOV_18 = at(2026, 10, 18, 23, 0)

describe('the end time on a finished turn line', () => {
  test('shows only the time for a turn that ended today', () => {
    expect(describeEndTime(at(2026, 10, 18, 14, 41), LATE_NOV_18)).toBe('2:41 PM')
  })

  test('shows the midnight hour as 12 AM and noon as 12 PM, minutes in two digits', () => {
    expect(describeEndTime(at(2026, 10, 18, 0, 5), LATE_NOV_18)).toBe('12:05 AM')
    expect(describeEndTime(at(2026, 10, 18, 12, 0), LATE_NOV_18)).toBe('12:00 PM')
  })

  test('adds the month and day for a turn that ended on an earlier day', () => {
    expect(describeEndTime(at(2026, 10, 17, 14, 41), LATE_NOV_18)).toBe('Nov 17 2:41 PM')
  })

  test('adds the year for a turn that ended in an earlier year', () => {
    expect(describeEndTime(at(2025, 10, 17, 9, 3), LATE_NOV_18)).toBe('Nov 17, 2025 9:03 AM')
  })

  test('counts days by the local calendar, so a turn just before midnight is yesterday', () => {
    expect(describeEndTime(at(2026, 10, 17, 23, 59), at(2026, 10, 18, 0, 1))).toBe('Nov 17 11:59 PM')
  })

  test('adds the month for a turn on the same day number of an earlier month', () => {
    expect(describeEndTime(at(2026, 9, 18, 8, 0), LATE_NOV_18)).toBe('Oct 18 8:00 AM')
  })
})
