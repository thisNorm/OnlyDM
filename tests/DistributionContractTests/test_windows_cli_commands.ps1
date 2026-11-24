$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourcePath = Join-Path $root 'cli\OnlyDM.Command.ps1'
$source = [IO.File]::ReadAllText($sourcePath)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }

# Keep the production parser and command body. Replace OS boundaries in this
# disposable copy so lifecycle commands cannot touch the user's app or registry.
$boundaries = @'
$script:TestRunning = $env:ONLYDM_CLI_TEST_RUNNING -eq '1'
function Write-TestEvent([string]$Value) {
    [IO.File]::AppendAllText($env:ONLYDM_CLI_TEST_LOG, $Value + [Environment]::NewLine)
}
function Get-Process {
    [CmdletBinding()] param([string]$Name)
    if ($Name -ne 'OnlyDM') { throw "Unexpected process query: $Name" }
    if ($script:TestRunning) { [pscustomobject]@{ Id = -101; ProcessName = 'OnlyDM' } }
}
function Start-Process {
    [CmdletBinding()] param([string]$FilePath, [string]$WorkingDirectory)
    $expected = Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\OnlyDM.exe'
    if ($FilePath -ne $expected -or $WorkingDirectory -ne (Split-Path -Parent $expected)) { throw 'Unsafe start target.' }
    $script:TestRunning = $true
    Write-TestEvent 'start'
}
function Stop-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, [switch]$Force)
    process {
        if ($InputObject.Id -ne -101) { throw 'Unsafe stop target.' }
        $script:TestRunning = $false
        Write-TestEvent 'stop'
    }
}
function Wait-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, [int]$Timeout)
    process {
        if ($InputObject.Id -ne -101) { throw 'Unsafe wait target.' }
        Write-TestEvent 'wait'
    }
}
function Get-Item {
    [CmdletBinding()] param([string]$LiteralPath)
    if ($LiteralPath -ne (Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\OnlyDM.exe')) { throw 'Unexpected version lookup.' }
    [pscustomobject]@{ VersionInfo = [pscustomobject]@{ FileVersion = '1.1.10.0' } }
}
function Invoke-RestMethod {
    [CmdletBinding()] param([string]$Uri, [int]$TimeoutSec, [hashtable]$Headers)
    if ($Uri -ne 'https://api.github.com/repos/thisNorm/OnlyDM/releases/latest') { throw 'Unexpected update request.' }
    Write-TestEvent 'check'
    $tag = 'v1.2.0'
    $assets = @('OnlyDM-win-x64.zip', 'OnlyDM-win-x64.zip.sha256', 'OnlyDM-win-arm64.zip', 'OnlyDM-win-arm64.zip.sha256')
    switch ($env:ONLYDM_CLI_TEST_RELEASE) {
        'current' { $tag = 'v1.1.10' }
        'older' { $tag = 'v1.1.9' }
        'missing' { $assets = @() }
        'offline' { throw 'Fixture network failure.' }
        'invalid' { $tag = 'unknown' }
    }
    [pscustomobject]@{
        tag_name = $tag
        draft = $false
        prerelease = $false
        assets = if ($env:ONLYDM_CLI_TEST_RELEASE -eq 'invalid-assets') { 'invalid' }
            else { ,@($assets | ForEach-Object { [pscustomobject]@{ name = $_ } }) }
    }
}
function Get-ItemProperty {
    [CmdletBinding()] param([string]$Path)
    if ($Path -notlike '*EdgeUpdate\Clients\*') { throw 'Unexpected registry read.' }
    [pscustomobject]@{ name = 'Microsoft Edge WebView2 Runtime'; pv = '1.0' }
}
function Get-ItemPropertyValue {
    [CmdletBinding()] param([string]$Path, [string]$Name)
    if ($Path -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -or $Name -ne 'OnlyDM') { throw 'Unexpected startup query.' }
    'fixture startup entry'
}
function New-Item {
    [CmdletBinding()] param([string]$Path, [switch]$Force)
    if ($Path -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { throw 'Unexpected registry key.' }
}
function New-ItemProperty {
    [CmdletBinding()] param([string]$Path, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force)
    if ($Path -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -or $Name -ne 'OnlyDM' -or $Value -ne ('"' + (Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\OnlyDM.exe') + '"')) { throw 'Unexpected startup write.' }
    Write-TestEvent 'autostart:on'
}
function Remove-ItemProperty {
    [CmdletBinding()] param([string]$Path, [string]$Name)
    if ($Path -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -or $Name -ne 'OnlyDM') { throw 'Unexpected startup removal.' }
    Write-TestEvent 'autostart:off'
}
'@

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('OnlyDM command test ' + [guid]::NewGuid().ToString('N'))
$cli = Join-Path $fixture 'cli'
$previous = @{}
foreach ($name in @('Path', 'LOCALAPPDATA', 'ONLYDM_CLI_TEST_LOG', 'ONLYDM_CLI_TEST_RUNNING', 'ONLYDM_CLI_TEST_RELEASE', 'ONLYDM_CLI_TEST_INSTALL_FAIL')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    New-Item -ItemType Directory -Path $cli | Out-Null
    $env:LOCALAPPDATA = Join-Path $fixture 'user data'
    $install = Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM'
    New-Item -ItemType Directory -Path $install | Out-Null
    $exe = Join-Path $install 'OnlyDM.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $exe
    $version = '1.1.10.0'
    $installer = @'
param([string]$ReleaseTag)
$event = if ($ReleaseTag) { 'install ' + $ReleaseTag } else { 'install' }
[IO.File]::AppendAllText($env:ONLYDM_CLI_TEST_LOG, $event + [Environment]::NewLine)
if ($env:ONLYDM_CLI_TEST_INSTALL_FAIL -eq '1') {
    [Console]::Error.WriteLine('Could not download OnlyDM. Try again.')
    exit 1
}
if ($ReleaseTag) { Write-Host "OnlyDM updated to $ReleaseTag." } else { Write-Host 'OnlyDM v1.2.0 installed.' }
'@
    [IO.File]::WriteAllText((Join-Path $install 'install.ps1'), $installer)
    [IO.File]::WriteAllText((Join-Path $install 'uninstall.ps1'), '[IO.File]::AppendAllText($env:ONLYDM_CLI_TEST_LOG, "uninstall" + [Environment]::NewLine)')
    $offset = $ast.ParamBlock.Extent.EndOffset
    [IO.File]::WriteAllText((Join-Path $cli 'OnlyDM.Command.ps1'), $source.Substring(0, $offset) + [Environment]::NewLine + $boundaries + [Environment]::NewLine + $source.Substring($offset))
    Copy-Item -LiteralPath (Join-Path $root 'cli\odm.cmd') -Destination $cli
    $env:Path = $cli + ';' + $previous.Path
    $env:ONLYDM_CLI_TEST_LOG = Join-Path $fixture 'events.log'
    $cases = @(
        @{ Args = ''; Events = @('start') },
        @{ Args = 'start'; Events = @('start'); Output = 'OnlyDM started\.' },
        @{ Args = 'start'; Running = $true; Events = @(); Output = 'already running' },
        @{ Args = 'stop'; Running = $true; Events = @('stop', 'wait') },
        @{ Args = 'stop'; Events = @(); Output = 'OnlyDM is already stopped\.' },
        @{ Args = 'restart'; Running = $true; Events = @('stop', 'wait', 'start'); Output = 'OnlyDM restarted\.'; Exclude = 'OnlyDM (started|stopped)\.' },
        @{ Args = 'restart'; Events = @('start') },
        @{ Args = 'status'; Running = $true; Events = @(); Output = 'Status: running' },
        @{ Args = 'on'; Events = @('autostart:on'); Output = 'Start at login is on\.' },
        @{ Args = 'off'; Events = @('autostart:off'); Output = 'Start at login is off\.' },
        @{ Args = 'install'; Events = @('install') },
        @{ Args = 'install'; Running = $true; Events = @('stop', 'wait', 'install', 'start') },
        @{ Args = 'update'; Events = @('check', 'install v1.2.0'); Output = 'OnlyDM updated to v1.2.0\.' },
        @{ Args = 'update'; Running = $true; Events = @('check', 'stop', 'wait', 'install v1.2.0', 'start'); Output = 'OnlyDM updated to v1.2.0\.' },
        @{ Args = 'update'; Running = $true; Release = 'current'; Events = @('check'); Output = 'OnlyDM is up to date \(v1.1.10\)\.' },
        @{ Args = 'update'; Running = $true; Release = 'older'; Events = @('check'); Output = 'OnlyDM v1.1.10 is newer than the latest release \(v1.1.9\)\.' },
        @{ Args = 'update'; Running = $true; Release = 'missing'; Events = @('check'); Exit = 1; Output = 'No update is available for this device\.' },
        @{ Args = 'update'; Running = $true; Release = 'offline'; Events = @('check'); Exit = 1; Output = 'Could not check for updates\. Try again\.'; Exclude = 'up to date|Fixture network failure' },
        @{ Args = 'update'; Running = $true; Release = 'invalid'; Events = @('check'); Exit = 1; Output = 'Could not check for updates\. Try again\.' },
        @{ Args = 'update'; Running = $true; Release = 'invalid-assets'; Events = @('check'); Exit = 1; Output = 'Could not check for updates\. Try again\.' },
        @{ Args = 'update'; Running = $true; InstallFail = $true; Events = @('check', 'stop', 'wait', 'install v1.2.0', 'start'); Exit = 1; Output = 'Could not download OnlyDM\. Try again\.'; Exclude = 'installed|OnlyDM-.*ps1|FullyQualifiedErrorId' },
        @{ Args = 'uninstall'; Events = @('uninstall') },
        @{ Args = 'uninstall'; Running = $true; Events = @('stop', 'wait', 'uninstall') },
        @{ Args = 'help'; Events = @(); Output = 'odm update' },
        @{ Args = '--help'; Events = @(); Output = 'odm update' },
        @{ Args = '-h'; Events = @(); Output = 'odm update' },
        @{ Args = 'version'; Events = @(); Output = [regex]::Escape($version) },
        @{ Args = '--version'; Events = @(); Output = [regex]::Escape($version) },
        @{ Args = '-v'; Events = @(); Output = [regex]::Escape($version) },
        @{ Args = '-Command status'; Running = $true; Events = @(); Output = 'Status: running' },
        @{ Args = 'not-a-command'; Events = @(); Exit = 2; Output = 'Unknown command' },
        @{ Args = '--unknown'; Events = @(); Exit = 2; Output = 'Unknown command' },
        @{ Args = 'stop extra'; Running = $true; Events = @(); Exit = 2; Output = 'one command' }
    )
    $passed = 0
    Push-Location ([IO.Path]::GetPathRoot($env:SystemRoot))
    try {
        foreach ($shell in @('PowerShell', 'CMD')) {
            foreach ($case in $cases) {
                [IO.File]::WriteAllText($env:ONLYDM_CLI_TEST_LOG, '')
                $env:ONLYDM_CLI_TEST_RUNNING = if ($case.Running) { '1' } else { '0' }
                $env:ONLYDM_CLI_TEST_RELEASE = $case.Release
                $env:ONLYDM_CLI_TEST_INSTALL_FAIL = if ($case.InstallFail) { '1' } else { '0' }
                $invocation = ('odm ' + $case.Args).TrimEnd()
                # Fixtures use only the fixed arguments above; no user text is evaluated.
                $ErrorActionPreference = 'Continue'
                try {
                    $output = if ($shell -eq 'PowerShell') {
                        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Restricted -Command ($invocation + '; exit $LASTEXITCODE') 2>&1
                    } else { & $env:ComSpec /d /c $invocation 2>&1 }
                    $code = $LASTEXITCODE
                } finally { $ErrorActionPreference = 'Stop' }
                $expectedCode = if ($case.ContainsKey('Exit')) { $case.Exit } else { 0 }
                $events = [IO.File]::ReadAllLines($env:ONLYDM_CLI_TEST_LOG)
                $wrongOutput = ($case.Output -and "$output" -notmatch $case.Output) -or
                    ($case.Exclude -and "$output" -match $case.Exclude)
                if ($code -ne $expectedCode -or ($events -join ',') -cne ($case.Events -join ',') -or $wrongOutput) {
                    throw "$shell '$invocation': exit=$code; events=$($events -join ','); output=$output"
                }
                $passed++
            }
        }
    } finally { Pop-Location }
    Write-Host "PASS: $passed Windows CLI command cases; lifecycle and registry boundaries isolated"
} finally {
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
