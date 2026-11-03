import type { HandoffLevel } from '../types/index'

export type Thresholds = { soft: number; firm: number; last: number }

export const LARGE_WINDOW = 500000

const LARGE: Thresholds = { soft: 350000, firm: 600000, last: 800000 }
const SMALL: Thresholds = { soft: 100000, firm: 150000, last: 170000 }

const pick = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

export const thresholdsFor = (window: number, options: Record<string, unknown>): Thresholds =>
  window >= LARGE_WINDOW
    ? {
        soft: pick(options.softTokens, LARGE.soft),
        firm: pick(options.firmTokens, LARGE.firm),
        last: pick(options.lastTokens, LARGE.last),
      }
    : {
        soft: pick(options.softTokensSmall, SMALL.soft),
        firm: pick(options.firmTokensSmall, SMALL.firm),
        last: pick(options.lastTokensSmall, SMALL.last),
      }

export const levelFor = (tokens: number | null | undefined, t: Thresholds): HandoffLevel => {
  if (tokens === null || tokens === undefined) return 0
  if (tokens >= t.last) return 3
  if (tokens >= t.firm) return 2
  if (tokens >= t.soft) return 1

  return 0
}

export const formatTokens = (n: number) => {
  if (n >= 1000000 || Math.round(n / 1000) >= 1000) {
    const m = Math.round(n / 100000) / 10

    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }

  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export const contextText = (tokens: number, window: number) => `${formatTokens(tokens)} из ${formatTokens(window)}`

export const questionFor = (level: HandoffLevel, tokens: number, window: number) => {
  const head = `Контекст ${contextText(tokens, window)}`

  if (level >= 3) {
    return `${head}. Модель уже заметно хуже держит ранние инструкции, и ошибки будут копиться. Лучше передать работу в чистую сессию прямо сейчас?`
  }
  if (level === 2) {
    return `${head}. Модель уже заметно хуже держит ранние инструкции. Передать работу в чистую сессию?`
  }

  return `${head}. Дальше качество ответов постепенно падает. Передать работу в чистую сессию?`
}

const two = (n: number) => String(n).padStart(2, '0')

export const stamp = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

export const handoffPath = (cwd: string, ms: number) =>
  `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/handoffs/handoff-${stamp(ms)}.md`

export const samePath = (a: unknown, b: string) =>
  typeof a === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])

export const isActiveAgent = (status: string) => ACTIVE_AGENT.has(status)

export const agentPrompt = (path: string) =>
  [
    'Пользователь передаёт работу в чистую сессию: контекст разросся. Сделай по порядку.',
    '1) Если в этой сессии есть важные решения или уроки, которые пока нигде не записаны, сохрани их там, где проект обычно хранит такие заметки (если сохранять нечего, пропусти).',
    '2) Проверь состояние: `git status` в затронутых репозиториях, запущенные фоновые задачи и серверы.',
    `3) Напиши Write-тулом файл \`${path}\` для агента, который продолжит без доступа к этой переписке. Разделы: \`## Цель и последний запрос\` (последний запрос пользователя дословно + статус), \`## Инструкции пользователя для этой работы\` (самое важное для продолжения: какие скиллы использовать и что в них критично учесть; обязательные правила работы, проверки и формат результата, которые пользователь давал в этой сессии, особенно в первом сообщении; ключевые формулировки пользователя дословно в кавычках, коротко. Не копируй сюда правила из CLAUDE.md и памяти: новая сессия получит их сама), \`## Сделано и проверено\`, \`## Сделано, но не проверено\`, \`## Решения и запреты пользователя\`, \`## Тупики и отвергнутое\` (что пробовали и почему не подошло), \`## Состояние\` (изменённые файлы, ветки, незакоммиченное, запущенные процессы, временные файлы), \`## Важные файлы\` (пути ссылками), \`## Открытые вопросы\`, \`## Следующий шаг\` (конкретное первое действие). Пустой раздел: «нет». Пиши конкретно, с путями и командами, не пересказывай всю историю.`,
    '4) Ответь одной строкой: HANDOFF READY.',
  ].join('\n')

export const retryPrompt = (path: string) =>
  `Файл \`${path}\` не найден. Напиши handoff-документ Write-тулом именно по этому пути (разделы из предыдущей инструкции), затем ответь одной строкой: HANDOFF READY.`

// What the engine hands back instead of an answer when the dialog is closed (a chat message typed
// while it was open, Esc, a failed ask): service text, never something the user wrote for the agent.
const DISMISSED = /^\s*\[\s*(user\s+)?(dismissed|declined|cancell?ed|rejected)\b|do not proceed, wait for next instruction/i

export const isDismissal = (answer: unknown) => typeof answer !== 'string' || answer.trim() === '' || DISMISSED.test(answer)

// The user's own words for the next agent, or null when there are none.
export const cleanNote = (text: unknown): string | null => (isDismissal(text) ? null : (text as string).trim())

export const seedText = (path: string, message: string | null) => {
  const base = `Продолжение работы из прошлой сессии. Прочитай \`${path}\` целиком прежде чем что-то делать, затем загрузи скиллы и соблюдай правила из раздела «Инструкции пользователя для этой работы», и только после этого продолжи с раздела «Следующий шаг». Приступай к «Следующему шагу» сразу, не спрашивай разрешения и не жди подтверждения: остановись и дождись пользователя только если документ прямо требует этого.`
  const note = cleanNote(message)

  return note === null ? base : `${base}\n\nСообщение пользователя для тебя: ${note}`
}
