import { test, expect } from 'claude-code/testing'
import { autoAction, autoIntervalMs, hoursLabel } from './auto'
import type { AutoInput } from './auto'

const MIN = 60000
const interval = autoIntervalMs(60 * MIN)

const base: AutoInput = {
  autoUntil: 10 * 60 * MIN,
  now: 100 * MIN,
  lastAt: 100 * MIN - interval,
  leftMin: 5,
  isWorking: false,
  isBusy: false,
  intervalMs: interval,
}

test('auto warm tick decides none, warm, off-expired, off-cold', () => {
  expect(interval).toBe(55 * MIN)
  expect(autoAction({ ...base, lastAt: base.now - interval + MIN, leftMin: 6 })).toBe('none')
  expect(autoAction({ ...base, isWorking: true })).toBe('none')
  expect(autoAction({ ...base, isBusy: true })).toBe('none')
  expect(autoAction(base)).toBe('warm')
  expect(autoAction({ ...base, autoUntil: base.now })).toBe('off-expired')
  expect(autoAction({ ...base, leftMin: 0 })).toBe('off-cold')
  expect(autoAction({ ...base, autoUntil: null })).toBe('none')
})

test('hours labels count warms with Russian plurals', () => {
  expect([1, 2, 4, 8].map(h => hoursLabel(h, interval))).toEqual([
    '1 ч (1 подогрев)',
    '2 ч (2 подогрева)',
    '4 ч (4 подогрева)',
    '8 ч (8 подогревов)',
  ])
})
