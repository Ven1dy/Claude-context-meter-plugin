import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { ContextFill, ContextPart, ContextParts, TurnEntry } from '../types'

const BAR_CELLS = 10
const SVG_W = 96
const SVG_H = 8
const TURNS_MAX = 300
const PREVIEW_CHARS = 60
const WARN_PERCENT = 30
const HISTORY_COMMAND = 'context-history'
const HISTORY_PANE = 'context-history'
const HISTORY_TITLE = 'История контекста'
const DELTA_W = 64
const WIDE_W = 160
const BLUE = '#4ea1ff'
const GREEN = '#3fb68b'
const YELLOW = '#e0a526'
const RED = '#e5534b'
const TRACK = 'rgba(128,128,128,0.3)'
// Цвета категорий по порядку размера, близко к легенде /context.
const PALETTE = ['#4ea1ff', '#e8803a', '#3fb68b', '#e0a526', '#a371f7', '#e5534b', '#39c5cf', '#8b949e']

// История живёт в состоянии сессии: уходит вместе с сессией, а /clear обнуляет её явно.
const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null)
const turns = atom({ plugin: 'context-meter', key: 'turns' } as const, [])
const warned = atom({ plugin: 'context-meter', key: 'warned' } as const, false)
// Разбивка по категориям и её снимок на начало последнего сообщения — для «▲ +6K».
const parts = atom({ plugin: 'context-meter', key: 'parts' } as const, null)
const partsBase = atom({ plugin: 'context-meter', key: 'partsBase' } as const, null)

const fillColor = (pct: number) => (pct >= 80 ? RED : pct >= 60 ? YELLOW : BLUE)

const tokens = (n: number) => (n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}K`)

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${tokens(Math.abs(n))}`

const deltaOf = (t: TurnEntry) => (t.before !== null && t.after !== null ? t.after - t.before : null)

const preview = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line || '(без текста)'
}

const toFill = (c: SessionContextUsage): ContextFill => {
  const percent = c.percent ?? (c.tokens !== undefined && c.window > 0 ? Math.round((c.tokens / c.window) * 100) : null)

  return { tokens: c.tokens ?? null, window: c.window, percent }
}

const svgBar = (frac: number, color: string, width = SVG_W) => {
  const f = Math.min(1, Math.max(0, frac))
  const w = f > 0 ? Math.min(width, Math.max(2, Math.round(f * width))) : 0

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SVG_H}" viewBox="0 0 ${width} ${SVG_H}">` +
    `<clipPath id="c"><rect width="${width}" height="${SVG_H}" rx="${SVG_H / 2}"/></clipPath>` +
    `<g clip-path="url(#c)"><rect width="${width}" height="${SVG_H}" fill="${TRACK}"/>` +
    `<rect width="${w}" height="${SVG_H}" fill="${color}"/></g></svg>`
  )
}

const cellCount = (frac: number) => {
  const f = Math.min(1, Math.max(0, frac))

  return f > 0 ? Math.min(BAR_CELLS, Math.max(1, Math.round(f * BAR_CELLS))) : 0
}

// Сводка истории: сколько сообщений и общий прирост.
const historySummary = (list: TurnEntry[]) => {
  const messages = list.filter(t => !t.compact)

  if (messages.length === 0) return null

  const total = messages.reduce((sum, t) => sum + (deltaOf(t) ?? 0), 0)

  return `${messages.length} · прирост ${signed(total)}`
}

// Полоска: картинкой там, где поверхность рисует SVG (десктоп), иначе клетками —
// символы вроде ▬ на десктопе шире клетки и наезжают на соседние колонки.
const meter = (els: ElementTable, frac: number, color: string, px: number) => {
  const { Text } = els
  const cells = Math.max(1, Math.round(px / 8))
  const f = Math.min(1, Math.max(0, frac))
  const on = f > 0 ? Math.min(cells, Math.max(1, Math.round(f * cells))) : 0

  return 'Svg' in els ? (
    <els.Svg source={svgBar(f, color, px)} alt={`${Math.round(f * 100)}%`} width={px} height={SVG_H} />
  ) : (
    <Text>
      <Text color={color}>{'█'.repeat(on)}</Text>
      <Text color="inactive">{'░'.repeat(cells - on)}</Text>
    </Text>
  )
}

