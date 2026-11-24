param(
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"
$commandArguments = @()
if ($PSBoundParameters.ContainsKey("Command")) { $commandArguments += $Command }
$commandArguments += $args
if ($commandArguments.Count -gt 1) {
    [Console]::Error.WriteLine("Expected one command. Run 'odm help'.")
    exit 2
}
if ($commandArguments.Count -eq 1) { $Command = $commandArguments[0].ToLowerInvariant() }
$Command = switch ($Command) {
    { $_ -in @("--help", "-h") } { "help" }
    { $_ -in @("--version", "-v") } { "version" }
    default { $Command }
}
if ($Command -notin @("install", "start", "stop", "restart", "status", "on", "off", "update", "uninstall", "help", "version")) {
    [Console]::Error.WriteLine("Unknown command. Run 'odm help'.")
    exit 2
}

if (-not $env:LOCALAPPDATA) {
    [Console]::Error.WriteLine("Windows app data is unavailable.")
    exit 1
}

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\OnlyDM"
$ExecutablePath = Join-Path $InstallDir "OnlyDM.exe"
$InstallScriptPath = Join-Path $InstallDir "install.ps1"
$UninstallScriptPath = Join-Path $InstallDir "uninstall.ps1"
$AutoStartKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$AutoStartName = "OnlyDM"
$WebView2BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

function Test-WebView2RuntimeInstalled {
    $registryPatterns = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\*"
    )

    foreach ($pattern in $registryPatterns) {
        $runtime = Get-ItemProperty -Path $pattern -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.name -match "WebView2") -and
                ($_.pv -or $_.version)
            } |
            Select-Object -First 1
        if ($runtime) {
            return $true
        }
    }

    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application"),
        (Join-Path $env:ProgramFiles "Microsoft\EdgeWebView\Application"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\EdgeWebView\Application")
    ) | Where-Object { $_ }

    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            $executable = Get-ChildItem -Path $root -Filter "msedgewebview2.exe" -Recurse -File -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($executable) {
                return $true
            }
        }
    }

    return $false
}

function Test-MicrosoftAuthenticodeSignature([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        -not $signature.SignerCertificate) {
        return $false
    }

    if ($signature.SignerCertificate.Subject -notmatch '(?i)(^|,\s*)CN=Microsoft Corporation(,|$)') {
        return $false
    }

    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    try {
        return $chain.Build($signature.SignerCertificate)
    }
    finally {
        $chain.Dispose()
    }
}

function Request-WebView2InstallConsent {
    Add-Type -AssemblyName System.Windows.Forms
    $message = @"
Microsoft Edge WebView2 Runtime is required to run OnlyDM.
It is not currently installed on this computer.

Would you like to install it now?
"@
    $result = [System.Windows.Forms.MessageBox]::Show(
        $message,
        "OnlyDM Setup",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button1
    )
    return $result -eq [System.Windows.Forms.DialogResult]::Yes
}

function Install-WebView2Runtime {
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("OnlyDM-WebView2-" + [Guid]::NewGuid().ToString("N"))
    $bootstrapperPath = Join-Path $tempRoot "MicrosoftEdgeWebview2Setup.exe"

    try {
        New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
        Write-Host "Downloading WebView2..." -ForegroundColor Cyan
        try { Invoke-WebRequest -Uri $WebView2BootstrapperUrl -UseBasicParsing -OutFile $bootstrapperPath }
        catch { throw "Could not download WebView2. Try again." }
        if (-not (Test-MicrosoftAuthenticodeSignature $bootstrapperPath)) {
            throw "Could not verify the WebView2 installer."
        }

        Write-Host "Installing WebView2..." -ForegroundColor Cyan
        $process = Start-Process -FilePath $bootstrapperPath -ArgumentList "/silent", "/install" -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "Could not install WebView2 (exit code $($process.ExitCode))."
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-WebView2RuntimeInstalled)) {
        throw "Could not verify the WebView2 installation."
    }
}

