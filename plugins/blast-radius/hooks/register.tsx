// Based on anthropics/claude-code-playground mods/blast-radius (Apache-2.0), reworked:
// the report is a card in the AbovePrompt band, and a button press also lets the held
// command past the auto mode classifier (tool.check), so the command runs at once.
//
// tool.call (Bash): if the command is risky, measure what it would change, show a card
// with three buttons and hold the call for up to 90 s. A press on the main button lets it
// run; "Отмена" refuses it. If the person does not answer, presses "Отложить", or another
// command is already held, the command is not run: it goes to the deletion queue
// (~/.claude/blast-radius/queue.json, shared by every session) and the agent gets a deny
// at once. The person later runs or rejects it in the "Очередь удалений" pane (/deletions),
// and the mod runs it itself and tells the agent that asked.
// tool.check (Bash): a call the person confirmed by the button is allowed outright.
//
// Holding: a hook has 10 s of its own time, and $.clock.sleep spends it, but time inside
// any other `$` call is free. So the hold waits on a short `$.process.run` sleep until a
// button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are spelled
// literally, and helpers that take `$` are top-level functions.

import type { Elements, EngineInterface, Register, RenderInput } from 'claude-code'

import { CD_SCRIPT, SCAN_SCRIPT, SNAPSHOT_SCRIPT, classify, countFiles, formatSize, isInsideDir, isPureCommand, normalizeFsPath, parseScan, plural, riskTitle, rmReport, summaryText, RUN_ACTION } from './classify'
import type { Group, Line, Report, Risk } from './classify'

const POLL_SECONDS = '0.3'
const HOLD_LIMIT_MS = 90 * 1000
const QUEUE_POLL_MS = 4000
const RESULT_TRIES = 5
const LOCK_TRIES = 60
const LOCK_STALE_MS = 30 * 1000
const RUN_TIMEOUT_MS = 120 * 1000
const OUTPUT_TAIL = 500
const COMMAND_LINES = 3
const LIST_MAX = 10
const FILES_SHOWN = 8
const ORANGE = '#ff9f43'
const TRACK = 'rgba(128,128,128,0.3)'
const GRAY = 'rgba(128,128,128,0.8)'
const GIT_USR = 'C:/Program Files/Git/usr/bin'
const PANE = 'deletions'
const PANE_TITLE = 'Очередь удалений'

type Decision = 'proceed' | 'cancel' | 'later' | 'timeout' | 'interrupted' | 'error' | 'skip'

type Held = { command: string; risk: Risk; report: Report | null; decision: Decision | null; isExpanded: boolean }

// The call being held, or null. One at a time: a second risky call goes straight to the queue.
let held: Held | null = null

// tool_use_id of the calls the person confirmed with the button, waiting for their tool.check.
const approved = new Set<string>()

// ---- The deletion queue -------------------------------------------------------

type Status = 'pending' | 'done' | 'failed' | 'rejected'

type QueueItem = {
  id: number
  command: string
  /** Where the command runs: the session folder the held call had. */
  cwd: string
  sessionId: string
  agentId?: string
  /** The agent that gave the command works in a git worktree of its own, so `cwd` (the session's) is not where it ran. */
  isWorktree?: true
  riskLabel: string
  riskTitle: string
  summary: string
  /** False when the summary is only the risk label (the call was queued without measuring). */
  isMeasured: boolean
  createdAt: number
  /** The moment the targets were last seen as the agent meant them: files changed after it are a warning. Equals createdAt. */
  snapshotAt: number
  /** For rm: the paths that existed when it was queued. A path that appears later is a change too. */
  existing?: string[]
  status: Status
  resolvedAt?: number
  /** The tail of stdout and stderr, at most OUTPUT_TAIL characters. */
  output?: string
  exitCode?: number
  /** True once the agent that asked has been told how it ended. */
  reported: boolean
  /** Set while a process runs the command, so a second press (here or in another session) does not start it again. */
  runningSince?: number
}

type Queue = { nextId: number; items: QueueItem[] }

type QueueWhy = 'timeout' | 'later' | 'busy'

// The last queue read, for the line above the prompt (the pane reads the file itself).
let cache: QueueItem[] = []

// Commands the mod runs right now, so a double click starts one process.
const running = new Set<number>()

// Items being told to the agent right now, how often it failed, and the ones already told
// (kept apart from the file, so a failed write of `reported` does not make the note go twice).
const reporting = new Set<number>()
const reportTries = new Map<number, number>()
const delivered = new Set<string>()

// Every session id this process has had: /clear gives a new one, and the answers to the old ones still belong here.
const knownSessions = new Set<string>()

// The PATH of the engine has no Git's usr/bin, so a command run by the mod gets it first, as the helper scripts do.
const PATH_FIRST = 'export PATH="/usr/bin:$PATH"\n'

// The report of each pending item, measured when the pane opens or on the button; null while measuring.
const reports = new Map<number, Report | null>()
const expanded = new Set<number>()

// Why a queued command was not run yet: something changed after it was queued. The second press ("Удалить всё равно") runs it.
const warnings = new Map<number, string>

let pollTimer: { cancel: () => void } | undefined
let isPaneFocused = false

// ---- The shell for the helper scripts ---------------------------------------

type Shell = { bash: string; sleep: string[] }

let shell: Shell | undefined

// The engine's PATH may put WSL's bash.exe or the Windows find first, so Git Bash is used by its path.
async function findShell($: EngineInterface): Promise<Shell> {
  if (shell !== undefined) return shell

  const hasGit = await $.fs.exists(`${GIT_USR}/bash.exe`).catch(() => false)

  shell = hasGit ? { bash: `${GIT_USR}/bash.exe`, sleep: [`${GIT_USR}/sleep.exe`, POLL_SECONDS] } : { bash: 'bash', sleep: ['sleep', POLL_SECONDS] }

  return shell
}

async function pause($: EngineInterface) {
  const { sleep } = await findShell($)

  await $.process.run(sleep, { timeoutMs: 5000 })
}

async function resolveDir($: EngineInterface, sessionCwd: string, dir: string): Promise<string | null> {
  if (dir === '-') return null // `cd -` depends on the shell's history

  const { bash } = await findShell($)
  const run = await $.process.run([bash, '-c', CD_SCRIPT, 'blast-radius', dir], { cwd: sessionCwd, timeoutMs: 5000 })
  const out = run.stdout.trim()

  return run.exitCode === 0 && out !== '' ? out : null
}

// ---- Measuring ---------------------------------------------------------------

const plain = (lead: string, strong = '', note = '', lines: Line[] = [], more = 0): Report => ({
  lead,
  strong,
  tail: '',
  scan: null,
  lines,
  more,
  note,
  action: RUN_ACTION,
})

/** A report that says there is nothing to lose: the call goes on without a card. */
const empty = (report: Report): Report => ({ ...report, isEmpty: true })

