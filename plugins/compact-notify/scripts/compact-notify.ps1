# Хук PreCompact: повідомлення в чаті й сповіщення Windows, що стиснення контексту запущено.
param([switch]$Toast, [string]$Text)

if ($Toast) {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.BalloonTipTitle = 'Claude Code'
    $n.BalloonTipText = $Text
    $n.Visible = $true
    $n.ShowBalloonTip(5000)
    Start-Sleep -Seconds 6
    $n.Dispose()
    exit 0
}

$trigger = 'manual'
try { $trigger = ([Console]::In.ReadToEnd() | ConvertFrom-Json).trigger } catch {}
$kind = if ($trigger -eq 'auto') { 'автоматичне' } else { 'ручне' }
$msg = "Стиснення контексту запущено ($kind). Зачекайте, це може тривати до хвилини."

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Toast', '-Text', "`"$msg`""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@{ systemMessage = $msg } | ConvertTo-Json -Compress