function Ensure-OnlyDMDependencies {
    if (Test-WebView2RuntimeInstalled) {
        return $true
    }

    if (-not (Request-WebView2InstallConsent)) {
        return $false
    }

    Install-WebView2Runtime
    return $true
}

function Assert-OnlyDMInstalled {
    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "OnlyDM is not installed. Run 'odm install'."
    }
}

function Start-OnlyDM([switch]$Quiet, [string]$Success = "OnlyDM started.") {
    Assert-OnlyDMInstalled
    if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) {
        if (-not $Quiet) { Write-Host "OnlyDM is already running." }
        return
    }
    if (-not (Ensure-OnlyDMDependencies)) {
        throw "Start canceled. OnlyDM needs WebView2."
    }
    try { Start-Process -FilePath $ExecutablePath -WorkingDirectory $InstallDir | Out-Null }
    catch { throw "Could not start OnlyDM. Check the installation with 'odm status'." }
    if (-not $Quiet) { Write-Host $Success -ForegroundColor Green }
}

function Stop-OnlyDM([switch]$Quiet) {
    $processes = Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue
    if (-not $processes) {
        if (-not $Quiet) { Write-Host "OnlyDM is already stopped." }
        return
    }
    try { $processes | Stop-Process -Force }
    catch { throw "Could not stop OnlyDM. Close it and try again." }
    $processes | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) {
        throw "OnlyDM is still running. Close it and try again."
    }
    if (-not $Quiet) { Write-Host "OnlyDM stopped." -ForegroundColor Green }
}

function Get-AutoStartEnabled {
    $value = Get-ItemPropertyValue -Path $AutoStartKey -Name $AutoStartName -ErrorAction SilentlyContinue
    return [bool]$value
}

function Enable-AutoStart {
    Assert-OnlyDMInstalled
    try {
        New-Item -Path $AutoStartKey -Force | Out-Null
        New-ItemProperty -Path $AutoStartKey -Name $AutoStartName -Value ('"' + $ExecutablePath + '"') -PropertyType String -Force | Out-Null
    }
    catch { throw "Could not turn on start at login." }
    Write-Host "Start at login is on." -ForegroundColor Green
}

function Disable-AutoStart {
    if (Get-AutoStartEnabled) {
        try { Remove-ItemProperty -Path $AutoStartKey -Name $AutoStartName }
        catch { throw "Could not turn off start at login." }
    }
    Write-Host "Start at login is off." -ForegroundColor Green
}

function Show-OnlyDMStatus {
    $installed = Test-Path -LiteralPath $ExecutablePath -PathType Leaf
    $running = [bool](Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue)
    $webView2 = Test-WebView2RuntimeInstalled
    $autoStart = Get-AutoStartEnabled
    $version = "-"
    if ($installed) {
        $version = (Get-Item -LiteralPath $ExecutablePath).VersionInfo.FileVersion
        if (-not $version) { $version = "unknown" }
    }

    Write-Host ("OnlyDM: {0}" -f $(if ($installed) { "installed" } else { "not installed" }))
    Write-Host ("Version: {0}" -f $version)
    Write-Host ("Status: {0}" -f $(if ($running) { "running" } else { "stopped" }))
    Write-Host ("Start at login: {0}" -f $(if ($autoStart) { "on" } else { "off" }))
    Write-Host ("WebView2: {0}" -f $(if ($webView2) { "installed" } else { "missing" }))
}

function Show-OnlyDMVersion {
    Assert-OnlyDMInstalled
    Write-Output (Get-Item -LiteralPath $ExecutablePath).VersionInfo.FileVersion
}

