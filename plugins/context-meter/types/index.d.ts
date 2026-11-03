export type ContextFill = { tokens: number | null; window: number; percent: number | null }

/**
 * Строка истории сессии: сообщение пользователя (контекст до него и после ответа)
 * или сжатие (`compact`), которое разрывает счёт между сообщениями.
 */
export type TurnEntry = { text: string; before: number | null; after: number | null; compact?: true }

/** Категория разбивки /context: `used` в окне, `free`, `buffer`, `deferred` — вне окна. */
export type ContextPart = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type ContextParts = { cats: ContextPart[]; total: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      fill: ContextFill | null
      turns: TurnEntry[]
      warned: boolean
      parts: ContextParts | null
      /** Токены категорий `used` на начало последнего сообщения, по имени. */
      partsBase: Record<string, number> | null
    }
  }
}