/** Never throws: a failed read is said, not hidden. */
async function measure($: EngineInterface, risk: Risk, sessionCwd: string): Promise<Report> {
  try {
    const cwd = risk.dir === null ? sessionCwd : await resolveDir($, sessionCwd, risk.dir)

    if (cwd === null) return plain('Не удалось оценить последствия', '', `Папка ${risk.dir} не найдена, поэтому не видно, что изменится.`)
    if (risk.kind === 'rm') return await measureRm($, risk.targets, cwd)
    if (risk.kind === 'migrate') return await measureMigrations($, risk, cwd)

    return await measureGit($, risk, cwd)
  } catch (error) {
    return plain('Не удалось оценить последствия', '', String((error as Error)?.message ?? error).slice(0, 200))
  }
}

async function measureRm($: EngineInterface, targets: string[], cwd: string): Promise<Report> {
  if (targets.length === 0) return empty(plain('Путей нет', '', 'Удалять нечего.'))

  const { bash } = await findShell($)
  const run = await $.process.run([bash, '-c', SCAN_SCRIPT, 'blast-radius', ...targets], { cwd, timeoutMs: 30000 })

  return rmReport(parseScan(run.stdout), targets)
}

const STATUS_WORDS: Record<string, string> = { M: 'изменён', A: 'добавлен', D: 'удалён', R: 'переименован', C: 'скопирован', U: 'конфликт', T: 'тип изменён' }

async function measureGit($: EngineInterface, risk: Exclude<Risk, { kind: 'rm' | 'migrate' }>, cwd: string): Promise<Report> {
  if (risk.kind === 'git-push-force') return await measurePush($, risk.args, cwd)

  if (risk.kind === 'git-clean') {
    const flags: string[] = []
    const paths: string[] = []

    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i] ?? ''

      if (a === '--') {
        paths.push(...risk.args.slice(i + 1))
        break
      }
      if (a === '-e' || a === '--exclude') {
        flags.push(a, risk.args[i + 1] ?? '')
        i += 1
      } else if (a.startsWith('--exclude=') || /^-e./.test(a)) {
        flags.push(a)
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, '') // -n is added below; -f, -i and -q would change the dry run

        if (kept !== '-') flags.push(kept)
      } else if (!a.startsWith('-')) {
        paths.push(a)
      }
    }

    const run = await $.process.run(['git', '-c', 'core.quotepath=false', 'clean', '-n', ...flags, '--', ...paths], { cwd, timeoutMs: 15000 })

    if (run.exitCode !== 0) return plain('Не удалось оценить последствия', '', run.stderr.trim().slice(0, 200))

    const gone = run.stdout.split('\n').filter(l => l.startsWith('Would remove ')).map(l => l.slice(13).replace(/\r$/, ''))

    if (gone.length === 0) return empty(plain('Ничего не удалится', '', 'Подходящих неотслеживаемых файлов нет.'))

    return plain(
      'Будет удалено',
      `${gone.length} ${plural(gone.length, 'неотслеживаемый путь', 'неотслеживаемых пути', 'неотслеживаемых путей')}`,
      'Этих файлов нет в git, восстановить их нельзя.',
      gone.slice(0, LIST_MAX).map(text => ({ text })),
      Math.max(0, gone.length - LIST_MAX),
    )
  }

  const status = await $.process.run(['git', '-c', 'core.quotepath=false', 'status', '--porcelain'], { cwd, timeoutMs: 15000 })

  if (status.exitCode !== 0) return plain('Не удалось оценить последствия', '', status.stderr.trim().slice(0, 200))

  const rows = status.stdout.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 3 && !l.startsWith('??'))
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === 'git-reset' ? rows : rows.filter(l => l[1] !== ' ')

  if (lost.length === 0) return empty(plain('Ничего не потеряется', '', 'Незакоммиченных изменений нет.'))

  return plain(
    'Будут потеряны правки в',
    `${lost.length} ${plural(lost.length, 'файле', 'файлах', 'файлах')}`,
    'Незакоммиченные правки восстановить нельзя.',
    lost.slice(0, LIST_MAX).map(l => {
      const code = l[1] !== ' ' ? l[1] : l[0]

      return { text: l.slice(3), tag: STATUS_WORDS[code ?? ''] }
    }),
    Math.max(0, lost.length - LIST_MAX),
  )
}

async function measurePush($: EngineInterface, args: string[], cwd: string): Promise<Report> {
  const positional = args.filter(a => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  const [spec0, spec1] = spec.includes(':') ? spec.split(':') : [spec, spec]
  let source = spec0 ?? ''
  let branch = (spec1 ?? '').replace(/^refs\/heads\//, '')

  if (!branch || branch === 'HEAD') {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10000 })

    branch = head.stdout.trim()
    source = 'HEAD'
  }
  source = source || 'HEAD'

  const ref = `${remote}/${branch}`
  const known = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd, timeoutMs: 10000 })

  if (known.exitCode !== 0) {
    return plain('Принудительная отправка в', ref, `Локальной копии ${ref} нет, поэтому не видно, какие коммиты пропадут. Сначала выполни git fetch.`)
  }

  const log = await $.process.run(['git', 'log', '--oneline', '--no-decorate', `${source}..${ref}`], { cwd, timeoutMs: 15000 })
  const dropped = log.stdout.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l !== '')

  if (dropped.length === 0) return empty(plain('Принудительная отправка в', ref, 'Коммиты не пропадут.'))

  return plain(
    `Пропадут из ${ref}`,
    `${dropped.length} ${plural(dropped.length, 'коммит', 'коммита', 'коммитов')}`,
    `Коммиты из ${ref}, которых нет в ${source}, по состоянию на последний fetch.`,
    dropped.slice(0, LIST_MAX).map(text => ({ text })),
    Math.max(0, dropped.length - LIST_MAX),
  )
}

type Lister = { argv: string[]; isPending: (l: string) => boolean; strip: (l: string) => string }

const MIGRATION_LISTERS: Record<string, Lister> = {
  django: { argv: ['python3', 'manage.py', 'showmigrations', '--plan'], isPending: l => l.startsWith('[ ]'), strip: l => l.slice(4) },
  alembic: { argv: ['alembic', 'history', '-r', 'current:head'], isPending: l => l.includes('->'), strip: l => l },
  rails: { argv: ['bin/rails', 'db:migrate:status'], isPending: l => /^\s*down\b/.test(l), strip: l => l.trim() },
  prisma: { argv: ['npx', '--no-install', 'prisma', 'migrate', 'status'], isPending: l => /^\s{2}\S/.test(l), strip: l => l.trim() },
}

