param(
    [Parameter(Mandatory = $true)][string]$TestExecutable,
    [Parameter(Mandatory = $true)][string]$HelperPath,
    [string]$CaseFilter = ''
)

$ErrorActionPreference = 'Stop'
$caseCount = 0
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("OnlyDM-update-fixture-" + [Guid]::NewGuid().ToString('N') + " space & () O'Hara")
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$powershellPath = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
$source = [IO.File]::ReadAllText($HelperPath)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Updater helper has syntax errors: $parseErrors" }
$body = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
$insertion = if ($body.Count) { $body[-1].Extent.StartOffset } else { 0 }

# Replace only external app launch, process-list observation and error UI. The
# real wait, argument construction, installer subprocess and recovery flow run.
$boundaries = @'
if (Get-Command Wait-OnlyDMParent -ErrorAction SilentlyContinue) {
    $script:RealParentWait = ${function:Wait-OnlyDMParent}
    function Wait-OnlyDMParent {
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'waiting'), 'entered')
        & $script:RealParentWait
    }
}
function Test-OnlyDMIsRunning {
    return (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'running-app'))
}
function Show-OnlyDMUpdateError([string]$Message) {
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'error-ui'), $Message)
}
function Start-OnlyDMProcess([Diagnostics.ProcessStartInfo]$StartInfo) {
    $entry = @{ executable = $StartInfo.FileName; arguments = $StartInfo.Arguments; shell = $StartInfo.UseShellExecute; hidden = $StartInfo.CreateNoWindow } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'launches.jsonl'), $entry + "`r`n")
    if ($StartInfo.FileName -eq (Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe')) {
        $real = [Diagnostics.Process]::Start($StartInfo)
        if ($env:ONLYDM_TEST_INSTALL_MODE -eq 'timeout') {
            [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'installer.pid'), [string]$real.Id)
            $facade = [pscustomobject]@{ StandardOutput = $real.StandardOutput; StandardError = $real.StandardError }
            $facade | Add-Member ScriptMethod WaitForExit {
                param([int]$Milliseconds)
                [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'installer-wait-ms'), [string]$Milliseconds)
                return $false
            }
            $facade | Add-Member ScriptMethod Dispose { }
            return $facade
        }
        return $real
    }
    $canonical = Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\OnlyDM.exe'
    $fallback = Join-Path $PSScriptRoot 'original & (old)\OnlyDM.exe'
    if ($StartInfo.FileName -notin @($canonical, $fallback)) { throw 'Unexpected executable in fixture.' }
    $inert = New-Object Diagnostics.ProcessStartInfo
    $inert.FileName = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\cmd.exe'
    $inert.Arguments = '/d /c exit 0'
    $inert.UseShellExecute = $false
    $inert.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($inert)
}
'@
$wrapperSource = $source.Insert($insertion, $boundaries + "`r`n")
$inertInstaller = @'
param([string]$ReleaseTag)
$ErrorActionPreference = 'Stop'
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'installed'), $ReleaseTag + "`r`n")
if ($env:ONLYDM_TEST_INSTALL_MODE -ne 'timeout') { Write-Output 'Inert installer output' }
switch ($env:ONLYDM_TEST_INSTALL_MODE) {
    'fail' { throw 'Inert installer failed deliberately.' }
    'reopen' {
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'running-app'), 'another dummy app')
        throw 'Inert installer saw an app opened by the user.'
    }
    'missing-target' { [IO.File]::Delete((Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\OnlyDM.exe')) }
    'timeout' {
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installer-stop')) -and $deadline.Elapsed.TotalSeconds -lt 15) {
            Start-Sleep -Milliseconds 25
        }
    }
}
exit 0
'@

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-Dummy([string]$StopFile) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $TestExecutable
    $info.Arguments = '--dummy-parent "' + $StopFile + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($info)
}

function New-Case([string]$Name) {
    $root = Join-Path $fixtureRoot $Name
    $local = Join-Path $root 'local'
    $canonical = Join-Path $local 'Programs\OnlyDM\OnlyDM.exe'
    $fallback = Join-Path $root 'original & (old)\OnlyDM.exe'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($canonical))
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($fallback))
    [IO.File]::WriteAllText($canonical, 'inert; launching is intercepted')
    [IO.File]::WriteAllText($fallback, 'inert; launching is intercepted')
    [IO.File]::WriteAllText((Join-Path $root 'helper.ps1'), $wrapperSource)
    [IO.File]::WriteAllText((Join-Path $root 'install.ps1'), $inertInstaller)
    $stop = Join-Path $root 'parent-stop'
    $parent = New-Dummy $stop
    return @{ Root = $root; Local = $local; Canonical = $canonical; Fallback = $fallback; Stop = $stop; Parent = $parent; Ticks = $parent.StartTime.ToUniversalTime().Ticks }
}

