$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'install.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$helper = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PathWithEntryFirst' }, $true)
if (-not $helper) { throw 'Installer must register its CLI before older npm shims.' }
. ([scriptblock]::Create($helper.Extent.Text))

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}

$entry = Join-Path $env:LOCALAPPDATA 'Programs\OnlyDM\cli'
$other = 'C:\Windows;C:\Tools with spaces'
Assert-Equal (Get-PathWithEntryFirst $other $entry) "$entry;$other"
Assert-Equal (Get-PathWithEntryFirst "$other;$entry" $entry) "$entry;$other"
Assert-Equal (Get-PathWithEntryFirst "$entry;$other" $entry) "$entry;$other"
$duplicate = '"' + $entry.ToUpperInvariant() + '\"'
Assert-Equal (Get-PathWithEntryFirst "$other;$duplicate;$entry" $entry) "$entry;$other"
Assert-Equal (Get-PathWithEntryFirst '%LOCALAPPDATA%\Programs\OnlyDM\cli;C:\Windows' $entry) "$entry;C:\Windows"
Assert-Equal (Get-PathWithEntryFirst '' $entry) $entry

# Use real shells with a stale npm shim and a directory containing spaces.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('OnlyDM CLI test ' + [guid]::NewGuid().ToString('N'))
$native = Join-Path $fixture 'OnlyDM cli'
$npm = Join-Path $fixture 'npm'
$previousPath = $env:Path
try {
    New-Item -ItemType Directory -Path $native, $npm | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'cli\odm.cmd'), (Join-Path $root 'cli\OnlyDM.Command.ps1') -Destination $native
    [IO.File]::WriteAllText((Join-Path $npm 'odm.ps1'), 'throw "Old npm shim ran."')
    [IO.File]::WriteAllText((Join-Path $npm 'odm.cmd'), "@echo Old npm shim ran.`r`n@exit /b 91`r`n")
    $env:Path = Get-PathWithEntryFirst "$npm;$previousPath" $native
    Push-Location ([IO.Path]::GetPathRoot($env:SystemRoot))
    try {
        $output = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Restricted -Command '(Get-Command odm).Source; odm help' 2>&1
        if ($LASTEXITCODE -ne 0 -or -not ($output -contains (Join-Path $native 'odm.cmd')) -or "$output" -match 'Old npm shim') {
            throw "PowerShell must select the native CMD wrapper: $output"
        }
        $output = & $env:ComSpec /d /c 'odm help' 2>&1
        if ($LASTEXITCODE -ne 0 -or "$output" -notmatch 'odm update' -or "$output" -match 'Old npm shim') {
            throw "CMD must invoke the native CLI from any directory: $output"
        }
    } finally { Pop-Location }
} finally {
    $env:Path = $previousPath
    $resolved = [IO.Path]::GetFullPath($fixture)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Write-Host 'PASS: Windows CLI PATH priority and PowerShell/CMD dispatch'