async function measureMigrations($: EngineInterface, risk: Extract<Risk, { kind: 'migrate' }>, cwd: string): Promise<Report> {
  const lister = MIGRATION_LISTERS[risk.tool]

  if (lister === undefined) return plain('Будут запущены миграции', '', 'Для этого инструмента список ожидающих миграций получить нельзя.')

  let run: { exitCode: number; stdout: string }

  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 })
  } catch {
    run = { exitCode: -1, stdout: '' }
  }
  if (run.exitCode !== 0) return plain(`Будет запущено ${risk.label}`, '', `Список ожидающих миграций получить не удалось (${lister.argv.join(' ')}).`)

  const pending = run.stdout.split('\n').map(l => l.replace(/\r$/, '')).filter(lister.isPending).map(lister.strip)

  if (pending.length === 0) return empty(plain('Применять нечего', '', 'Ожидающих миграций нет.'))

  return plain(
    'Будет применено',
    `${pending.length} ${plural(pending.length, 'миграция', 'миграции', 'миграций')}`,
    '',
    pending.slice(0, LIST_MAX).map(text => ({ text })),
    Math.max(0, pending.length - LIST_MAX),
  )
}

// ---- Drawing -----------------------------------------------------------------

const BAR_CELLS = 6
const BAR_W = 72

const svgBar = (frac: number, color: string, thick: number) => {
  const f = Math.min(1, Math.max(0, frac))
  const fill = f > 0 ? Math.min(BAR_W, Math.max(2, Math.round(f * BAR_W))) : 0

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${thick}" viewBox="0 0 ${BAR_W} ${thick}">` +
    `<clipPath id="c"><rect width="${BAR_W}" height="${thick}" rx="${thick / 2}"/></clipPath>` +
    `<g clip-path="url(#c)"><rect width="${BAR_W}" height="${thick}" fill="${TRACK}"/>` +
    `<rect width="${fill}" height="${thick}" fill="${color}"/></g></svg>`
  )
}

// next(e) answers the engine's own placeholder ({ type: 'engine' }) when no mod below drew a row:
// it shows nothing, so there is no row to put a divider against.
const isModRow = (rest: unknown) => Boolean(rest) && (rest as { type?: unknown }).type !== 'engine'

