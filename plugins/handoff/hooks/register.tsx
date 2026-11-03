import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { HandoffData, HandoffFlow, HandoffLevel, HandoffPending, HandoffStage } from '../types/index'
import {
  agentPrompt,
  cleanNote,
  contextText,
  handoffPath,
  isActiveAgent,
  isDismissal,
  levelFor,
  questionFor,
  retryPrompt,
  samePath,
  seedText,
  thresholdsFor,
} from './lib'

const PENDING_KEY = 'pending'
const POLL_MS = 10000
const WAIT_MAX_MS = 600000
const CLEAR_TIMEOUT_MS = 30000
const SEED_AFTER_END_MS = 1000
const SEED_FALLBACK_MS = 5000
const RETRY_TURNS = 3
const MAX_MISSES = 2

const NOW = 'Передать сейчас'
const LATER = 'Отложить'
const MUTE = 'Не предлагать до следующего порога'

const INITIAL: HandoffData = { tokens: null, window: null, level: 0, flow: null, isComposing: false, hiddenLevel: 0 }

const data = atom({ plugin: 'handoff', key: 'data' } as const, INITIAL)

type Timer = { cancel: () => void }
type Via = 'start' | 'session.end' | 'timer'

let settings: Record<string, unknown> = {}
let isWorking = false
let isAsking = false
let isSeeding = false
let shownLevel = 0
let mutedLevel = 0
let retryIn = 0
let waitSince: number | null = null
let pollTimer: Timer | undefined
let clearTimer: Timer | undefined
let seedTimer: Timer | undefined
let fallbackTimer: Timer | undefined

const stop = (timer: Timer | undefined) => timer?.cancel()

const stopAll = () => {
  stop(pollTimer)
  stop(clearTimer)
  stop(seedTimer)
  stop(fallbackTimer)
  pollTimer = clearTimer = seedTimer = fallbackTimer = undefined
  waitSince = null
}

const resetOffers = () => {
  shownLevel = 0
  mutedLevel = 0
  retryIn = 0
}

const getPending = async ($: EngineInterface): Promise<HandoffPending | null> => {
  const value = await $.store.get(PENDING_KEY)

  return typeof value === 'object' && value !== null ? (value as HandoffPending) : null
}

const setFlow = ($: EngineInterface, change: (flow: HandoffFlow) => HandoffFlow | null) =>
  update($, data, prev => (prev.flow === null ? prev : { ...prev, flow: change(prev.flow) }))

const setStage = ($: EngineInterface, stage: HandoffStage) => setFlow($, flow => ({ ...flow, stage }))

const send = async ($: EngineInterface, text: string) => {
  try {
    const result = await $.prompt.submit({ text })

    return result.drop === undefined
  } catch {
    return false
  }
}

async function applyContext($: EngineInterface, tokens: number | undefined, window: number) {
  const level = levelFor(tokens, thresholdsFor(window, settings))

  shownLevel = Math.min(shownLevel, level)
  mutedLevel = Math.min(mutedLevel, level)

  await update($, data, prev => {
    const hiddenLevel = Math.min(prev.hiddenLevel ?? 0, level) as HandoffLevel

    return prev.tokens === (tokens ?? null) && prev.window === window && prev.level === level && (prev.hiddenLevel ?? 0) === hiddenLevel
      ? prev
      : { ...prev, tokens: tokens ?? null, window, level, hiddenLevel }
  })

  return level
}

async function refreshUsage($: EngineInterface) {
  const { context } = await $.session.usage()

  return applyContext($, context.tokens, context.window)
}

async function watchWrite($: EngineInterface, agentId: string | undefined, path: unknown, isFailed: boolean) {
  if (agentId !== undefined || isFailed) return

  const flow = (await read($, data)).flow

  if (flow?.stage === 'writing' && samePath(path, flow.path)) await setFlow($, f => ({ ...f, wrote: true }))
}

async function failDoc($: EngineInterface) {
  stopAll()
  await setStage($, 'docFailed')
}

