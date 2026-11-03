export type HandoffLevel = 0 | 1 | 2 | 3

export type HandoffStage = 'writing' | 'waiting' | 'clearing' | 'docFailed' | 'clearFailed'

export type HandoffFlow = {
  stage: HandoffStage
  path: string
  message: string | null
  startedAt: number
  isStarted: boolean
  wrote: boolean
  misses: number
}

export type HandoffData = {
  tokens: number | null
  window: number | null
  level: HandoffLevel
  flow: HandoffFlow | null
  isComposing: boolean
  // The band row stays hidden while the level is at or below this (Отложить, Не напоминать, Скрыть).
  hiddenLevel?: HandoffLevel
}

export type HandoffPending = {
  path: string
  message: string | null
  at: number
  sessionId: string
  isReady: boolean
  isCleared: boolean
  isSeeded: boolean
}

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      data: HandoffData
    }
  }
}
