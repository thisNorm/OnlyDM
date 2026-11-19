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
foreach ($name in @('Path', 'LOCALAPPDATA', 'ONLYDM_CLI_TEST_LOG', 'ONLYDM_CLI_TEST_RUNNING')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    New-Item -ItemType Directory -Path $cli | Out-Null
    $env:LOCALAPPDATA = Join-Path $fixture 'user data'
    $install = Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM'
    New-Item -ItemType Directory -Path $install | Out-Null
    $exe = Join-Path $install 'OnlyDM.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $exe
    $version = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
    foreach ($command in @('install', 'uninstall')) {
        $stub = '[IO.File]::AppendAllText($env:ONLYDM_CLI_TEST_LOG, "' + $command + '" + [Environment]::NewLine)'
        [IO.File]::WriteAllText((Join-Path $install "$command.ps1"), $stub)
    }
    $offset = $ast.ParamBlock.Extent.EndOffset
    [IO.File]::WriteAllText((Join-Path $cli 'OnlyDM.Command.ps1'), $source.Substring(0, $offset) + [Environment]::NewLine + $boundaries + [Environment]::NewLine + $source.Substring($offset))
    Copy-Item -LiteralPath (Join-Path $root 'cli\odm.cmd') -Destination $cli
    $env:Path = $cli + ';' + $previous.Path
    $env:ONLYDM_CLI_TEST_LOG = Join-Path $fixture 'events.log'
    $cases = @(
        @{ Args = ''; Events = @('start') },
        @{ Args = 'start'; Events = @('start') },
        @{ Args = 'start'; Running = $true; Events = @(); Output = 'already running' },
        @{ Args = 'stop'; Running = $true; Events = @('stop', 'wait') },
        @{ Args = 'stop'; Events = @(); Output = 'not running' },
        @{ Args = 'restart'; Running = $true; Events = @('stop', 'wait', 'start') },
        @{ Args = 'restart'; Events = @('start') },
        @{ Args = 'status'; Running = $true; Events = @(); Output = 'Process\s+running' },
        @{ Args = 'on'; Events = @('autostart:on') },
        @{ Args = 'off'; Events = @('autostart:off') },
        @{ Args = 'install'; Events = @('install') },
        @{ Args = 'install'; Running = $true; Events = @('stop', 'wait', 'install', 'start') },
        @{ Args = 'update'; Events = @('install') },
        @{ Args = 'update'; Running = $true; Events = @('stop', 'wait', 'install', 'start') },
        @{ Args = 'uninstall'; Events = @('uninstall') },
        @{ Args = 'uninstall'; Running = $true; Events = @('stop', 'wait', 'uninstall') },
        @{ Args = 'help'; Events = @(); Output = 'odm update' },
        @{ Args = '--help'; Events = @(); Output = 'odm update' },
        @{ Args = '-h'; Events = @(); Output = 'odm update' },
        @{ Args = 'version'; Events = @(); Output = [regex]::Escape($version) },
        @{ Args = '--version'; Events = @(); Output = [regex]::Escape($version) },
        @{ Args = '-v'; Events = @(); Output = [regex]::Escape($version) },
        @{ Args = '-Command status'; Running = $true; Events = @(); Output = 'Process\s+running' },
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
                if ($code -ne $expectedCode -or ($events -join ',') -cne ($case.Events -join ',') -or ($case.Output -and "$output" -notmatch $case.Output)) {
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
