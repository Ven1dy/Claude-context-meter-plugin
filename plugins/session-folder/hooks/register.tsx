import type { EngineInterface, Register } from 'claude-code'

import type { SessionFolderData } from '../types/index'

const INITIAL: SessionFolderData = { start: null, cwd: null, branch: null }

const dataRef = { plugin: 'session-folder', key: 'data' } as const

const norm = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')

const same = (a: string, b: string) => norm(a).toLowerCase() === norm(b).toLowerCase()

// The path from the home folder (`~/work/site`), or the whole path when it lies outside it.
const folderLabel = (path: string, home: string | undefined) => {
  const p = norm(path)
  const root = home === undefined || home === '' ? undefined : norm(home)

  if (root === undefined) return p
  if (p.toLowerCase() === root.toLowerCase()) return '~'
  if (p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return `~/${p.slice(root.length + 1)}`

  return p
}

const readBranch = async ($: EngineInterface, cwd: string) => {
  try {
    const ran = await $.process.run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const name = ran.stdout.trim()

    return ran.exitCode === 0 && name !== '' ? name : null
  } catch {
    return null
  }
}

const apply = async ($: EngineInterface, cwd: string, startHint?: string) => {
  const branch = await readBranch($, cwd)
  const { value: prev = INITIAL } = await $.state.get(dataRef)
  const start = prev.start ?? startHint ?? cwd

  if (prev.start === start && prev.cwd === cwd && prev.branch === branch) return

  await $.state.set(dataRef, { start, cwd, branch })
}

const refresh = async ($: EngineInterface) => apply($, await $.session.cwd())

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void apply($, e.cwd, e.cwd).catch(() => undefined)

    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    void apply($, e.new_cwd).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { value: data = INITIAL } = await $.state.get(dataRef)
    if (data.cwd === null || data.start === null) return next(e)

    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const isMoved = !same(data.cwd, data.start)
    const label = isMoved
      ? `папка сменилась: ${folderLabel(data.cwd, home)} (была ${folderLabel(data.start, home)})`
      : data.branch === null
        ? folderLabel(data.cwd, home)
        : `${folderLabel(data.cwd, home)} · ${data.branch}`

    // The terminal draws the modes list; Desktop does not (checked 2026-10-13), so there the label is our own Text.
    if (e.surface !== 'desktop') return next({ ...e, props: { ...e.props, modes: [...e.props.modes, isMoved ? `⚠ ${label}` : label] } })

    const { Box, Text } = $.ui.resolve(e)
    const rest = await next(e)
    const own = isMoved ? <Text color="warning">{label}</Text> : <Text dimColor>{label}</Text>

    return (
      <Box flexDirection="row" columnGap={2}>
        {own}
        {rest}
      </Box>
    )
  })
}