async function cancelFlow($: EngineInterface) {
  stopAll()
  retryIn = RETRY_TURNS
  await $.store.delete(PENDING_KEY)
  await update($, data, prev => ({ ...prev, flow: null }))
}

async function startHandoff($: EngineInterface, message: string | null) {
  if ((await read($, data)).flow !== null) return false

  const [cwd, sessionId, now] = await Promise.all([$.session.cwd(), $.session.id(), $.clock.now()])
  const path = handoffPath(cwd, now)
  const note = cleanNote(message)
  const pending: HandoffPending = { path, message: note, at: now, sessionId, isReady: false, isCleared: false, isSeeded: false }

  stopAll()
  await $.store.set(PENDING_KEY, pending)
  const flow: HandoffFlow = { stage: 'writing', path, message: note, startedAt: now, isStarted: false, wrote: false, misses: 0 }

  await update($, data, prev => ({ ...prev, isComposing: false, flow }))

  void send($, agentPrompt(path)).then(async ok => {
    if (ok) return
    await $.clock.sleep(1500)
    if (!(await send($, agentPrompt(path)))) await failDoc($)
  })

  return true
}

async function clearFailed($: EngineInterface) {
  stopAll()
  await setStage($, 'clearFailed')
}

async function runClear($: EngineInterface) {
  stopAll()
  await setStage($, 'clearing')
  clearTimer = $.clock.after(CLEAR_TIMEOUT_MS, () => void clearFailed($).catch(() => undefined))

  $.clock.after(0, () => {
    void (async () => {
      try {
        await $.command.run({ command: 'clear' })
      } catch {
        await clearFailed($)

        return
      }

      const pending = await getPending($)

      if (pending?.isCleared === true) {
        fallbackTimer = $.clock.after(SEED_FALLBACK_MS, () => void seed($, 'timer').catch(() => undefined))
      }
    })().catch(() => undefined)
  })
}

async function pollAgents($: EngineInterface) {
  const flow = (await read($, data)).flow

  if (flow?.stage !== 'waiting') return

  const agents = await $.agent.list().catch(() => [])
  const now = await $.clock.now()
  const isBusy = agents.some(agent => isActiveAgent(agent.status))

  if (!isBusy || now - (waitSince ?? now) >= WAIT_MAX_MS) {
    await runClear($)

    return
  }
  pollTimer = $.clock.after(POLL_MS, () => void pollAgents($).catch(() => undefined))
}

async function enterWaiting($: EngineInterface) {
  const pending = await getPending($)

  if (pending !== null) await $.store.set(PENDING_KEY, { ...pending, isReady: true })
  waitSince = await $.clock.now()
  await setStage($, 'waiting')
  await pollAgents($)
}

async function checkDoc($: EngineInterface, flow: HandoffFlow, isAborted: boolean) {
  if (isAborted) {
    await failDoc($)

    return
  }

  const exists = await $.fs.exists(flow.path).catch(() => false)
  let isReady = exists && flow.wrote

  if (exists && !flow.wrote) {
    const stat = await $.fs.stat(flow.path).catch(() => undefined)

    isReady = stat !== undefined && stat.mtimeMs >= flow.startedAt - 2000
  }
  if (isReady) {
    await enterWaiting($)

    return
  }

  const misses = flow.misses + 1

  if (misses >= MAX_MISSES) {
    await failDoc($)

    return
  }
  await setFlow($, f => ({ ...f, misses, isStarted: false }))
  void send($, retryPrompt(flow.path)).then(ok => (ok ? undefined : failDoc($)))
}

async function seed($: EngineInterface, via: Via) {
  if (isSeeding) return

  const pending = await getPending($)

  if (pending === null || !pending.isReady || pending.isSeeded) return
  if (via === 'timer' && !pending.isCleared) return

  isSeeding = true
  try {
    await $.store.set(PENDING_KEY, { ...pending, isSeeded: true })
    stopAll()

    const isSent = await send($, seedText(pending.path, pending.message))

    await $.store.delete(PENDING_KEY)
    await update($, data, prev => ({ ...prev, flow: null }))
    $.ui.toast(isSent ? 'Передано в чистую сессию' : `Не удалось отправить продолжение. Документ: ${pending.path}`, {
      timeoutMs: isSent ? 4000 : 10000,
    })
  } finally {
    isSeeding = false
  }
}

