param(
    [string]$ReleaseTag = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
trap {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
if (-not $env:LOCALAPPDATA) { throw "Windows app data is unavailable." }

$Repository = "thisNorm/OnlyDM"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\OnlyDM"
$BackupDir = "$InstallDir.backup"
$StartMenuDir = [Environment]::GetFolderPath("Programs")
$ShortcutPath = Join-Path $StartMenuDir "OnlyDM.lnk"
$CliDir = Join-Path $InstallDir "cli"
$WebView2BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

function Get-OnlyDMArchitecture {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    }
    else {
        $env:PROCESSOR_ARCHITECTURE
    }

    switch ($architecture.ToUpperInvariant()) {
        "AMD64" { return "win-x64" }
        "ARM64" { return "win-arm64" }
        default { throw "OnlyDM is unavailable for this Windows device." }
    }
}

function Get-ReleaseAssetUrl($Release, [string]$Name) {
    $asset = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
   if (-not $asset) {
       throw "No OnlyDM installer is available for this device."
   }
    $downloadUri = $null
   if (-not [Uri]::TryCreate($asset.browser_download_url, [UriKind]::Absolute, [ref]$downloadUri) -or
        $downloadUri.Host -ne "github.com" -or
        $downloadUri.AbsolutePath -ne "/$Repository/releases/download/$($Release.tag_name)/$Name") {
        throw "Could not verify the download source."
    }
    return $downloadUri.AbsoluteUri
}

function Assert-OnlyDMIsClosed {
    if (Get-Process -Name "OnlyDM" -ErrorAction SilentlyContinue) {
        throw "OnlyDM is running. Close it and try again."
    }
}

function Recover-StaleBackup {
    $installExists = Test-Path -LiteralPath $InstallDir
    $backupExists = Test-Path -LiteralPath $BackupDir

    if ($backupExists -and -not $installExists) {
        Write-Host "Restoring the previous installation..." -ForegroundColor Yellow
        Move-Item -LiteralPath $BackupDir -Destination $InstallDir
        return
    }

    if ($backupExists -and $installExists) {
        Remove-Item -LiteralPath $BackupDir -Recurse -Force
    }
}

function New-OnlyDMShortcut([string]$ExecutablePath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $ExecutablePath
    $shortcut.WorkingDirectory = Split-Path -Parent $ExecutablePath
    $shortcut.Description = "OnlyDM"
    $shortcut.Save()
}

function Get-PathWithEntryFirst([string]$Current, [string]$Entry) {
    $normalized = [Environment]::ExpandEnvironmentVariables($Entry).Trim().Trim('"').TrimEnd('\')
    $entries = @($Current -split ';' | Where-Object {
        $_ -and [Environment]::ExpandEnvironmentVariables($_).Trim().Trim('"').TrimEnd('\') -ine $normalized
    })
    return (@($Entry) + $entries) -join ';'
}

function Add-UserPathEntry([string]$PathToAdd) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $newValue = Get-PathWithEntryFirst $current $PathToAdd
    if ($current -cne $newValue) {
        [Environment]::SetEnvironmentVariable("Path", $newValue, "User")
    }
    $env:Path = Get-PathWithEntryFirst $env:Path $PathToAdd
}

function Test-WebView2RuntimeInstalled {
    $registryPatterns = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\*"
    )

    foreach ($pattern in $registryPatterns) {
        $runtime = Get-ItemProperty -Path $pattern -ErrorAction SilentlyContinue |
            Where-Object { ($_.name -match "WebView2") -and ($_.pv -or $_.version) } |
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
    $message = "Microsoft Edge WebView2 Runtime is required to run OnlyDM.`r`nIt is not currently installed on this computer.`r`n`r`nWould you like to install it now?"
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
        catch { throw "Could not download WebView2. Run 'odm start' to retry." }
        if (-not (Test-MicrosoftAuthenticodeSignature $bootstrapperPath)) {
            throw "Could not verify the WebView2 installer."
        }
        Write-Host "Installing WebView2..." -ForegroundColor Cyan
        $process = Start-Process -FilePath $bootstrapperPath -ArgumentList "/silent", "/install" -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "Could not install WebView2 (exit code $($process.ExitCode)). Run 'odm start' to retry."
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
        Write-Host "WebView2 skipped. Run 'odm start' to install it." -ForegroundColor Yellow
        return $false
    }
    Install-WebView2Runtime
    return $true
}

if ($ReleaseTag -and $ReleaseTag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "ReleaseTag must match vMAJOR.MINOR.PATCH."
}

Assert-OnlyDMIsClosed
Recover-StaleBackup

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ "User-Agent" = "OnlyDM-Installer"; "Accept" = "application/vnd.github+json" }
$releaseUrl = if ($ReleaseTag) {
    "https://api.github.com/repos/$Repository/releases/tags/$ReleaseTag"
}
else {
    "https://api.github.com/repos/$Repository/releases/latest"
}
if (-not $ReleaseTag) { Write-Host "Checking for OnlyDM releases..." -ForegroundColor Cyan }
try { $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -TimeoutSec 15 }
catch { throw "Could not check for OnlyDM releases. Try again." }
if ($release.draft -or $release.prerelease) {
    throw "No stable OnlyDM release was found."
}
if ($release.tag_name -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "Could not verify the OnlyDM release."
}
if ($ReleaseTag -and $release.tag_name -ne $ReleaseTag) {
    throw "Could not verify the requested OnlyDM version."
}