const divider = ($: EngineInterface, e: RenderInput<'AbovePrompt'>) => {
  const els = $.ui.resolve(e)

  if (e.surface === 'desktop' && 'Svg' in els) {
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

type Drawing = RenderInput<'AbovePrompt'> | RenderInput<'Pane'>

type ReportView = { isExpanded: boolean; setExpanded: (value: boolean) => void }

/** The body of a report: what it says, the files and bars, "Показать ещё", the note. Shared by the card and the pane. */
const drawReport = ($: EngineInterface, e: Drawing, report: Report, view: ReportView): JSX.Element[] => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isDesktop = e.surface === 'desktop'
  const Svg = isDesktop ? $.ui.resolve(e).Svg : undefined
  const hasBars = isDesktop || (e.props.bodyColumns ?? 0) >= 60

  const bar = (key: string, frac: number, color: string, themeColor: string | undefined, thick: number) => {
    if (!hasBars) return null

    if (Svg !== undefined) {
      return (
        <Box key={key} flexShrink={0}>
          <Svg source={svgBar(frac, color, thick)} alt="доля по размеру" width={BAR_W} height={thick} />
        </Box>
      )
    }

    const cells = frac > 0 ? Math.min(BAR_CELLS, Math.max(1, Math.round(frac * BAR_CELLS))) : 0

    return (
      <Box key={key} flexShrink={0}>
        <Text>
          <Text color={themeColor}>{'█'.repeat(cells)}</Text>
          <Text color="inactive">{'░'.repeat(BAR_CELLS - cells)}</Text>
        </Text>
      </Box>
    )
  }

  const sizeCell = (key: string, bytes: number, isBold: boolean) => (
    <Box key={key} width={9} flexShrink={0} justifyContent="flex-end">
      <Text bold={isBold}>{formatSize(bytes)}</Text>
    </Box>
  )

  const body: JSX.Element[] = []
  const { scan } = report
  let moreButton: JSX.Element | null = null

  if (scan !== null) {
    const maxGroup = Math.max(1, ...scan.groups.map(g => g.bytes))
    const maxFile = Math.max(1, ...scan.groups.flatMap(g => g.items.map(i => i.bytes)))
    const listed = scan.groups.reduce((sum, g) => sum + g.items.length, 0)
    let left = view.isExpanded ? Number.POSITIVE_INFINITY : FILES_SHOWN
    let isAllShown = true

    scan.groups.forEach((g: Group, gi) => {
      if (left <= 0) {
        isAllShown = false

        return
      }

      const items = g.items.slice(0, left)

      left -= items.length
      if (items.length < g.items.length) isAllShown = false

      body.push(
        <Box key={`g${gi}`} flexDirection="row" alignItems="center" columnGap={2}>
          <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-start">{g.label}</Text>
            </Box>
            <Text dimColor>{countFiles(g.files)}</Text>
          </Box>
          {sizeCell(`gs${gi}`, g.bytes, true)}
          {bar(`gb${gi}`, g.bytes / maxGroup, ORANGE, ORANGE, 6)}
        </Box>,
      )
      items.forEach((it, ii) => {
        body.push(
          <Box key={`f${gi}-${ii}`} flexDirection="row" alignItems="center" columnGap={2}>
            <Box paddingLeft={2} flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-middle">{it.name}</Text>
            </Box>
            {sizeCell(`fs${gi}-${ii}`, it.bytes, false)}
            {bar(`fb${gi}-${ii}`, it.bytes / maxFile, GRAY, undefined, 4)}
          </Box>,
        )
      })

      const unlisted = g.files - g.items.length

      if (items.length === g.items.length && unlisted > 0) {
        body.push(
          <Box key={`gm${gi}`} paddingLeft={2}>
            <Text dimColor>{`и ещё ${countFiles(unlisted)}`}</Text>
          </Box>,
        )
      }
    })

    if (isAllShown && scan.otherFiles > 0) {
      body.push(
        <Box key="other" flexDirection="row" columnGap={1}>
          <Text dimColor>{`и ещё ${countFiles(scan.otherFiles)} в других папках`}</Text>
          <Text dimColor>{`· ${formatSize(scan.otherBytes)}`}</Text>
        </Box>,
      )
    }

    const hidden = listed - (view.isExpanded ? listed : Math.min(listed, FILES_SHOWN))

    if (!view.isExpanded && hidden > 0) {
      moreButton = (
        <Button
          key="more"
          label={`Показать ещё ${hidden}`}
          onPress={() => {
            view.setExpanded(true)
            $.ui.invalidate('ui.render')
          }}
        />
      )
    } else if (view.isExpanded && listed > FILES_SHOWN) {
      moreButton = (
        <Button
          key="less"
          label="Свернуть"
          onPress={() => {
            view.setExpanded(false)
            $.ui.invalidate('ui.render')
          }}
        />
      )
    }
  }

  report.lines.forEach((line, i) => {
    body.push(
      <Box key={`l${i}`} flexDirection="row" columnGap={2}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{line.text}</Text>
        </Box>
        {line.tag ? <Text dimColor>{line.tag}</Text> : null}
      </Box>,
    )
  })
  if (report.more > 0) {
    body.push(
      <Text key="more-lines" dimColor>
        {`и ещё ${report.more}`}
      </Text>,
    )
  }

  return [
    <Box key="lead" marginTop={1} flexDirection="row" columnGap={1}>
      <Text>{report.lead}</Text>
      {report.strong === '' ? null : <Text bold>{report.strong}</Text>}
      {report.tail === '' ? null : <Text dimColor>{report.tail}</Text>}
    </Box>,
    body.length === 0 ? null : (
      <Box key="body" marginTop={1} flexDirection="column">
        {body}
      </Box>
    ),
    moreButton === null ? null : (
      <Box key="expand" marginTop={1} flexDirection="row">
        {moreButton}
      </Box>
    ),
    report.note === '' ? null : (
      <Box key="note" marginTop={1}>
        <Text dimColor wrap="wrap">
          {report.note}
        </Text>
      </Box>
    ),
  ].filter((part): part is JSX.Element => part !== null)
}

const draw = ($: EngineInterface, e: RenderInput<'AbovePrompt'>, state: Held, report: Report) => {
  const { Box, Text, Button } = $.ui.resolve(e)

  const decide = (choice: Decision) => () => {
    if (state.decision === null) state.decision = choice
  }

  const command = state.command.replace(/\s+/g, ' ').trim()
  const view: ReportView = {
    isExpanded: state.isExpanded,
    setExpanded: value => {
      state.isExpanded = value
    },
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={2}>
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>{riskTitle(state.risk)}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {command}
          </Text>
        </Box>
      </Box>
      {drawReport($, e, report, view)}
      <Box marginTop={1} flexDirection="row" alignItems="center" columnGap={3}>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Button key="proceed" variant="primary" label={report.action} onPress={decide('proceed')} />
          <Button key="later" label="Отложить" onPress={decide('later')} />
          <Button key="cancel" label="Отмена" onPress={decide('cancel')} />
        </Box>
        <Text dimColor>Ждёт твоего решения 90 секунд</Text>
      </Box>
    </Box>
  )
}

// ---- Queue file --------------------------------------------------------------

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const two = (n: number) => String(n).padStart(2, '0')

const timeText = (ts: number, now: number) => {
  const d = new Date(ts)
  const n = new Date(now)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  const isToday = d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear()

  return isToday ? hm : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${hm}`
}

/** The last two segments of a folder path. */
const folderText = (cwd: string) => cwd.replace(/\\/g, '/').split('/').filter(part => part !== '').slice(-2).join('/')

const tailOf = (text: string) => {
  const t = text.replace(/\r/g, '').trim()

  return t.length > OUTPUT_TAIL ? t.slice(-OUTPUT_TAIL) : t
}

const signature = (items: QueueItem[]) => items.map(i => `${i.id}:${i.status}:${i.reported}:${i.runningSince ?? ''}`).join('|')

/** The file says a process runs it: another session's, or ours. */
const isClaimed = (item: QueueItem, now: number) => item.runningSince !== undefined && now - item.runningSince < RUN_TIMEOUT_MS + 30000

const isBusyNow = (item: QueueItem, now: number) => running.has(item.id) || isClaimed(item, now)

/** Ids differ between files that were deleted and made again, so the creation time joins them. */
const itemKey = (item: QueueItem) => `${item.id}@${item.createdAt}`

let queueFile: string | undefined

// One file for every session, so it is read again at each use, never kept: another Claude may have changed it.
async function queuePath($: EngineInterface): Promise<string> {
  if (queueFile !== undefined) return queueFile

  const profile = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  if (profile === undefined || profile === '') throw new Error('Не найдена домашняя папка')

  queueFile = `${profile.replace(/\\/g, '/').replace(/\/$/, '')}/.claude/blast-radius/queue.json`

  return queueFile
}

/** A half-written file (another session is writing) is read again a moment later; throws if it stays unreadable. */
async function readQueue($: EngineInterface): Promise<Queue> {
  const file = await queuePath($)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await $.fs.exists(file))) return { nextId: 1, items: [] }

    try {
      const raw = await $.fs.read(file)

      if (raw.trim() === '') return { nextId: 1, items: [] }

      const parsed = JSON.parse(raw) as Partial<Queue>

      if (Array.isArray(parsed.items)) {
        const top = parsed.items.reduce((max, i) => Math.max(max, i.id), 0)

        return { nextId: Math.max(parsed.nextId ?? 1, top + 1), items: parsed.items }
      }
    } catch {
      // read again below
    }
    await pause($)
  }

  throw new Error('Не удалось прочитать очередь удалений')
}

// The lock is a folder next to queue.json: mkdir (without -p) is atomic, so one process gets it.
// Git Bash's mkdir and rmdir are used, and /usr/bin goes first on PATH like in the other scripts.
const LOCK_MAKE = 'PATH="/usr/bin:$PATH"; mkdir -p -- "${1%/*}" && mkdir -- "$1"'
const LOCK_DROP = 'PATH="/usr/bin:$PATH"; rmdir -- "$1"'

async function withLock<T>($: EngineInterface, work: () => Promise<T>): Promise<T> {
  const lock = `${await queuePath($)}.lock`
  const { bash } = await findShell($)
  let isLocked = false

  for (let attempt = 0; attempt < LOCK_TRIES && !isLocked; attempt += 1) {
    const made = await $.process.run([bash, '-c', LOCK_MAKE, 'blast-radius', lock], { timeoutMs: 5000 })

    if (made.exitCode === 0) {
      isLocked = true
    } else {
      const stat = await $.fs.stat(lock).catch(() => undefined)

      // A lock left by a process that died: older than LOCK_STALE_MS, so it is removed and the next pass takes it.
      if (stat !== undefined && stat.mtimeMs > 0 && (await $.clock.now()) - stat.mtimeMs > LOCK_STALE_MS) {
        await $.process.run([bash, '-c', LOCK_DROP, 'blast-radius', lock], { timeoutMs: 5000 })
      } else {
        await pause($)
      }
    }
  }
  if (!isLocked) throw new Error('Очередь удалений занята другой сессией')

  try {
    return await work()
  } finally {
    await $.process.run([bash, '-c', LOCK_DROP, 'blast-radius', lock], { timeoutMs: 5000 }).catch(() => undefined)
  }
}

// Every change goes through this chain, one at a time in this process, and through the lock between processes.
let mutations: Promise<unknown> = Promise.resolve()

function mutate($: EngineInterface, change: (queue: Queue) => void): Promise<Queue> {
  const done = mutations.then(() =>
    withLock($, async () => {
      const queue = await readQueue($)

      change(queue)
      await $.fs.write(await queuePath($), JSON.stringify(queue, null, 2))
      cache = queue.items

      return queue
    }),
  )

  mutations = done.catch(() => undefined)

  return done
}

async function loadQueue($: EngineInterface): Promise<QueueItem[]> {
  try {
    const queue = await readQueue($)

    cache = queue.items

    return queue.items
  } catch {
    return cache
  }
}

// ---- Putting a command in the queue ---------------------------------------------

const WHY_QUEUED: Record<QueueWhy, string> = {
  timeout: 'пользователь не ответил за 90 секунд',
  later: 'пользователь нажал «Отложить»',
  busy: 'пока ждала ответа другая команда',
}

/** Writes the command to the queue and answers the agent with the deny that says what happened. */
async function queueCommand(
  $: EngineInterface,
  e: { command: string; agentId?: string },
  risk: Risk,
  cwd: string,
  summary: string,
  why: QueueWhy,
  isMeasured: boolean,
): Promise<{ deny: string }> {
  try {
    const sessionId = await $.session.id()
    const made = { id: 0 }

    knownSessions.add(sessionId)

    const isWorktree = await isWorktreeAgent($, e.agentId)
    // Measured in the session's folder, which is not the worktree the agent ran in.
    const said = isWorktree ? `${risk.label}, последствия не посчитаны: папка worktree неизвестна` : summary

    // The paths that exist now, taken just before the stamp: whatever appears or changes after it is a warning later.
    let existing: string[] | undefined

    if (risk.kind === 'rm' && !isWorktree) existing = (await scanTargets($, risk, cwd, undefined).catch(() => null))?.existing

    const createdAt = await $.clock.now()

    await mutate($, queue => {
      made.id = queue.nextId
      queue.nextId += 1
      queue.items.push({
        id: made.id,
        command: e.command,
        cwd,
        sessionId,
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
        ...(isWorktree ? { isWorktree: true as const } : {}),
        riskLabel: risk.label,
        riskTitle: riskTitle(risk),
        summary: said,
        isMeasured: isMeasured && !isWorktree,
        createdAt,
        snapshotAt: createdAt,
        ...(existing === undefined ? {} : { existing }),
        status: 'pending',
        reported: false,
      })
    })
    $.ui.invalidate('ui.render')

    return {
      deny: `blast-radius отложил эту команду в очередь удалений (#${made.id}): ${WHY_QUEUED[why]}. Команда не выполнена. Продолжай остальную работу, не повторяй её и не удаляй это другим способом. Пользователь просмотрит очередь, и мод выполнит команду сам. В итоговом отчёте упомяни, что удаление #${made.id} ждёт подтверждения. Последствия: ${said}.${isWorktree ? ' Команда из отдельного worktree: при повторной постановке используй абсолютные пути.' : ''}`,
    }
  } catch {
    return {
      deny: `blast-radius не смог записать команду в очередь удалений, поэтому она не выполнена. Не повторяй её без просьбы пользователя. Последствия, которые команда имела бы: ${summary}.`,
    }
  }
}