const hideRow = ($: EngineInterface, level: HandoffLevel) => update($, data, prev => ({ ...prev, hiddenLevel: level, isComposing: false }))

async function ask($: EngineInterface, level: HandoffLevel, tokens: number, window: number) {
  const surfaces = await $.session.surfaces().catch(() => [])

  if (surfaces.length === 0 || isWorking || (await read($, data)).flow !== null) return
  shownLevel = level
  // The question is back, so is the row beside it.
  await update($, data, prev => ({ ...prev, hiddenLevel: 0 as HandoffLevel }))

  let answer: string | undefined

  try {
    answer = await $.ui.ask(questionFor(level, tokens, window), { header: 'Handoff', options: [NOW, LATER, MUTE] })
  } catch {
    answer = undefined
  }

  // A chat message typed while the dialog was open closes it with service text, not an answer: that is "not now".
  if (answer === undefined || answer === LATER || (answer !== MUTE && isDismissal(answer))) {
    retryIn = RETRY_TURNS
    if (answer === LATER) await hideRow($, level)
  } else if (answer === MUTE) {
    mutedLevel = level
    await hideRow($, level)
  } else {
    await startHandoff($, answer === NOW ? null : answer)
  }
}

function offer($: EngineInterface, level: HandoffLevel, tokens: number, window: number) {
  isAsking = true
  $.clock.after(0, () => {
    void ask($, level, tokens, window)
      .catch(() => undefined)
      .finally(() => {
        isAsking = false
      })
  })
}

// next(e) answers the engine's own placeholder ({ type: 'engine' }) when no mod below drew a row:
// it shows nothing, so there is no row to put a divider against.
const isModRow = (rest: unknown) => Boolean(rest) && (rest as { type?: unknown }).type !== 'engine'