function Get-OnlyDMUpdateTag {
    Write-Host "Checking for updates..." -ForegroundColor Cyan
    $fileVersion = [string](Get-Item -LiteralPath $ExecutablePath).VersionInfo.FileVersion
    $installedVersion = [regex]::Match($fileVersion, '^\d+\.\d+\.\d+').Value
    if (-not $installedVersion) { throw "Could not read the installed version. Run 'odm install'." }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $headers = @{ "User-Agent" = "OnlyDM-CLI"; "Accept" = "application/vnd.github+json" }
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/thisNorm/OnlyDM/releases/latest" -TimeoutSec 15 -Headers $headers
        if ($release.draft -ne $false -or $release.prerelease -ne $false -or $release.tag_name -cnotmatch '^v\d+\.\d+\.\d+$') {
            throw "Invalid release."
        }
        $latest = [version]$release.tag_name.Substring(1)
    }
    catch { throw "Could not check for updates. Try again." }

    $current = [version]$installedVersion
    if ($current -eq $latest) {
        Write-Host "OnlyDM is up to date (v$current)." -ForegroundColor Green
        return
    }
    if ($current -gt $latest) {
        Write-Host "OnlyDM v$current is newer than the latest release (v$latest)."
        return
    }
    if ($release.assets -isnot [Array]) { throw "Could not check for updates. Try again." }
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $archive = switch ($architecture) {
        "AMD64" { "OnlyDM-win-x64.zip" }
        "ARM64" { "OnlyDM-win-arm64.zip" }
    }
    $assets = @($release.assets | ForEach-Object { $_.name })
    if (-not $archive -or $archive -cnotin $assets -or "$archive.sha256" -cnotin $assets) {
        throw "No update is available for this device."
    }
    return $release.tag_name
}

function Invoke-LocalMaintenanceScript([string]$ScriptPath, [string[]]$ScriptArguments = @()) {
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "OnlyDM setup files are missing. Reinstall OnlyDM."
    }

    $tempPath = Join-Path ([IO.Path]::GetTempPath()) ("OnlyDM-" + [Guid]::NewGuid().ToString("N") + ".ps1")
    try {
        Copy-Item -LiteralPath $ScriptPath -Destination $tempPath
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempPath @ScriptArguments | Out-Host
        return $LASTEXITCODE
    }
    finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

function Show-Help {
    @"
OnlyDM CLI

Usage:
  odm              Open OnlyDM
  odm install      Install OnlyDM
  odm update       Install or update OnlyDM
  odm start        Open OnlyDM
  odm stop         Stop OnlyDM
  odm restart      Restart OnlyDM
  odm status       Show version and status
  odm on           Start at login
  odm off          Turn off start at login
  odm uninstall    Remove OnlyDM and local data
  odm help         Show help
  odm --version    Show the app version
"@ | Write-Host
}

try {
    switch ($Command) {
        "start" { Start-OnlyDM }
        "stop" { Stop-OnlyDM }
        "restart" {
            Assert-OnlyDMInstalled
            if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) {
                Stop-OnlyDM -Quiet
                Start-Sleep -Milliseconds 300
                Start-OnlyDM -Success "OnlyDM restarted."
            }
            else { Start-OnlyDM }
        }
        "status" { Show-OnlyDMStatus }
        "on" { Enable-AutoStart }
        "off" { Disable-AutoStart }
        { $_ -in @("install", "update") } {
            $scriptArguments = @()
            if ($Command -eq "update" -and (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
                $tag = Get-OnlyDMUpdateTag
                if (-not $tag) { exit 0 }
                $scriptArguments = @("-ReleaseTag", $tag)
            }
            $wasRunning = [bool](Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue)
            if ($wasRunning) { Stop-OnlyDM -Quiet }
            try { $code = Invoke-LocalMaintenanceScript $InstallScriptPath $scriptArguments }
            finally {
                if ($wasRunning) {
                    try { Start-OnlyDM -Quiet }
                    catch {
                        [Console]::Error.WriteLine("Could not reopen OnlyDM. Run 'odm start'.")
                        if ($code -eq 0) { $code = 1 }
                    }
                }
            }
            exit $code
        }
        "uninstall" {
            Stop-OnlyDM -Quiet
            exit (Invoke-LocalMaintenanceScript $UninstallScriptPath)
        }
        "help" { Show-Help }
        "version" { Show-OnlyDMVersion }
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