// ---- Subagents in a worktree ---------------------------------------------------------

// The Agent calls made with isolation "worktree": the caller's id and the call's description, which
// $.agent.list() gives back as the agent's description. The API gives no folder for such an agent.
const worktreeSpawns = new Set<string>()

const spawnKey = (parentId: string | undefined, description: string) => `${parentId ?? ''}\n${description}`

/** True if the agent, or one of its ancestors, was started with isolation "worktree"; unknown agents count once any such call was made. */
async function isWorktreeAgent($: EngineInterface, agentId: string | undefined): Promise<boolean> {
  if (agentId === undefined || worktreeSpawns.size === 0) return false

  try {
    const list = await $.agent.list()
    let current = list.find(a => a.id === agentId)

    if (current === undefined) return true

    for (let depth = 0; current !== undefined && depth < 20; depth += 1) {
      if (worktreeSpawns.has(spawnKey(current.parentId, current.description))) return true

      const parentId: string | undefined = current.parentId

      current = parentId === undefined ? undefined : list.find(a => a.id === parentId)
    }

    return false
  } catch {
    return true
  }
}

const ABSOLUTE_PATH = /^(\/|~|[A-Za-z]:)/

const MIXED_TEXT = 'Составная команда: опасная часть смешана с другими действиями, мод её не запустит. Выполни части вручную или отклони'
const WORKTREE_TEXT = 'Субагент работал в отдельном worktree, папку не определить. Удали вручную или отклони'

/**
 * Why the mod must not run an item, or null if it may. A mixed command (from an older version of the mod)
 * would run its other parts with it. A worktree item may run only when it is an rm whose paths are all
 * absolute: the folder it runs in does not matter then.
 */
function blockReason(item: QueueItem): string | null {
  if (!isPureCommand(item.command)) return MIXED_TEXT
  if (item.isWorktree !== true) return null

  const risk = classify(item.command)

  // A second segment (`rm -rf /abs; rm -rf src`) is not what classify looked at.
  if (/[;&|\n`]|\$\(/.test(item.command)) return WORKTREE_TEXT

  return risk !== null && risk.kind === 'rm' && risk.targets.length > 0 && risk.targets.every(t => ABSOLUTE_PATH.test(t)) ? null : WORKTREE_TEXT
}

const canRunItem = (item: QueueItem) => blockReason(item) === null

// ---- What changed after a command was queued -------------------------------------------

/** The folder an rm or a git command runs in: the session's, or where its own `cd` leads; null if that folder is gone. */
const commandDir = ($: EngineInterface, risk: Risk, sessionCwd: string) =>
  risk.dir === null ? Promise.resolve(sessionCwd) : resolveDir($, sessionCwd, risk.dir)

/** True if every target of the rm lies below the system TEMP (never TEMP itself or its parent): nothing there is worth a card. */
async function isInsideTemp($: EngineInterface, risk: Extract<Risk, { kind: 'rm' }>, sessionCwd: string): Promise<boolean> {
  if (risk.targets.length === 0) return false

  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))

  if (temp === undefined || temp === '') return false

  const cwd = await commandDir($, risk, sessionCwd)

  if (cwd === null) return false

  const root = normalizeFsPath(temp)

  for (const target of risk.targets) {
    if (/[$`]/.test(target)) return false // a variable or a substitution: the path is not known

    let path = target

    if (path === '~' || path.startsWith('~/')) {
      const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

      if (home === undefined || home === '') return false

      path = `${home}${path.slice(1)}`
    } else if (path.startsWith('~')) {
      return false
    }

    let abs = normalizeFsPath(/^([/\\]|[A-Za-z]:)/.test(path) ? path : `${cwd}/${path}`)

    // Git Bash maps /tmp to the user's TEMP.
    if (abs === '/tmp' || abs.startsWith('/tmp/')) abs = `${root}${abs.slice(4)}`
    if (!isInsideDir(abs, root)) return false
  }

  return true
}

