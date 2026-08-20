# OnlyDM

OnlyDM is a focused Windows Instagram Direct client built with WPF + Microsoft Edge WebView2. The main window behaves like a compact desktop messenger: it keeps only the chat list visible, supports quick search, and opens a conversation in a separate chat window on double-click.

> **Unofficial project:** OnlyDM is not affiliated with, endorsed by, or sponsored by Instagram or Meta. Instagram and Meta are trademarks of their respective owners. Do not use Instagram or Meta logos as OnlyDM branding.

## Install

### Recommended: npm global command

If Node.js 18+ and npm are installed:

```powershell
npm install -g @thisnorm/onlydm
odm start
```

The first `odm start` installs the selected OnlyDM GitHub Release if the app is not installed yet. Later runs start the existing app directly. No administrator privilege is required.

### Direct PowerShell installer

```powershell
$releaseTag = 'v0.2.0'
$installer = Join-Path $env:TEMP 'OnlyDM-install.ps1'
Invoke-WebRequest -Uri "https://github.com/thisNorm/OnlyDM/releases/download/$releaseTag/install.ps1" -OutFile $installer
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ReleaseTag $releaseTag
Remove-Item -LiteralPath $installer -Force
```

Replace v0.2.0 with the reviewed release tag you intend to install. This fallback does not require Node.js. The installer chooses x64 or ARM64 automatically, verifies the release ZIP with SHA-256, and installs per-user to:

```text
%LOCALAPPDATA%\Programs\OnlyDM
```

No administrator privilege is required. Close OnlyDM before installing or updating.

The npm package is a thin wrapper around `install.ps1` / `uninstall.ps1`; release download, architecture selection, checksum verification, install location, and cleanup therefore have one implementation.

### Update

After installation, use the local wrapper so maintenance scripts are not fetched from a mutable branch:

```powershell
odm update
```

### Uninstall

```powershell
odm uninstall
```

Uninstall removes the application, Start Menu shortcut, and local WebView2 profile/session data.

## Requirements

### Installed release

- Windows 10/11 on x64 or ARM64
- Microsoft Edge WebView2 Runtime
- Network access to Instagram

Release packages are .NET 8 self-contained, so a separate .NET Desktop Runtime installation is not required.

### Development

- Windows 10/11
- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
- Node.js 18+ and npm when using the npm global command

The project uses `Microsoft.Web.WebView2` NuGet package `1.0.4078.44`.

## Features

- DM-only messenger shell: Instagram navigation/feed/Reels/profile UI stays hidden and only the Direct conversation list is projected into OnlyDM
- Search button filters currently loaded Direct conversations without exporting their contents to the host app
- Double-click a conversation to open it in a separate chat window while the list window remains open
- Two appearance presets with live mini chat previews in Settings: Kakao-style yellow and DM-style purple/blue
- Theme preference stored locally under `%LOCALAPPDATA%\OnlyDM\settings.json`
- Shared WebView2 profile keeps Instagram login/session state across all chat windows
- Allows top-level navigation only to Instagram login and `/direct/*`
- Blocks feed, Reels, profile, external top-level navigation, popups, and downloads
- X button hides the list window to the system tray instead of exiting
- Custom OnlyDM program/tray icon; tray quick settings include theme, Windows auto-start, notifications, and message-preview visibility
- GUI + `odm on/off` support Windows login auto-start
- Release packages are self-contained; separate .NET Desktop Runtime installation is not required
- If WebView2 is missing, OnlyDM asks in English before downloading and running Microsoft's official Evergreen Bootstrapper
- Desktop DM notifications are enabled by default; message text is shown by default and can be hidden from Settings or the tray
- Clicking a notification opens the related chat window
- WebView2 DevTools disabled in Release builds

## Privacy

OnlyDM does not implement a separate DM backend. Its in-page presentation script reads the currently rendered Direct thread rows (display name, avatar URL, latest preview text, and timestamp) only to draw the local OnlyDM chat list and detect local desktop notifications. The host process receives a thread URL/title/preview only when opening a chat or showing a notification. Small local caches for thread routing, the friends list, and user aliases are protected with Windows DPAPI for the current user; they are not uploaded or sent to an OnlyDM server. Instagram credentials, cookies, and tokens remain inside WebView2. Instagram login/session state is handled by WebView2 under:

```text
%LOCALAPPDATA%\OnlyDM\WebView2
```

See [PRIVACY.md](PRIVACY.md) for details.

## Explicit non-goals

OnlyDM does **not** provide:

- company firewall/DNS/proxy/URL-filter bypasses
- VPN, proxy, or tunnel setup
- Instagram Private API reverse engineering
- bulk message scraping/export or automated Direct-message collection
- automated DM sending
- Instagram password/cookie/token extraction
- third-party messenger logos or brand assets

If `instagram.com` is blocked by the network, OnlyDM is blocked as well.

## Run from source

```powershell
dotnet run --project .\src\OnlyDM\OnlyDM.csproj
```

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

This runs the navigation-policy test harness, a Release build, public-distribution checks, and the messenger UI contract.

## Build release archives locally

x64:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

ARM64:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1 -RuntimeIdentifier win-arm64
```

Each package command creates a ZIP and matching SHA-256 file under `artifacts`.

## Publish a GitHub Release

Pushing a `v*` tag runs `.github/workflows/release.yml`, verifies the project, creates self-contained x64/ARM64 archives, generates checksums, and publishes those assets as a GitHub Release.

Example first release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The tagged installer reads the selected published GitHub Release, so do not advertise it until the repository is public and at least one release exists. After publishing `@thisnorm/onlydm`, the npm global command creates the `odm` wrapper and uses the same tagged installer.

## Manual smoke test

1. Launch OnlyDM and verify only the compact conversation-list layout is visible.
2. Sign in, exit, relaunch, and verify the session is reused.
3. Click the search icon and verify the list filters, then clears correctly.
4. Double-click a conversation and verify a separate chat window opens while the list window stays open.
5. Open two different conversations and verify both windows can remain open.
6. Change Kakao/DM theme using the preview cards in Settings, relaunch, and verify the preference is retained.
7. Verify Settings and tray both control theme, auto-start, notifications, and message-preview visibility.
8. With notifications enabled, receive a new DM and verify a desktop notification appears; toggle message preview off and verify the next notification hides message text.
9. Verify feed/Reels/profile top-level navigation is rejected and links cannot create a popup window.
10. Click X and verify OnlyDM hides to the tray; restore and open Settings from the tray menu.
11. Run `odm status`, `odm on`, `odm off`, `odm restart`, and verify each reported state.
12. Run the installer again with OnlyDM closed and verify update/reinstall succeeds.
13. Uninstall and verify `%LOCALAPPDATA%\OnlyDM` is removed.

## Login challenges

Instagram can require additional security verification on a top-level path outside `/accounts/login`. The current navigation policy may block that page. Complete the account verification in a normal browser and retry OnlyDM.

## License

MIT. See [LICENSE](LICENSE).
