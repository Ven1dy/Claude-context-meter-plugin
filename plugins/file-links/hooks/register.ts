import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { linkify, MAX_TRACKED, normalize, resolveFile } from './linkify'
import type { Env, LinkStyle, Resolve, StatKind } from './linkify'

const filesRef = { plugin: 'file-links', key: 'files' } as const
const dirsRef = { plugin: 'file-links', key: 'dirs' } as const
// The Desktop file pane resolves links from the folder the session started in, not from a cwd moved later by `cd`.
const baseRef = { plugin: 'file-links', key: 'base' } as const
const askedRef = { plugin: 'file-links', key: 'asked' } as const

const REQUEST_DIRECTORY = 'mcp__ccd_directory__request_directory'
const MAX_FOLDERS_PER_TURN = 3

const TRACKED_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const MAX_STATS_PER_BLOCK = 20
const MAX_CACHE = 1000
const FOUND_TTL_MS = 60_000
const MISSING_TTL_MS = 10_000
const SETTINGS_TTL_MS = 30_000

type CacheEntry = { file: string | null; stamp: string; at: number }

const cache = new Map<string, CacheEntry>()
let settingsDirs: { at: number; dirs: string[] } = { at: -Infinity, dirs: [] }

const readSettingsDirs = async ($: EngineInterface, now: number, cwd: string) => {
  if (now - settingsDirs.at < SETTINGS_TTL_MS) return settingsDirs.dirs

  const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
  const permissions = settings.permissions as { additionalDirectories?: unknown } | undefined
  const listed = permissions?.additionalDirectories
  const dirs = Array.isArray(listed)
    ? listed.filter((d): d is string => typeof d === 'string').map(d => normalize(/^([A-Za-z]:|[\\/])/.test(d) ? d : `${cwd}/${d}`))
    : []

  settingsDirs = { at: now, dirs }

  return dirs
}

const track = async ($: EngineInterface, path: string) => {
  const abs = normalize(path)
  const lower = abs.toLowerCase()

  await update($, filesRef, files => {
    const list = files ?? []

    return list.some(f => f.toLowerCase() === lower) ? list : [...list, abs].slice(-MAX_TRACKED)
  })
}

const rewrite = async ($: EngineInterface, text: string, style: LinkStyle, collect?: (file: string) => void) => {
  const now = await $.clock.now()
  const current = normalize(await $.session.cwd())
  const { value: base } = await $.state.get(baseRef)
  const cwd = base ? normalize(base) : current
  const { value: files = [] } = await $.state.get(filesRef)
  const { value: added = [] } = await $.state.get(dirsRef)
  const fromSettings = await readSettingsDirs($, now, cwd)
  const dirs = [...new Set([current, ...added, ...fromSettings].map(normalize))].filter(d => d.toLowerCase() !== cwd.toLowerCase())

  let used = 0
  let isExhausted = false

  const stat = async (abs: string): Promise<StatKind | null> => {
    if (used >= MAX_STATS_PER_BLOCK) {
      isExhausted = true

      return null
    }

    used += 1

    const found = await $.fs.stat(abs).catch(() => null)

    return found?.kind === 'file' ? 'file' : found?.kind === 'dir' ? 'dir' : null
  }

  const env: Env = { cwd, dirs, tracked: files, stat }
  const stamp = `${files.length}|${files.at(-1) ?? ''}|${dirs.join(';')}`

  const resolve: Resolve = async (path, mode) => {
    const k = `${cwd}\0${mode}\0${path}`
    const hit = cache.get(k)

    if (hit !== undefined && hit.stamp === stamp && now - hit.at < (hit.file === null ? MISSING_TTL_MS : FOUND_TTL_MS)) {
      return hit.file
    }

    const file = await resolveFile(path, env, mode)

    if (!isExhausted) {
      if (cache.size >= MAX_CACHE) cache.clear()
      cache.set(k, { file, stamp, at: now })
    }

    return file
  }

  return linkify(text, { cwd, dirs, style, resolve, collect })
}

const folderOf = (file: string) => {
  const dir = normalize(file).replace(/\/[^/]*$/, '')

  return /^[A-Za-z]:/.test(dir) ? dir.replaceAll('/', '\\') : dir
}

// Asks Desktop to add the folders of answer files that lie outside the session; every folder once per session.
const requestFolders = async ($: EngineInterface, text: string, style: LinkStyle) => {
  const outside = new Map<string, string>()

  await rewrite($, text, style, file => {
    const dir = folderOf(file)

    outside.set(normalize(dir).toLowerCase(), dir)
  })

  if (outside.size === 0) return

  const { value: asked = [] } = await $.state.get(askedRef)
  const seen = new Set(asked.map(d => normalize(d).toLowerCase()))
  const todo = [...outside].filter(([k]) => !seen.has(k)).slice(0, MAX_FOLDERS_PER_TURN)

  if (todo.length === 0) return
  if (!(await $.tool.list()).some(t => t.name === REQUEST_DIRECTORY)) return

  for (const [, dir] of todo) {
    await update($, askedRef, list => [...(list ?? []), dir])

    const granted = await $.tool.call({ tool: REQUEST_DIRECTORY, path: dir }).catch(() => null)

    if (granted === null || granted.deny !== undefined || granted.isError === true) continue

    const added = normalize(dir)

    await update($, dirsRef, list => {
      const current = list ?? []

      return current.includes(added) ? current : [...current, added]
    })
  }
}

export const register: Register = (on, options) => {
  const style: LinkStyle = options.linkStyle === 'angle' ? 'angle' : 'percent'

  // A hot reload fires session.start again with the current cwd, so keep the first value.
  on('session.start', async ($, e, next) => {
    await update($, baseRef, base => base ?? normalize(e.cwd)).catch(() => undefined)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (TRACKED_TOOLS.has(e.tool)) {
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
      const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path

      if (typeof path === 'string' && path !== '') {
        await track($, path).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('classic.DirectoryAdded', async ($, e, next) => {
    const dir = normalize(e.directory)

    await update($, dirsRef, dirs => {
      const list = dirs ?? []

      return list.includes(dir) ? list : [...list, dir]
    }).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) {
      // The hook budget is ~10 s and the grant waits for the user, so the request runs detached.
      $.clock.after(0, async () => {
        await requestFolders($, e.answer, style).catch(() => undefined)
      })
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text

    if (!text.includes('`') && !text.includes('](')) return next(e)

    try {
      const linked = await rewrite($, text, style)

      if (linked !== text) return next({ ...e, props: { ...e.props, text: linked } })
    } catch {
      return next(e)
    }

    return next(e)
  })
}
