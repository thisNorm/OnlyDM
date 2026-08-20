param(
    [ValidateSet("start", "stop", "restart", "status", "on", "off", "update", "uninstall", "help")]
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"
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
        Write-Host "Downloading Microsoft Edge WebView2 Runtime installer..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $WebView2BootstrapperUrl -UseBasicParsing -OutFile $bootstrapperPath
        if (-not (Test-MicrosoftAuthenticodeSignature $bootstrapperPath)) {
            throw "The downloaded WebView2 installer is not a valid Microsoft-signed executable."
        }

        Write-Host "Installing Microsoft Edge WebView2 Runtime..." -ForegroundColor Cyan
        $process = Start-Process -FilePath $bootstrapperPath -ArgumentList "/silent", "/install" -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "WebView2 installer exited with code $($process.ExitCode)."
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-WebView2RuntimeInstalled)) {
        throw "WebView2 Runtime installation could not be verified."
    }
}

function Ensure-OnlyDMDependencies {
    if (Test-WebView2RuntimeInstalled) {
        return $true
    }

    if (-not (Request-WebView2InstallConsent)) {
        Write-Host "WebView2 installation was declined. OnlyDM was not started." -ForegroundColor Yellow
        return $false
    }

    Install-WebView2Runtime
    return $true
}

function Assert-OnlyDMInstalled {
    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "OnlyDM is not installed. Install it first with the public installer or npm bootstrapper."
    }
}

function Start-OnlyDM {
    Assert-OnlyDMInstalled
    if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) {
        Write-Host "OnlyDM is already running." -ForegroundColor Yellow
        return
    }
    if (-not (Ensure-OnlyDMDependencies)) {
        return
    }
    Start-Process -FilePath $ExecutablePath -WorkingDirectory $InstallDir | Out-Null
    Write-Host "OnlyDM started." -ForegroundColor Green
}

function Stop-OnlyDM {
    $processes = Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue
    if (-not $processes) {
        Write-Host "OnlyDM is not running." -ForegroundColor Yellow
        return
    }
    $processes | Stop-Process -Force
    $processes | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Write-Host "OnlyDM stopped." -ForegroundColor Green
}

function Get-AutoStartEnabled {
    $value = Get-ItemPropertyValue -Path $AutoStartKey -Name $AutoStartName -ErrorAction SilentlyContinue
    return [bool]$value
}

function Enable-AutoStart {
    Assert-OnlyDMInstalled
    New-Item -Path $AutoStartKey -Force | Out-Null
    New-ItemProperty -Path $AutoStartKey -Name $AutoStartName -Value ('"' + $ExecutablePath + '"') -PropertyType String -Force | Out-Null
    Write-Host "OnlyDM auto start enabled." -ForegroundColor Green
}

function Disable-AutoStart {
    Remove-ItemProperty -Path $AutoStartKey -Name $AutoStartName -ErrorAction SilentlyContinue
    Write-Host "OnlyDM auto start disabled." -ForegroundColor Green
}

function Show-OnlyDMStatus {
    $installed = Test-Path -LiteralPath $ExecutablePath -PathType Leaf
    $running = [bool](Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue)
    $webView2 = Test-WebView2RuntimeInstalled
    $autoStart = Get-AutoStartEnabled
    $version = "not installed"
    if ($installed) {
        $version = (Get-Item -LiteralPath $ExecutablePath).VersionInfo.FileVersion
        if (-not $version) { $version = "installed" }
    }

    Write-Host ("OnlyDM      {0}" -f $(if ($installed) { "installed" } else { "not installed" }))
    Write-Host ("Version     {0}" -f $version)
    Write-Host ("Process     {0}" -f $(if ($running) { "running" } else { "stopped" }))
    Write-Host ("WebView2    {0}" -f $(if ($webView2) { "installed" } else { "missing" }))
    Write-Host ("Auto start  {0}" -f $(if ($autoStart) { "on" } else { "off" }))
}

function Invoke-LocalMaintenanceScript([string]$ScriptPath) {
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Installed maintenance script is missing: $ScriptPath"
    }

    $tempPath = Join-Path ([IO.Path]::GetTempPath()) ("OnlyDM-" + [Guid]::NewGuid().ToString("N") + ".ps1")
    try {
        Copy-Item -LiteralPath $ScriptPath -Destination $tempPath
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempPath
        if ($LASTEXITCODE -ne 0) {
            throw "$ScriptPath failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

function Show-Help {
    @"
OnlyDM command wrapper

Usage:
  odm              Start OnlyDM
  odm start        Start OnlyDM
  odm stop         Stop OnlyDM
  odm restart      Restart OnlyDM
  odm status       Show install/runtime/process/autostart status
  odm on           Enable Windows login auto start
  odm off          Disable Windows login auto start
  odm update       Update to the latest GitHub Release
  odm uninstall    Uninstall OnlyDM
"@ | Write-Host
}

switch ($Command) {
    "start" { Start-OnlyDM }
    "stop" { Stop-OnlyDM }
    "restart" { Stop-OnlyDM; Start-Sleep -Milliseconds 300; Start-OnlyDM }
    "status" { Show-OnlyDMStatus }
    "on" { Enable-AutoStart }
    "off" { Disable-AutoStart }
    "update" {
        $wasRunning = [bool](Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue)
        if ($wasRunning) { Stop-OnlyDM }
        Invoke-LocalMaintenanceScript $InstallScriptPath
        if ($wasRunning) { Start-OnlyDM }
    }
    "uninstall" {
        if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) { Stop-OnlyDM }
        Invoke-LocalMaintenanceScript $UninstallScriptPath
    }
    "help" { Show-Help }
}
