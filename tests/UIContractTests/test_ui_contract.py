from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'src' / 'OnlyDM'

required = [
    SRC / 'AppTheme.cs',
    SRC / 'AppSettings.cs',
    SRC / 'SettingsStore.cs',
    SRC / 'SettingsWindow.xaml',
    SRC / 'SettingsWindow.xaml.cs',
    SRC / 'WebViewProfile.cs',
    SRC / 'WebView2DependencyService.cs',
    SRC / 'WebViewScripts.cs',
    SRC / 'ChatWindow.xaml',
    SRC / 'ChatWindow.xaml.cs',
    SRC / 'Assets' / 'OnlyDM.ico',
    SRC / 'Assets' / 'OnlyDM.png',
    ROOT / 'docs' / 'assets' / 'onlydm-showcase.png',
]

for path in required:
    assert path.is_file(), f'Missing UI artifact: {path.relative_to(ROOT)}'

csproj = (SRC / 'OnlyDM.csproj').read_text(encoding='utf-8')
assert '<ApplicationIcon>Assets\\OnlyDM.ico</ApplicationIcon>' in csproj
assert 'Assets\\OnlyDM.ico' in csproj

settings_store = (SRC / 'SettingsStore.cs').read_text(encoding='utf-8')
assert 'settings.json' in settings_store
assert 'SpecialFolder.LocalApplicationData' in settings_store

app_theme = (SRC / 'AppTheme.cs').read_text(encoding='utf-8')
assert 'Kakao' in app_theme and 'DM' in app_theme
assert '#FEE500' in app_theme, 'Kakao yellow theme is required'

main_xaml = (SRC / 'MainWindow.xaml').read_text(encoding='utf-8')
for marker in ['SearchButton', 'SettingsButton', 'SearchBox', 'Browser', '채팅']:
    assert marker in main_xaml, f'MainWindow missing {marker}'

dependency = (SRC / 'WebView2DependencyService.cs').read_text(encoding='utf-8')
for marker in ['Would you like to install it now?', '2124703', 'MessageBoxButton.YesNo', 'GetAvailableBrowserVersionString']:
    assert marker in dependency, f'WebView2 dependency service missing {marker}'

main_cs = (SRC / 'MainWindow.xaml.cs').read_text(encoding='utf-8')
for marker in ['WebMessageReceived', 'open-thread', 'new ChatWindow', 'filter-threads', 'OpenSettings']:
    assert marker in main_cs, f'MainWindow code missing {marker}'

chat_xaml = (SRC / 'ChatWindow.xaml').read_text(encoding='utf-8')
assert 'ChatBrowser' in chat_xaml
chat_cs = (SRC / 'ChatWindow.xaml.cs').read_text(encoding='utf-8')
assert 'BuildChatScript' in chat_cs
assert 'NavigationPolicy.IsDirectUri' in chat_cs
for marker in ['IsInstagramCallUri', 'nav.Cancel = true', 'permission.State']:
    assert marker in chat_cs, f'Call popup security contract missing {marker}'
assert 'IsInstagramUri' not in chat_cs

scripts = (SRC / 'WebViewScripts.cs').read_text(encoding='utf-8')
for marker in ['dblclick', '/direct/t/', 'open-thread', 'filter-threads', 'BuildInboxScript', 'BuildChatScript']:
    assert marker in scripts, f'WebViewScripts missing {marker}'

settings_xaml = (SRC / 'SettingsWindow.xaml').read_text(encoding='utf-8')
for marker in ['KakaoThemeButton', 'DmThemeButton', 'AutoStartCheckBox', '카카오톡 스타일', 'DM 스타일']:
    assert marker in settings_xaml, f'Settings UI missing {marker}'

tray = (SRC / 'TrayIconService.cs').read_text(encoding='utf-8')
assert 'OnlyDM.ico' in tray
assert 'SystemIcons.Application' not in tray


# OnlyDM is permanently DM-only. Instagram surface toggles must not exist.
app_settings = (SRC / 'AppSettings.cs').read_text(encoding='utf-8')
for forbidden in ['ShowInstagramShortcuts', 'ShowFeed', 'ShowReels', 'ShowExplore', 'ShowProfile']:
    assert forbidden not in app_settings, f'AppSettings must stay DM-only: {forbidden}'

for forbidden in ['InstagramShortcutsCheckBox', 'Instagram 부가기능', 'HomeButton', 'ReelsButton', 'ExploreButton', 'ActivityButton', 'ProfileButton']:
    assert forbidden not in settings_xaml + main_xaml, f'Instagram feature surface must not be exposed: {forbidden}'

# Inbox must be projected into an OnlyDM-owned shell instead of shrinking Instagram's layout.
for marker in ['OnlyDmShell', 'onlydm-thread-list', 'onlydm-thread-row', 'cloneThreadData', 'renderThreadList', 'scrollbar-width: none', '::-webkit-scrollbar', 'dblclick', 'open-thread']:
    assert marker in scripts, f'Inbox shell contract missing {marker}'

assert '[href*="/direct/t/"]' in scripts, 'Instagram thread link elements remain the source of truth'
assert 'body > *:not(#OnlyDmShell)' in scripts, 'Original Instagram UI must be visually hidden behind the OnlyDM shell'
assert "event.preventDefault();" in scripts and "event.stopPropagation();" in scripts, 'Projected rows must suppress native Instagram navigation'
assert 'overflow: hidden' in scripts, 'Outer Instagram scrollbars must be removed'
for marker in ['canonicalThreadHref', 'threadKey', 'openThreadByKey', 'item.key', "type: 'request-open'"]:
    assert marker in scripts, f'Canonical thread identity contract missing {marker}'
