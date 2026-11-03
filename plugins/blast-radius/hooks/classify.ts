// Based on anthropics/claude-code-playground mods/blast-radius (Apache-2.0), reworked.

export type GitKind = 'git-reset' | 'git-clean' | 'git-push-force' | 'git-checkout'

export type Risk =
  | { kind: 'rm'; label: string; targets: string[]; dir: string | null }
  | { kind: GitKind; label: string; args: string[]; dir: string | null }
  | { kind: 'migrate'; tool: string; label: string; dir: string | null }

type Cd = { cd: string | null }

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'cd', 'git'])
// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) return arg ?? '~'

  return dir ? `${dir}/${arg}` : arg
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
export function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) words.push(m[1] ?? m[2] ?? m[3] ?? '')

  return words
}

/** The first risky segment of a shell command, or null. */
export function classify(command: string): Risk | null {
  let dir: string | null = null // where a `cd` earlier on the line moved to; null means the session folder
  const scopes: (string | null)[] = [] // dir to restore when a ( subshell ) closes
  const pushed: (string | null)[] = [] // pushd stack, for popd

  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '')
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0

    for (let k = 0; k < opens; k += 1) scopes.push(dir)

    const seg = classifySegment(raw, dir, pushed)

    if (seg !== null && !('cd' in seg)) return seg
    if (seg !== null) dir = seg.cd // a cd, pushd or popd moved the folder

    for (let k = 0; k < closes && scopes.length > 0; k += 1) dir = scopes.pop() ?? null // a cd inside ( ... ) doesn't outlive it
  }

  return null
}

// ---- A "pure" command: one risky segment and nothing else that does work -------

// The words a pure command may have besides its one risky segment (and `cd`, which classifySegment reads).
const PURE_WORDS = new Set(['true', 'pwd', 'echo', 'ls'])
// Redirects that only throw output away or merge the streams.
const SAFE_REDIRECT = /\s*(?:[12&]?>>?\s*\/dev\/null|2>&1|1>&2|>&2)/g
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g

