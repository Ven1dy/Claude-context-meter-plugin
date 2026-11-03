import { test, expect } from 'claude-code/testing'
import { recapTranscript } from './recap'

test('recap transcript drops reminders and empty tool rows, keeps the newest', () => {
  const text = recapTranscript([
    { role: 'user', text: 'Сделай кнопку <system-reminder>служебное</system-reminder>' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'Готово, кнопка в полосе.' },
  ])

  expect(text).toBe('Пользователь: Сделай кнопку\n\nАгент: Готово, кнопка в полосе.')

  const long = recapTranscript(
    [
      { role: 'user', text: 'старое сообщение' },
      { role: 'assistant', text: 'новое' },
    ],
    20,
  )

  expect(long).toBe('Агент: новое')
})
