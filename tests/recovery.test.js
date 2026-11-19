import { describe, expect, it } from 'vitest'
import { getRecoveryLabel } from '../src/frontend/utils/recovery.js'

describe('getRecoveryLabel', () => {
  it.each([
    [90, 'Green'],
    [67, 'Green'],
    [50, 'Yellow'],
    [10, 'Red'],
  ])('labels %i as %s', (score, label) => {
    expect(getRecoveryLabel(score)).toBe(label)
  })
})
