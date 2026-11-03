import { test, expect } from 'claude-code/testing'
import { linkify, OUTSIDE_NOTE, parseCandidate, resolveFile } from './linkify'
import type { Env, LinkStyle, StatKind } from './linkify'

const CWD = 'C:/Work/Проект Один'
const EXTRA = 'C:/Extra/Доп папка'
const DOCS = 'D:/Docs'

const FILES = [
  `${CWD}/Промпты/4. Презентация.md`,
  `${CWD}/src/app.ts`,
  `${CWD}/README.md`,
  `${CWD}/a/index.ts`,
  `${CWD}/b/index.ts`,
  `${CWD}/docs/guide/Старт.md`,
  `${CWD}/pkg/__init__.py`,
  `${EXTRA}/notes.md`,
  `${DOCS}/guide.md`,
  'C:/Elsewhere/outside.txt',
  'C:/Work/Другой/Промпты/5. Тест.md',
]
const DIRS = [`${CWD}/src`, `${CWD}/Промпты`]

const TRACKED = [
  `${CWD}/a/index.ts`,
  `${CWD}/b/index.ts`,
  `${CWD}/docs/guide/Старт.md`,
  'C:/Work/Другой/Промпты/5. Тест.md',
]

const kinds = new Map<string, StatKind>([
  ...FILES.map(f => [f.toLowerCase(), 'file'] as [string, StatKind]),
  ...DIRS.map(d => [d.toLowerCase(), 'dir'] as [string, StatKind]),
])

const env: Env = {
  cwd: CWD,
  dirs: [EXTRA, DOCS],
  tracked: TRACKED,
  stat: async abs => kinds.get(abs.toLowerCase()) ?? null,
}

const run = (text: string, style: LinkStyle = 'angle') =>
  linkify(text, { cwd: CWD, dirs: env.dirs, style, resolve: (path, mode) => resolveFile(path, env, mode) })

