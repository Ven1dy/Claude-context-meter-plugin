export type LinkStyle = 'angle' | 'percent'
export type StatKind = 'file' | 'dir'

export type Env = {
  cwd: string
  dirs: string[]
  tracked: string[]
  stat: (abs: string) => Promise<StatKind | null>
}

export type Candidate = { written: string; path: string }
export type ResolveMode = 'code' | 'link'
export type Resolve = (path: string, mode: ResolveMode) => Promise<string | null>

export const OUTSIDE_NOTE = ' *(вне папок сессии)*'
export const MAX_TRACKED = 2000

const MAX_CANDIDATE = 260
const MAX_LABEL = 500

const COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'node', 'python', 'python3', 'py', 'pip', 'uv', 'git', 'gh',
  'cd', 'ls', 'cat', 'rm', 'mv', 'cp', 'mkdir', 'echo', 'grep', 'rg', 'sed', 'awk', 'find', 'curl', 'ssh', 'scp',
  'docker', 'supabase', 'vercel', 'claude', 'codex', 'bash', 'sh', 'powershell', 'pwsh', 'tsc', 'go',
  'cargo', 'make', 'code', 'sudo', 'export', 'set', 'op', 'ffmpeg', 'dotnet',
])

const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|data|javascript|file|vscode|sms):)/i
const EXTENSION = /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/
const LINE_SUFFIX = /(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L?\d+)?)$/

export const slashes = (p: string) => p.replaceAll('\\', '/')

export const isAbsolute = (p: string) => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

export const normalize = (input: string) => {
  let p = slashes(input)
  const bash = /^\/([A-Za-z])(\/.*)?$/.exec(p)

  if (bash !== null) p = `${bash[1]}:${bash[2] ?? '/'}`

  const drive = /^[A-Za-z]:/.test(p) ? `${p[0]?.toUpperCase()}:` : ''
  const rest = drive === '' ? p : p.slice(2)
  const isRooted = rest.startsWith('/')
  const out: string[] = []

  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!isRooted) out.push('..')
      continue
    }
    out.push(seg)
  }

  return `${drive}${isRooted ? '/' : ''}${out.join('/')}`
}

export const join = (base: string, rel: string) => normalize(`${base}/${rel}`)

const key = (p: string) => p.toLowerCase()

const trimEnd = (p: string) => p.replace(/\/+$/, '')

export const isInside = (root: string, p: string) => key(p).startsWith(`${key(trimEnd(normalize(root)))}/`)

export const relative = (from: string, to: string): string | null => {
  const a = normalize(from).split('/').filter(Boolean)
  const b = normalize(to).split('/').filter(Boolean)

  if (key(a[0] ?? '') !== key(b[0] ?? '')) return null

  let common = 0

  while (common < a.length && common < b.length && key(a[common] ?? '') === key(b[common] ?? '')) common += 1

  return [...Array<string>(a.length - common).fill('..'), ...b.slice(common)].join('/')
}

