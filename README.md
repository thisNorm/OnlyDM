# OnlyDM

**Instagram Direct, and nothing else.**

OnlyDM is a small Windows desktop client for Instagram DMs. It signs in through Instagram Web inside Microsoft Edge WebView2 and projects **only** your conversations into its own messenger interface — no feed, no Reels, no Explore, no profile browsing.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
![.NET](https://img.shields.io/badge/.NET-8-512BD4)

> **Unofficial project.** OnlyDM is not affiliated with, endorsed by, or sponsored by Instagram or Meta. Instagram and Meta are trademarks of their respective owners.

## How it works

Login and messaging happen on `instagram.com` inside WebView2 — the same pages a browser would load. OnlyDM reads the conversation rows Instagram has already rendered and draws its own list, chat windows, and friends list on top of them. There is no private API, no reverse engineering, and no separate backend: your password, cookies, and tokens never leave WebView2.

Because the session lives in a shared WebView2 profile, signing in once covers every OnlyDM window.

## Install

### npm (recommended)

Requires Node.js 18+.

```powershell
npm install -g @thisnorm/onlydm
odm start
```

The first `odm start` installs the app from the selected GitHub Release; later runs launch the installed copy. No administrator privileges are needed.

| Command | What it does |
| --- | --- |
| `odm start` / `odm stop` / `odm restart` | Run, quit, or restart OnlyDM |
| `odm status` | Show install state, version, and auto-start setting |
| `odm on` / `odm off` | Turn Windows login auto-start on or off |
| `odm update` | Update to the latest published release |
| `odm uninstall` | Remove the app, shortcut, and local session data |

### PowerShell installer

For machines without Node.js:

```powershell
$releaseTag = 'v0.2.0'
$installer = Join-Path $env:TEMP 'OnlyDM-install.ps1'
Invoke-WebRequest -Uri "https://github.com/thisNorm/OnlyDM/releases/download/$releaseTag/install.ps1" -OutFile $installer
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ReleaseTag $releaseTag
Remove-Item -LiteralPath $installer -Force
```

The installer picks x64 or ARM64 automatically, verifies the release ZIP against its SHA-256, and installs per user to `%LOCALAPPDATA%\Programs\OnlyDM`. Close OnlyDM before installing or updating. The npm package is a thin wrapper around the same `install.ps1` / `uninstall.ps1`, so download, checksum, and cleanup have one implementation.

## Requirements

|  | Running a release | Building from source |
| --- | --- | --- |
| OS | Windows 10/11 (x64 or ARM64) | Windows 10/11 |
| Runtime | Microsoft Edge WebView2 | Microsoft Edge WebView2 |
| SDK | — | .NET 8 SDK |
| Other | Network access to Instagram | Node.js 18+ for the CLI wrapper |

Releases are .NET 8 self-contained, so no separate .NET Desktop Runtime is required. If WebView2 is missing, OnlyDM asks for permission before downloading and running Microsoft's official Evergreen Bootstrapper.

## Features

**Conversations**
- A messenger-style list built from your Direct inbox, ordered newest first, with unread badges
- Search by display name, account handle, or the name you gave someone
- Double-click or press <kbd>Enter</kbd> to open a conversation in its own window; <kbd>↑</kbd>/<kbd>↓</kbd> move the selection, <kbd>Esc</kbd> closes
- Conversations you have opened before reopen from their remembered address instead of being searched for again
- Closing a chat window hides it, so a half-typed message is still there when you come back; idle windows are released to keep memory down
- Leave or delete a conversation from the info panel inside the chat window

**People**
- A friends tab built from your following list, collected once and cached, with a refresh button
- Profile card with one-to-one chat, voice call, and video call
- New-chat picker: one person opens a direct chat, several create a group, and an existing room is reused instead of duplicated
- Calls open in an OnlyDM window; microphone and camera are granted only to Instagram, only from a conversation

**Local names**
- Rename anyone from the chat header or their profile card — hover the name and type
- Names are keyed to the account, so renaming in a conversation also renames them in the friends list, the DM list, the window title, and a group's member list
- Group conversations can be renamed too, per room
- Names are yours alone: they stay on this machine and are never sent to Instagram or shown to the other person
- Clearing a name restores what Instagram calls them

**Notifications and appearance**
- Desktop notification once per new message, with optional message text; clicking one opens the conversation
- Two themes, Classic and DM, applied live without reloading the conversation list
- Frameless rounded windows; closing the main window hides it to the tray
- Tray menu for theme, auto-start, notifications, and message-preview visibility

**Reliability**
- A crashed page reloads itself; if the whole browser process dies OnlyDM restarts rather than leaving dead windows behind
- Failures are written to `%LOCALAPPDATA%\OnlyDM\error.log`

## Privacy

OnlyDM has no server and no account of its own. The in-page script reads what Instagram already rendered — display name, avatar URL, latest preview text, and timestamp — to draw the local list and raise desktop notifications. The host process only ever receives a conversation's address, title, and preview.

Local files under `%LOCALAPPDATA%\OnlyDM`:

| File | Contents |
| --- | --- |
| `WebView2\` | Instagram login and session state, owned by WebView2 |
| `settings.json` | Theme, notification, and auto-start preferences |
| `threads.json`, `friends.json`, `aliases.json` | Conversation addresses, cached following list, and your local names — protected with Windows DPAPI for the current user |

Nothing here is uploaded. DevTools are disabled in Release builds. See [PRIVACY.md](PRIVACY.md) for the full statement.

## Non-goals

OnlyDM deliberately does **not** provide:

- firewall, DNS, proxy, or URL-filter bypasses, or VPN/tunnel setup
- Instagram Private API use or reverse engineering
- bulk scraping, message export, or automated sending
- extraction of Instagram passwords, cookies, or tokens
- third-party messenger logos or brand assets

Top-level navigation is limited to the Instagram login page and `/direct/*`; feed, Reels, profile pages, external links, popups, and downloads are blocked. If your network blocks `instagram.com`, it blocks OnlyDM too.

## Development

```powershell
# run from source
dotnet run --project .\src\OnlyDM\OnlyDM.csproj

# navigation-policy tests, Release build, distribution checks, UI contract
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1

# release archives + SHA-256 into .\artifacts
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1 -RuntimeIdentifier win-arm64
```

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies the project, builds self-contained x64 and ARM64 archives, generates checksums, and publishes them as a GitHub Release.

```powershell
git tag v0.1.0
git push origin v0.1.0
```

<details>
<summary>Manual smoke test</summary>

1. Launch OnlyDM: only the conversation list is visible, never Instagram's own UI.
2. Sign in, quit, relaunch — the session is reused.
3. Search filters the list and clears correctly.
4. Open two conversations in separate windows; type a draft, close one, reopen it, and the draft is still there.
5. Rename someone from the chat header and confirm the friends list and DM list follow.
6. Receive a DM: one notification arrives, and clicking it opens that conversation.
7. Switch theme in Settings and from the tray; relaunch and the choice is kept.
8. Click X — the window hides to the tray; restore it from the tray menu.
9. Run `odm status`, `odm on`, `odm off`, `odm restart`.
10. Reinstall over the existing copy, then uninstall and confirm `%LOCALAPPDATA%\OnlyDM` is gone.

</details>

## Troubleshooting

**Instagram asks for extra verification.** Security challenges open on a path outside `/accounts/login`, which the navigation policy blocks. Complete the verification in a normal browser, then start OnlyDM again.

**The conversation list is empty on first launch.** OnlyDM pages through Instagram's virtualised inbox once to collect every conversation; give it a moment on a large inbox.

## License

MIT — see [LICENSE](LICENSE).
