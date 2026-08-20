$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\OnlyDM"
$DataDir = Join-Path $env:LOCALAPPDATA "OnlyDM"
$CliDir = Join-Path $InstallDir "cli"
$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Programs")) "OnlyDM.lnk"
$AutoStartKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

function Remove-UserPathEntry([string]$PathToRemove) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $current) { return }
    $entries = @($current -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $PathToRemove.TrimEnd('\\') })
    [Environment]::SetEnvironmentVariable("Path", ($entries -join ';'), "User")
}

if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is not available."
}

if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) {
    throw "OnlyDM is running. Close OnlyDM and run the uninstaller again."
}

Remove-ItemProperty -Path $AutoStartKey -Name "OnlyDM" -ErrorAction SilentlyContinue
Remove-UserPathEntry $CliDir

if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
}
if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
if (Test-Path -LiteralPath $DataDir) {
    Remove-Item -LiteralPath $DataDir -Recurse -Force
}

Write-Host "OnlyDM has been uninstalled." -ForegroundColor Green
Write-Host "Application files, ODM PATH entry, auto start entry, Start Menu shortcut, and WebView2 session data were removed."
