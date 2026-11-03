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

$SettingsPath = Join-Path $HOME '.claude\settings.json'

# Параметры мода из pluginConfigs, как аргументы --config key=value: настройки старой установки переезжают.
function Get-OldOptions($path, $name) {
    if (-not (Test-Path $path)) { return @() }
    try { $s = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return @() }
    if (-not $s.pluginConfigs) { return @() }
    $cfg = $s.pluginConfigs.$name
    if (-not $cfg -or -not $cfg.options) { return @() }
    $opts = @()
    foreach ($p in $cfg.options.PSObject.Properties) {
        $v = if ($p.Value -is [bool]) { "$($p.Value)".ToLower() } else { "$($p.Value)" }
        $opts += '--config'; $opts += "$($p.Name)=$v"
    }
    return $opts
}

# Убирает из settings.json старое подключение установленных модов: папки в CLAUDE_CODE_PLUGIN_DIRS
# и хук compact-notify.ps1. Остальное не трогает; перед записью кладёт копию рядом. Возвращает, что убрано.
function Remove-OldMods($path, $names) {
    if (-not (Test-Path $path)) { return @() }
    $s = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $removed = @()

    if ($s.env -and $s.env.CLAUDE_CODE_PLUGIN_DIRS) {
        $keep = @()
        foreach ($d in ($s.env.CLAUDE_CODE_PLUGIN_DIRS -split ';' | Where-Object { $_ -ne '' })) {
            $name = Split-Path $d.TrimEnd('\', '/') -Leaf
            $manifest = Join-Path $d '.claude-plugin\plugin.json'
            if (Test-Path $manifest) { try { $name = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).name } catch {} }
            if ($names -contains $name) { $removed += $name } else { $keep += $d }
        }
        if ($keep.Count -gt 0) { $s.env.CLAUDE_CODE_PLUGIN_DIRS = $keep -join ';' }
        else { $s.env.PSObject.Properties.Remove('CLAUDE_CODE_PLUGIN_DIRS') }
        if (@($s.env.PSObject.Properties).Count -eq 0) { $s.PSObject.Properties.Remove('env') }
    }

    if ($names -contains 'compact-notify' -and $s.hooks) {
        foreach ($ev in @($s.hooks.PSObject.Properties)) {
            $groups = @()
            foreach ($g in @($ev.Value)) {
                $all = @($g.hooks)
                $inner = @($all | Where-Object { "$($_.command)" -notmatch 'compact-notify\.ps1' })
                if ($inner.Count -eq $all.Count) { $groups += $g; continue }
                $removed += "хук $($ev.Name) compact-notify"
                if ($inner.Count -gt 0) { $g.hooks = $inner; $groups += $g }
            }
            if ($groups.Count -gt 0) { $s.hooks.($ev.Name) = $groups } else { $s.hooks.PSObject.Properties.Remove($ev.Name) }
        }
        if (@($s.hooks.PSObject.Properties).Count -eq 0) { $s.PSObject.Properties.Remove('hooks') }
    }

    if ($removed.Count -gt 0) {
        Copy-Item $path "$path.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        # Без этого Windows PowerShell 5.1 пишет массивы как {"value": [...], "Count": n}.
        Remove-TypeData System.Array -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText($path, (Format-Json ($s | ConvertTo-Json -Depth 100)), (New-Object System.Text.UTF8Encoding $false))
    }
    return $removed
}

# ConvertTo-Json в 5.1 выравнивает по ширине ключей: переводим в обычный отступ в 2 пробела.
function Format-Json($json) {
    $level = 0
    $lines = foreach ($raw in ($json -split "`r?`n")) {
        $line = $raw.Trim()
        if ($line -eq '') { continue }
        if ($line -match '^[\]}]') { $level-- }
        ('  ' * [Math]::Max(0, $level)) + ($line -replace '^(".*?"):\s+', '$1: ')
        if ($line -match '[\[{]$') { $level++ }
    }
    ($lines -join "`n") + "`n"
}

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
$ok = 0; $failed = @(); $installed = @()
foreach ($m in $Mods) {
    $label = $m.Name.PadRight(15)
    $opts = @(Get-OldOptions $SettingsPath $m.Name)
    $out = & $Claude plugin install "$($m.Name)@$Market" --scope user @opts 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $out -match 'already') {
        Write-Host '    ✓ ' -ForegroundColor Green -NoNewline
        Write-Host $label -ForegroundColor White -NoNewline
        Write-Host $m.Text -ForegroundColor DarkGray -NoNewline
        if ($opts.Count -gt 0) { Write-Host "  [$((($opts | Where-Object { $_ -ne '--config' }) -join ', '))]" -ForegroundColor DarkCyan } else { Write-Host '' }
        $ok++; $installed += $m.Name
    } else {
        Write-Host '    ✗ ' -ForegroundColor Red -NoNewline
        Write-Host $label -ForegroundColor White -NoNewline
        Write-Host ($out.Trim() -split "`n" | Select-Object -Last 1) -ForegroundColor DarkGray
        $failed += $m.Name
    }
}

# 4. Те же моды, подключённые раньше папками или хуком, загрузились бы дважды.
if ($installed.Count -gt 0) {
    Step 'Проверяю старое подключение в ~/.claude/settings.json'
    try {
        $removed = @(Remove-OldMods $SettingsPath $installed)
        if ($removed.Count -gt 0) {
            Say "    ✓ убрал: $($removed -join ', ')" Green
            Say '      копия прежнего файла: settings.json.bak-*' DarkGray
        } else { Say '    ✓ дублей нет' Green }
    } catch {
        Say "    ! Не удалось разобрать settings.json: $($_.Exception.Message)" Yellow
        Say '      Если там CLAUDE_CODE_PLUGIN_DIRS с этими модами, уберите их вручную.' Yellow
    }
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
