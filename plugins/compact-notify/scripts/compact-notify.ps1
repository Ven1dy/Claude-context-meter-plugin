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

# Повідомлення про стиснення більше не виводиться ні в чат, ні як сповіщення Windows.
exit 0