/** Splits a line at the operators outside quotes; null if it has a heredoc, a substitution or a background `&`. */
function pureSegments(command: string): string[] | null {
  if (/\$\(|`|<<|<\(|>\(/.test(command)) return null

  const segments: string[] = []
  let current = ''
  let quote: string | null = null

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? ''
    const following = command[i + 1] ?? ''

    if (quote !== null) {
      current += ch
      if (ch === '\\' && quote === '"') {
        current += following
        i += 1
      } else if (ch === quote) {
        quote = null
      }
    } else if (ch === '\\') {
      current += ch + following
      i += 1
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ';' || ch === '\n') {
      segments.push(current)
      current = ''
    } else if (ch === '|') {
      segments.push(current)
      current = ''
      if (following === '|') i += 1
    } else if (ch === '&') {
      if (following === '&') {
        segments.push(current)
        current = ''
        i += 1
      } else if ((command[i - 1] ?? '') === '>' || following === '>') {
        current += ch // 2>&1 and &>/dev/null
      } else {
        return null
      }
    } else {
      current += ch
    }
  }
  if (quote !== null) return null

  segments.push(current)

  return segments
}

/**
 * True if the line has exactly one risky segment and the rest is only `cd`, `echo`, `true`, `pwd`, `ls`
 * and harmless redirects (`2>&1`, `>/dev/null`, `|| true`). Anything else that does work, a heredoc or a
 * substitution makes it mixed: it could not be held or queued without running the rest with it.
 */
export function isPureCommand(command: string): boolean {
  const segments = pureSegments(command)

  if (segments === null) return false

  let risky = 0

  for (const raw of segments) {
    const text = raw.replace(SAFE_REDIRECT, '')

    if (/[<>&]/.test(text.replace(QUOTED, ''))) return false

    const seg = classifySegment(text, null, [])

    if (seg !== null) {
      if (!('cd' in seg)) risky += 1

      continue
    }

    const words = tokenize(text.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))

    while (words.length > 0 && ASSIGNMENT.test(words[0] ?? '')) words.shift()

    const head = words[0]

    if (head !== undefined && !PURE_WORDS.has(head)) return false
  }

  return risky === 1
}

// ---- Paths --------------------------------------------------------------------

/** "D:\Work\Temp", "/d/Work/Temp" and "d:/work/temp/" all become "d:/work/temp"; `.` and `..` are folded. */
export function normalizeFsPath(path: string): string {
  const p = path.trim().replace(/\\/g, '/').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:').toLowerCase()
  const head = /^[a-z]:/.test(p) ? p.slice(0, 2) : ''
  const stack: string[] = []

  for (const part of p.slice(head.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }

  return `${head}/${stack.join('/')}`
}

/** True if `path` is below `root` (not `root` itself, not its parent). Both are compared as normalizeFsPath makes them. */
export function isInsideDir(path: string, root: string): boolean {
  const base = normalizeFsPath(root)
  const prefix = base.endsWith('/') ? base : `${base}/`
  const p = normalizeFsPath(path)

  return p.startsWith(prefix) && p.length > prefix.length
}

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment: string, dir: string | null, pushed: (string | null)[]): Risk | Cd | null {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))

  while (words.length > 0 && ASSIGNMENT.test(words[0] ?? '')) words.shift() // leading VAR=value

  const peek = () => words[0]

  if (peek() === 'sudo') {
    words.shift()
    while (words.length > 0 && (peek() ?? '').startsWith('-')) {
      const option = words.shift() ?? ''

      if (SUDO_VALUE_OPTIONS.has(option)) words.shift()
    }
  }
  while (words.length > 0 && (PREFIXES.has(words[0] ?? '') || ASSIGNMENT.test(words[0] ?? ''))) words.shift()
  if (peek() === 'nice') {
    words.shift()
    if (peek() === '-n') words.splice(0, 2)
    else if (/^-\d+$/.test(words[0] ?? '')) words.shift()
  }

  const [first, ...args] = words

  if (first === undefined) return null

  const cmd = first.replace(/^\\/, '') // \rm skips aliases; it's still rm

  if (cmd === 'cd') return { cd: args[0] === '-' ? '-' : joinDir(dir, args[0]) }
  if (cmd === 'pushd') {
    pushed.push(dir)

    return { cd: joinDir(dir, args[0]) }
  }
  if (cmd === 'popd') return { cd: pushed.length > 0 ? (pushed.pop() ?? null) : '-' }

  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter(a => a.startsWith('-'))
    const isRecursive = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const isForce = flags.some(f => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))

    if (isRecursive || isForce) {
      const targets = args.filter(a => !a.startsWith('-') || a === '-')

      return { kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), targets, dir }
    }
  }

  if (cmd === 'git') {
    // Git's own options come before the subcommand; -C moves where it runs.
    let gitDir = dir
    let i = 0

    while (i < args.length && (args[i] ?? '').startsWith('-')) {
      if (args[i] === '-C' && i + 1 < args.length) {
        gitDir = joinDir(gitDir, args[i + 1])
        i += 2
      } else if (args[i] === '-c' && i + 1 < args.length) {
        i += 2
      } else {
        i += 1
      }
    }

    const sub = args[i]
    const rest = args.slice(i + 1)

    if (sub === 'reset' && rest.includes('--hard')) return { kind: 'git-reset', label: 'git reset --hard', args: rest, dir: gitDir }
    if (sub === 'clean') return { kind: 'git-clean', label: 'git clean', args: rest, dir: gitDir }
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^\+/.test(a))) {
      return { kind: 'git-push-force', label: 'git push --force', args: rest, dir: gitDir }
    }

    const isStagedOnly = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')

    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !isStagedOnly) {
      return { kind: 'git-checkout', label: `git ${sub} -- .`, args: rest, dir: gitDir }
    }
  }

  const joined = words.join(' ')

  if (/\balembic\s+upgrade\b/.test(joined)) return { kind: 'migrate', tool: 'alembic', label: 'alembic upgrade', dir }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) return { kind: 'migrate', tool: 'rails', label: 'db:migrate', dir }
  if (/\bprisma\s+migrate\b/.test(joined)) return { kind: 'migrate', tool: 'prisma', label: 'prisma migrate', dir }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) return { kind: 'migrate', tool: 'django', label: 'manage.py migrate', dir }
  if (!READ_ONLY.has(cmd) && args.includes('migrate')) return { kind: 'migrate', tool: 'unknown', label: 'migrate', dir }

  return null
}

// ---- Russian wording --------------------------------------------------------

export function plural(n: number, one: string, few: string, many: string): string {
  const hundred = Math.abs(n) % 100
  const digit = hundred % 10

  if (hundred > 10 && hundred < 20) return many
  if (digit === 1) return one
  if (digit >= 2 && digit <= 4) return few

  return many
}

export const countFiles = (n: number) => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes) || 0} Б`

  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let n = bytes
  let i = -1

  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }

  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

/** The heading word of the card for each kind of risk. */
export function riskTitle(risk: Risk): string {
  if (risk.kind === 'rm') return 'Удаление'
  if (risk.kind === 'migrate') return 'Миграции'

  return risk.label
}

// ---- Measuring the files an rm would remove ---------------------------------

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution. /usr/bin
// goes first on PATH so that Git Bash's find and sort are used, not the
// Windows find.exe and sort.exe. Output, tab separated:
//   T <paths found> <files> <bytes>
//   D <files> <bytes> <folder>             the biggest folders, by bytes
//   F <bytes> <folder> <path>              the biggest files, at most 40 per folder
export const SCAN_SCRIPT = `
PATH="/usr/bin:$PATH"
export LC_ALL=C
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then printf 'T\\t0\\t0\\t0\\n'; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*|[A-Za-z]:*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp" "$tmp.d"' EXIT
if find --version >/dev/null 2>&1; then
  find "\${paths[@]}" '(' -type f -o -type l ')' -printf '%s\\t%h\\t%p\\n' > "$tmp" 2>/dev/null
else
  # BSD find (macOS) has no -printf: sizes come from wc -c, the folder is the path without its last part.
  find "\${paths[@]}" -type f -exec wc -c {} + 2>/dev/null | awk '{ s = $1; sub(/^ *[0-9]+ /, ""); if ($0 == "total") next; d = $0; sub(/\\/[^\\/]*$/, "", d); if (d == "") d = "/"; printf "%s\\t%s\\t%s\\n", s, d, $0 }' > "$tmp"
fi
awk -F'\\t' '{ n++; b += $1 } END { printf "T\\t%d\\t%d\\t%.0f\\n", np, n, b }' np=\${#paths[@]} "$tmp"
awk -F'\\t' '{ c[$2]++; s[$2] += $1 } END { for (d in c) printf "D\\t%d\\t%.0f\\t%s\\n", c[d], s[d], d }' "$tmp" | sort -t $'\\t' -k3,3nr | head -n 30 > "$tmp.d"
cat "$tmp.d"
sort -t $'\\t' -k1,1nr "$tmp" | awk -F'\\t' 'NR == FNR { ok[$4] = 1; next } ok[$2] && k[$2]++ < 40 && ++t <= 200 { printf "F\\t%s\\t%s\\t%s\\n", $1, $2, $3 }' "$tmp.d" -
`

// Which of the paths an rm names exist now, and the first one changed after a moment. Arguments: the moment
// in epoch seconds (empty: skip the second part), then the paths as typed. The paths go to bash as arguments
// and the globs are expanded the way SCAN_SCRIPT does. Output, tab separated:
//   E <path>       a path that exists
//   N <path>       the first path (or file inside it) modified after the moment
export const SNAPSHOT_SCRIPT = `
PATH="/usr/bin:$PATH"
shopt -s nullglob dotglob
since="$1"; shift
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
for p in "\${paths[@]}"; do printf 'E\\t%s\\n' "$p"; done
if [[ -n "$since" ]] && (( \${#paths[@]} > 0 )); then
  for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*|[A-Za-z]:*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
  if find --version >/dev/null 2>&1; then
    find "\${paths[@]}" -newermt "@$since" -print -quit 2>/dev/null | sed 's/^/N\\t/'
  else
    ref=$(mktemp) && touch -t "$(date -r "$since" +%Y%m%d%H%M.%S)" "$ref" && find "\${paths[@]}" -newer "$ref" -print 2>/dev/null | head -n 1 | sed 's/^/N\\t/'
    rm -f "$ref"
  fi
fi
`

// Resolves a `cd` target to an absolute folder, or nothing if it doesn't exist.
// pwd -W gives a Windows path under Git Bash (the engine cannot spawn in /c/...);
// elsewhere it fails and pwd -P answers. The target is passed as an argument, never as source.
export const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && { pwd -W 2>/dev/null || pwd -P; }`

export type FileRow = { name: string; bytes: number }
export type Group = { label: string; files: number; bytes: number; items: FileRow[] }
export type Scan = {
  found: number
  files: number
  bytes: number
  groups: Group[]
  /** Files in folders that are not among the listed groups. */
  otherFiles: number
  otherBytes: number
}

/** "./build/assets" becomes "build/assets/", "." becomes "./". */
export function dirLabel(dir: string): string {
  const d = dir.replace(/^\.\//, '')

  if (d === '.') return './'

  return d.endsWith('/') ? d : `${d}/`
}

export function parseScan(stdout: string): Scan {
  const scan: Scan = { found: 0, files: 0, bytes: 0, groups: [], otherFiles: 0, otherBytes: 0 }
  const byDir = new Map<string, Group>()
  const rows: { dir: string; path: string; bytes: number }[] = []

  for (const line of stdout.split('\n')) {
    const p = line.replace(/\r$/, '').split('\t')

    if (p[0] === 'T') {
      scan.found = Number(p[1]) || 0
      scan.files = Number(p[2]) || 0
      scan.bytes = Number(p[3]) || 0
    } else if (p[0] === 'D' && p.length >= 4) {
      const dir = p.slice(3).join('\t')
      const group: Group = { label: dirLabel(dir), files: Number(p[1]) || 0, bytes: Number(p[2]) || 0, items: [] }

      scan.groups.push(group)
      byDir.set(dir, group)
    } else if (p[0] === 'F' && p.length >= 4) {
      rows.push({ dir: p[2] ?? '', path: p.slice(3).join('\t'), bytes: Number(p[1]) || 0 })
    }
  }

  for (const r of rows) {
    const group = byDir.get(r.dir)

    if (group !== undefined) group.items.push({ name: r.path.startsWith(`${r.dir}/`) ? r.path.slice(r.dir.length + 1) : r.path, bytes: r.bytes })
  }

  scan.otherFiles = Math.max(0, scan.files - scan.groups.reduce((sum, g) => sum + g.files, 0))
  scan.otherBytes = Math.max(0, scan.bytes - scan.groups.reduce((sum, g) => sum + g.bytes, 0))

  return scan
}

// ---- What the card shows ----------------------------------------------------

export type Line = { text: string; tag?: string }

export type Report = {
  lead: string
  strong: string
  tail: string
  /** Folders with their files, for rm only. */
  scan: Scan | null
  lines: Line[]
  more: number
  note: string
  /** Label of the main button. */
  action: string
  /** Set when the measure found nothing to lose, so the command needs no card. */
  isEmpty?: true
}

export const RUN_ACTION = 'Выполнить'

export function rmReport(scan: Scan, targets: string[]): Report {
  const base = { scan: null, lines: [], more: 0, note: '', action: RUN_ACTION, lead: '', strong: '', tail: '' }

  if (scan.found === 0) {
    return { ...base, lead: 'Ничего не удалится', note: `Путей нет: ${targets.join(' ')}`, isEmpty: true }
  }
  if (scan.files === 0) {
    return { ...base, lead: 'Будет удалено', strong: `${scan.found} ${plural(scan.found, 'путь', 'пути', 'путей')}`, tail: '· файлов внутри нет' }
  }

  return {
    ...base,
    lead: 'Будет удалено',
    strong: countFiles(scan.files),
    tail: `· ${formatSize(scan.bytes)}`,
    scan,
    action: `Удалить ${countFiles(scan.files)}`,
  }
}

export function summaryText(report: Report): string {
  return [report.lead, report.strong, report.tail].filter(s => s !== '').join(' ')
}
