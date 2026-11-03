# Установщик пака модов Claude Code: irm https://raw.githubusercontent.com/Ven1dy/Claude-context-meter-plugin/main/install.ps1 | iex
# Ставит все моды в пользовательскую область (~/.claude): они работают в терминале, VS Code, Cursor и Claude Desktop.

& {
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Repo = 'Ven1dy/Claude-context-meter-plugin'
$Market = 'claude-context-meter-plugin'
$Mods = @(
    @{ Name = 'context-meter';  Text = 'заполнение контекста над полем ввода, история по сообщениям' },
    @{ Name = 'session-pulse';  Text = 'кэш промпта и лимиты 5ч / неделя, подогрев кэша' },
    @{ Name = 'handoff';        Text = 'перенос работы в чистую сессию, /handoff' },
    @{ Name = 'blast-radius';   Text = 'карточка перед rm -rf, reset --hard, force push; /deletions' },
    @{ Name = 'file-links';     Text = 'кликабельные пути к файлам в ответах' },
    @{ Name = 'session-folder'; Text = 'папка сессии и ветка git в подвале' },
    @{ Name = 'compact-notify'; Text = 'уведомление Windows о запуске сжатия' }
)

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "  > $text" -ForegroundColor Cyan }

Write-Host ''
Write-Host '   ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗' -ForegroundColor Magenta
Write-Host '  ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝' -ForegroundColor Magenta
Write-Host '  ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║   ' -ForegroundColor DarkMagenta
Write-Host '  ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║   ' -ForegroundColor DarkMagenta
Write-Host '  ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║   ' -ForegroundColor Blue
Write-Host '   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝   ' -ForegroundColor Blue
Write-Host '                 m e t e r   ·   пак модов Claude Code' -ForegroundColor DarkGray
Write-Host ''

# 1. Claude Code CLI: из PATH, из расширения редактора или официальным установщиком.
Step 'Ищу Claude Code'
$Claude = $null
$cmd = Get-Command claude -ErrorAction SilentlyContinue
if ($cmd) { $Claude = $cmd.Source }
if (-not $Claude) {
    $roots = @("$HOME\.local\bin\claude.exe")
    foreach ($ext in @('.vscode', '.vscode-insiders', '.cursor', '.windsurf')) {
        $roots += Get-ChildItem "$HOME\$ext\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | ForEach-Object FullName
    }
    $Claude = $roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Claude) {
    Say '    Claude Code не найден, ставлю официальным установщиком (claude.ai/install.ps1)…' Yellow
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    $env:Path = "$HOME\.local\bin;$env:Path"
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { $Claude = $cmd.Source }
}
if (-not $Claude) {
    Say '    Не удалось найти claude. Установите Claude Code (https://claude.com/claude-code) и запустите команду снова.' Red
    return
}
Say "    ✓ $Claude" Green

# 2. Маркетплейс.
Step "Подключаю маркетплейс $Repo"
$out = & $Claude plugin marketplace add $Repo 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { Say '    ✓ добавлен' Green }
else {
    & $Claude plugin marketplace update $Market *> $null
    Say '    ✓ уже был, обновил' Green
}

# 3. Моды.
Step 'Ставлю моды'
$ok = 0; $failed = @()
foreach ($m in $Mods) {
    $label = $m.Name.PadRight(15)
    $out = & $Claude plugin install "$($m.Name)@$Market" --scope user 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $out -match 'already') {
        Write-Host '    ✓ ' -ForegroundColor Green -NoNewline
        Write-Host $label -ForegroundColor White -NoNewline
        Write-Host $m.Text -ForegroundColor DarkGray
        $ok++
    } else {
        Write-Host '    ✗ ' -ForegroundColor Red -NoNewline
        Write-Host $label -ForegroundColor White -NoNewline
        Write-Host ($out.Trim() -split "`n" | Select-Object -Last 1) -ForegroundColor DarkGray
        $failed += $m.Name
    }
}

# 4. Те же моды, подключённые папками, загрузились бы дважды.
$settings = "$HOME\.claude\settings.json"
if ((Test-Path $settings) -and ((Get-Content $settings -Raw -Encoding UTF8) -match 'CLAUDE_CODE_PLUGIN_DIRS')) {
    Write-Host ''
    Say '    ! В ~/.claude/settings.json есть CLAUDE_CODE_PLUGIN_DIRS. Если там эти же моды из папок,' Yellow
    Say '      уберите их оттуда, иначе они загрузятся дважды.' Yellow
}

Write-Host ''
if ($failed.Count -eq 0) {
    Say "  ✔ Готово: $ok из $($Mods.Count). Перезапустите Claude Code (терминал, VS Code или Desktop)." Green
} else {
    Say "  Установлено $ok из $($Mods.Count). Не встали: $($failed -join ', ')" Yellow
}
Say "  Настройка: claude plugin configure <мод>, например session-pulse (ttlMinutes=60 для часового кэша)." DarkGray
Write-Host ''
}