function Start-Helper($Case, [string]$Mode = '', [long]$Ticks = $Case.Ticks) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $powershellPath
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $Case.Root 'helper.ps1') + '" -ParentProcessId ' + $Case.Parent.Id + ' -ParentStartTimeUtcTicks ' + $Ticks + ' -ReleaseTag v9.8.7 -InstallerPath "' + (Join-Path $Case.Root 'install.ps1') + '" -FallbackExecutablePath "' + $Case.Fallback + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['LOCALAPPDATA'] = $Case.Local
    $info.EnvironmentVariables['ONLYDM_TEST_INSTALL_MODE'] = $Mode
    return [Diagnostics.Process]::Start($info)
}

function Stop-Dummy($Case) {
    [IO.File]::WriteAllText($Case.Stop, 'exit gracefully')
    Assert ($Case.Parent.WaitForExit(5000)) 'Dummy parent did not exit gracefully.'
}

function Read-Launches($Case) {
    $path = Join-Path $Case.Root 'launches.jsonl'
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | ForEach-Object { $_ | ConvertFrom-Json } }
}

function Run-Case([string]$Name, [scriptblock]$Test) {
    if ($CaseFilter -and $CaseFilter -ne $Name) { return }
    $case = New-Case $Name
    try {
        & $Test $case
        $script:caseCount++
        Write-Output "PASS: helper $Name"
    }
    finally {
        Stop-Dummy $case
        $case.Parent.Dispose()
    }
}