$installedExecutable = Join-Path $InstallDir "OnlyDM.exe"
$previousVersion = $null
if (Test-Path -LiteralPath $installedExecutable -PathType Leaf) {
    $fileVersion = [string](Get-Item -LiteralPath $installedExecutable).VersionInfo.FileVersion
    $versionText = [regex]::Match($fileVersion, '^\d+\.\d+\.\d+').Value
    [void][version]::TryParse($versionText, [ref]$previousVersion)
}
$releaseVersion = $null
if (-not [version]::TryParse($release.tag_name.Substring(1), [ref]$releaseVersion)) {
    throw "Could not verify the OnlyDM release."
}

$runtime = Get-OnlyDMArchitecture
$archiveName = "OnlyDM-$runtime.zip"
$checksumName = "$archiveName.sha256"
$archiveUrl = Get-ReleaseAssetUrl $release $archiveName
$checksumUrl = Get-ReleaseAssetUrl $release $checksumName

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("OnlyDM-install-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $tempRoot $archiveName
$checksumPath = Join-Path $tempRoot $checksumName
$extractDir = Join-Path $tempRoot "payload"

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    Write-Host "Downloading OnlyDM $($release.tag_name)..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $archiveUrl -Headers $headers -UseBasicParsing -OutFile $archivePath
        Invoke-WebRequest -Uri $checksumUrl -Headers $headers -UseBasicParsing -OutFile $checksumPath
    }
    catch { throw "Could not download OnlyDM. Try again." }

    $checksumText = (Get-Content -Raw $checksumPath).Trim()
    if ($checksumText -notmatch '(?i)\b([0-9a-f]{64})\b') {
        throw "Could not verify the OnlyDM download. Try again."
    }
    $expectedHash = $Matches[1].ToLowerInvariant()
    $actualHash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Could not verify the OnlyDM download. Try again."
    }

    Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force
    $newExecutable = Join-Path $extractDir "OnlyDM.exe"
    $newOdm = Join-Path $extractDir "cli\odm.cmd"
    if (-not (Test-Path -LiteralPath $newExecutable -PathType Leaf)) {
        throw "The OnlyDM download is incomplete. Try again."
    }
    if (-not (Test-Path -LiteralPath $newOdm -PathType Leaf)) {
        throw "The OnlyDM download is incomplete. Try again."
    }

    if (Test-Path -LiteralPath $BackupDir) {
        Remove-Item -LiteralPath $BackupDir -Recurse -Force
    }

    $hadExistingInstall = Test-Path -LiteralPath $InstallDir
    if ($hadExistingInstall) {
        Move-Item -LiteralPath $InstallDir -Destination $BackupDir
    }

    try {
        $installParent = Split-Path -Parent $InstallDir
        New-Item -ItemType Directory -Force -Path $installParent | Out-Null
        Move-Item -LiteralPath $extractDir -Destination $InstallDir
        New-OnlyDMShortcut (Join-Path $InstallDir "OnlyDM.exe")
        Add-UserPathEntry $CliDir
    }
    catch {
        if (Test-Path -LiteralPath $InstallDir) {
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
        }
        if ($hadExistingInstall -and (Test-Path -LiteralPath $BackupDir)) {
            Move-Item -LiteralPath $BackupDir -Destination $InstallDir
        }
        throw
    }

    if (Test-Path -LiteralPath $BackupDir) {
        Remove-Item -LiteralPath $BackupDir -Recurse -Force
    }

    if ($previousVersion -and $previousVersion -lt $releaseVersion) {
        Write-Host "OnlyDM updated to $($release.tag_name)." -ForegroundColor Green
    }
    else {
        Write-Host "OnlyDM $($release.tag_name) installed." -ForegroundColor Green
    }

    [void](Ensure-OnlyDMDependencies)
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
