import { test, expect } from 'claude-code/testing'
import { classify, countFiles, formatSize, isInsideDir, isPureCommand, parseScan, plural, rmReport, summaryText } from './classify'

test('risky commands are classified, safe ones are not', () => {
  expect(classify('rm -rf build')).toMatchObject({ kind: 'rm', targets: ['build'], dir: null })
  expect(classify('cd x && rm -rf y')).toMatchObject({ kind: 'rm', targets: ['y'], dir: 'x' })
  expect(classify('git push --force origin main')).toMatchObject({ kind: 'git-push-force', dir: null })
  expect(classify('git -C repo reset --hard')).toMatchObject({ kind: 'git-reset', dir: 'repo' })
  expect(classify('git push origin +main')).toMatchObject({ kind: 'git-push-force' })
  expect(classify('npx prisma migrate deploy')).toMatchObject({ kind: 'migrate', tool: 'prisma' })
  expect(classify('rm file.txt')).toBeNull()
  expect(classify('ls -la && git status && git push origin main')).toBeNull()
  expect(classify('git restore --staged .')).toBeNull()
  expect(classify('(cd sub && ls) && rm -rf after')).toMatchObject({ kind: 'rm', dir: null })
})

test('rm with a quoted Cyrillic path containing a space keeps it as one target', () => {
  expect(classify('rm -rf "мои файлы/сборка"')).toMatchObject({ kind: 'rm', targets: ['мои файлы/сборка'] })
  expect(classify("cd 'папка один' && rm -r старое")).toMatchObject({ kind: 'rm', targets: ['старое'], dir: 'папка один' })
})

test('scan output is parsed into folders with their files', () => {
  const out = [
    'T\t1\t64\t135670',
    'D\t2\t128000\tмои файлы/сборка/assets',
    'D\t60\t2370\tмои файлы/сборка/many',
    'F\t120000\tмои файлы/сборка/assets\tмои файлы/сборка/assets/main.js',
    'F\t8000\tмои файлы/сборка/assets\tмои файлы/сборка/assets/стили.css',
    'F\t69\tмои файлы/сборка/many\tмои файлы/сборка/many/f 59.dat',
    '',
  ].join('\n')
  const scan = parseScan(out)

  expect(scan.files).toBe(64)
  expect(scan.groups.map(g => g.label)).toEqual(['мои файлы/сборка/assets/', 'мои файлы/сборка/many/'])
  expect(scan.groups[0]?.items).toEqual([
    { name: 'main.js', bytes: 120000 },
    { name: 'стили.css', bytes: 8000 },
  ])
  expect(scan.groups[1]?.items).toEqual([{ name: 'f 59.dat', bytes: 69 }])
  expect(scan.otherFiles).toBe(2)
  expect(summaryText(rmReport(scan, ['мои файлы/сборка']))).toBe('Будет удалено 64 файла · 132 КБ')
})

test('files in the current folder get the ./ label, and a missing path says nothing is removed', () => {
  expect(parseScan('T\t1\t1\t42\nD\t1\t42\t.\nF\t42\t.\t./solo.txt\n').groups[0]).toMatchObject({ label: './', items: [{ name: 'solo.txt', bytes: 42 }] })
  expect(rmReport(parseScan('T\t0\t0\t0\n'), ['nope'])).toMatchObject({ lead: 'Ничего не удалится', action: 'Выполнить' })
})

test('Russian plurals and sizes', () => {
  expect([1, 2, 3, 5, 9, 11, 12, 21, 22, 25, 111].map(countFiles)).toEqual([
    '1 файл',
    '2 файла',
    '3 файла',
    '5 файлов',
    '9 файлов',
    '11 файлов',
    '12 файлов',
    '21 файл',
    '22 файла',
    '25 файлов',
    '111 файлов',
  ])
  expect(plural(4, 'коммит', 'коммита', 'коммитов')).toBe('коммита')
  expect([0, 512, 239616, 1536, 5 * 1024 * 1024].map(formatSize)).toEqual(['0 Б', '512 Б', '234 КБ', '1.5 КБ', '5.0 МБ'])
})

test('a pure command has one risky segment and only cd, echo, true, pwd, ls and harmless redirects around it', () => {
  expect(isPureCommand('rm -rf "a b"')).toBe(true)
  expect(isPureCommand('cd x && rm -rf y')).toBe(true)
  expect(isPureCommand('rm -f x 2>/dev/null || true')).toBe(true)
  expect(isPureCommand('rm -rf a && echo done 2>&1')).toBe(true)
  expect(isPureCommand('rm -rf "мои файлы; старое"')).toBe(true)
})

test('a command that mixes the risky segment with other work is not pure', () => {
  const heredoc = "python - <<'EOF'\nimport json\nEOF\nsed -i 's/a/b/' f.json && rm -f x.txt && python build_lf.py | tail -5"

  expect(isPureCommand(heredoc)).toBe(false)
  expect(isPureCommand("sed -i 's/a/b/' f.json && rm -f x.txt && python build_lf.py | tail -5")).toBe(false)
  expect(isPureCommand('rm -rf a; npm run build')).toBe(false)
  expect(isPureCommand('git add . && git commit -m x && git push --force')).toBe(false)
  expect(isPureCommand('rm -rf a > log.txt')).toBe(false)
  expect(isPureCommand('rm -rf $(cat list)')).toBe(false)
  expect(isPureCommand('rm -rf a &')).toBe(false)
  expect(isPureCommand('ls')).toBe(false)
})

test('paths are compared inside a folder whatever the spelling of the drive', () => {
  const temp = 'D:\\Work\\AppData\\Local\\Temp'

  expect(isInsideDir('/d/Work/AppData/Local/Temp/job/out', temp)).toBe(true)
  expect(isInsideDir('D:/work/appdata/local/temp/a/../b', temp)).toBe(true)
  expect(isInsideDir('D:/Work/AppData/Local/Temp', temp)).toBe(false)
  expect(isInsideDir('D:/Work/AppData/Local', temp)).toBe(false)
  expect(isInsideDir('D:/Work/AppData/Local/Temp/../src', temp)).toBe(false)
})
