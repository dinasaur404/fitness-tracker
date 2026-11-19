import { describe, expect, it } from 'vitest'
import { formatLocalDate, formatSleepDuration } from '../src/frontend/utils/formatters.js'

describe('formatSleepDuration', () => {
  it('formats whole hours', () => {
    expect(formatSleepDuration(480)).toBe('8h')
  })
  it('formats hours and minutes', () => {
    expect(formatSleepDuration(450)).toBe('7h 45m')
  })
  it('treats missing values as zero', () => {
    expect(formatSleepDuration(0)).toBe('0h')
  })
})

describe('formatLocalDate', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(formatLocalDate(new Date(2026, 0, 6))).toBe('2026-01-06')
  })
})
