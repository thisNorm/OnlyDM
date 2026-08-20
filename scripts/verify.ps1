$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    # Build first, then run the produced exe. "dotnet run" repeats an implicit restore
    # on every invocation, which is the slow, network-dependent path.
    Write-Host "[1/4] Release build" -ForegroundColor Cyan
    dotnet build ".\OnlyDM.sln" -c Release --nologo
    if ($LASTEXITCODE -ne 0) { throw "Release build failed." }

    Write-Host "[2/4] Navigation policy tests" -ForegroundColor Cyan
    $testExe = ".\tests\OnlyDM.NavigationPolicyTests\bin\Release\net8.0\OnlyDM.NavigationPolicyTests.exe"
    if (-not (Test-Path -LiteralPath $testExe)) { throw "Test executable was not produced: $testExe" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "Navigation policy tests failed." }

    Write-Host "[3/4] Distribution contract" -ForegroundColor Cyan
    $requiredFiles = @(
        ".\LICENSE",
        ".\PRIVACY.md",
        ".\install.ps1",
        ".\uninstall.ps1",
        ".\package.json",
        ".\cli\odm.js",
        ".\cli\odm.ps1",
        ".\cli\odm.cmd",
        ".\.github\workflows\release.yml"
    )
    foreach ($path in $requiredFiles) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Missing distribution file: $path"
        }
    }

    $installer = Get-Content -Raw ".\install.ps1"
    $workflow = Get-Content -Raw ".\.github\workflows\release.yml"
    foreach ($asset in @("OnlyDM-win-x64.zip", "OnlyDM-win-arm64.zip")) {
        if (-not $installer.Contains('OnlyDM-$runtime.zip')) {
            throw "Installer asset naming contract is missing."
        }
        if (-not $workflow.Contains($asset)) {
            throw "Release workflow asset is missing: $asset"
        }
    }
   if (-not $installer.Contains("Get-FileHash")) {
       throw "Installer checksum verification is missing."
   }
    foreach ($marker in @("ReleaseTag", "Test-MicrosoftAuthenticodeSignature")) {
        if (-not $installer.Contains($marker)) { throw "Installer security contract is missing: $marker" }
    }
    if (-not $workflow.Contains(".sha256")) {
        throw "Release checksum assets are missing."
    }

    $packageJson = Get-Content -Raw ".\package.json"
    $nodeCli = Get-Content -Raw ".\cli\odm.js"
    $odmCli = Get-Content -Raw ".\cli\odm.ps1"
    if (-not $packageJson.Contains('"name": "@thisnorm/onlydm"')) {
        throw "npm package name contract is missing."
    }
    if (-not $packageJson.Contains('"access": "public"')) {
        throw "Scoped npm package public access contract is missing."
    }
    if (-not $packageJson.Contains('"odm": "cli/odm.js"')) {
        throw "npm odm bin contract is missing."
    }
    if (-not ($nodeCli.Contains("install.ps1") -and $nodeCli.Contains("uninstall.ps1"))) {
        throw "npm PowerShell delegation contract is missing."
    }
    if (-not ($nodeCli.Contains("command === 'start'") -and $nodeCli.Contains("OnlyDM is not installed"))) {
        throw "odm first-run bootstrap contract is missing."
    }
   if (-not $odmCli.Contains("Ensure-OnlyDMDependencies")) {
       throw "odm dependency check is missing."
   }
    if ($odmCli.Contains("Invoke-BootstrapScript")) {
        throw "Installed odm must not execute mutable branch scripts."
    }

    Write-Host "[4/4] Messenger UI contract" -ForegroundColor Cyan
    $uiFiles = @(
        ".\src\OnlyDM\AppTheme.cs",
        ".\src\OnlyDM\AppSettings.cs",
        ".\src\OnlyDM\SettingsStore.cs",
        ".\src\OnlyDM\SettingsWindow.xaml",
        ".\src\OnlyDM\ChatWindow.xaml",
        ".\src\OnlyDM\WebViewScripts.cs",
       ".\src\OnlyDM\WebView2DependencyService.cs",
        ".\src\OnlyDM\LocalDataProtection.cs",
       ".\src\OnlyDM\Assets\OnlyDM.ico",
        ".\docs\assets\onlydm-showcase.png"
    )
    foreach ($path in $uiFiles) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Missing UI file: $path"
        }
    }
   $mainWindowCode = Get-Content -Raw ".\src\OnlyDM\MainWindow.xaml.cs"
   $webScripts = Get-Content -Raw ".\src\OnlyDM\WebViewScripts.cs"
   $themeCode = Get-Content -Raw ".\src\OnlyDM\AppTheme.cs"
    $chatCode = Get-Content -Raw ".\src\OnlyDM\ChatWindow.xaml.cs"
    $threadStore = Get-Content -Raw ".\src\OnlyDM\ThreadStore.cs"
    $friendsStore = Get-Content -Raw ".\src\OnlyDM\FriendsStore.cs"
    $aliasBook = Get-Content -Raw ".\src\OnlyDM\AliasBook.cs"
    if (-not ($mainWindowCode.Contains("open-thread") -and $mainWindowCode.Contains("new ChatWindow"))) {
        throw "Separate chat-window bridge is missing."
    }
    foreach ($marker in @("NavigationCompleted", "ExecuteScriptAsync", "RunInboxProjectionAsync", "projection-error")) {
        if (-not $mainWindowCode.Contains($marker)) { throw "Explicit inbox projection runtime is missing: $marker" }
    }
    if (-not ($webScripts.Contains("dblclick") -and $webScripts.Contains("filter-threads"))) {
        throw "Inbox interaction bridge is missing."
    }
    # Theme changes must repaint in place; reloading would re-harvest every conversation.
    # Rows must be updated in place; rebuilding them mid-harvest makes conversations unopenable.
    foreach ($marker in @("updateThreadRow", "onlydm-chip", "data-tiles")) {
        if (-not $webScripts.Contains($marker)) { throw "Classic list contract is missing: $marker" }
    }
    foreach ($marker in @("set-theme", "BuildInboxThemeMessage", "BuildChatThemeMessage", "PAGE_SIZE")) {
        if (-not $webScripts.Contains($marker)) { throw "Live theme/paging contract is missing: $marker" }
    }
    if ($mainWindowCode.Contains("Browser.Reload()")) {
        throw "Settings changes must not reload the inbox (it re-harvests every conversation)."
    }
    if (-not ($webScripts.Contains("normalize('NFC')") -and $mainWindowCode.Contains("IsNormalized"))) {
        throw "Hangul NFC composition contract is missing."
    }
    # A stray control character makes ExecuteScriptAsync fail silently, which disables
    # the entire DM projection without surfacing an error anywhere.
    $control = [regex]::Matches($webScripts, "[\x00-\x08\x0B\x0C\x0E-\x1F]")
    if ($control.Count -gt 0) {
        $where = ($control | ForEach-Object { "U+{0:X4}@{1}" -f [int][char]$_.Value, $_.Index }) -join ", "
        throw "Injected scripts contain control characters: $where"
    }
   foreach ($marker in @("sourceDiagnostics", "No DM thread rows detected", "projection-error")) {
       if (-not $webScripts.Contains($marker)) { throw "Projection diagnostic contract is missing: $marker" }
   }
    foreach ($marker in @("canonicalThreadHref", "threadKey", "openThreadByKey", "item.key")) {
        if (-not $webScripts.Contains($marker)) { throw "Canonical thread identity contract is missing: $marker" }
    }
    foreach ($store in @($threadStore, $friendsStore, $aliasBook)) {
        if (-not $store.Contains("LocalDataProtection.Protect")) { throw "Protected metadata storage contract is missing." }
    }
    if (-not $chatCode.Contains("IsInstagramCallUri")) { throw "Call origin contract is missing." }
    if (-not ($themeCode.Contains("#FEE500") -and $themeCode.Contains("ThemeKind.DM"))) {
        throw "Classic/DM theme contract is missing."
    }
    $settingsXaml = Get-Content -Raw ".\src\OnlyDM\SettingsWindow.xaml"
    $settingsCode = Get-Content -Raw ".\src\OnlyDM\AppSettings.cs"
    $trayCode = Get-Content -Raw ".\src\OnlyDM\TrayIconService.cs"
    foreach ($marker in @("OnlyDmShell", "onlydm-thread-row", "renderThreadList", "thread-notification", "scrollbar-width: none",
                          "onlydm-unread-badge", "harvestThreads", "__onlydmInboxRerun")) {
        if (-not $webScripts.Contains($marker)) { throw "DM-only projection contract is missing: $marker" }
    }
    foreach ($marker in @("ClassicThemePreview", "DmThemePreview", "NotificationEnabledCheckBox", "NotificationPreviewCheckBox")) {
        if (-not $settingsXaml.Contains($marker)) { throw "Settings preview/notification contract is missing: $marker" }
    }
    foreach ($marker in @("NotificationsEnabled", "NotificationPreviewEnabled")) {
        if (-not $settingsCode.Contains($marker)) { throw "Notification setting contract is missing: $marker" }
    }
    foreach ($marker in @("알림 받기", "메시지 내용 표시", "UpdateQuickSettings", "ShowNotification", "BalloonTipClicked")) {
        if (-not $trayCode.Contains($marker)) { throw "Tray quick-setting contract is missing: $marker" }
    }

    Write-Host "Verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