try {
    Run-Case 'waits-for-graceful-parent-exit-and-pins-release' {
        param($case)
        $helper = Start-Helper $case
        try {
            $deadline = [Diagnostics.Stopwatch]::StartNew()
            while (-not (Test-Path -LiteralPath (Join-Path $case.Root 'waiting')) -and $deadline.Elapsed.TotalSeconds -lt 5) {
                Start-Sleep -Milliseconds 30
            }
            Assert (Test-Path -LiteralPath (Join-Path $case.Root 'waiting')) 'Helper never entered the real parent wait.'
            Assert (Test-Path -LiteralPath (Join-Path $case.Root 'ready')) 'Helper entered the parent wait without publishing readiness.'
            Assert (-not (Test-Path -LiteralPath (Join-Path $case.Root 'ready.tmp'))) 'Readiness was not atomically published.'
            Start-Sleep -Milliseconds 300
            Assert (-not (Test-Path -LiteralPath (Join-Path $case.Root 'installed'))) 'Installer ran before graceful parent exit.'
            Assert (-not $case.Parent.HasExited) 'Helper terminated the parent.'
            Stop-Dummy $case
            Assert ($helper.WaitForExit(10000)) 'Successful helper exceeded ten seconds after parent exit.'
            Assert ($helper.ExitCode -eq 0) 'Successful helper failed.'
            Assert (([IO.File]::ReadAllText((Join-Path $case.Root 'installed'))).Trim() -ceq 'v9.8.7') 'Installer did not receive exactly the pinned release tag.'
            $launches = @(Read-Launches $case)
            Assert ($launches.Count -eq 2) 'Expected exactly one installer and one restart.'
            Assert (-not $launches[0].shell -and $launches[0].hidden) 'Installer did not use a hidden direct process.'
            Assert ($launches[1].executable -eq $case.Canonical -and $launches[1].arguments -eq '--account-switch') 'Successful update did not restart the canonical app visibly.'
        }
        finally { $helper.Dispose() }
    }
    foreach ($mode in @('fail', 'missing-target', 'reopen')) {
        Run-Case $mode {
            param($case)
            Stop-Dummy $case
            $otherStop = Join-Path $case.Root 'other-stop'
            $other = New-Dummy $otherStop
            $helper = Start-Helper $case $mode
            try {
                Assert ($helper.WaitForExit(10000)) 'Failed helper did not finish.'
                Assert ($helper.ExitCode -ne 0) 'Installer/restart failure was reported as success.'
                Assert (Test-Path -LiteralPath (Join-Path $case.Root 'update.log')) 'Failure did not leave a private log.'
                Assert (Test-Path -LiteralPath (Join-Path $case.Root 'error-ui')) 'Failure did not report an OnlyDM error.'
                Assert (-not $other.HasExited) 'Helper terminated an unrelated process.'
                $launches = @(Read-Launches $case)
                if ($mode -eq 'reopen') {
                    Assert ($launches.Count -eq 1) 'Helper relaunched an app while the user had another open.'
                }
                else {
                    Assert ($launches.Count -eq 2) 'Failure must attempt exactly one fallback restart.'
                    Assert ($launches[1].executable -eq $case.Fallback -and $launches[1].arguments -eq '--account-switch') 'Failure did not restart the original app visibly.'
                }
            }
            finally {
                [IO.File]::WriteAllText($otherStop, 'exit gracefully')
                Assert ($other.WaitForExit(5000)) 'Other dummy failed to exit.'
                $other.Dispose()
                $helper.Dispose()
            }
        }
    }
    Run-Case 'reused-pid-is-not-waited-on-or-terminated' {
        param($case)
        $helper = Start-Helper $case '' ($case.Ticks + 1)
        try {
            Assert ($helper.WaitForExit(10000)) 'Reused PID was incorrectly waited on.'
            Assert ($helper.ExitCode -eq 0) 'Original parent already exited, but update failed.'
            Assert (-not $case.Parent.HasExited) 'Reused PID was terminated.'
        }
        finally { $helper.Dispose() }
    }
    Run-Case 'another-app-opened-before-install-is-retained' {
        param($case)
        Stop-Dummy $case
        [IO.File]::WriteAllText((Join-Path $case.Root 'running-app'), 'user reopened app')
        $helper = Start-Helper $case
        try {
            Assert ($helper.WaitForExit(10000)) 'Already-running check did not finish.'
            Assert ($helper.ExitCode -ne 0) 'Already-running app was not reported.'
            Assert (@(Read-Launches $case).Count -eq 0) 'An installer or duplicate app was launched.'
        }
        finally { $helper.Dispose() }
    }
    Run-Case 'pre-ready-validation-error-is-logged-without-ui-or-restart' {
        param($case)
        [IO.File]::Delete((Join-Path $case.Root 'install.ps1'))
        $helper = Start-Helper $case
        try {
            Assert ($helper.WaitForExit(5000)) 'Pre-ready validation error did not exit.'
            Assert ($helper.ExitCode -ne 0) 'Invalid staging was accepted.'
            Assert (Test-Path -LiteralPath (Join-Path $case.Root 'update.log')) 'Pre-ready failure was not logged.'
            Assert (-not (Test-Path -LiteralPath (Join-Path $case.Root 'ready'))) 'Invalid helper signaled readiness.'
            Assert (-not (Test-Path -LiteralPath (Join-Path $case.Root 'error-ui'))) 'Pre-ready failure blocked on UI.'
            Assert (@(Read-Launches $case).Count -eq 0) 'Pre-ready failure started another process.'
            Assert (-not $case.Parent.HasExited) 'Pre-ready failure stopped the parent.'
        }
        finally { $helper.Dispose() }
    }
    Run-Case 'installer-timeout-does-not-kill-installer-or-restart-app' {
        param($case)
        Stop-Dummy $case
        $helper = Start-Helper $case 'timeout'
        $installer = $null
        try {
            Assert ($helper.WaitForExit(10000)) 'Installer timeout handling did not finish.'
            Assert ($helper.ExitCode -ne 0) 'Installer timeout was accepted.'
            $installer = [Diagnostics.Process]::GetProcessById([int][IO.File]::ReadAllText((Join-Path $case.Root 'installer.pid')))
            Assert (-not $installer.HasExited) 'Timed-out installer was terminated during its transaction.'
            Assert (@(Read-Launches $case).Count -eq 1) 'An app was restarted while the installer was still running.'
            Assert (([IO.File]::ReadAllText((Join-Path $case.Root 'installer-wait-ms'))) -eq '600000') 'Installer wait was not bounded to ten minutes.'
            Assert (([IO.File]::ReadAllText((Join-Path $case.Root 'error-ui'))) -match 'still running') 'Timeout UI did not explain the live installer.'
            Assert (([IO.File]::ReadAllText((Join-Path $case.Root 'update.log'))) -match 'still running') 'Timeout log did not explain the live installer.'
        }
        finally {
            [IO.File]::WriteAllText((Join-Path $case.Root 'installer-stop'), 'exit gracefully')
            if ($null -ne $installer) {
                Assert ($installer.WaitForExit(5000)) 'Inert installer did not exit gracefully.'
                $installer.Dispose()
            }
            $helper.Dispose()
        }
    }
    Run-Case '30-second-parent-timeout-never-kills-or-installs' {
        param($case)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $helper = Start-Helper $case
        try {
            Assert ($helper.WaitForExit(35000)) 'Helper exceeded the bounded parent wait.'
            Assert ($timer.Elapsed.TotalSeconds -ge 29 -and $timer.Elapsed.TotalSeconds -lt 35) 'Parent wait was not approximately 30 seconds.'
            Assert ($helper.ExitCode -ne 0) 'Parent timeout was reported as success.'
            Assert (-not $case.Parent.HasExited) 'Timed-out parent was terminated.'
            Assert (@(Read-Launches $case).Count -eq 0) 'Timed-out update started an installer or duplicate app.'
            Assert (Test-Path -LiteralPath (Join-Path $case.Root 'update.log')) 'Parent timeout did not produce diagnostics.'
            Assert (Test-Path -LiteralPath (Join-Path $case.Root 'error-ui')) 'Parent timeout did not report an error.'
        }
        finally { $helper.Dispose() }
    }
    Assert ($caseCount -gt 0) 'No helper fixture cases ran.'
    Write-Output "Updater helper fixture: $caseCount cases passed (dummy processes and inert installer only)."
}
finally {
    # This path was created here; never enumerate or clean a real OnlyDM directory.
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'OnlyDM-update-fixture-*') {
        throw 'Refusing to remove a fixture outside its owned temporary directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
