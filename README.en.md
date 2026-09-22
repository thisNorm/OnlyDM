# OnlyDM

<p align="center">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

**A Windows messenger that shows only your Instagram DMs.**

Leaving a regular messenger window open at work feels normal. Leaving Instagram open does not. There is always a feed, Reels, Stories, and far more than you need just to answer a message. Keeping your phone in your hand all day is not a great alternative either.

So I kept trimming until **only the DMs remained**. No feed, no Reels, and no Explore page—just a conversation list and chat windows that look and behave like a familiar desktop messenger.

If you have had the same problem, feel free to use it.

![OnlyDM interface](assets/onlydm.png)

<sub>The screenshot uses example data instead of real conversations.</sub>

## How it works

Sign-in and messaging happen entirely on **Instagram Web**. OnlyDM opens the same pages you would use in a browser inside the Edge WebView2 runtime built into Windows.

OnlyDM then draws its own messenger interface over that page. It reads the conversation list Instagram has already rendered and presents it in a cleaner desktop layout. It does not use a private Instagram API, bypass authentication, or send your data through a separate server. There is no OnlyDM server at all.

## What it feels like

The app is designed to work like a familiar desktop messenger.

**Conversations**
- Recent conversations move to the top, and unread conversations receive a red badge
- Search works with names, Instagram handles, and names you assign locally
- Double-click or press <kbd>Enter</kbd> to open a chat, use <kbd>↑</kbd> and <kbd>↓</kbd> to move, and press <kbd>Esc</kbd> to close
- Drafts remain when you close a chat window and return later
- OnlyDM remembers rooms you have already opened so they open much faster next time

**People**
- The Friends list comes from the accounts you follow. It is cached after the first load and can be refreshed when needed
- Open a profile to start a 1:1 chat, voice call, or video call
- To start a new conversation, just select people. One person creates a direct chat; multiple people create a group chat; an existing room opens instead of being duplicated

**Local names**
- Hover over a name in a chat title or profile card and edit it directly
- Names are attached to Instagram handles, so a change made in a chat also appears in Friends, and vice versa
- Group conversations can have their own local room name
- **These changes stay on your computer.** They do not change anything on Instagram or on anyone else's screen
- Clear a local name to restore the original one

**More**
- New DMs produce one Windows notification. Click it to open that conversation, or disable message previews in Settings
- Two themes are included: Classic and DM. Changes apply immediately
- English UI is supported. Click the **gear icon** in the lower-left corner, then choose `Auto`, `한국어`, or `English` at the top of the Settings window
- Closing the main window sends OnlyDM to the system tray. The tray menu also provides quick controls for the theme, startup, and notifications
- If the embedded page stops responding, OnlyDM reloads it and can restart itself after a larger browser failure

## Your data stays local

**Automatic sign-in is stored only on this computer.** WebView2 keeps the Instagram session just like a browser. OnlyDM does not separately read or store your password, cookies, or tokens, and there is no OnlyDM server to send them to.

Local names, conversation addresses, and the cached Friends list are stored only on your PC. Windows DPAPI encrypts that metadata so it can only be opened by your Windows account.

Everything is stored under `%LOCALAPPDATA%\OnlyDM`.

| Path | Contents |
| --- | --- |
| `WebView2\` | Instagram sign-in session managed by WebView2 |
| `settings.json` | Theme, notification, language, and startup settings |
| `threads.json` · `friends.json` · `aliases.json` | Conversation addresses, Friends cache, and local names protected with DPAPI |

Delete that folder or run `odm uninstall` to remove the local data.

See [PRIVACY.md](PRIVACY.md) for more details.

## Install

If Node.js 18 or newer is installed, this is the easiest option:

```powershell
npm install -g @thisnorm/onlydm
odm start
```

The first `odm start` downloads and installs the app. Later runs start it immediately. Administrator privileges are not required.

| Command | Description |
| --- | --- |
| `odm start` · `odm stop` · `odm restart` | Start, stop, or restart OnlyDM |
| `odm status` | Show the installed version and current status |
| `odm on` · `odm off` | Enable or disable startup with Windows |
| `odm update` | Install the latest release |
| `odm uninstall` | Remove the app and its local data |

If Node.js is not installed, use PowerShell:

```powershell
$releaseTag = 'v0.2.7'
$installer = Join-Path $env:TEMP 'OnlyDM-install.ps1'
Invoke-WebRequest -Uri "https://github.com/thisNorm/OnlyDM/releases/download/$releaseTag/install.ps1" -OutFile $installer
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ReleaseTag $releaseTag
Remove-Item -LiteralPath $installer -Force
```

The installer selects x64 or ARM64 automatically, verifies the downloaded SHA-256 checksum, and installs OnlyDM under `%LOCALAPPDATA%\Programs\OnlyDM`. Close OnlyDM before installing or updating it.

**Requirements:** Windows 10 or 11 and the Edge WebView2 Runtime. If WebView2 is missing, OnlyDM asks for permission before downloading and running Microsoft's official installer. The distributed build includes .NET, so a separate .NET installation is not required.

## Troubleshooting

**Instagram requests additional verification** — OnlyDM blocks security-check pages outside `/accounts/login`. Complete the verification in your regular browser, then restart OnlyDM.

**The conversation list is empty on first launch** — Instagram renders only a small part of a long conversation list at a time. OnlyDM makes one pass through the list to collect it, which can take a moment if you have many conversations.

## Build from source

```powershell
# Run from source
dotnet run --project .\src\OnlyDM\OnlyDM.csproj

# Policy tests, Release build, distribution checks, and UI contract checks
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1

# Create self-contained release archives and SHA-256 files under artifacts
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1 -RuntimeIdentifier win-arm64
```

Pushing a `v*` tag runs the [release workflow](.github/workflows/release.yml), which verifies the project and publishes self-contained x64 and ARM64 builds with checksums to GitHub Releases.

<details>
<summary>Manual verification checklist</summary>

1. Launching the app shows only the conversation list, never Instagram's original interface
2. The Instagram session remains available after restarting OnlyDM
3. Search filters the list and clearing it restores the full list
4. Two chat windows can be opened, and drafts remain after closing and reopening them
5. A local name changed in a chat also changes in Friends and the conversation list
6. A new DM produces one notification, and clicking it opens the correct conversation
7. Theme and language choices remain after restarting
8. Closing the main window sends it to the tray, and the tray menu opens it again
9. `odm status`, `odm on`, `odm off`, and `odm restart` report and update the expected state
10. Reinstallation works, and uninstalling removes `%LOCALAPPDATA%\OnlyDM`

</details>

## License

OnlyDM is available under the [MIT License](LICENSE). You may use, modify, and redistribute it.

OnlyDM is an independent, unofficial project and is not affiliated with Instagram or Meta.
