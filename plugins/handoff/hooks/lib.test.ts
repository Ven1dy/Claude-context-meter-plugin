import { test, expect } from 'claude-code/testing'
import { cleanNote, contextText, handoffPath, isDismissal, levelFor, seedText, thresholdsFor } from './lib'

test('level follows the window size and the highest threshold passed', () => {
  const large = thresholdsFor(1000000, {})
  const small = thresholdsFor(200000, {})

  expect(large).toEqual({ soft: 350000, firm: 600000, last: 800000 })
  expect(small).toEqual({ soft: 100000, firm: 150000, last: 170000 })
  expect([0, 349999, 350000, 610000, 800000].map(n => levelFor(n, large))).toEqual([0, 0, 1, 2, 3])
  expect([99999, 120000, 160000, 175000].map(n => levelFor(n, small))).toEqual([0, 1, 2, 3])
  expect(levelFor(undefined, large)).toBe(0)
  expect(thresholdsFor(1000000, { softTokens: 400000 }).soft).toBe(400000)
})

test('context text uses k and M', () => {
  expect(contextText(352000, 1000000)).toBe('352k из 1M')
  expect(contextText(1200000, 1000000)).toBe('1.2M из 1M')
  expect(contextText(171500, 200000)).toBe('172k из 200k')
})

test('seed text carries the document path and the optional user note', () => {
  const path = 'C:/work/проект/.claude/handoffs/handoff-2026-10-08-1405.md'

  expect(seedText(path, null)).toBe(
    `Продолжение работы из прошлой сессии. Прочитай \`${path}\` целиком прежде чем что-то делать, затем загрузи скиллы и соблюдай правила из раздела «Инструкции пользователя для этой работы», и только после этого продолжи с раздела «Следующий шаг». Приступай к «Следующему шагу» сразу, не спрашивай разрешения и не жди подтверждения: остановись и дождись пользователя только если документ прямо требует этого.`,
  )
  expect(seedText(path, ' сначала запусти тесты ')).toBe(
    `Продолжение работы из прошлой сессии. Прочитай \`${path}\` целиком прежде чем что-то делать, затем загрузи скиллы и соблюдай правила из раздела «Инструкции пользователя для этой работы», и только после этого продолжи с раздела «Следующий шаг». Приступай к «Следующему шагу» сразу, не спрашивай разрешения и не жди подтверждения: остановись и дождись пользователя только если документ прямо требует этого.\n\nСообщение пользователя для тебя: сначала запусти тесты`,
  )
})

test('handoff path is built in local time from a Windows cwd', () => {
  const at = new Date(2026, 9, 8, 14, 5).getTime()

  expect(handoffPath('C:\\work\\Проект\\', at)).toBe(
    'C:/work/Проект/.claude/handoffs/handoff-2026-10-08-1405.md',
  )
})

test('service text of a closed dialog is never the user note', () => {
  const path = 'C:/work/.claude/handoffs/handoff-2026-10-13-1409.md'
  const dismissed = '[User dismissed — do not proceed, wait for next instruction]'

  expect(isDismissal(dismissed)).toBe(true)
  expect(isDismissal('[Dismissed]')).toBe(true)
  expect(isDismissal('')).toBe(true)
  expect(isDismissal('   ')).toBe(true)
  expect(isDismissal(undefined)).toBe(true)
  expect(isDismissal('сначала запусти тесты')).toBe(false)
  expect(isDismissal('Передать сейчас')).toBe(false)
  expect(cleanNote(dismissed)).toBeNull()
  expect(cleanNote('  не забудь про миграцию ')).toBe('не забудь про миграцию')
  expect(seedText(path, dismissed)).toBe(seedText(path, null))
  expect(seedText(path, dismissed)).not.toContain('Сообщение пользователя')
  expect(seedText(path, null)).toContain('не спрашивай разрешения')
})