const CASES: [string, string, string, LinkStyle?][] = [
  [
    'cyrillic, spaces and backslashes, angle',
    'Файл `Промпты\\4. Презентация.md` готов',
    'Файл [Промпты/4. Презентация.md](<Промпты/4. Презентация.md>) готов',
  ],
  [
    'cyrillic, spaces and backslashes, percent',
    'Файл `Промпты\\4. Презентация.md` готов',
    'Файл [Промпты/4. Презентация.md](Промпты/4.%20Презентация.md) готов',
    'percent',
  ],
  ['ascii path', 'Смотри `src/app.ts`.', 'Смотри [src/app.ts](src/app.ts).'],
  ['line suffix', '`src/app.ts:42`', '[src/app.ts:42](src/app.ts)'],
  ['bare file name', '`README.md`', '[README.md](README.md)'],
  ['double backtick span', '``src/app.ts``', '[src/app.ts](src/app.ts)'],
  ['absolute path inside cwd', '`C:\\Work\\Проект Один\\src\\app.ts`', '[C:/Work/Проект Один/src/app.ts](src/app.ts)'],
  ['git bash path', '`/c/Work/Проект Один/src/app.ts`', '[/c/Work/Проект Один/src/app.ts](src/app.ts)'],
  [
    'absolute path in additional dir',
    '`C:\\Extra\\Доп папка\\notes.md`',
    '[C:/Extra/Доп папка/notes.md](<../../Extra/Доп папка/notes.md>)',
  ],
  ['relative to additional dir', '`notes.md`', '[notes.md](<../../Extra/Доп папка/notes.md>)'],
  ['additional dir on another drive', '`D:\\Docs\\guide.md`', '[D:/Docs/guide.md](D:/Docs/guide.md)'],
  ['outside session folders', '`C:\\Elsewhere\\outside.txt`', `\`C:\\Elsewhere\\outside.txt\`${OUTSIDE_NOTE}`],
  ['tail match inside cwd', 'Открой `guide\\Старт.md`', 'Открой [guide/Старт.md](<docs/guide/Старт.md>)'],
  ['tail match, wrong prefix', '`Лишняя/guide/Старт.md`', '[Лишняя/guide/Старт.md](<docs/guide/Старт.md>)'],
  [
    'tail match outside session folders',
    '`Другой\\Промпты\\5. Тест.md`',
    `\`Другой\\Промпты\\5. Тест.md\`${OUTSIDE_NOTE}`,
  ],
  ['underscores in label are escaped', '`pkg/__init__.py`', '[pkg/\\_\\_init\\_\\_.py](pkg/__init__.py)'],
  ['ambiguous tail is left alone', '`index.ts`', '`index.ts`'],
  ['missing file is left alone', '`nope/missing.ts`', '`nope/missing.ts`'],
  ['directory is left alone', '`src/` и `src`', '`src/` и `src`'],
  ['command is left alone', '`npm run build` и `git add src/app.ts`', '`npm run build` и `git add src/app.ts`'],
  ['padded code is left alone', '` src/app.ts `', '` src/app.ts `'],
  ['version is left alone', '`v1.2.3`', '`v1.2.3`'],
  ['fenced block is left alone', '```\n`src/app.ts`\nsrc/app.ts\n```', '```\n`src/app.ts`\nsrc/app.ts\n```'],
  ['tilde fence is left alone', '~~~md\n`src/app.ts`\n~~~', '~~~md\n`src/app.ts`\n~~~'],
  ['unclosed fence is left alone', '```ts\n`src/app.ts`', '```ts\n`src/app.ts`'],
  [
    'text around a fence is still linked',
    '`src/app.ts`\n```\n`src/app.ts`\n```\n`README.md`',
    '[src/app.ts](src/app.ts)\n```\n`src/app.ts`\n```\n[README.md](README.md)',
  ],
  ['url in code is left alone', '`https://example.com/a.md`', '`https://example.com/a.md`'],
  [
    'url in text and link is left alone',
    'https://example.com/a.md и [x](https://example.com/src/app.ts)',
    'https://example.com/a.md и [x](https://example.com/src/app.ts)',
  ],
  ['link that resolves is left alone', '[app](src/app.ts)', '[app](src/app.ts)'],
  ['encoded link that resolves is left alone', '[x](Промпты/4.%20Презентация.md)', '[x](Промпты/4.%20Презентация.md)'],
  [
    'working link to an additional dir is left alone',
    '[x](../../Extra/Доп%20папка/notes.md)',
    '[x](../../Extra/Доп%20папка/notes.md)',
  ],
  [
    'working link outside session folders is marked',
    '[x](../Другой/Промпты/5.%20Тест.md)',
    `[x](../Другой/Промпты/5.%20Тест.md)${OUTSIDE_NOTE}`,
  ],
  ['broken link is repaired', '[старт](<guide/Старт.md>)', '[старт](<docs/guide/Старт.md>)'],
  ['link title is kept', '[старт](<guide/Старт.md> "t")', '[старт](<docs/guide/Старт.md> "t")'],
  ['unresolvable link is left alone', '[x](nope/missing.md)', '[x](nope/missing.md)'],
  ['anchor and mailto are left alone', '[x](#a) [y](mailto:a@b.c)', '[x](#a) [y](mailto:a@b.c)'],
  [
    'code inside a link label is not duplicated',
    '[`src/app.ts`](https://example.com)',
    '[`src/app.ts`](https://example.com)',
  ],
  ['image is left alone', '![a](guide/Старт.md)', '![a](guide/Старт.md)'],
  ['escaped backtick is not a span', '\\`src/app.ts\\`', '\\`src/app.ts\\`'],
]

test('paths are linked as the table says', async () => {
  for (const [name, input, expected, style] of CASES) {
    expect([name, await run(input, style)]).toEqual([name, expected])
  }
})

test('the same text twice gives the same answer', async () => {
  const text = '`Промпты\\4. Презентация.md` и `src/app.ts:7`'

  expect(await run(text)).toBe(await run(text))
})

const CANDIDATES: [string, string | null][] = [
  ['Промпты\\4. Презентация.md', 'Промпты\\4. Презентация.md'],
  ['src/app.ts:12:3', 'src/app.ts'],
  ['a.test.ts#L10-L20', 'a.test.ts'],
  ['.env', '.env'],
  ['Dockerfile', null],
  ['bin/run', 'bin/run'],
  ['npm run build', null],
  ['--flag', null],
  ['src/**/*.ts', null],
  [' src/app.ts', null],
  ['https://a.b/c.md', null],
  ['mailto:a@b.c', null],
  ['1.5', null],
  ['@types/node', null],
  ['..', null],
]

test('candidates are recognized as paths', () => {
  for (const [input, path] of CANDIDATES) {
    expect([input, parseCandidate(input)?.path ?? null]).toEqual([input, path])
  }
})
