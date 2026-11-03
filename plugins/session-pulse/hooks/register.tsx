import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, SessionRateLimit } from 'claude-code'

import type { CacheKeeperData, UsageLimit, UsageLimits } from '../types/index'
import { AUTO_HOURS, autoAction, autoIntervalMs, hoursLabel } from './auto'
import type { AutoAction } from './auto'
import { RECAP_MODEL, RECAP_SYSTEM, recapTranscript } from './recap'

const TICK_MS = 60000
const WARM_PROMPT = 'Ответь одним словом: ok'

const NO_LIMITS: UsageLimits = { fiveHour: null, sevenDay: null }

const INITIAL: CacheKeeperData = {
  lastAt: null,
  ctx: null,
  leftMin: null,
  isWorking: false,
  isHidden: false,
  busy: null,
  toastedFor: null,
  autoUntil: null,
  autoHours: null,
  limits: NO_LIMITS,
  recap: null,
  isRecapping: false,
}

const BAR_CELLS = 8
const SVG_W = 72
const SVG_H = 8
const BLUE = '#4ea1ff'
const YELLOW = '#e0a526'
const RED = '#e5534b'
const TRACK = 'rgba(128,128,128,0.3)'

const toLimit = (w: SessionRateLimit | undefined): UsageLimit | null => {
  if (w === undefined) return null
  const at = w.resetsAt === undefined ? Number.NaN : Date.parse(w.resetsAt)

  return { pct: w.percentUsed, resetsAt: Number.isNaN(at) ? null : at }
}

const toLimits = (windows: readonly SessionRateLimit[]): UsageLimits => ({
  fiveHour: toLimit(windows.find(w => w.kind === 'five_hour')),
  sevenDay: toLimit(windows.find(w => w.kind === 'seven_day')),
})

const fillColor = (pct: number) => (pct >= 90 ? RED : pct >= 70 ? YELLOW : BLUE)

const untilText = (ms: number) => {
  const mins = Math.ceil(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60

  return h > 0 ? (m > 0 ? `${h} ч ${m} мин` : `${h} ч`) : `${m} мин`
}

const svgBar = (frac: number, color: string) => {
  const f = Math.min(1, Math.max(0, frac))
  const fill = f > 0 ? Math.min(SVG_W, Math.max(2, Math.round(f * SVG_W))) : 0

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}">` +
    `<clipPath id="c"><rect width="${SVG_W}" height="${SVG_H}" rx="${SVG_H / 2}"/></clipPath>` +
    `<g clip-path="url(#c)"><rect width="${SVG_W}" height="${SVG_H}" fill="${TRACK}"/>` +
    `<rect width="${fill}" height="${SVG_H}" fill="${color}"/></g></svg>`
  )
}

const cellCount = (frac: number) => {
  const f = Math.min(1, Math.max(0, frac))

  return f > 0 ? Math.min(BAR_CELLS, Math.max(1, Math.round(f * BAR_CELLS))) : 0
}

type Meter = {
  id: string
  label: string
  alt: string
  frac: number | null
  hex: string
  themeColor: string | undefined
  text: string
  isTextDim: boolean
  extra: string
}

const data = atom({ plugin: 'session-pulse', key: 'data' } as const, INITIAL)

