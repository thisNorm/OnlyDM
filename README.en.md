# OnlyDM

<p align="center"><a href="README.md">한국어</a> · <strong>English</strong></p>

**Instagram DMs in a familiar desktop messenger.**

Leaving a chat window open at work feels normal. Leaving Instagram open, with its feed and Reels, feels different. Constantly picking up a phone to reply isn't ideal either.

OnlyDM keeps the DMs and leaves out the distractions. If you've had the same problem, you're welcome to use it.

## Install

Use **Command Prompt (CMD) on Windows, or a terminal on Ubuntu/macOS**.

**With Node.js and npm installed, run these two commands.** If needed, install [Node.js](https://nodejs.org/) first, then open a new terminal.

```sh
npm install -g @thisnorm/onlydm
odm update
```

The first command registers `odm`. The second installs the app if it is missing, or updates an existing installation. OnlyDM selects and verifies the right download for your OS and CPU. Ubuntu and macOS may ask for administrator approval through the operating system.

Run `odm start` to open the app. For future updates, just run `odm update`. On Windows, the command also works in a new PowerShell window. You don't need to clone the project or configure paths.

Use [Install from a file](#install-from-a-file) below only if these commands aren't available to you.

Supported: **Windows 10/11 (x64/ARM64), Ubuntu 24.04 desktop (x64), and macOS (Apple Silicon/Intel)**.

## Update

Run this from any folder in a new terminal:

```sh
odm update
```

When a newer version is available, an **update button appears at the bottom of the app's left sidebar**. Click it to install and restart. OnlyDM checks at startup and every six hours.

Sign-in sessions and settings are kept. Send unfinished messages before stopping or updating through the command line. The in-app update button asks for confirmation if there are unsent drafts.

> Older versions may ask you to quit OnlyDM once and rerun `odm update`. On macOS, use **OnlyDM → Quit** or `⌘Q`; closing the window may only hide it.

## Everyday commands

| Command | Action |
| --- | --- |
| `odm install` | Install or apply the latest installer |
| `odm start` | Open OnlyDM |
| `odm stop` | Quit |
| `odm restart` | Reopen the app |
| `odm status` | Show installed version, running state and auto start |
| `odm update` | Update to the latest version |
| `odm on` / `odm off` | Enable / disable startup at sign-in |
| `odm uninstall` | Remove the app |
| `odm help` | Show command help |

On Windows, `odm uninstall` also removes local data, including sign-in sessions. On Ubuntu and macOS, local account data is kept after removing the app.

## First launch

1. Sign in yourself on Instagram's official page and complete any additional verification there.
2. Open a conversation from the chat list.
3. Use **Settings → Switch account** on Windows, or the account selector above the list on Ubuntu/macOS. Choose linked Instagram profiles or a separate sign-in as appropriate.

Automatic sign-in uses the embedded browser's local profile. OnlyDM does not ask for or separately store your password, or send it to its own server.

## Make it yours

**Light, Dark and Custom** — Open **Appearance** in Settings. Custom provides independent colors for the shared top bar/sidebar, main app background, chat background, incoming bubbles and outgoing bubbles. The same color can be used in several places.

Choose a preset, **drag the spectrum** below it, or enter a **six-digit HEX code**. Text and icons adapt to their background. Saving also updates open views.

**Work mode** — Replace names and message previews in new DM notifications with generic notices. It doesn't change conversations or anything sent to another person. You can also switch it from the tray or menu bar.

**Korean and English** — Choose `Auto`, `한국어` or `English` in Settings. `Auto` follows your operating system's language. This setting is available on Ubuntu and macOS starting with OnlyDM 1.2.1.

## Platform features

All three platforms provide conversations, search, messaging, account switching, notifications, Work mode, color customization and updates, plus **friends, new one-to-one/group chats, local names, independent chat windows, voice/video calls and a tray menu**.

Friends come from your following list. A name edited in a profile or one-to-one chat also appears in friends, conversations, member lists and notifications. **Names stay on this device.** Group names apply only to that room. They do not change Instagram or anyone else's profile.

Ubuntu and macOS remain previews. Calls depend on Instagram's web support and OS microphone/camera permissions. Linux tray visibility depends on the desktop environment's status-icon support.

![OnlyDM light and dark examples](assets/onlydm.png)

<sub>These examples use fictional names, messages and profiles. No real accounts or conversations are shown.</sub>

## Install from a file

Use this when command-line installation is unavailable. Download from the [latest release](https://github.com/thisNorm/OnlyDM/releases/latest).

<details>
<summary>Windows</summary>

Download [Windows x64](https://github.com/thisNorm/OnlyDM/releases/latest/download/OnlyDM-win-x64.zip) or [ARM64](https://github.com/thisNorm/OnlyDM/releases/latest/download/OnlyDM-win-arm64.zip). Extract it and open **OnlyDM.exe**. If WebView2 is needed, follow Microsoft's installation prompt.

</details>

<details>
<summary>Ubuntu</summary>

Download the [Ubuntu installer](https://github.com/thisNorm/OnlyDM/releases/latest/download/OnlyDM-linux-x64.deb), open it and install. Then open **OnlyDM** from your app launcher.

</details>

<details>
<summary>macOS</summary>

Choose [Apple Silicon](https://github.com/thisNorm/OnlyDM/releases/latest/download/OnlyDM-mac-arm64.dmg) or [Intel Mac](https://github.com/thisNorm/OnlyDM/releases/latest/download/OnlyDM-mac-x64.dmg). Open it, drag **OnlyDM.app into Applications**, then launch it.

The macOS preview is ad-hoc signed and has not been notarized by Apple. If the first launch is blocked, check the download source and refer to [Apple's guidance](https://support.apple.com/en-us/102445).

</details>

<details>
<summary>The global npm installation reports a permission error</summary>

On Ubuntu or macOS, you can use:

```sh
sudo npm install -g @thisnorm/onlydm
```

Run subsequent `odm` commands without `sudo`.

</details>

## Data and privacy

Sign-in and messages are handled by Instagram's website. OnlyDM has no separate chat server and uses no unofficial API or authentication bypass. Browser sign-in state and preferences remain on your device.

Read the [privacy notice](PRIVACY.md) or the [developer guide](desktop/README.md) for details.

OnlyDM is an unofficial personal project and is not affiliated with Instagram or Meta.