// Токены с десятыми до 100K, как в /context: иначе мелкие категории сливаются в «1K».
const tokens1 = (n: number) => (n < 100000 && n >= 100 ? `${(n / 1000).toFixed(1)}K` : tokens(n))

// Разбивка /context в оценке summary: локальная, без запроса к API.
async function refreshParts($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const b = context.breakdown

  if (!b) return

  const next: ContextParts = { cats: b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })), total: b.totalTokens, window: b.rawMaxTokens }

  await update($, parts, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
}

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === HISTORY_PANE)

// Номер сообщения для каждой строки: сжатия не нумеруются.
const numbered = (list: TurnEntry[]) => {
  let n = 0

  return list.map(t => ({ t, n: t.compact ? 0 : (n += 1) }))
}

// Порог: одна подсказка и звук при переходе через WARN_PERCENT; ниже порога (после сжатия) снова взводится.
async function checkWarn($: EngineInterface, percent: number | null) {
  if (percent === null) return

  const was = await read($, warned)

  if (percent < WARN_PERCENT) {
    if (was) await update($, warned, () => false)

    return
  }

  if (was) return

  await update($, warned, () => true)
  $.ui.toast(`Контекст заполнен на ${percent}% — можно сделать /compact`)
  await $.audio.play({ asset: 'sounds/ping.wav' }).catch(() => undefined)
}

async function setFill($: EngineInterface, c: SessionContextUsage) {
  const next = toFill(c)

  await update($, fill, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))

  // Каждый ответ модели в ходе двигает «после» у последнего сообщения.
  if (next.tokens !== null) {
    const now = next.tokens

    await update($, turns, prev => {
      const last = prev[prev.length - 1]

      if (!last || last.compact || last.after === now) return prev

      return [...prev.slice(0, -1), { ...last, after: now }]
    })
  }

  await checkWarn($, next.percent)
}

async function refresh($: EngineInterface) {
  await setFill($, (await $.session.usage()).context)
}

// В VS Code замер после ответа (session.measure) до мода доходит не всегда:
// заполнение ещё и опрашиваем по таймеру, оценка локальная.
const POLL_MS = 5000
let poll: { cancel: () => void } | undefined

const ensurePoll = ($: EngineInterface) => {
  poll ??= $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))
}

async function startTurn($: EngineInterface, text: string) {
  const before = (await read($, fill))?.tokens ?? null
  const p = await read($, parts)

  await update($, partsBase, () => (p ? Object.fromEntries(p.cats.filter(c => c.kind === 'used').map(c => [c.name, c.tokens])) : null))

  await update($, turns, prev => [...prev, { text: preview(text), before, after: null }].slice(-TURNS_MAX))
}

// Полная оценка /context: системный промпт, инструменты и переписка.
const measureTotal = async ($: EngineInterface) => {
  const { context } = await $.session.usage({ breakdown: 'summary' })

  return { context, total: context.breakdown?.totalTokens }
}

// Пока хук сжатия не вернулся, движок держит старую переписку, и /context считает её же.
// Поэтому «было» снимаем до сжатия, а «стало» — когда сжатие закончилось и оценка упала.
const AFTER_MS = 1000
const AFTER_TRIES = 5