assert "post({ type: 'request-open', title: row.dataset.key });" not in scripts

# Theme chooser shows real message previews rather than text-only cards.
for marker in ['KakaoThemePreview', 'DmThemePreview', '안녕하세요!', '반가워요', 'NotificationEnabledCheckBox', 'NotificationPreviewCheckBox']:
    assert marker in settings_xaml, f'Settings preview/notification UI missing {marker}'

# Notification defaults are visible and both settings + tray can control them.
for marker in ['NotificationsEnabled', 'NotificationPreviewEnabled']:
    assert marker in app_settings, f'AppSettings missing {marker}'
assert 'NotificationsEnabled { get; set; } = true' in app_settings
assert 'NotificationPreviewEnabled { get; set; } = true' in app_settings

for marker in ['알림 받기', '메시지 내용 표시', 'Windows 시작 시 자동 실행', 'Kakao', 'DM', 'UpdateQuickSettings', 'ShowNotification', 'BalloonTipClicked']:
    assert marker in tray, f'Tray quick settings/notification contract missing {marker}'

for marker in ['thread-notification', 'NotificationsEnabled', 'NotificationPreviewEnabled', 'ShowNotification']:
    assert marker in main_cs, f'MainWindow notification bridge missing {marker}'

for marker in ['thread-notification', 'threadSnapshot', 'detectThreadChanges']:
    assert marker in scripts, f'Inbox notification detector missing {marker}'

readme = (ROOT / 'README.md').read_text(encoding='utf-8')
assert 'onlydm-showcase.png' not in readme, 'Showcase must not be advertised before Windows UI smoke verification'

print('OnlyDM UI static contract: PASS')

# Raw Instagram must never become visible before OnlyDM projection is ready.
for marker in ['InboxLoadingPanel', 'Visibility="Hidden"']:
    assert marker in main_xaml, f'MainWindow raw-WebView guard missing {marker}'
for marker in ['inbox-ready', 'ShowProjectedInbox']:
    assert marker in main_cs, f'MainWindow readiness bridge missing {marker}'

# Presentation scripts must wait for DOM readiness and tolerate non-anchor thread link elements.
for marker in ['DOMContentLoaded', 'startInboxProjection', '[href*="/direct/t/"]', 'inbox-ready']:
    assert marker in scripts, f'Inbox bootstrap/selector contract missing {marker}'
assert 'a[href*="/direct/t/"]' not in scripts, 'Thread extraction must not depend on anchor tags only'

# Chat windows use the same raw-WebView guard.
chat_xaml_text = chat_xaml
for marker in ['ChatLoadingPanel', 'Visibility="Hidden"']:
    assert marker in chat_xaml_text, f'ChatWindow raw-WebView guard missing {marker}'
for marker in ['chat-ready', 'ShowProjectedChat']:
    assert marker in chat_cs, f'ChatWindow readiness bridge missing {marker}'
for marker in ['startChatProjection', 'chat-ready']:
    assert marker in scripts, f'Chat projection bootstrap missing {marker}'

# WebView2 is HwndHost-backed; hide/show it with Visibility, never Opacity.
assert 'x:Name="Browser" Visibility="Hidden"' in main_xaml, 'MainWindow WebView2 must start hidden'
assert 'x:Name="ChatBrowser" Visibility="Hidden"' in chat_xaml_text, 'ChatWindow WebView2 must start hidden'
assert '<wv2:WebView2 x:Name="Browser" Opacity=' not in main_xaml, 'Do not set Opacity on WebView2'
assert '<wv2:WebView2 x:Name="ChatBrowser" Opacity=' not in chat_xaml_text, 'Do not set Opacity on WebView2'
assert 'Browser.Visibility = Visibility.Hidden' in main_cs
assert 'Browser.Visibility = Visibility.Visible' in main_cs
assert 'ChatBrowser.Visibility = Visibility.Hidden' in chat_cs
assert 'ChatBrowser.Visibility = Visibility.Visible' in chat_cs
assert 'Browser.Opacity' not in main_cs
assert 'ChatBrowser.Opacity' not in chat_cs

# Projection must be explicitly executed after navigation; document-created injection alone is too fragile for Instagram SPA boot.
for marker in ['NavigationCompleted', 'ExecuteScriptAsync', 'RunInboxProjectionAsync', 'projection-error']:
    assert marker in main_cs, f'Explicit inbox projection execution missing {marker}'
assert 'AddScriptToExecuteOnDocumentCreatedAsync(WebViewScripts.BuildInboxScript' not in main_cs, 'Inbox projection must not rely only on document-created injection'

for marker in ['NavigationCompleted', 'ExecuteScriptAsync', 'RunChatProjectionAsync', 'projection-error']:
    assert marker in chat_cs, f'Explicit chat projection execution missing {marker}'
assert 'AddScriptToExecuteOnDocumentCreatedAsync(WebViewScripts.BuildChatScript' not in chat_cs, 'Chat projection must not rely only on document-created injection'

for marker in ['ProjectionStatusText', 'ProjectionRetryButton']:
    assert marker in main_xaml, f'Projection diagnostic UI missing {marker}'

for marker in ['projection-error', 'stage', 'message']:
    assert marker in scripts, f'Projection script error bridge missing {marker}'

assert 'ChatProjectionStatusText' in chat_xaml_text, 'Chat projection diagnostic status is required'

for marker in ['sourceDiagnostics', 'hrefMatches', 'roleLinks', 'No DM thread links detected']:
    assert marker in scripts, f'Projection diagnostics missing {marker}'
