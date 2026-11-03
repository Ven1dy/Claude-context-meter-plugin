export type UsageLimit = {
  pct: number
  resetsAt: number | null
}

export type UsageLimits = {
  fiveHour: UsageLimit | null
  sevenDay: UsageLimit | null
}

export type CacheKeeperData = {
  lastAt: number | null
  ctx: number | null
  leftMin: number | null
  isWorking: boolean
  isHidden: boolean
  busy: 'warm' | 'compact' | null
  toastedFor: number | null
  autoUntil: number | null
  autoHours: number | null
  limits: UsageLimits
  recap: string | null
  isRecapping: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-pulse': {
      data: CacheKeeperData
    }
  }
}