async function afterCompact($: EngineInterface, before: number | undefined, saved: number | undefined, tries = AFTER_TRIES): Promise<void> {
  const { context, total } = await measureTotal($)
  const dropped = total !== undefined && before !== undefined && total < before

  if (!dropped && tries > 1) {
    $.clock.after(AFTER_MS, () => void afterCompact($, before, saved, tries - 1).catch(() => undefined))
    return
  }

  // Оценка так и не упала: «стало» — «было» минус то, что сжатие сберегло в переписке
  // (tokensBefore/tokensAfter считают только её).
  const after = dropped ? total : before !== undefined && saved ? before - saved : undefined

  if (before === undefined || after === undefined) return refresh($)

  // Строку в чат не пишем; сжатие видно в панели истории и в полосе над промптом.
  await update($, turns, prev => [...prev, { text: '', before, after, compact: true as const }].slice(-TURNS_MAX))

  const next = { tokens: after, window: context.window, percent: context.window > 0 ? Math.round((after / context.window) * 100) : null }

  await update($, fill, () => next)
  await checkWarn($, next.percent)
}

async function resetSession($: EngineInterface) {
  await update($, turns, () => [])
  await update($, partsBase, () => null)
  await update($, warned, () => false)
}

// next(e) answers the engine's own placeholder ({ type: 'engine' }) when no mod below drew a row.
const isModRow = (rest: unknown) => Boolean(rest) && (rest as { type?: unknown }).type !== 'engine'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: HISTORY_COMMAND, description: 'История контекста: сколько токенов добавило каждое сообщение' }).catch(() => undefined)
    await refresh($).catch(() => undefined)
    ensurePoll($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetSession($).catch(() => undefined)
    else {
      poll?.cancel()
      poll = undefined
    }

    return next(e)
  })

  // Считаем только сообщения человека: слэш-команды и служебные подсказки — не ходы.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    if (!e.command && !e.isMeta && !('drop' in result && result.drop)) await startTurn($, e.text).catch(() => undefined)

    return result
  })

  on('command.run', { command: HISTORY_COMMAND }, async $ => {
    await refreshParts($).catch(() => undefined)
    const opened = await $.ui.open({ id: HISTORY_PANE, title: HISTORY_TITLE })

    return { text: opened.isPlaced ? 'История контекста открыта в панели.' : `Панель истории не показана: ${opened.reason}` }
  })

  // Панель: сверху заполнение и разбивка по категориям, ниже таблица по сообщениям.
  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const list = await read($, turns)
    const f = await read($, fill)
    const p = await read($, parts)
    const base = await read($, partsBase)
    const summary = historySummary(list)
    const maxDelta = Math.max(1, ...list.filter(t => !t.compact).map(t => Math.abs(deltaOf(t) ?? 0)))

    const used = p ? p.cats.filter(c => c.kind === 'used').sort((a, b) => b.tokens - a.tokens) : []
    const usedTotal = used.reduce((sum, c) => sum + c.tokens, 0)
    const free = p?.cats.find(c => c.kind === 'free')?.tokens
    const deferred = p ? p.cats.filter(c => c.kind === 'deferred' && c.tokens > 0) : []
    const now = p?.total ?? f?.tokens ?? null
    const window = p?.window ?? f?.window
    const pct = now !== null && window ? Math.round((now / window) * 100) : null

    // Сколько строк остаётся на таблицу сообщений, когда сверху разбивка.
    const room = Math.max(3, (e.viewport?.rows ?? 40) - 7 - (used.length ? used.length + 3 : 0) - (deferred.length ? 1 : 0))
    const rows = numbered(list).slice(-room)
    const hidden = list.length - rows.length

    const section = (title: string) => (
      <Box marginTop={1}>
        <Text bold dimColor>{title}</Text>
      </Box>
    )

    const head = (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Text bold color={pct === null ? undefined : fillColor(pct)}>{now !== null ? `${tokens(now)}${window ? ` из ${tokens(window)}` : ''}` : '—'}</Text>
        {pct !== null ? <Text dimColor>{`${pct}%`}</Text> : null}
        {pct !== null ? meter(els, pct / 100, fillColor(pct), WIDE_W) : null}
        {free !== undefined ? <Text dimColor>{`свободно ${tokens(free)}`}</Text> : null}
        <Box flexGrow={1} />
        <Button key="history-close" plain onPress={() => void $.ui.close({ id: HISTORY_PANE })}>
          <Text dimColor>✕</Text>
        </Button>
      </Box>
    )

    const category = (c: ContextPart, i: number) => {
      const color = PALETTE[i % PALETTE.length]
      const share = usedTotal > 0 ? c.tokens / usedTotal : 0
      const was = base?.[c.name]
      const diff = was === undefined ? 0 : c.tokens - was

      return (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Text color={color}>■</Text>
          <Box width={18} flexShrink={0}><Text wrap="truncate-end">{c.name}</Text></Box>
          <Box width={6} flexShrink={0} justifyContent="flex-end"><Text>{tokens1(c.tokens)}</Text></Box>
          {meter(els, share, color, SVG_W)}
          <Box width={4} flexShrink={0} justifyContent="flex-end"><Text dimColor>{`${Math.round(share * 100)}%`}</Text></Box>
          {Math.abs(diff) >= 100 ? <Text color={diff > 0 ? YELLOW : GREEN}>{`${diff > 0 ? '▲' : '▼'} ${signed(diff)}`}</Text> : null}
        </Box>
      )
    }

    const columns = (
      <Box flexDirection="row" columnGap={1}>
        <Box width={4} flexShrink={0}><Text dimColor>№</Text></Box>
        <Box width={DELTA_W / 8} flexShrink={0}><Text dimColor> </Text></Box>
        <Box width={7} flexShrink={0}><Text dimColor>прирост</Text></Box>
        <Box width={6} flexShrink={0}><Text dimColor>итого</Text></Box>
        <Text dimColor>сообщение</Text>
      </Box>
    )

    const row = ({ t, n }: { t: TurnEntry; n: number }) => {
      if (t.compact) {
        const saved = t.before !== null && t.after !== null ? ` · −${tokens(Math.max(0, t.before - t.after))}` : ''

        return <Text color={GREEN}>{`  ⇣ сжатие ${t.before !== null ? tokens(t.before) : '?'} → ${t.after !== null ? tokens(t.after) : '?'}${saved}`}</Text>
      }

      const d = deltaOf(t)
      const frac = d === null ? 0 : Math.abs(d) / maxDelta
      const color = d === null ? BLUE : d < 0 ? GREEN : fillColor(Math.round(frac * 100))

      return (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box width={4} flexShrink={0}><Text dimColor>{`${n}.`}</Text></Box>
          <Box width={DELTA_W / 8} flexShrink={0}>{meter(els, frac, color, DELTA_W)}</Box>
          <Box width={7} flexShrink={0}><Text bold={d !== null && d === maxDelta} color={d === null ? 'inactive' : color}>{d === null ? 'идёт…' : signed(d)}</Text></Box>
          <Box width={6} flexShrink={0}><Text dimColor>{t.after !== null ? tokens(t.after) : '—'}</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text wrap="truncate-end">{t.text || '(без текста)'}</Text></Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {head}
        {used.length ? section('ЧТО ЗАНИМАЕТ') : null}
        {used.map(category)}
        {deferred.length ? <Text dimColor>{`  отложено, не в контексте: ${deferred.map(c => `${c.name} ${tokens1(c.tokens)}`).join(' · ')}`}</Text> : null}
        {section(summary ? `ПО СООБЩЕНИЯМ · ${summary}` : 'ПО СООБЩЕНИЯМ')}
        {summary ? columns : <Text dimColor>пока пусто: история начнётся с вашего следующего сообщения</Text>}
        {hidden > 0 ? <Text dimColor>{`  … ещё ${hidden} выше`}</Text> : null}
        {rows.map(row)}
      </Box>
    )
  })

  // Разбивку пересчитываем после ответа модели и только пока панель открыта.
  on('session.measure', async ($, e, next) => {
    await setFill($, e.context).catch(() => undefined)
    if (await isPaneOpen($).catch(() => false)) await refreshParts($).catch(() => undefined)

    return next(e)
  })

  // До следующего ответа модели usage().context держит прежнюю заполненность:
  // размер до и после сжатия берём из полной оценки /context.
  on('session.compact', async ($, e, next) => {
    const main = e.trigger !== 'precompute' && e.agentId === undefined
    const before = main
      ? await measureTotal($).then(
          async m => m.total ?? (await read($, fill))?.tokens ?? undefined,
          () => undefined,
        )
      : undefined
    const result = await next(e)

    if (main && !result.skip) {
      const saved = result.tokensBefore !== undefined && result.tokensAfter !== undefined ? Math.max(0, result.tokensBefore - result.tokensAfter) : undefined

      // «Not enough messages to compact»: сжатие ничего не сберегло — строку не пишем.
      if (saved !== 0) $.clock.after(AFTER_MS, () => void afterCompact($, before, saved).catch(() => undefined))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    ensurePoll($)

    const f = await read($, fill)

    if (f === null) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const list = await read($, turns)
    const pct = f.percent === null ? null : Math.min(100, Math.max(0, f.percent))
    const hex = pct === null ? BLUE : fillColor(pct)
    const pctText = pct === null ? '—' : `${pct}%`
    const amount = f.tokens === null ? `из ${tokens(f.window)}` : `${tokens(f.tokens)} / ${tokens(f.window)}`
    const lastTurn = [...list].reverse().find(t => !t.compact)
    const delta = lastTurn ? deltaOf(lastTurn) : null

    const openContext = () => void $.command.run({ command: 'context' }).catch(err => $.ui.toast(`Не удалось открыть /context: ${String(err).slice(0, 120)}`))
    // Панелью рядом с чатом: модель её не видит, токены не тратятся. Повторное нажатие закрывает.
    const openHistory = async () => {
      const isOpen = (await $.ui.panes()).some(p => p.id === HISTORY_PANE)

      if (isOpen) return $.ui.close({ id: HISTORY_PANE })

      await refreshParts($).catch(() => undefined)

      const opened = await $.ui.open({ id: HISTORY_PANE, title: HISTORY_TITLE, closeOnEscape: true })

      if (!opened.isPlaced) $.ui.toast(`Панель истории не показана: ${opened.reason}`)
    }
    const runCompact = () => void $.command.run({ command: 'compact' }).catch(err => $.ui.toast(`Не удалось запустить /compact: ${String(err).slice(0, 120)}`))
    const runClear = async () => {
      const answer = await $.ui.ask('Начать новую сессию? Текущий разговор будет очищен.', ['Да, очистить', 'Отмена']).catch(() => 'Отмена')

      if (answer !== 'Да, очистить') return

      await $.command.run({ command: 'clear' }).catch(err => $.ui.toast(`Не удалось запустить /clear: ${String(err).slice(0, 120)}`))
    }

    const bar =
      pct === null ? null : 'Svg' in els ? (
        <els.Svg source={svgBar(pct / 100, hex)} alt={`контекст ${pctText}`} width={SVG_W} height={SVG_H} />
      ) : (
        <Text>
          <Text color={hex}>{'█'.repeat(cellCount(pct / 100))}</Text>
          <Text color="inactive">{'░'.repeat(BAR_CELLS - cellCount(pct / 100))}</Text>
        </Text>
      )

    const block = (
      <Box flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>контекст</Text>
        </Box>
        {bar}
        <Button key="context-open" variant="secondary" onPress={openContext}>
          <Text bold color={hex}>{pctText}</Text> <Text dimColor>{amount}</Text>
        </Button>
        {lastTurn ? (
          <Button key="context-history" variant="secondary" onPress={() => void openHistory()}>
            <Text color={delta !== null && delta < 0 ? 'success' : undefined}>{delta === null ? 'ход идёт… · история' : `${signed(delta)} за ход · история`}</Text>
          </Button>
        ) : null}
        <Button key="context-compact" variant="secondary" onPress={runCompact}>
          /compact
        </Button>
        <Button key="context-clear" variant="secondary" onPress={() => void runClear()}>
          /clear
        </Button>
      </Box>
    )

    const rest = await next(e)

    return isModRow(rest) ? (
      <Box flexDirection="column" rowGap="xs">
        {rest}
        {block}
      </Box>
    ) : (
      block
    )
  })
}
