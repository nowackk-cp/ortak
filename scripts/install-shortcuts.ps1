# Creates "Ortak" shortcuts on the Desktop and in the Start menu (plus "Ortak'ı Durdur" in the
# Start menu). Re-running just overwrites them.   npm run kisayol
# (Saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Turkish names correctly.)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbs = "`"$(Join-Path $root 'Ortak.vbs')`""
$icon = Join-Path $root 'assets\ortak.ico'
$shell = New-Object -ComObject WScript.Shell

function New-Shortcut($path, $arguments, $description) {
  # WScript.Shell saves through the ANSI code page ("ı" would become "i"), so save under an ASCII
  # name and rename afterwards.
  $tmp = Join-Path (Split-Path $path) "ortak-tmp-$PID.lnk"
  $lnk = $shell.CreateShortcut($tmp)
  $lnk.TargetPath = $wscript
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = $description
  $lnk.Save()
  Move-Item -LiteralPath $tmp -Destination $path -Force
  Write-Output "  $path"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Ortak'
New-Item -ItemType Directory -Force $startMenu | Out-Null

Write-Output 'Kısayollar oluşturuldu:'
New-Shortcut (Join-Path $desktop 'Ortak.lnk') $vbs 'Claude Code, Codex ve Antigravity tek yerde'
New-Shortcut (Join-Path $startMenu 'Ortak.lnk') $vbs 'Claude Code, Codex ve Antigravity tek yerde'
New-Shortcut (Join-Path $startMenu "Ortak'ı Durdur.lnk") "$vbs stop" 'Arka planda çalışan Ortak sunucusunu kapatır'
