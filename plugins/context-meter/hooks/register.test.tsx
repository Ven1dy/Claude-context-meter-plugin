import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'context-meter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the band shows the fill and a press opens /context', async ($, on) => {
  const ran: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 94000, window: 200000, percent: 47 }, rateLimits: [] } }))
  on('command.run', (_, e) => (ran.push(e.command), { text: '' }))
  // Стоит за движком: его собственная заглушка ряда, которую мод не должен оборачивать.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as const)

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /47%/ }))?.text).toBe('47%')
    await ui.press({ key: 'context-open' })
    await ui.press({ key: 'context-compact' })
    await ui.unmount()
  }

  expect(ran).toEqual(['context', 'compact', 'context', 'compact', 'context', 'compact'])
})

// Пока хук сжатия не вернулся, /context считает старую переписку; новая — после.
const compactWorld = (on: Parameters<Parameters<typeof test>[1]>[1], before: number, after: number, result: { tokensBefore: number; tokensAfter: number }) => {
  const logs: string[] = []
  let total = before

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', (_, e) =>
    e.breakdown
      ? { value: { startedAt: 0, context: { tokens: before, window: 1000000, percent: 13, breakdown: { totalTokens: total, categories: [] } }, rateLimits: [] } }
      : { value: { startedAt: 0, context: { tokens: before, window: 1000000, percent: 13 }, rateLimits: [] } },
  )
  on('session.compact', () => ((total = after), { messages: [{ role: 'user' as const, text: 'привет', toolUses: [] }], ...result }))
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as const)

  return logs
}

const compact = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.compact({ trigger: 'manual', messages: [{ role: 'user' as const, text: 'привет', toolUses: [] }] })

test('after /compact the line compares /context before and after, and the band shows the new size', async ($, on) => {
  const clock = mock.clock(on)
  const logs = compactWorld(on, 130000, 70000, { tokensBefore: 67000, tokensAfter: 7000 })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await compact($)
  expect(logs).toEqual([])
  await clock.advance(1000)

  expect(logs).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /\/ 1M/ }))?.text).toBe('70K / 1M')
  expect(await ui.find({ type: 'Text', text: /сжато/ })).toBe(undefined)
  await ui.unmount()
})

test('when /context never drops, the saving comes from the compaction itself', async ($, on) => {
  const clock = mock.clock(on)
  const logs = compactWorld(on, 140000, 140000, { tokensBefore: 107000, tokensAfter: 20000 })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await compact($)
  await clock.advance(4000)
  expect(logs).toEqual([])
  await clock.advance(1000)

  expect(logs).toEqual([])
})

test('a compaction that saved nothing writes no line', async ($, on) => {
  const clock = mock.clock(on)
  const logs = compactWorld(on, 74000, 74000, { tokensBefore: 50000, tokensAfter: 50000 })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await compact($)
  await clock.advance(10000)

  expect(logs).toEqual([])
})