export const linkTarget = (file: string, cwd: string, style: LinkStyle) => {
  const rel = relative(cwd, file) ?? normalize(file)

  if (style === 'percent') {
    return rel.replace(/[ ()%#?[\]]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  }

  return /[^\x21-\x7E]|[()<>]/.test(rel) ? `<${rel}>` : rel
}

const escapeLabel = (text: string) => slashes(text).replace(/[\\`*_[\]<>]/g, c => `\\${c}`)

const splitSuffix = (s: string) => {
  const match = LINE_SUFFIX.exec(s)

  return match === null ? { path: s, suffix: '' } : { path: s.slice(0, match.index), suffix: match[0] }
}

export const parseCandidate = (content: string): Candidate | null => {
  if (content === '' || content !== content.trim() || content.length > MAX_CANDIDATE) return null
  if (/[<>|*?"\x00-\x1f]/.test(content)) return null
  if (URLISH.test(content)) return null
  if (/^[-$@#]/.test(content)) return null

  const { path } = splitSuffix(content)

  if (path === '' || /^\.+$/.test(path)) return null

  if (/\s/.test(path)) {
    const first = (path.split(/\s/)[0] ?? '').toLowerCase().replace(/\.exe$/, '')

    if (COMMANDS.has(first)) return null
  }

  const last = slashes(path).split('/').at(-1) ?? ''
  const hasSeparator = /[\\/]/.test(path)

  if (last === '') return null
  if (!EXTENSION.test(last) && !hasSeparator) return null

  return { written: content, path }
}

const isFile = async (env: Env, abs: string) => (await env.stat(abs)) === 'file'

export const resolveFile = async (path: string, env: Env, mode: ResolveMode): Promise<string | null> => {
  const p = normalize(path)

  if (isAbsolute(slashes(path))) return (await isFile(env, p)) ? p : null

  const cwd = normalize(env.cwd)
  const fromMain = join(cwd, p)

  if (mode === 'link') {
    const found = await env.stat(fromMain)

    if (found === 'file') return fromMain
    if (found !== null) return null
  } else if (await isFile(env, fromMain)) {
    return fromMain
  }

  for (const dir of env.dirs) {
    const candidate = join(dir, p)

    if (await isFile(env, candidate)) return candidate
  }

  const segs = p.split('/').filter(s => s !== '' && s !== '.' && s !== '..')
  if (segs.length === 0) return null

  const unique = [...new Map(env.tracked.map(t => [key(normalize(t)), normalize(t)])).values()]

  for (let n = segs.length; n >= Math.min(segs.length, 2); n -= 1) {
    const tail = `/${segs.slice(segs.length - n).join('/')}`.toLowerCase()
    const found = unique.filter(t => key(t).endsWith(tail))

    if (found.length > 1) return null
    if (found.length === 1) {
      const only = found[0] as string

      return (await isFile(env, only)) ? only : null
    }
  }

  return null
}

type Piece =
  | { type: 'text'; raw: string }
  | { type: 'code'; raw: string; content: string }
  | { type: 'link'; raw: string; label: string; target: string; rest: string }

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/

const splitFences = (text: string) => {
  const parts: { fence: boolean; raw: string }[] = []
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let fence: { char: string; size: number } | null = null
  let buffer = ''
  let isFence = false

  const flush = () => {
    if (buffer !== '') parts.push({ fence: isFence, raw: buffer })
    buffer = ''
  }

  for (const line of lines) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line.replace(/\r?\n$/, ''))
      const marker = open?.[1]

      if (marker !== undefined && !(marker.startsWith('`') && (open?.[2] ?? '').includes('`'))) {
        flush()
        isFence = true
        fence = { char: marker[0] as string, size: marker.length }
        buffer = line
        continue
      }

      buffer += line
      continue
    }

    buffer += line

    const closing = new RegExp(`^\\s*${fence.char}{${fence.size},}\\s*$`)

    if (closing.test(line.replace(/\r?\n$/, ''))) {
      flush()
      isFence = false
      fence = null
    }
  }

  flush()

  return parts
}

const skipCode = (s: string, i: number) => {
  let size = 0

  while (s[i + size] === '`') size += 1

  let j = i + size

  while (j < s.length) {
    if (s[j] !== '`') {
      j += 1
      continue
    }

    let run = 0

    while (s[j + run] === '`') run += 1

    if (run === size) return { size, end: j + run, content: s.slice(i + size, j) }

    j += run
  }

  return { size, end: -1, content: '' }
}

const parseLink = (s: string, start: number): Extract<Piece, { type: 'link' }> | null => {
  let depth = 0
  let i = start

  for (; i < s.length && i - start <= MAX_LABEL; i += 1) {
    const c = s[i]

    if (c === '\\') {
      i += 1
    } else if (c === '`') {
      const code = skipCode(s, i)

      if (code.end !== -1) i = code.end - 1
    } else if (c === '[') {
      depth += 1
    } else if (c === ']') {
      depth -= 1
      if (depth === 0) break
    } else if (c === '\n' && s[i + 1] === '\n') {
      return null
    }
  }

  if (depth !== 0 || s[i + 1] !== '(') return null

  const label = s.slice(start + 1, i)
  let j = i + 2

  while (s[j] === ' ') j += 1

  let target = ''

  if (s[j] === '<') {
    const close = s.indexOf('>', j)

    if (close === -1 || s.slice(j, close).includes('\n')) return null

    target = s.slice(j + 1, close)
    j = close + 1
  } else {
    let parens = 0
    const from = j

    for (; j < s.length; j += 1) {
      const c = s[j]

      if (c === ' ' || c === '\n') break
      if (c === '(') parens += 1
      if (c === ')') {
        if (parens === 0) break
        parens -= 1
      }
    }

    target = s.slice(from, j)
  }

  const restStart = j

  while (j < s.length && s[j] !== ')' && s[j] !== '\n') j += 1

  if (s[j] !== ')') return null

  return { type: 'link', raw: s.slice(start, j + 1), label, target, rest: s.slice(restStart, j) }
}

const scanInline = (s: string): Piece[] => {
  const pieces: Piece[] = []
  let textStart = 0
  let i = 0

  const flush = (to: number) => {
    if (to > textStart) pieces.push({ type: 'text', raw: s.slice(textStart, to) })
  }

  while (i < s.length) {
    const c = s[i]

    if (c === '\\') {
      i += 2
    } else if (c === '`') {
      const code = skipCode(s, i)

      if (code.end === -1) {
        i += code.size
      } else {
        flush(i)
        pieces.push({ type: 'code', raw: s.slice(i, code.end), content: code.content })
        i = code.end
        textStart = i
      }
    } else if (c === '[' && s[i - 1] !== '!') {
      const link = parseLink(s, i)

      if (link === null) {
        i += 1
      } else {
        flush(i)
        pieces.push(link)
        i += link.raw.length
        textStart = i
      }
    } else if (s.startsWith('http://', i) || s.startsWith('https://', i)) {
      while (i < s.length && !/[\s<`]/.test(s[i] as string)) i += 1
    } else {
      i += 1
    }
  }

  flush(s.length)

  return pieces
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export type Options = { cwd: string; dirs: string[]; style: LinkStyle; resolve: Resolve; collect?: (file: string) => void }

const inSession = (file: string, options: Options) =>
  [options.cwd, ...options.dirs].some(root => isInside(root, file))

const rewriteCode = async (piece: Extract<Piece, { type: 'code' }>, options: Options) => {
  const candidate = parseCandidate(piece.content)

  if (candidate === null) return piece.raw

  const file = await options.resolve(candidate.path, 'code')

  if (file === null) return piece.raw

  if (!inSession(file, options)) {
    options.collect?.(file)

    return `${piece.raw}${OUTSIDE_NOTE}`
  }

  return `[${escapeLabel(candidate.written)}](${linkTarget(file, options.cwd, options.style)})`
}

// A relative link the file pane already opens: it resolves from the session folder to the very file found.
const isWorking = (path: string, file: string, options: Options) =>
  !isAbsolute(slashes(path)) && key(join(options.cwd, normalize(path))) === key(file)

const rewriteLink = async (piece: Extract<Piece, { type: 'link' }>, options: Options) => {
  const target = decode(piece.target)

  if (target === '' || target.startsWith('#') || URLISH.test(target)) {
    return piece.raw
  }
  if (/[#?]/.test(target)) return piece.raw

  const { path } = splitSuffix(target)
  const file = await options.resolve(path, 'link')

  if (file === null) return piece.raw

  if (!inSession(file, options)) {
    options.collect?.(file)

    return `${piece.raw}${OUTSIDE_NOTE}`
  }

  if (isWorking(path, file, options)) return piece.raw

  return `[${piece.label}](${linkTarget(file, options.cwd, options.style)}${piece.rest})`
}

export const linkify = async (text: string, options: Options): Promise<string> => {
  if (!text.includes('`') && !text.includes('](')) return text

  const out: string[] = []

  for (const part of splitFences(text)) {
    if (part.fence) {
      out.push(part.raw)
      continue
    }

    for (const piece of scanInline(part.raw)) {
      if (piece.type === 'code') out.push(await rewriteCode(piece, options))
      else if (piece.type === 'link') out.push(await rewriteLink(piece, options))
      else out.push(piece.raw)
    }
  }

  return out.join('')
}