/** The paths an rm names that exist now and, given a moment, the first one modified after it (SNAPSHOT_SCRIPT). Null if the folder is gone. */
async function scanTargets(
  $: EngineInterface,
  risk: Extract<Risk, { kind: 'rm' }>,
  sessionCwd: string,
  since: number | undefined,
): Promise<{ existing: string[]; changed: string | null } | null> {
  const cwd = await commandDir($, risk, sessionCwd)

  if (cwd === null) return null

  const { bash } = await findShell($)
  const seconds = since === undefined ? '' : String(Math.floor(since / 1000))
  const run = await $.process.run([bash, '-c', SNAPSHOT_SCRIPT, 'blast-radius', seconds, ...risk.targets], { cwd, timeoutMs: 30000 })

  if (run.exitCode !== 0) throw new Error(run.stderr.trim().slice(0, 120) || 'не удалось прочитать цели')

  const existing: string[] = []
  let changed: string | null = null

  for (const line of run.stdout.split('\n')) {
    const row = line.replace(/\r$/, '')

    if (row.startsWith('E\t')) existing.push(row.slice(2))
    else if (row.startsWith('N\t') && changed === null) changed = row.slice(2).replace(/^\.\//, '')
  }

  return { existing, changed }
}

/** What differs from the moment the command was queued, in words for the warning; null if nothing does. */
async function changesSince($: EngineInterface, item: QueueItem): Promise<string | null> {
  const risk = classify(item.command)

  if (risk === null) return null

  if (risk.kind === 'rm') {
    const scan = await scanTargets($, risk, item.cwd, item.snapshotAt ?? item.createdAt)

    if (scan === null) return null

    const before = new Set(item.existing ?? scan.existing)
    const added = scan.existing.find(path => !before.has(path))

    if (added !== undefined) return `${added} (новая цель)`

    return scan.changed
  }

  // A call queued without measuring has no summary of the time to compare with.
  if (item.isMeasured !== true) return null

  const now = summaryText(await measure($, risk, item.cwd))

  return now === item.summary ? null : `было «${item.summary}», стало «${now}»`
}

// ---- Resolving a queued command ----------------------------------------------------

async function runItem($: EngineInterface, id: number, isForced = false) {
  if (running.has(id)) return

  const known = cache.find(i => i.id === id)
  const blocked = known === undefined ? null : blockReason(known)

  if (blocked !== null) {
    $.ui.toast(`Удаление #${id}: мод не запустит эту команду`)

    return
  }

  // `running` is already ours here, so the claim in the file looks at the file's runningSince alone.
  running.add(id)

  let isStarted = false

  try {
    if (!isForced && known !== undefined) {
      let changed: string | null

      try {
        changed = await changesSince($, known)
      } catch (error) {
        changed = `не удалось проверить (${clip(String((error as Error)?.message ?? error), 80)})`
      }
      if (changed !== null) {
        warnings.set(id, changed)
        $.ui.invalidate('ui.render')

        return
      }
    }
    warnings.delete(id)

    const startedAt = await $.clock.now()
    const claim: { item?: QueueItem } = {}

    await mutate($, queue => {
      const found = queue.items.find(i => i.id === id)

      if (found === undefined || found.status !== 'pending' || isClaimed(found, startedAt)) return

      found.runningSince = startedAt
      claim.item = { ...found }
    })

    const { item } = claim

    if (item === undefined) {
      $.ui.toast(`Удаление #${id} уже обработано`)

      return
    }
    $.ui.invalidate('ui.render')

    let exitCode = -1
    let output = ''

    // From here the command may have run, so runningSince stays in the file whatever happens next.
    isStarted = true

    try {
      const { bash } = await findShell($)
      const run = await $.process.run([bash, '-c', `${PATH_FIRST}${item.command}`], { cwd: item.cwd, timeoutMs: RUN_TIMEOUT_MS })

      exitCode = run.exitCode
      output = tailOf(`${run.stdout}${run.stderr}`)
    } catch (error) {
      output = tailOf(String((error as Error)?.message ?? error))
    }

    const resolvedAt = await $.clock.now()
    const status: Status = exitCode === 0 ? 'done' : 'failed'

    for (let attempt = 1; ; attempt += 1) {
      try {
        await mutate($, queue => {
          const found = queue.items.find(i => i.id === id)

          if (found === undefined) return

          found.status = status
          found.resolvedAt = resolvedAt
          found.exitCode = exitCode
          found.output = output
          delete found.runningSince
        })
        break
      } catch (error) {
        if (attempt >= RESULT_TRIES) throw error
        await pause($)
      }
    }
    $.ui.toast(status === 'done' ? `Удаление #${id} выполнено` : `Удаление #${id}: ошибка, код выхода ${exitCode}`)
    $.ui.invalidate('ui.render')
    await reportResolved($, await loadQueue($))
  } catch (error) {
    if (!isStarted) {
      await mutate($, queue => {
        const found = queue.items.find(i => i.id === id)

        if (found !== undefined) delete found.runningSince
      }).catch(() => undefined)
    }
    $.ui.toast(
      isStarted
        ? `Удаление #${id}: команда уже запускалась, но результат не записан в очередь (${clip(String((error as Error)?.message ?? error), 80)})`
        : `Удаление #${id}: ${clip(String((error as Error)?.message ?? error), 120)}`,
    )
    $.ui.invalidate('ui.render')
  } finally {
    running.delete(id)
  }
}

async function rejectItem($: EngineInterface, id: number) {
  const now = await $.clock.now()

  await mutate($, queue => {
    const found = queue.items.find(i => i.id === id)

    if (found === undefined || found.status !== 'pending' || isBusyNow(found, now)) return

    found.status = 'rejected'
    found.resolvedAt = now
  })
  $.ui.toast(`Удаление #${id} отклонено`)
  $.ui.invalidate('ui.render')
  await reportResolved($, await loadQueue($))
}

async function clearResolved($: EngineInterface) {
  await mutate($, queue => {
    // A decision the agent has not been told yet stays, so the note still reaches it.
    queue.items = queue.items.filter(i => i.status === 'pending' || !i.reported)
  })
  $.ui.invalidate('ui.render')
}

// ---- Telling the agent --------------------------------------------------------------

function noteText(item: QueueItem): string {
  const command = clip(oneLine(item.command), 300)

  if (item.status === 'rejected') {
    return `Пользователь отклонил удаление #${item.id} из очереди blast-radius, команда не выполнена: ${command}. Не выполняй её и не удаляй это другим способом.`
  }

  const base = `Пользователь подтвердил удаление #${item.id} из очереди blast-radius, мод выполнил: ${command}. Код выхода ${item.exitCode ?? -1}.`

  return item.status === 'failed' && item.output ? `${base} Команда завершилась с ошибкой. Вывод: ${clip(oneLine(item.output), 300)}` : base
}

/** Appends the note to the agent that asked if it still works, else to the main conversation; true if a row was stored. */
async function notifyAgent($: EngineInterface, item: QueueItem): Promise<boolean> {
  const content = [{ type: 'text' as const, text: noteText(item) }]

  if (item.agentId !== undefined) {
    const agentId = item.agentId
    const isAlive = await $.agent
      .list()
      .then(list => list.some(a => a.id === agentId && a.status !== 'completed' && a.status !== 'failed' && a.status !== 'killed'))
      .catch(() => false)

    if (isAlive) {
      const sent = await $.session.append({ message: { type: 'user', content }, agentId }).catch(() => undefined)

      if (sent !== undefined && sent.deny === undefined) return true
    }
  }

  const sent = await $.session.append({ message: { type: 'user', content } }).catch(() => undefined)

  return sent !== undefined && sent.deny === undefined
}

/** Tells this session's agents about the items that were resolved, here or in another session; never throws. */
async function reportResolved($: EngineInterface, items: QueueItem[]) {
  try {
    knownSessions.add(await $.session.id())

    const due = items.filter(i => i.status !== 'pending' && !i.reported && knownSessions.has(i.sessionId) && !reporting.has(i.id))

    for (const item of due) {
      // Told already, but the write of `reported` failed: only the write is made again.
      const isTold = delivered.has(itemKey(item))

      reporting.add(item.id)

      try {
        const isSent = isTold || (await notifyAgent($, item))
        const tries = (reportTries.get(item.id) ?? 0) + 1

        if (isSent) delivered.add(itemKey(item))
        reportTries.set(item.id, tries)
        if (isSent || tries >= 3) {
          reportTries.delete(item.id)
          await mutate($, queue => {
            const found = queue.items.find(i => i.id === item.id)

            if (found !== undefined) found.reported = true
          })
        }
      } catch {
        // the next pass tries again
      } finally {
        reporting.delete(item.id)
      }
    }
  } catch {
    // nothing to tell, or the queue is unreadable right now
  }
}

async function tick($: EngineInterface) {
  const before = signature(cache)
  const items = await loadQueue($)

  if (signature(items) !== before) $.ui.invalidate('ui.render')
  await reportResolved($, items)
}

// ---- The pane ----------------------------------------------------------------------

async function openPane($: EngineInterface) {
  reports.clear()
  await loadQueue($)
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

/** Measures a pending item once; the pane shows the cached report, and "Пересчитать" drops the cache. */
function ensureReport($: EngineInterface, item: QueueItem) {
  if (reports.has(item.id)) return

  reports.set(item.id, null)
  void (async () => {
    const risk = classify(item.command)
    const report = risk === null ? plain('Не удалось оценить последствия', '', 'Команда больше не похожа на опасную.') : await measure($, risk, item.cwd)

    reports.set(item.id, report)
    $.ui.invalidate('ui.render')
  })().catch(() => undefined)
}

const STATUS_TEXT: Record<Exclude<Status, 'pending'>, string> = { done: 'выполнено', failed: 'ошибка', rejected: 'отклонено' }

const pendingCard = ($: EngineInterface, e: RenderInput<'Pane'>, item: QueueItem, now: number) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const report = reports.get(item.id) ?? null
  const isRunning = isBusyNow(item, now)
  // The frame (border and padding) takes 6 columns and the title of the risk with its gap the rest of the row:
  // the command is cut by its length too, so it stays within COMMAND_LINES lines whatever the surface lays out.
  const commandChars = Math.max(20, e.props.bodyColumns - 6 - item.riskTitle.length - 2)
  const blocked = blockReason(item)
  const isRunnable = blocked === null
  const warning = warnings.get(item.id)
  const view: ReportView = {
    isExpanded: expanded.has(item.id),
    setExpanded: value => {
      if (value) expanded.add(item.id)
      else expanded.delete(item.id)
    },
  }

  return (
    <Box key={`item-${item.id}`} flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={2} marginBottom={1}>
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Text bold>{`#${item.id}`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{timeText(item.createdAt, now)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{clip(folderText(item.cwd), 30)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{item.agentId === undefined ? 'главная сессия' : 'субагент'}</Text>
        </Box>
      </Box>
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Text dimColor>{item.riskTitle}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="wrap">{clip(oneLine(item.command), commandChars * COMMAND_LINES)}</Text>
        </Box>
      </Box>
      {!isRunnable ? (
        <Box marginTop={1} flexDirection="column">
          <Text>{item.summary}</Text>
          <Text dimColor wrap="wrap">
            {blocked}
          </Text>
        </Box>
      ) : report === null ? (
        <Box marginTop={1}>
          <Text dimColor>Считаю последствия…</Text>
        </Box>
      ) : (
        drawReport($, e, report, view)
      )}
      {warning === undefined || !isRunnable ? null : (
        <Box marginTop={1}>
          <Text color={ORANGE} wrap="wrap">{`Изменилось после постановки в очередь: ${warning}`}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="row" alignItems="center" columnGap={1}>
        {isRunning ? (
          <Text dimColor>Выполняется…</Text>
        ) : isRunnable ? (
          <Button
            key={`run-${item.id}`}
            variant="primary"
            label={warning === undefined ? 'Удалить' : 'Удалить всё равно'}
            onPress={() => void runItem($, item.id, warning !== undefined).catch(() => undefined)}
          />
        ) : null}
        {isRunning ? null : <Button key={`reject-${item.id}`} label="Отклонить" onPress={() => void rejectItem($, item.id).catch(() => undefined)} />}
      </Box>
    </Box>
  )
}

const resolvedRow = ($: EngineInterface, e: RenderInput<'Pane'>, item: QueueItem, now: number) => {
  const { Box, Text } = $.ui.resolve(e)
  const word = item.status === 'pending' ? '' : STATUS_TEXT[item.status]
  const code = item.status === 'failed' && item.exitCode !== undefined ? ` (код ${item.exitCode})` : ''
  const meta = `#${item.id}  ${timeText(item.resolvedAt ?? item.createdAt, now)}  ${word}${code}`
  const columns = e.props.bodyColumns

  return (
    <Box key={`done-${item.id}`} flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Text dimColor>{meta}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {clip(oneLine(item.command), Math.max(20, columns - meta.length - 2))}
          </Text>
        </Box>
      </Box>
      {item.status === 'failed' && item.output ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {clip(oneLine(item.output), Math.max(20, Math.min(160, columns - 2)))}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

// ---- Hooks -------------------------------------------------------------------

const WHY: Record<Exclude<Decision, 'proceed' | 'later' | 'timeout' | 'skip'>, string> = {
  cancel: 'Пользователь нажал «Отмена»',
  interrupted: 'Ход был прерван',
  error: 'blast-radius получил ошибку, пока держал команду',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'deletions', description: 'Очередь удалений: отложенные опасные команды, которые ждут твоего решения' }).catch(() => undefined)
    knownSessions.add(await $.session.id().catch(() => ''))

    pollTimer ??= $.clock.every(QUEUE_POLL_MS, () => void tick($).catch(() => undefined))
    void tick($).catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)

    pollTimer?.cancel()
    pollTimer = undefined

    return next(e)
  })

  on('command.run', { command: 'deletions' }, async $ => {
    await openPane($)

    return { text: 'Очередь удалений открыта.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await reportResolved($, await loadQueue($))

    return next(e)
  })

  // Remembers a worktree subagent's call before next(e): a foreground agent works inside next. Nothing is held or changed.
  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    if (e.isolation === 'worktree') worktreeSpawns.add(spawnKey(e.agentId, e.description))

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const risk = classify(e.command)

    if (risk === null) return next(e)

    // A risky part mixed with other work cannot be held or queued: confirming it would run the rest too.
    if (!isPureCommand(e.command)) {
      return {
        deny: `blast-radius не выполнил эту команду: опасная операция (${risk.label}) смешана с другими действиями. Выполни остальные части отдельной командой сейчас, а удаление отдельной чистой командой без других действий, тогда его можно будет подтвердить или отложить в очередь. Ничего из этой команды не выполнено.`,
      }
    }

    const cwd = await $.session.cwd()

    // Deleting inside the system TEMP is not worth a card.
    if (risk.kind === 'rm' && (await isInsideTemp($, risk, cwd).catch(() => false))) return next(e)

    // One hold at a time. If another risky call is already held (a subagent's, say), this one
    // does not wait for it: it goes to the queue at once, so parallel subagents don't pile up.
    // `held` is claimed with no await between the check and the claim, so two calls can't both hold.
    if (held !== null) {
      // Not measured: that can take long, and the pane measures it when the person opens the queue.
      return await queueCommand($, e, risk, cwd, `${risk.label}, последствия посчитает панель очереди`, 'busy', false)
    }

    const mine: Held = { command: e.command, risk, report: null, decision: null, isExpanded: false }

    held = mine

    let decision: Decision | null = null
    let summary = risk.label

    try {
      const report = await measure($, risk, cwd)

      summary = summaryText(report)

      // Nothing to lose: no card, the call goes on as if it were safe.
      if (report.isEmpty === true) mine.decision = 'skip'
      else mine.report = report

      $.ui.invalidate('ui.render')

      const startedAt = await $.clock.now()

      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = 'interrupted'
          break
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = 'timeout'
          break
        }
        await pause($)
      }
    } catch {
      mine.decision = 'error' // anything unexpected refuses the command
    } finally {
      decision = mine.decision
      if (held === mine) held = null
      $.ui.invalidate('ui.render')
    }

    if (decision === 'proceed') {
      // The press is the person's go-ahead: the tool.check that next(e) raises lets this one call past the mode,
      // so the id must be in place before next(e), not after it.
      approved.add(e.tool_use_id)

      try {
        return await next(e)
      } finally {
        approved.delete(e.tool_use_id)
      }
    }

    if (decision === 'skip') return next(e)

    if (decision === 'timeout' || decision === 'later') return await queueCommand($, e, risk, cwd, summary, decision, true)

    return {
      deny: `blast-radius держал эту команду и не выполнил её. ${WHY[decision ?? 'error']}. Последствия, которые команда имела бы: ${summary}. Не повторяй её без просьбы пользователя.`,
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'blast-radius: не удалось проверить команду, она не выполнена. Не повторяй её без просьбы пользователя.' },
  )

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool_use_id === undefined || !approved.delete(e.tool_use_id)) return next(e)

    const below = await next(e)

    // A deny from a settings rule still stands: the button answers the mode's question, not the rules'.
    return below.decision === 'deny' ? below : { decision: 'allow', reason: 'blast-radius: пользователь подтвердил кнопкой' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = held

    if (e.props.hasSurvey) return next(e)

    let top: JSX.Element | null = null

    if (state !== null) {
      if (state.report !== null) top = draw($, e, state, state.report)
    } else {
      const count = cache.filter(i => i.status === 'pending').length

      if (count > 0) {
        const { Box, Text, Button } = $.ui.resolve(e)

        top = (
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Text color={ORANGE}>{`В очереди ${count} ${plural(count, 'удаление', 'удаления', 'удалений')}`}</Text>
            <Button key="open-queue" label="Открыть" onPress={() => void openPane($).catch(() => undefined)} />
          </Box>
        )
      }
    }

    if (top === null) return next(e)

    const { Box } = $.ui.resolve(e)
    // The band is shared: our row goes above what other mods draw.
    const rest = await next(e)

    return (
      <Box flexDirection="column">
        {top}
        {isModRow(rest) ? divider($, e) : null}
        {rest}
      </Box>
    )
  })

  // On Desktop a click that moves the focus ring redraws the pane, the Button gets a new handle,
  // and the press arrives under the old one and is dropped. Keeping the ring where it is makes the first click press.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) =>
    e.origin.kind === 'person' && e.element !== undefined ? {} : next(e),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A first click into the pane flips isFocused and the engine redraws while the mouse is still down:
    // holding this drawing back a moment lets the click land on the drawing it was made on.
    const gainsFocus = e.props.isFocused && !isPaneFocused

    isPaneFocused = e.props.isFocused
    if (gainsFocus) await $.clock.sleep(400)

    const { Box, Text, Button } = $.ui.resolve(e) as Elements['terminal']
    const now = await $.clock.now()
    const items = await loadQueue($)
    const pending = items.filter(i => i.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
    // A decision the agent has not been told yet is kept in the file but not shown.
    const resolved = items.filter(i => i.status !== 'pending' && i.reported).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))

    for (const item of pending) if (canRunItem(item)) ensureReport($, item)

    if (pending.length === 0 && resolved.length === 0) return <Text dimColor>Очередь пуста</Text>

    return (
      <Box flexDirection="column">
        {pending.length === 0 ? (
          <Box marginBottom={1}>
            <Text dimColor>Ожидающих удалений нет</Text>
          </Box>
        ) : (
          <Box flexDirection="row" alignItems="center" columnGap={2} marginBottom={1}>
            <Text bold>{`Ждут решения: ${pending.length}`}</Text>
            <Button
              key="remeasure"
              label="Пересчитать последствия"
              onPress={() => {
                reports.clear()
                $.ui.invalidate('ui.render')
              }}
            />
          </Box>
        )}
        {pending.map(item => pendingCard($, e, item, now))}
        {resolved.length === 0 ? null : (
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="center" columnGap={2} marginBottom={1}>
              <Text dimColor>Решённые</Text>
              <Button key="clear" label="Очистить решённые" onPress={() => void clearResolved($).catch(() => undefined)} />
            </Box>
            {resolved.map(item => resolvedRow($, e, item, now))}
          </Box>
        )}
      </Box>
    )
  })
}
