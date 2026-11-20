param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][long]$ParentStartTimeUtcTicks,
    [Parameter(Mandatory = $true)][string]$ReleaseTag,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$FallbackExecutablePath
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $PSScriptRoot 'update.log'
$parentClosed = $false
$readyWritten = $false
$installerStillRunning = $false

function Write-OnlyDMUpdateLog([string]$Message) {
    [IO.File]::AppendAllText($logPath, ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + "`r`n"), [Text.Encoding]::UTF8)
}

function Wait-OnlyDMParent {
    try { $parent = [Diagnostics.Process]::GetProcessById($ParentProcessId) }
    catch [ArgumentException] { return }
    try {
        try { $ticks = $parent.StartTime.ToUniversalTime().Ticks }
        catch [InvalidOperationException] { return }
        if ($ticks -ne $ParentStartTimeUtcTicks) { return }
        if (-not $parent.WaitForExit(30000)) {
            throw 'OnlyDM did not close within 30 seconds. It is still running. Close it before trying the update again.'
        }
    }
    finally { $parent.Dispose() }
}

function Test-OnlyDMIsRunning {
    $processes = [Diagnostics.Process]::GetProcessesByName('OnlyDM')
    try { return $processes.Length -gt 0 }
    finally { foreach ($process in $processes) { $process.Dispose() } }
}

function Start-OnlyDMProcess([Diagnostics.ProcessStartInfo]$StartInfo) {
    return [Diagnostics.Process]::Start($StartInfo)
}

function Start-OnlyDMApp([string]$ExecutablePath) {
    if (Test-OnlyDMIsRunning) { return $false }
    if (-not [IO.File]::Exists($ExecutablePath)) { throw "OnlyDM executable is missing: $ExecutablePath" }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $ExecutablePath
    $info.Arguments = '--account-switch'
    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($ExecutablePath)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = Start-OnlyDMProcess $info
    if ($null -eq $process) { throw 'Windows did not start OnlyDM.' }
    $process.Dispose()
    return $true
}

function ConvertTo-OnlyDMNativeArgument([string]$Value) {
    # Windows PowerShell 5.1 lacks ProcessStartInfo.ArgumentList.
    return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Show-OnlyDMUpdateError([string]$Message) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($Message, 'OnlyDM update failed',
        [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
}

try {
    $parsedVersion = $null
    if ($ReleaseTag -cnotmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
        -not [Version]::TryParse($ReleaseTag.Substring(1), [ref]$parsedVersion) -or
        $ReleaseTag -cne ('v' + $parsedVersion.ToString(3))) {
        throw 'The requested OnlyDM update tag is not a stable vMAJOR.MINOR.PATCH version.'
    }
    if ($ParentProcessId -le 0 -or $ParentStartTimeUtcTicks -le 0) { throw 'The OnlyDM parent process identity is invalid.' }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not available.' }
    $InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
    if ($InstallerPath -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'install.ps1')) -or
        -not [IO.File]::Exists($InstallerPath)) {
        throw 'The staged OnlyDM installer is missing or outside the update directory.'
    }
    $canonicalExecutable = Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\OnlyDM.exe'
    $FallbackExecutablePath = [IO.Path]::GetFullPath($FallbackExecutablePath)
    if (-not [IO.File]::Exists($FallbackExecutablePath)) { throw 'The original OnlyDM executable is missing.' }
    $powershell = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not [IO.File]::Exists($powershell)) { throw 'Windows PowerShell is missing.' }

    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready.tmp'), 'ready')
    [IO.File]::Move((Join-Path $PSScriptRoot 'ready.tmp'), (Join-Path $PSScriptRoot 'ready'))
    $readyWritten = $true

    Wait-OnlyDMParent
    $parentClosed = $true
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'cancelled')) { throw 'The OnlyDM update was cancelled before installation.' }
    if (Test-OnlyDMIsRunning) {
        throw 'Another OnlyDM window was opened. It has been left running. Close OnlyDM before trying the update again.'
    }

    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $powershell
    $info.Arguments = (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', $InstallerPath, '-ReleaseTag', $ReleaseTag) |
        ForEach-Object { ConvertTo-OnlyDMNativeArgument $_ }) -join ' '
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $installer = Start-OnlyDMProcess $info
    if ($null -eq $installer) { throw 'Windows did not start the OnlyDM installer.' }
    try {
        $output = $installer.StandardOutput.ReadToEndAsync()
        $errors = $installer.StandardError.ReadToEndAsync()
        if (-not $installer.WaitForExit(600000)) {
            $installerStillRunning = $true
            throw 'The OnlyDM installer is still running after 10 minutes. It has been left running, and no app was restarted. Wait for installation to finish before reopening OnlyDM or trying again.'
        }
        foreach ($capture in @($output, $errors)) {
            if ($capture.Wait(1000)) {
                $text = $capture.Result
                if ($text) { Write-OnlyDMUpdateLog $text.Substring(0, [Math]::Min($text.Length, 65536)) }
            }
        }
        if ($installer.ExitCode -ne 0) { throw "OnlyDM installation failed (exit code $($installer.ExitCode))." }
    }
    finally { $installer.Dispose() }

    [void](Start-OnlyDMApp $canonicalExecutable)
    exit 0
}
catch {
    $message = $_.Exception.Message
    try { Write-OnlyDMUpdateLog $message } catch { }
    if ($parentClosed -and -not $installerStillRunning) {
        try {
            if (Start-OnlyDMApp $FallbackExecutablePath) { $message += "`r`n`r`nThe previous OnlyDM app was reopened." }
            else { $message += "`r`n`r`nAn OnlyDM app is already running and has been left open." }
        }
        catch {
            $message += "`r`n`r`nThe previous app could not be reopened: " + $_.Exception.Message
            try { Write-OnlyDMUpdateLog $_.Exception.Message } catch { }
        }
    }
    $message += "`r`n`r`nDiagnostic log: " + $logPath
    if ($readyWritten) {
        try { Show-OnlyDMUpdateError $message } catch { }
    }
    exit 1
}
