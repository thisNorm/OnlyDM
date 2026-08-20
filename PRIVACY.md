# OnlyDM Privacy

OnlyDM is a local Windows WebView2 wrapper for the Instagram Direct web interface. It does not operate a separate messaging backend.

## What OnlyDM stores

Instagram authentication, cookies, and web session state are managed by Microsoft Edge WebView2 in the local profile directory:

```text
%LOCALAPPDATA%\OnlyDM\WebView2
```

OnlyDM reuses that profile so you do not have to sign in on every launch.

## Local Direct presentation data

To present a DM-only UI, the JavaScript running inside the Instagram WebView reads the Direct thread rows already rendered by Instagram. It uses the display name, avatar URL, latest message preview, timestamp, and thread URL to render the local chat list. When a new preview is detected, the thread title/URL/preview can be passed to the Windows host process to display a desktop notification.

Thread routing, friends-list entries, and user aliases needed for the local presentation are cached in %LOCALAPPDATA%\OnlyDM and protected with Windows DPAPI for the current Windows user. They are not uploaded, sent to an OnlyDM backend, or used for analytics. You can disable notifications or hide message text in notifications from Settings or the tray menu.

## What OnlyDM does not collect

The application code does not export, upload, or separately store your Instagram password, cookies, access tokens, full Direct history, or media. It does not include analytics or telemetry and it does not send OnlyDM-owned requests to a separate application server.

Normal Instagram web traffic still goes directly between the embedded WebView2 browser and Instagram/Meta and is subject to their own terms and privacy practices.

## Uninstall

The supplied `uninstall.ps1` removes the installed application, Start Menu shortcut, and `%LOCALAPPDATA%\OnlyDM`, including the WebView2 profile and its login/session data. Close OnlyDM before uninstalling.

## Security boundary

OnlyDM does not implement Instagram Private API access, bulk message scraping/export, automated DM sending, credential/session extraction, VPN/proxy/tunnel setup, or bypasses for network restrictions.