const tokens = (n: number) => (n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}K`)

const COOL_RED_MIN = 5
const COOL_YELLOW_MIN = 15

type Config = { ttlMs: number; warnMin: number; intervalMs: number }

let timer: { cancel: () => void } | undefined

async function refresh($: EngineInterface, cfg: Config) {
  const now = await $.clock.now()
  let toastLeft: number | null = null

  await update($, data, prev => {
    const leftMin = prev.lastAt === null ? null : Math.ceil((prev.lastAt + cfg.ttlMs - now) / 60000)
    const isDue =
      !prev.isWorking && prev.lastAt !== null && leftMin !== null && leftMin > 0 && leftMin <= cfg.warnMin && prev.toastedFor !== prev.lastAt

    toastLeft = isDue ? leftMin : null

    return { ...prev, leftMin, toastedFor: isDue ? prev.lastAt : prev.toastedFor }
  })

  if (toastLeft !== null) $.ui.toast(`Кэш остынет через ${toastLeft} мин`)
}

type WarmReason = 'manual' | 'auto'

async function warmNow($: EngineInterface, cfg: Config, reason: WarmReason) {
  let isClaimed = false

  await update($, data, prev => {
    if (prev.busy !== null) return prev
    isClaimed = true

    return { ...prev, busy: 'warm' as const }
  })
  if (!isClaimed) return

  const startedAt = await $.clock.now()
  const failed = reason === 'auto' ? 'Автоподогрев не удался' : 'Не удалось подогреть кэш'

  try {
    const r = await $.model.fork({ prompt: WARM_PROMPT })

    if (!r.isAnswered) {
      $.ui.toast(`${failed}: ${r.reason}`)
    } else {
      const { cache_read_input_tokens: cached, cache_creation_input_tokens: written } = r.usage

      await update($, data, prev => ({ ...prev, lastAt: startedAt, isHidden: false }))
      $.ui.toast(
        cached >= written
          ? reason === 'auto'
            ? 'Автоподогрев: кэш продлён'
            : `Кэш продлён, прочитано из кэша ${tokens(cached)} токенов`
          : `Кэш уже остыл, префикс записан заново: ${tokens(written)} токенов`,
      )
    }
  } catch (error) {
    $.ui.toast(`${failed}: ${String(error).slice(0, 120)}`)
  }

  await update($, data, prev => ({ ...prev, busy: null }))
  await refresh($, cfg).catch(() => undefined)
}

// A one-off Haiku call over the dialogue text: the main thread and its prompt cache stay untouched.
async function recapNow($: EngineInterface) {
  let isClaimed = false

  await update($, data, prev => {
    if (prev.isRecapping === true) return prev
    isClaimed = true

    return { ...prev, isRecapping: true, recap: null }
  })
  if (!isClaimed) return

  let recap: string | null = null

  try {
    const transcript = recapTranscript(await $.session.messages())

    if (transcript === '') {
      $.ui.toast('Пересказывать пока нечего')
    } else {
      const r = await $.model.complete({ model: RECAP_MODEL, system: RECAP_SYSTEM, prompt: transcript, maxTokens: 400, timeoutMs: 60000 })

      if (r.isAnswered) recap = r.text.trim()
      else $.ui.toast(`Не удалось пересказать: ${r.reason}`)
    }
  } catch (error) {
    $.ui.toast(`Не удалось пересказать: ${String(error).slice(0, 120)}`)
  }

  await update($, data, prev => ({ ...prev, isRecapping: false, recap }))
}

async function autoStep($: EngineInterface, cfg: Config) {
  const now = await $.clock.now()
  const decided: { action: AutoAction } = { action: 'none' }

  await update($, data, prev => {
    decided.action = autoAction({
      autoUntil: prev.autoUntil ?? null,
      now,
      lastAt: prev.lastAt,
      leftMin: prev.leftMin,
      isWorking: prev.isWorking,
      isBusy: prev.busy !== null,
      intervalMs: cfg.intervalMs,
    })

    return decided.action === 'off-expired' || decided.action === 'off-cold' ? { ...prev, autoUntil: null, autoHours: null } : prev
  })

  const { action } = decided

  if (action === 'off-expired') $.ui.toast('Автоподогрев закончился')
  else if (action === 'off-cold') $.ui.toast('Кэш уже остыл, автоподогрев выключен')
  else if (action === 'warm') void warmNow($, cfg, 'auto').catch(() => undefined)
}

async function setLimits($: EngineInterface, windows: readonly SessionRateLimit[]) {
  const limits = toLimits(windows)

  await update($, data, prev => (JSON.stringify(prev.limits) === JSON.stringify(limits) ? prev : { ...prev, limits }))
}

async function refreshLimits($: EngineInterface) {
  const { rateLimits } = await $.session.usage()

  await setLimits($, rateLimits)
}

function ensureTimer($: EngineInterface, cfg: Config) {
  timer ??= $.clock.every(TICK_MS, () => void refresh($, cfg).then(() => autoStep($, cfg)).catch(() => undefined))
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

export const register: Register = (on, options) => {
  const ttlMinutes = typeof options.ttlMinutes === 'number' && options.ttlMinutes >= 1 ? options.ttlMinutes : 5
  const cfg: Config = {
    ttlMs: ttlMinutes * 60000,
    warnMin: Math.min(5, Math.max(1, Math.floor(ttlMinutes / 2))),
    intervalMs: autoIntervalMs(ttlMinutes * 60000),
  }

  on('session.start', async ($, e, next) => {
    ensureTimer($, cfg)
    await refreshLimits($).catch(() => undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await setLimits($, e.rateLimits).catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    await update($, data, () => INITIAL)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, data, prev => ({ ...prev, isWorking: true, recap: null }))
    const result = await next(e)

    if (result.drop !== undefined) {
      await update($, data, prev => ({ ...prev, isWorking: false }))
    }
    await refresh($, cfg).catch(() => undefined)

    return result
  })

  on('turn.start', async ($, e, next) => {
    ensureTimer($, cfg)
    await update($, data, prev => ({ ...prev, isWorking: true }))
    await refresh($, cfg).catch(() => undefined)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    ensureTimer($, cfg)
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage

    if (usage !== null) {
      await update($, data, prev => ({
        ...prev,
        lastAt: startedAt,
        ctx: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
        isHidden: false,
      }))
      await refresh($, cfg).catch(() => undefined)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, data, prev => ({ ...prev, isWorking: false }))
      await refresh($, cfg).catch(() => undefined)
      await refreshLimits($).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const d = await read($, data)
    const now = await $.clock.now()
    const { fiveHour, sevenDay } = d.limits
    const hasCache = d.isWorking || d.lastAt !== null
    const autoUntil = d.autoUntil ?? null
    const isDue =
      autoUntil === null &&
      !e.props.isWorking && !d.isWorking && !d.isHidden && d.lastAt !== null && d.leftMin !== null && d.leftMin > 0 && d.leftMin <= cfg.warnMin
    const hasRecap = d.isRecapping === true || (d.recap ?? null) !== null
    const hasStrip = d.busy !== null || isDue || hasRecap

    if (!hasCache && fiveHour === null && sevenDay === null && !hasStrip) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const isDesktop = e.surface === 'desktop'

    const meters: Meter[] = []

    if (hasCache) {
      const left = d.leftMin ?? 0

      if (d.isWorking) {
        meters.push({ id: 'ck-cache', label: 'кэш', alt: 'кэш: ход идёт', frac: null, hex: BLUE, themeColor: undefined, text: 'ход идёт', isTextDim: true, extra: '' })
      } else {
        const isCold = left <= 0
        const hex = isCold || left < COOL_RED_MIN ? RED : left <= COOL_YELLOW_MIN ? YELLOW : BLUE
        const themeColor = isCold || left < COOL_RED_MIN ? 'error' : left <= COOL_YELLOW_MIN ? 'warning' : BLUE
        const text = isCold ? 'остыл' : `${left} мин`

        meters.push({
          id: 'ck-cache',
          label: 'кэш',
          alt: `кэш ${text}`,
          frac: isCold ? 0 : left / ttlMinutes,
          hex,
          themeColor,
          text,
          isTextDim: false,
          extra: '',
        })
      }
    }

    const addLimit = (id: string, label: string, name: string, l: UsageLimit, withReset: boolean) => {
      const pct = Math.min(100, Math.max(0, l.pct))
      const hex = fillColor(pct)
      const reset = withReset && l.resetsAt !== null && l.resetsAt > now ? untilText(l.resetsAt - now) : ''

      meters.push({
        id,
        label,
        alt: `${name} ${Math.round(pct)}%`,
        frac: pct / 100,
        hex,
        themeColor: hex,
        text: `${Math.round(pct)}%`,
        isTextDim: false,
        extra: reset,
      })
    }

    if (fiveHour !== null) addLimit('ck-5h', '5ч', '5-часовой лимит', fiveHour, true)
    if (sevenDay !== null) addLimit('ck-7d', 'нед', 'недельный лимит', sevenDay, false)

    const widthOf = (withBars: boolean) =>
      meters.reduce(
        (sum, m) => sum + m.label.length + 1 + (withBars && m.frac !== null ? BAR_CELLS + 1 : 0) + m.text.length + (m.extra === '' ? 0 : m.extra.length + 1),
        0,
      ) +
      3 * Math.max(0, meters.length - 1)
    const enableAuto = async () => {
      const labels = AUTO_HOURS.map(h => hoursLabel(h, cfg.intervalMs))
      let answer: string | undefined

      try {
        answer = await $.ui.ask('На сколько включить автоподогрев кэша?', { header: 'Автоподогрев', options: labels })
      } catch {
        return
      }

      const hours = AUTO_HOURS[labels.indexOf(answer)]

      if (hours === undefined) return
      const at = await $.clock.now()

      await update($, data, prev => ({ ...prev, autoUntil: at + hours * 3600000, autoHours: hours }))
      $.ui.toast(`Автоподогрев включён на ${hours} ч`)
    }

    const disableAuto = async () => {
      await update($, data, prev => ({ ...prev, autoUntil: null, autoHours: null }))
      $.ui.toast('Автоподогрев выключен')
    }

    const hasBars = isDesktop || widthOf(true) <= e.props.bodyColumns

    const Svg = isDesktop ? $.ui.resolve(e).Svg : undefined

    const meterRow =
      meters.length === 0 ? null : (
        <Box flexDirection="row" columnGap={3} rowGap={1} flexWrap="wrap">
          {meters.map((m, i) => (
            <Box key={m.id} flexDirection="row" alignItems="center" columnGap={i === 0 ? 2 : 1} flexShrink={0}>
              {i === 0 ? (
                <Box width={8} flexShrink={0}>
                  <Text dimColor>{m.label}</Text>
                </Box>
              ) : (
                <Text dimColor>{m.label}</Text>
              )}
              {hasBars && m.frac !== null ? (
                Svg !== undefined ? (
                  <Svg source={svgBar(m.frac, m.hex)} alt={m.alt} width={SVG_W} height={SVG_H} />
                ) : (
                  <Text>
                    <Text color={m.themeColor}>{'█'.repeat(cellCount(m.frac))}</Text>
                    <Text color="inactive">{'░'.repeat(BAR_CELLS - cellCount(m.frac))}</Text>
                  </Text>
                )
              ) : null}
              {m.isTextDim ? (
                <Text dimColor>{m.text}</Text>
              ) : m.id === 'ck-cache' ? (
                <Text color={m.themeColor}>{m.text}</Text>
              ) : (
                <Text>{m.text}</Text>
              )}
              {m.extra === '' ? null : <Text dimColor>{m.extra}</Text>}
            </Box>
          ))}
          {/* Авто and Где мы sit together; Где мы is the row's main action, drawn as Desktop's primary button. */}
          <Box key="ck-actions" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {autoUntil !== null ? (
              <Box flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
                <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
                  <Text dimColor>авто</Text>
                  <Text bold>{untilText(autoUntil - now)}</Text>
                </Box>
                <Button key="auto-off" label="Выключить" onPress={() => void disableAuto()} />
              </Box>
            ) : d.lastAt !== null ? (
              <Button key="auto-on" label="Авто" onPress={() => void enableAuto()} />
            ) : null}
            {d.lastAt !== null && !d.isWorking && !e.props.isWorking && d.isRecapping !== true ? (
              <Button key="recap" label="Где мы" variant="primary" onPress={() => void recapNow($)} />
            ) : null}
          </Box>
        </Box>
      )

    let strip: ReturnType<typeof Box> | null = null

    if (d.busy !== null) {
      strip = (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box width={8} flexShrink={0}>
            <Text dimColor>кэш</Text>
          </Box>
          <Text>{d.busy === 'warm' ? 'подогреваю...' : 'сжимаю контекст...'}</Text>
        </Box>
      )
    } else if (isDue) {
      const setBusy = (busy: CacheKeeperData['busy']) => update($, data, prev => ({ ...prev, busy }))

      const compact = async () => {
        await setBusy('compact')

        try {
          const r = await $.session.compact()

          if (r.skip !== undefined) {
            $.ui.toast(`Сжатие пропущено: ${r.skip}`)
          } else {
            await update($, data, prev => ({ ...prev, lastAt: null, ctx: r.tokensAfter ?? null, isHidden: false }))
          }
        } catch (error) {
          $.ui.toast(`Не удалось сжать контекст: ${String(error).slice(0, 120)}`)
        }

        await setBusy(null)
        await refresh($, cfg).catch(() => undefined)
      }

      strip = (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box width={8} flexShrink={0}>
            <Text dimColor>кэш</Text>
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={4} flexShrink={0}>
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              <Text>остынет через</Text>
              <Text bold>{String(d.leftMin)}</Text>
              <Text>мин</Text>
            </Box>
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              <Text dimColor>следующий ход перечитает</Text>
              <Text bold>{`~${tokens(d.ctx ?? 0)}`}</Text>
              <Text dimColor>токенов</Text>
            </Box>
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Button key="warm" label="Подогреть" onPress={() => void warmNow($, cfg, 'manual')} />
            <Button key="compact" label="Сжать" onPress={() => void compact()} />
            <Button
              key="hide"
              label="Скрыть"
              onPress={() => void update($, data, prev => ({ ...prev, isHidden: true }))}
            />
          </Box>
        </Box>
      )
    }

    const recapRow = !hasRecap ? null : (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>где мы</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {d.isRecapping === true ? <Text dimColor>пересказываю...</Text> : <Text>{d.recap ?? ''}</Text>}
        </Box>
        {d.isRecapping === true ? null : (
          <Button key="recap-hide" label="Скрыть" onPress={() => void update($, data, prev => ({ ...prev, recap: null }))} />
        )}
      </Box>
    )

    if (meterRow === null && strip === null && recapRow === null) return next(e)

    // The band is shared: our temporary rows go above what other mods draw, the meters stay last.
    const rest = await next(e)
    const rows = [recapRow, strip, isModRow(rest) ? rest : null, meterRow].filter(r => r !== null)

    if (rows.length === 1 && meterRow !== null) return rest ? <Box flexDirection="column" rowGap="xs">{rest}{meterRow}</Box> : meterRow

    return (
      <Box flexDirection="column">
        {rows.flatMap((row, i) => (i === 0 ? [row] : [divider($, e), row]))}
        {isModRow(rest) ? null : rest}
      </Box>
    )
  })
}
