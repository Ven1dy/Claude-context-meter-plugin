const MIN_MS = 60000
const MARGIN_MS = 5 * MIN_MS

export const AUTO_HOURS = [1, 2, 4, 8] as const

export type AutoAction = 'none' | 'warm' | 'off-expired' | 'off-cold'

export type AutoInput = {
  autoUntil: number | null
  now: number
  lastAt: number | null
  leftMin: number | null
  isWorking: boolean
  isBusy: boolean
  intervalMs: number
}

// The cache TTL counts from the request start, so warm 5 minutes ahead of it.
export const autoIntervalMs = (ttlMs: number) => Math.max(MIN_MS, ttlMs - MARGIN_MS)

export const warmsCount = (hours: number, intervalMs: number) => Math.floor((hours * 60 * MIN_MS) / intervalMs)

export const plural = (n: number, forms: readonly [string, string, string]) => {
  const mod10 = n % 10
  const mod100 = n % 100

  if (mod10 === 1 && mod100 !== 11) return forms[0]

  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2]
}

export const hoursLabel = (hours: number, intervalMs: number) => {
  const n = warmsCount(hours, intervalMs)

  return `${hours} ч (${n} ${plural(n, ['подогрев', 'подогрева', 'подогревов'])})`
}

export function autoAction(i: AutoInput): AutoAction {
  if (i.autoUntil === null) return 'none'
  if (i.now >= i.autoUntil) return 'off-expired'
  if (i.leftMin !== null && i.leftMin <= 0) return 'off-cold'

  return !i.isWorking && !i.isBusy && i.lastAt !== null && i.now - i.lastAt >= i.intervalMs ? 'warm' : 'none'
}