const divider = ($: EngineInterface, e: RenderInput<'AbovePrompt'>) => {
  const els = $.ui.resolve(e)

  if ('Svg' in els) {
    const { Svg } = els
    // Wide markup stretched to the slot (no width prop, aspect ratio off): the line spans the band, 1 px thick.
    const w = 4000
    const source =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="17" viewBox="0 0 ${w} 17" preserveAspectRatio="none">` +
      `<rect y="8" width="${w}" height="1" fill="rgba(128,128,128,0.25)"/></svg>`

    return <Svg source={source} alt="разделитель" height={17} />
  }

  const { Text } = els

  return <Text dimColor>{'─'.repeat(e.props.bodyColumns ?? 40)}</Text>
}

const STAGE_TEXT: Record<HandoffStage, string> = {
  writing: 'пишу документ…',
  waiting: 'жду субагентов…',
  clearing: 'очищаю…',
  docFailed: 'не удалось записать документ',
  clearFailed: 'не получилось очистить',
}

export const register: Register = (on, options) => {
  settings = options

  on('session.start', async ($, e, next) => {
    await $.store.delete(PENDING_KEY).catch(() => undefined)
    await $.command
      .register({
        name: 'handoff',
        description: 'Передать работу в чистую сессию через handoff-документ',
        argumentHint: '[сообщение для нового агента]',
      })
      .catch(() => undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await applyContext($, e.context.tokens, e.context.window).catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      stopAll()

      return next(e)
    }

    const pending = await getPending($).catch(() => null)

    resetOffers()
    isWorking = false
    await update($, data, () => INITIAL).catch(() => undefined)

    if (pending !== null && pending.isReady && !pending.isSeeded) {
      stop(clearTimer)
      clearTimer = undefined
      await $.store.set(PENDING_KEY, { ...pending, isCleared: true }).catch(() => undefined)
      seedTimer = $.clock.after(SEED_AFTER_END_MS, () => void seed($, 'session.end').catch(() => undefined))
    }

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      $.clock.after(0, () => void seed($, 'start').catch(() => undefined))
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true

    const flow = (await read($, data)).flow

    if (flow?.stage === 'writing' && !flow.isStarted && e.text.includes(flow.path)) {
      await setFlow($, f => ({ ...f, isStarted: true }))
    }

    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)

    await watchWrite($, e.agentId, e.file_path, ran.deny !== undefined || ran.isError === true).catch(() => undefined)

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)

    await watchWrite($, e.agentId, e.file_path, ran.deny !== undefined || ran.isError === true).catch(() => undefined)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    isWorking = false
    if (retryIn > 0) retryIn -= 1

    const level = await refreshUsage($).catch(() => 0 as HandoffLevel)
    const flow = (await read($, data)).flow

    if (flow?.stage === 'writing' && flow.isStarted) {
      await checkDoc($, flow, e.isAborted).catch(() => failDoc($))
    } else if (flow === null && !e.isAborted && !isAsking && level > mutedLevel && (level > shownLevel || retryIn === 0)) {
      const { tokens, window } = await read($, data)

      if (level > 0 && tokens !== null && window !== null) offer($, level, tokens, window)
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if ((await read($, data)).flow !== null) return { text: 'Передача уже идёт.' }

    // prompt.submit is refused while the command's own dispatch runs: start once it has finished.
    const message = e.args.trim() === '' ? null : e.args
    $.clock.after(0, () => void startHandoff($, message).catch(() => undefined))

    return { text: 'Передаю работу в чистую сессию.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const d = await read($, data)

    if (d.flow === null && (d.level === 0 || d.tokens === null || d.window === null || d.level <= (d.hiddenLevel ?? 0))) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const flow = d.flow
    const color = d.level >= 3 ? 'error' : d.level === 2 ? 'warning' : undefined

    let body: ReturnType<typeof Text>
    let actions: ReturnType<typeof Box> | null = null

    if (flow !== null) {
      body = <Text>{STAGE_TEXT[flow.stage]}</Text>

      if (flow.stage === 'docFailed' || flow.stage === 'clearFailed' || flow.stage === 'waiting') {
        const isClear = flow.stage === 'clearFailed'
        const retry = async () => {
          if (isClear) {
            await runClear($)

            return
          }
          await cancelFlow($)
          await startHandoff($, flow.message)
        }

        actions = (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            {flow.stage === 'waiting' ? null : (
              <Button
                key="retry"
                label={isClear ? 'очистить и продолжить' : 'повторить'}
                onPress={() => void retry().catch(() => undefined)}
              />
            )}
            <Button key="cancel" label="отменить" onPress={() => void cancelFlow($).catch(() => undefined)} />
          </Box>
        )
      }
    } else {
      body = <Text color={color}>{contextText(d.tokens ?? 0, d.window ?? 0)}</Text>
      actions = (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Button key="now" label="перенести в новую сессию" onPress={() => void startHandoff($, null).catch(() => undefined)} />
          <Button
            key="note"
            label="с сообщением для агента"
            onPress={() => void update($, data, prev => ({ ...prev, isComposing: !prev.isComposing })).catch(() => undefined)}
          />
          <Button key="hide" label="Скрыть" onPress={() => void hideRow($, d.level).catch(() => undefined)} />
        </Box>
      )
    }

    const row = (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>контекст</Text>
        </Box>
        {body}
        {actions}
      </Box>
    )

    const composer =
      flow === null && d.isComposing && Input !== undefined ? (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box width={8} flexShrink={0} />
          <Input
            key="note-input"
            placeholder="сообщение для нового агента"
            submitLabel="перенести"
            autoFocus
            onSubmit={(value: string) => void startHandoff($, value).catch(() => undefined)}
          />
        </Box>
      ) : null

    const line = composer === null ? row : <Box flexDirection="column">{row}{composer}</Box>

    // The band is shared: keep what other mods draw below ours.
    const rest = await next(e)

    if (isModRow(rest)) return <Box flexDirection="column">{line}{divider($, e)}{rest}</Box>
    return rest ? <Box flexDirection="column">{line}{rest}</Box> : line
  })
}