const HISTORY = {
  plugin: 'context-meter',
  component: 'Pane',
  requestId: 'context-history',
  props: { title: 'История контекста', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const usageAt =(tokens: number) => ({ value: { startedAt: 0, context: { tokens, window: 200000, percent: Math.round((tokens / 200000) * 100) }, rateLimits: [] } })
const measureAt = (tokens: number) => ({ context: { tokens, window: 200000, percent: Math.round((tokens / 200000) * 100) }, rateLimits: [], units: ['context' as const] })

test('growth per message, history pane on a press, /clear empties it', async ($, on) => {
  const toasts: string[] = []
  const sounds: string[] = []
  const logs: string[] = []
  const opened: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true as const } }))
  on('session.usage', () => usageAt(40000))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }))
  on('audio.play', (_, e) => (sounds.push(String(e.clip.asset)), { value: undefined }))
  on('session.measure', () => ({ changed: ['context' as const] }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as const)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'первое сообщение' })
  await $.session.measure(measureAt(52000))
  await $.session.measure(measureAt(54000))
  await $.prompt.submit({ text: 'второе' })
  await $.session.measure(measureAt(70000))

  expect(toasts).toEqual(['Контекст заполнен на 35% — можно сделать /compact'])
  expect(sounds).toEqual(['sounds/ping.wav'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /за ход/ }))?.text).toBe('+16K за ход · история')
  await ui.press({ key: 'context-history' })
  expect(opened).toEqual(['context-history'])
  expect(logs).toHaveLength(0)
  await ui.unmount()

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const pane = await $.ui.mount({ ...HISTORY, surface })

    expect((await pane.find({ type: 'Text', text: /ПО СООБЩЕНИЯМ/ }))?.text).toBe('ПО СООБЩЕНИЯМ · 2 · прирост +30K')
    expect((await pane.find({ type: 'Text', text: /^\+14K$/ }))?.text).toBe('+14K')
    expect((await pane.find({ type: 'Text', text: /первое сообщение/ }))?.text).toBe('первое сообщение')
    expect((await pane.find({ type: 'Text', text: /^второе$/ }))?.text).toBe('второе')
    await pane.unmount()
  }

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await after.find({ type: 'Text', text: /за ход/ })).toBe(undefined)
  await after.unmount()
})

test('/clear button asks first', async ($, on) => {
  const ran: string[] = []
  let answer = 'Отмена'

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usageAt(30000))
  on('command.run', (_, e) => (ran.push(e.command), { text: '' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({ result: { questions: (e as any).questions, answers: { [(e as any).questions[0].question]: answer } } }) as never)
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as const)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'context-clear' })
  answer = 'Да, очистить'
  await ui.press({ key: 'context-clear' })
  await ui.unmount()

  expect(ran).toEqual(['clear'])
})

const breakdown = (messages: number) => ({
  categories: [
    { name: 'System tools', tokens: 25800, color: 'x', isDeferred: false, kind: 'used' as const },
    { name: 'Messages', tokens: messages, color: 'x', isDeferred: false, kind: 'used' as const },
    { name: 'Free space', tokens: 900000, color: 'x', isDeferred: false, kind: 'free' as const },
    { name: 'MCP tools (deferred)', tokens: 38600, color: 'x', isDeferred: true, kind: 'deferred' as const },
  ],
  totalTokens: 25800 + messages,
  rawMaxTokens: 1000000,
})

test('the pane breaks the context down by category and marks what grew', async ($, on) => {
  let messages = 10000

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [{ id: 'context-history', title: 'История контекста', isShown: true, isFocused: false, isPlaced: true }] as never }))
  on('session.usage', (_, e) => ({
    value: { startedAt: 0, context: { tokens: 25800 + messages, window: 1000000, percent: 4, ...(e.breakdown ? { breakdown: breakdown(messages) as never } : {}) }, rateLimits: [] },
  }))
  on('command.run', (_, e) => ({ text: e.command }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.measure', () => ({ changed: ['context' as const] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'context-history' })
  await $.prompt.submit({ text: 'привет' })
  messages = 16000
  await $.session.measure({ context: { tokens: 41800, window: 1000000, percent: 4 }, rateLimits: [], units: ['context' as const] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...HISTORY, surface })

    expect((await pane.find({ type: 'Text', text: /^System tools$/ }))?.text).toBe('System tools')
    expect((await pane.find({ type: 'Text', text: /^25\.8K$/ }))?.text).toBe('25.8K')
    expect((await pane.find({ type: 'Text', text: /▲/ }))?.text).toBe('▲ +6K')
    expect((await pane.find({ type: 'Text', text: /отложено/ }))?.text).toBe('  отложено, не в контексте: MCP tools (deferred) 38.6K')
    expect((await pane.find({ type: 'Text', text: /свободно/ }))?.text).toBe('свободно 900K')
    await pane.unmount()
  }
})
