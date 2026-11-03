export type RecapMessage = { role: 'user' | 'assistant'; text: string }

export const RECAP_MODEL = 'haiku'
export const RECAP_MAX_CHARS = 40000

export const RECAP_SYSTEM =
  'Тебе дают переписку пользователя с ИИ-агентом в Claude Code. Перескажи по-русски в двух-трёх коротких предложениях: ' +
  'над чем работали, на чём остановились и что ожидается следующим шагом. Пиши обычными предложениями, без вступления, ' +
  'без списков и без markdown.'

const NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/g,
]

const clean = (text: string) => NOISE.reduce((t, re) => t.replace(re, ''), text).trim()

// The transcript as plain dialogue, newest kept when it is too long: tool output and reminders dropped.
export const recapTranscript = (messages: readonly RecapMessage[], maxChars = RECAP_MAX_CHARS) => {
  const lines = messages
    .map(m => ({ role: m.role, text: clean(m.text) }))
    .filter(m => m.text !== '')
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Агент'}: ${m.text}`)
  const kept: string[] = []
  let size = 0

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string

    if (size + line.length > maxChars) {
      if (kept.length === 0) kept.push(line.slice(line.length - maxChars))
      break
    }
    kept.push(line)
    size += line.length + 2
  }

  return kept.reverse().join('\n\n')
}
