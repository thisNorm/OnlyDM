using System;
using System.Collections.Generic;
using System.Linq;
using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Application = System.Windows.Application;
using Button = System.Windows.Controls.Button;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public partial class MainWindow : Window
{
    private readonly TrayIconService _trayIconService;
    private readonly Dictionary<string, ChatWindow> _chatWindows = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<Guid, AccountInboxWatcher> _accountWatchers = new();
    private readonly DispatcherTimer _accountWatcherRetry = new(DispatcherPriority.Background)
    {
        Interval = AccountInboxWatcher.RetryInterval,
    };
    private readonly AppUpdateService _updates = new();
    private readonly CancellationTokenSource _updateLifetime = new();
    private readonly DispatcherTimer _updateTimer = new(DispatcherPriority.Background)
    {
        Interval = TimeSpan.FromHours(6),
    };
    private AppUpdateRelease? _availableUpdate;
    private bool _checkingForUpdate;
    private bool _installingUpdate;
    private AppSettings _settings;
    private bool _webViewReady;
    private bool _inboxProjected;
    private bool _authenticationVisible;
    private bool _friendsReady;
    private bool _friendsView;
    private string? _ownProfile;
    private string? _pendingCallMode;
    private readonly List<FriendEntry> _roster = new();
    private readonly Dictionary<string, string> _threadUrls = ThreadStore.Load();
    private readonly Dictionary<string, string> _threadTitles = new(StringComparer.Ordinal);
    private static bool _restarting;
    private Action? _refreshAccountChooserLanguage;
    private bool _instagramProfilePanelOpen;
    private bool _identityResetting;
    private bool _nicknamesHooked;
    private bool _languagePageRequested;
    private bool _languageApplyStarted;
    private bool _instagramLanguageChecked;
    private int _languageSwitchAttempts;
    private int _inboxCount;
    private int _unreadCount;
    private bool _inboxCountKnown;

    // 0.4 turns a ~330px control into a ~820px CSS viewport, past Instagram's 736px
    // desktop breakpoint.
    private const double FriendsZoom = 0.4;
    private bool _allowClose;

    public MainWindow()
    {
        InitializeComponent();
        _settings = SettingsStore.Load();
        StateChanged += (_, _) => UpdateMaximizeButton();
        _roster.AddRange(FriendsStore.Load());
        _trayIconService = new TrayIconService(OpenFromTray, OpenSettingsFromTray, RequestExit);
        _trayIconService.ThemeChanged += Tray_ThemeChanged;
        _trayIconService.AutoStartChanged += Tray_AutoStartChanged;
        _trayIconService.NotificationsChanged += Tray_NotificationsChanged;
        _trayIconService.NotificationPreviewChanged += Tray_NotificationPreviewChanged;
        _trayIconService.WorkModeChanged += Tray_WorkModeChanged;
        _accountWatcherRetry.Tick += (_, _) =>
        {
            var now = Environment.TickCount64;
            if (_accountWatchers.Values.Any(watcher => watcher.IsRetryDue(now))) RefreshAccountWatchers();
        };
        _updateTimer.Tick += async (_, _) => await CheckForUpdatesAsync();
        ApplyTheme();
        ApplyLanguage();
        UpdateTrayQuickSettings();

        // An explicit account switch must show the new window even with tray startup enabled.
        if (_settings.StartInTray && Application.Current is not App { ShowOnAccountSwitch: true })
        {
            ContentRendered += HideOnFirstRender;
        }
    }

    // WindowStyle=None gives square corners on Windows 11; this asks the desktop
    // manager for its rounded ones, which also keeps the drop shadow.
    internal static void RoundCorners(Window window)
    {
        try
        {
            var handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
            if (handle == IntPtr.Zero) return;
            var preference = 2; // DWMWCP_ROUND
            _ = DwmSetWindowAttribute(handle, 33, ref preference, sizeof(int));
        }
        catch (DllNotFoundException)
        {
            // Older Windows simply keeps square corners.
        }
    }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool EnableWindow(IntPtr hwnd,
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool enabled);

    private void HideOnFirstRender(object? sender, EventArgs e)
    {
        ContentRendered -= HideOnFirstRender;
        Hide();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        RoundCorners(this);
        if (!_updateTimer.IsEnabled)
        {
            _updateTimer.Start();
            _ = CheckForUpdatesAsync();
        }
        if (_webViewReady) return;

        try
        {
            if (!await WebView2DependencyService.EnsureInstalledWithConsentAsync(this, _settings.Language))
            {
                RequestExit();
                return;
            }

            var environment = await WebViewProfile.CreateEnvironmentAsync();
            await Browser.EnsureCoreWebView2Async(environment);
            ConfigureWebView();
            _webViewReady = true;
            NavigateToInbox();
            RefreshAccountWatchers();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                Text("Microsoft Edge WebView2 런타임이 필요합니다. odm start 명령을 실행하면 설치 여부를 확인할 수 있습니다.",
                    "Microsoft Edge WebView2 Runtime is required. Run OnlyDM with the 'odm start' command to install it with your consent."),
                "OnlyDM",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            RequestExit();
        }
        catch (Exception ex)
        {
            App.Log("initialize", ex);
            MessageBox.Show(Text("OnlyDM을 초기화하지 못했습니다.", "Could not initialize OnlyDM."), "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            RequestExit();
        }
    }

    private void ConfigureWebView()
    {
        var core = Browser.CoreWebView2;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.Settings.IsStatusBarEnabled = false;
        core.NavigationStarting += Core_NavigationStarting;
        core.NavigationCompleted += Core_NavigationCompleted;
        core.SourceChanged += Core_SourceChanged;
        core.NewWindowRequested += (_, args) => args.Handled = true;
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.WebMessageReceived += Core_WebMessageReceived;
        core.ProcessFailed += Core_ProcessFailed;
    }

    // Every view in OnlyDM talks to one browser process. A page can lose its renderer
    // and be reloaded, but if the browser process itself dies every WebView is a dead
    // handle: the next click on one used to end the app, tray icon included.
    private void Core_ProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (_restarting) return;
        App.Log("process-failed", e.ProcessFailedKind);
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
        {
            try { (sender as CoreWebView2)?.Reload(); } catch (Exception ex) { App.Log("reload", ex); }
            return;
        }

        _restarting = true;
        // Restarting only helps something that was working a moment ago; a failure right
        // after launch would otherwise restart forever.
        using var process = Process.GetCurrentProcess();
        var uptime = DateTime.Now - process.StartTime;
        if (uptime > TimeSpan.FromSeconds(30) && Application.Current is App app)
        {
            app.RestartAfterBrowserFailure();
        }
        else
        {
            MessageBox.Show(
                Text("브라우저 구성 요소가 중지되어 OnlyDM을 종료합니다.", "The browser component stopped, so OnlyDM will close."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
        }

        AllowCloseForSessionEnding();
        Application.Current.Shutdown();
    }

    private async void Core_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
            if (_languagePageRequested)
            {
                App.Log("language", $"Instagram language navigation failed: {e.WebErrorStatus}");
                ReturnFromInstagramLanguage(verify: false);
                return;
            }
            ShowProjectionError("navigation", $"Instagram navigation failed: {e.WebErrorStatus}");
            return;
        }

        _identityResetting = false;
        _instagramProfilePanelOpen = false;

        // Login is Instagram's own page, not an OnlyDM projection. Showing it must not
        // depend on injected JavaScript successfully posting a login-ready message.
        if (NavigationPolicy.IsLoginUri(Browser.Source))
        {
            // NavigationStarting hides on the dispatcher; queue this after it so the
            // last redirect cannot leave the completed login page hidden again.
            _ = Dispatcher.BeginInvoke(new Action(() =>
            {
                if (NavigationPolicy.IsLoginUri(Browser.Source)) ShowAuthentication();
            }));
            return;
        }

        var onLanguagePage = NavigationPolicy.IsLanguageSettingsUri(Browser.Source);
        if (_languagePageRequested && !onLanguagePage)
        {
            _languagePageRequested = false;
            _languageApplyStarted = false;
            Browser.ZoomFactor = 1;
        }

        if (onLanguagePage)
        {
            await ApplyInstagramLanguageAsync();
            return;
        }

        if (NavigationPolicy.IsDirectUri(Browser.Source)
            && !await EnsureInstagramLanguageAsync()) return;

        await RunInboxProjectionAsync();
    }

    private async Task RunInboxProjectionAsync()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        if (NavigationPolicy.IsLoginUri(Browser.Source))
        {
            ShowAuthentication();
            return;
        }

        try
        {
            ProjectionStatusText.Text = Text("채팅 목록을 불러오는 중입니다.", "Loading conversations.");
            ProjectionRetryButton.Visibility = Visibility.Collapsed;
            Browser.ZoomFactor = WebViewScripts.InboxZoomFactor;
            var palette = AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors);
            await Browser.CoreWebView2.ExecuteScriptAsync(
                WebViewScripts.BuildInboxScript(palette, _settings.Language, WebViewScripts.InboxZoomFactor));
        }
        catch (Exception ex)
        {
            ShowProjectionError("execute", ex.Message);
        }
    }

    private async Task<bool> EnsureInstagramLanguageAsync()
    {
        if (_instagramLanguageChecked || Browser.CoreWebView2 is null) return true;

        var expected = AppLanguageChoice.InstagramCode(_settings.Language);
        var raw = await Browser.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang || ''");
        var current = JsonSerializer.Deserialize<string>(raw)?.Trim() ?? string.Empty;
        if (current.Length == 0 || current.Split('-')[0].Equals(expected, StringComparison.OrdinalIgnoreCase))
        {
            _instagramLanguageChecked = true;
            _languageSwitchAttempts = 0;
            return true;
        }

        if (_languageSwitchAttempts >= 2)
        {
            App.Log("language", "Instagram did not confirm the selected language.");
            _instagramLanguageChecked = true;
            return true;
        }

        _languageSwitchAttempts++;
        BeginInstagramLanguageChange();
        return false;
    }

    private void BeginInstagramLanguageChange()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        _languagePageRequested = true;
        _languageApplyStarted = false;
        HideBrowserForProjection();
        Browser.ZoomFactor = FriendsZoom;
        Browser.CoreWebView2.Navigate(NavigationPolicy.LanguageSettingsUri.AbsoluteUri);
    }

    private async Task ApplyInstagramLanguageAsync()
    {
        if (!_languagePageRequested || _languageApplyStarted || Browser.CoreWebView2 is null) return;
        _languageApplyStarted = true;

        try
        {
            var expected = AppLanguageChoice.InstagramCode(_settings.Language);
            var selected = string.Empty;
            for (var waited = 0; waited < 15000 && selected.Length == 0; waited += 100)
            {
                var raw = await Browser.CoreWebView2.ExecuteScriptAsync(
                    WebViewScripts.BuildInstagramLanguageScript(_settings.Language));
                selected = JsonSerializer.Deserialize<string>(raw) ?? string.Empty;
                if (selected.Length == 0) await Task.Delay(100);
            }
            if (!selected.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Instagram language selector was not found.");

            await Task.Delay(700);
            ReturnFromInstagramLanguage(verify: true);
        }
        catch (Exception ex)
        {
            App.Log("language", ex);
            ReturnFromInstagramLanguage(verify: false);
        }
    }

    private void ReturnFromInstagramLanguage(bool verify)
    {
        _languagePageRequested = false;
        _languageApplyStarted = false;
        _instagramLanguageChecked = !verify;
        _friendsReady = false;
        Browser.ZoomFactor = 1;
        NavigateToInbox(force: true);
    }

    private async void Core_SourceChanged(object? sender, CoreWebView2SourceChangedEventArgs e)
    {
        if (e.IsNewDocument || !_webViewReady || Browser.CoreWebView2 is null) return;
        try
        {
            if (NavigationPolicy.IsLoginUri(Browser.Source))
            {
                ShowAuthentication();
                // Instagram can open verification without replacing the inbox document.
                await Browser.CoreWebView2.ExecuteScriptAsync(WebViewScripts.BuildInboxScript(
                    AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors), _settings.Language, WebViewScripts.InboxZoomFactor));
            }
            else if (_authenticationVisible && NavigationPolicy.IsInboxUri(Browser.Source))
            {
                HideBrowserForProjection();
                if (await EnsureInstagramLanguageAsync()) await RunInboxProjectionAsync();
            }
            else if (_authenticationVisible && NavigationPolicy.IsInstagramRootUri(Browser.Source))
            {
                NavigateToInbox(force: true);
            }
        }
        catch (Exception ex)
        {
            App.Log("authentication-view", ex);
        }
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
            || (!NavigationPolicy.IsAllowedTopLevelUri(uri)
                && !(_languagePageRequested && NavigationPolicy.IsLanguageSettingsUri(uri))))
        {
            e.Cancel = true;
            Dispatcher.BeginInvoke(new Action(() => NavigateToInbox()));
            return;
        }

        if (IsThreadUri(uri))
        {
            e.Cancel = true;
            if (_inboxProjected)
            {
                Browser.CoreWebView2?.PostWebMessageAsJson(
                    JsonSerializer.Serialize(new { type = "thread-route", href = uri.AbsoluteUri }));
            }
            else
            {
                Dispatcher.BeginInvoke(new Action(() => NavigateToInbox()));
            }
            return;
        }

        if (NavigationPolicy.IsLoginUri(uri))
        {
            Browser.ZoomFactor = 1;
            Dispatcher.BeginInvoke(new Action(() =>
            {
                if (NavigationPolicy.IsLoginUri(Browser.Source)) ShowAuthentication();
            }));
        }
        else
        {
            if (NavigationPolicy.IsDirectUri(uri)) Browser.ZoomFactor = WebViewScripts.InboxZoomFactor;
            Dispatcher.BeginInvoke(new Action(HideBrowserForProjection));
        }
    }

    private void Core_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_restarting || _identityResetting) return;
        if (ReferenceEquals(sender, FriendsBrowser.CoreWebView2)
            && (!Uri.TryCreate(e.Source, UriKind.Absolute, out var friendSource)
                || !NavigationPolicy.IsOwnProfileUri(friendSource))) return;
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            if (!message.RootElement.TryGetProperty("type", out var typeElement)) return;

            if (ReferenceEquals(sender, Browser.CoreWebView2)
                && NavigationPolicy.IsLoginUri(Browser.Source)
                && typeElement.GetString() != "login-ready") return;

            var fromInbox = ReferenceEquals(sender, Browser.CoreWebView2)
                && Uri.TryCreate(e.Source, UriKind.Absolute, out var inboxSource)
                && NavigationPolicy.IsInboxUri(inboxSource)
                && NavigationPolicy.IsInboxUri(Browser.Source);

            switch (typeElement.GetString())
            {
                case "open-thread":
                    HandleOpenThreadMessage(message.RootElement);
                    break;
                case "thread-notification":
                    HandleThreadNotification(message.RootElement);
                    break;
                case "inbox-ready":
                case "login-ready":
                    ShowProjectedInbox();
                    PushNicknames();
                    break;
                case "set-alias":
                    AliasBook.Set(
                        TryGetString(message.RootElement, "handle"),
                        TryGetString(message.RootElement, "alias"));
                    break;
                case "inbox-count":
                    HandleInboxCount(message.RootElement);
                    break;
                case "request-open":
                    HandleOpenRequest(message.RootElement);
                    break;
                case "close-window":
                    Dispatcher.BeginInvoke(new Action(Hide));
                    break;
                case "own-profile":
                    if (fromInbox && !_instagramProfilePanelOpen
                        && TryGetString(message.RootElement, "username") is string handle
                        && AccountStore.IsDisplayHandle(handle))
                    {
                        var accounts = AccountStore.Current;
                        var previousHandle = _ownProfile ?? accounts.HandleFor(accounts.SelectedId);
                        var changed = previousHandle is not null && !previousHandle.Equals(handle, StringComparison.OrdinalIgnoreCase);
                        _ownProfile = handle;
                        NavigationPolicy.OwnProfileUsername = handle;
                        try { accounts.RememberHandle(handle); }
                        catch (Exception ex) when (ex is System.IO.IOException or UnauthorizedAccessException)
                        {
                            App.Log("account-label", ex);
                        }
                        if (changed) ResetIdentityViews();
                        RefreshAccountWatchers();
                    }
                    break;
                case "friends-roster":
                    HandleFriendsRoster(message.RootElement);
                    break;
                case "friends-ready":
                    ShowFriendsView();
                    PushNicknames();
                    break;
                case "switch-account":
                    // Leave the WebView2 callback before entering WPF's modal message loop.
                    Dispatcher.BeginInvoke(new Action(OpenAccountPanel));
                    break;
                case "account-panel-opened":
                    if (fromInbox)
                    {
                        _instagramProfilePanelOpen = true;
                        Browser.ZoomFactor = 1;
                    }
                    break;
                case "account-panel-closed":
                    if (fromInbox && _instagramProfilePanelOpen)
                    {
                        _instagramProfilePanelOpen = false;
                        _instagramLanguageChecked = false;
                        _languageSwitchAttempts = 0;
                        Browser.ZoomFactor = WebViewScripts.InboxZoomFactor;
                        // A linked profile changes inside Instagram's SPA; rebuild its inbox once.
                        Dispatcher.BeginInvoke(new Action(() =>
                        {
                            if (!_restarting && NavigationPolicy.IsInboxUri(Browser.Source))
                                NavigateToInbox(force: true);
                        }));
                    }
                    break;
                case "open-friend-chat":
                    HandleFriendChat(message.RootElement, null);
                    break;
                case "open-friend-call":
                    HandleFriendChat(message.RootElement, TryGetString(message.RootElement, "mode"));
                    break;
                case "friends-error":
                    HandleFriendsError(
                        TryGetString(message.RootElement, "stage") ?? "friends",
                        TryGetString(message.RootElement, "message") ?? "Unknown friends error");
                    break;
                case "need-inbox":
                    Dispatcher.BeginInvoke(new Action(() => NavigateToInbox(force: true)));
                    break;
                case "projection-error":
                    ShowProjectionError(
                        TryGetString(message.RootElement, "stage") ?? "script",
                        TryGetString(message.RootElement, "message") ?? "Unknown projection error");
                    break;
            }
        }
        catch (JsonException)
        {
            // The WebView bridge accepts only the small OnlyDM presentation contract.
        }
    }

    // A conversation whose address is already known opens directly; only a first-time
    // conversation pays for the search through Instagram's hidden list.
    private void HandleOpenRequest(JsonElement root)
    {
        if (_installingUpdate) return;
        UpdateInboxHeader();
        var title = TryGetString(root, "title");
        var key = TryGetString(root, "key");
        if (TryGetThreadUri(root, out var direct))
        {
            OpenThread(direct, title, key);
            return;
        }

        if (string.IsNullOrWhiteSpace(key) && string.IsNullOrWhiteSpace(title)) return;

        // Instagram keeps only a handful of conversation rows in the page at a time, so
        // asking it to open one means scrolling the hidden list until that row exists
        // again - slow, and it fails outright when the row will not come back. An
        // address learned from a previous visit skips all of that.
        if (!string.IsNullOrWhiteSpace(key)
            && _threadUrls.TryGetValue(key, out var known)
            && Uri.TryCreate(known, UriKind.Absolute, out var cached)
            && IsThreadUri(cached))
        {
            OpenThread(cached, title, key);
            return;
        }

        Browser.CoreWebView2?.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "open-row", key, title }));
    }

    // Filed under the identity the conversation list uses, which is what a later click
    // arrives with. The address itself is filed too, for anything that starts from one.
    private void RememberThread(string? title, Uri uri, string? rowKey = null)
    {
        var keys = new[] { AliasBook.ThreadKey(uri), rowKey };
        var changed = false;

        foreach (var key in keys)
        {
            if (string.IsNullOrWhiteSpace(key)) continue;
            if (!string.IsNullOrWhiteSpace(title)) _threadTitles[key] = title;
            if (_threadUrls.TryGetValue(key, out var existing) && existing == uri.AbsoluteUri) continue;
            _threadUrls[key] = uri.AbsoluteUri;
            changed = true;
        }

        if (changed)
        {
            ThreadStore.Save(_threadUrls);
            PushNicknames();
        }
    }

    private void HandleOpenThreadMessage(JsonElement root)
    {
        if (!TryGetThreadUri(root, out var uri)) return;
        var title = TryGetString(root, "title");
        var key = TryGetString(root, "key");
        OpenThread(uri, title, key);

        // The projection walks itself back to the inbox through the SPA so the harvested
        // conversations survive; it asks for a real navigation only if that fails.
    }

    private void HandleThreadNotification(JsonElement root)
    {
        var title = TryGetString(root, "title") ?? "OnlyDM";
        Uri? threadUri = TryGetThreadUri(root, out var parsedUri) ? parsedUri : null;
        var rowKey = TryGetString(root, "key");
        var key = threadUri is null ? rowKey : AliasBook.ThreadKey(threadUri);
        if (!_settings.NotificationsEnabled || IsThreadWindowActive(key, title)) return;

        _trayIconService.ShowNotification(title, NotificationBody(root), () =>
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                if (threadUri is not null) OpenThread(threadUri, title, rowKey);
                else OpenThreadByKey(key, title);
            }));
        });
    }

    private void HandleInboxCount(JsonElement root)
    {
        _inboxCount = root.TryGetProperty("count", out var countElement) ? countElement.GetInt32() : 0;
        _unreadCount = root.TryGetProperty("unread", out var unreadElement) ? unreadElement.GetInt32() : 0;
        _inboxCountKnown = true;
        if (_inboxCount > 0 && !_inboxProjected && !_friendsView) ShowProjectedInbox();
        UpdateInboxHeader();
        Title = _unreadCount > 0 ? $"OnlyDM ({_unreadCount})" : "OnlyDM";
        _trayIconService.UpdateUnreadCount(_unreadCount);
    }

    private void UpdateInboxHeader()
    {
        if (_friendsView || _authenticationVisible) return;
        if (!_inboxCountKnown)
        {
            HeaderHint.Text = Text("더블클릭으로 새 채팅창", "Double-click to open a chat");
            return;
        }

        HeaderHint.Text = AppLanguageChoice.Resolve(_settings.Language) == AppLanguage.Korean
            ? (_unreadCount > 0 ? $"대화 {_inboxCount} · 안 읽음 {_unreadCount}" : $"대화 {_inboxCount}")
            : (_unreadCount > 0 ? $"Chats {_inboxCount} · Unread {_unreadCount}" : $"Chats {_inboxCount}");
    }

    private bool IsThreadWindowActive(string? key, string title)
    {
        foreach (var chat in _chatWindows.Values)
        {
            var sameThread = string.IsNullOrWhiteSpace(key)
                ? chat.ThreadTitle == title
                : chat.ThreadIdentity == key;
            if (sameThread && chat.IsVisible && chat.IsActive) return true;
        }
        return false;
    }

    private void OpenThreadByKey(string? key, string title)
    {
        if (_installingUpdate) return;
        foreach (var pair in _chatWindows)
        {
            var sameThread = string.IsNullOrWhiteSpace(key)
                ? pair.Value.ThreadTitle == title
                : pair.Value.ThreadIdentity == key;
            if (!sameThread) continue;
            RestoreChatWindow(pair.Value);
            return;
        }

        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        OpenFromTray();
        Browser.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "open-row", key, title }));
    }

    private static bool TryGetThreadUri(JsonElement root, out Uri uri)
    {
        uri = null!;
        if (!root.TryGetProperty("href", out var hrefElement)) return false;
        var href = hrefElement.GetString();
        if (!Uri.TryCreate(href, UriKind.Absolute, out var parsed) || !IsThreadUri(parsed)) return false;
        uri = parsed;
        return true;
    }

    private static string? TryGetString(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var element) || element.ValueKind != JsonValueKind.String) return null;
        return ToComposed(element.GetString());
    }

    // Decomposed Hangul renders as loose jamo in Windows notifications and window
    // titles, so every string crossing the WebView bridge is composed to NFC.
    private static string? ToComposed(string? value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        return value.IsNormalized() ? value : value.Normalize();
    }

    private static string TrimNotificationText(string value)
    {
        var singleLine = ToComposed(value)!.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return singleLine.Length <= 160 ? singleLine : singleLine[..157] + "...";
    }

    private static bool IsThreadUri(Uri uri)
    {
        return NavigationPolicy.IsDirectUri(uri)
            && uri.AbsolutePath.StartsWith("/direct/t/", StringComparison.OrdinalIgnoreCase);
    }

    private static string ThreadKey(Uri threadUri) => threadUri.GetLeftPart(UriPartial.Path).TrimEnd('/');

    // Each hidden window keeps a live WebView, which is real memory and CPU. Now that a
    // known conversation reopens in about a second, holding many of them open is not
    // worth the cost; two covers going back and forth between a pair of chats.
    private const int MaxChatWindows = 2;

    private static void RestoreChatWindow(ChatWindow chatWindow)
    {
        chatWindow.MarkUsed();
        if (!chatWindow.IsVisible) chatWindow.Show();
        if (chatWindow.WindowState == WindowState.Minimized) chatWindow.WindowState = WindowState.Normal;
        chatWindow.Activate();
    }

    private async Task EvictOldChatWindowsAsync()
    {
        if (_chatWindows.Count <= MaxChatWindows) return;

        var hidden = _chatWindows.Where(pair => !pair.Value.IsVisible)
            .Select(pair => (pair.Key, Chat: pair.Value, pair.Value.LastUsedUtc))
            .OrderBy(candidate => candidate.LastUsedUtc)
            .ToArray();
        foreach (var (key, chat, lastUsed) in hidden)
        {
            if (_chatWindows.Count <= MaxChatWindows || _allowClose || _installingUpdate) return;
            if (chat.IsVisible || chat.LastUsedUtc != lastUsed || await chat.HasUnsentDraftAsync() != false) continue;

            // A room can be reopened or replaced while WebView2 checks its composer.
            if (_chatWindows.Count <= MaxChatWindows || _allowClose || _installingUpdate) return;
            if (chat.IsVisible || chat.LastUsedUtc != lastUsed
                || !_chatWindows.TryGetValue(key, out var current) || current != chat) continue;

            _chatWindows.Remove(key);
            try { chat.ForceClose(); }
            catch (Exception ex) { App.Log("chat-eviction", ex); }
        }
    }

    private void MarkInboxThreadRead(Uri threadUri, string? key)
    {
        // Resolving a cold room may temporarily put the inbox document on a thread route.
        if (_allowClose || _restarting || _installingUpdate || _identityResetting || _instagramProfilePanelOpen
            || !_inboxProjected || Browser.Source is not { } source
            || (!NavigationPolicy.IsInboxUri(source) && !IsThreadUri(source))
            || Browser.CoreWebView2 is not { } core) return;

        try
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "mark-thread-read", href = threadUri.AbsoluteUri, key }));
        }
        catch (Exception ex)
        {
            App.Log("thread-read", ex);
        }
    }

    private void OpenThread(Uri threadUri, string? title, string? rowKey)
    {
        if (_installingUpdate) return;
        RememberThread(title, threadUri, rowKey);
        var key = ThreadKey(threadUri);
        if (_chatWindows.TryGetValue(key, out var existing))
        {
            if (!string.IsNullOrEmpty(rowKey)) existing.InboxRowKey = rowKey;
            existing.PendingCall = _pendingCallMode;
            _pendingCallMode = null;
            RestoreChatWindow(existing);
            return;
        }

        var chatWindow = new ChatWindow(threadUri, _settings, title) { PendingCall = _pendingCallMode, InboxRowKey = rowKey };
        _pendingCallMode = null;
        _chatWindows[key] = chatWindow;
        chatWindow.ThreadRead += () => MarkInboxThreadRead(threadUri, chatWindow.InboxRowKey);
        chatWindow.Closed += (_, _) => _chatWindows.Remove(key);
        chatWindow.IsVisibleChanged += (_, e) =>
        {
            if (e.NewValue is not false || _chatWindows.Count <= MaxChatWindows) return;

            // A window can be hidden from inside Closing, so defer disposal.
            _ = chatWindow.Dispatcher.BeginInvoke(DispatcherPriority.Background,
                new Action(() => _ = EvictOldChatWindowsAsync()));
        };
        chatWindow.Show();
        chatWindow.Activate();
        _ = EvictOldChatWindowsAsync();
    }

    // Esc/Enter are also handled inside the projection, because the WebView swallows
    // keys whenever it holds focus. This covers the WPF chrome (search box, rail).
    private void Window_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (UpdateButton.IsKeyboardFocusWithin && e.Key != System.Windows.Input.Key.Escape) return;
        if (NavigationPolicy.IsLoginUri(Browser.Source)) return;
        // Let a focused native button keep its normal Enter/click behavior. The window
        // preview handler must not reinterpret button activation as opening the selected chat.
        if (e.Key == System.Windows.Input.Key.Enter
            && System.Windows.Input.Keyboard.FocusedElement is System.Windows.Controls.Primitives.ButtonBase)
            return;
        // Keys must reach the view that is actually on screen; they used to always go
        // to the conversation list, so Enter in the friends tab opened whatever chat
        // happened to be selected there.
        if (_friendsView)
        {
            var friendsKey = e.Key switch
            {
                System.Windows.Input.Key.Escape => "Escape",
                System.Windows.Input.Key.Enter => "Enter",
                System.Windows.Input.Key.Down => "ArrowDown",
                System.Windows.Input.Key.Up => "ArrowUp",
                _ => null,
            };

            if (friendsKey is null) return;
            e.Handled = true;
            FriendsBrowser.CoreWebView2?.PostWebMessageAsJson(
                JsonSerializer.Serialize(new { type = "friends-key", key = friendsKey }));
            return;
        }

        if (e.Key == System.Windows.Input.Key.Escape)
        {
            e.Handled = true;
            Hide();
            return;
        }

        if (e.Key == System.Windows.Input.Key.Enter)
        {
            e.Handled = true;
            OpenSelectedThread();
            return;
        }

        if (e.Key == System.Windows.Input.Key.Down || e.Key == System.Windows.Input.Key.Up)
        {
            e.Handled = true;
            MoveSelection(e.Key == System.Windows.Input.Key.Down ? 1 : -1);
        }
    }

    private void MoveSelection(int delta)
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        Browser.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "move-selection", delta }));
    }

    private void OpenSelectedThread()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "open-selected" }));
    }

    private void NewChatButton_Click(object sender, RoutedEventArgs e)
    {
        if (_installingUpdate) return;
        if (_roster.Count == 0)
        {
            MessageBox.Show(
                Text(
                    "친구 목록을 먼저 불러와 주세요. 친구 탭을 한 번 열면 목록이 준비됩니다.",
                    "Load the friends list first by opening the Friends tab once."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var picker = new NewChatWindow(_roster, AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors), _settings.Language) { Owner = this };
        if (picker.ShowDialog() != true) return;

        var handles = picker.SelectedHandles;
        if (handles.Count == 0 || !_webViewReady || Browser.CoreWebView2 is null) return;

        ShowChatView();
        Browser.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "new-room", handles }));
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => SystemCommands.MinimizeWindow(this);

    private void MaximizeButton_Click(object sender, RoutedEventArgs e)
    {
        if (WindowState == WindowState.Maximized) SystemCommands.RestoreWindow(this);
        else SystemCommands.MaximizeWindow(this);
    }

    private void UpdateMaximizeButton()
    {
        var maximized = WindowState == WindowState.Maximized;
        MaximizeButton.Content = maximized ? "\uE923" : "\uE922";
        MaximizeButton.ToolTip = maximized ? Text("이전 크기로 복원", "Restore") : Text("최대화", "Maximize");
    }

    // Same as the title-bar X used to do: OnlyDM keeps running in the tray.
    private void CloseButton_Click(object sender, RoutedEventArgs e) => Hide();

    // A friend is reached through the conversation list: the projection scrolls to the
    // matching conversation and opens it; a call is then started inside that window.
    private void HandleFriendChat(JsonElement root, string? callMode)
    {
        if (_installingUpdate) return;
        var name = TryGetString(root, "name");
        if (string.IsNullOrWhiteSpace(name)) return;

        _pendingCallMode = callMode;
        ShowChatView();

        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            type = "open-friend",
            name,
            handle = TryGetString(root, "handle") ?? string.Empty,
        }));
    }

    // A failed friends load must never strand the user on an empty tab: fall back to
    // the conversation list and say what happened.
    private void HandleFriendsError(string stage, string message)
    {
        if (!_friendsView) return;
        App.Log("friends", $"[{stage}] {message}");
        ShowChatView();
        MessageBox.Show(
            Text("팔로잉 목록을 불러오지 못했습니다. 다시 시도해 주세요.", "Could not load the following list. Try again."),
            "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void UpdateRailSelection()
    {
        var palette = AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors);
        var active = _friendsView ? FriendsButton : ChatButton;
        var inactive = _friendsView ? ChatButton : FriendsButton;
        active.SetResourceReference(Button.BackgroundProperty, "ShellAccentBrush");
        active.Foreground = AppTheme.Brush(palette.AccentText);
        inactive.ClearValue(Button.BackgroundProperty);
        inactive.ClearValue(Button.ForegroundProperty);
    }

    private void ShowChatView()
    {
        _friendsView = false;
        UpdateRailSelection();
        UpdateNativeViewLabels();
        FriendsBrowser.Visibility = Visibility.Collapsed;
        FriendsBrowser.IsHitTestVisible = false;
        if (!_inboxProjected) return;
        Browser.Visibility = Visibility.Visible;
        Browser.IsHitTestVisible = true;
        InboxLoadingPanel.Visibility = Visibility.Collapsed;
    }

    private void ShowFriendsView()
    {
        if (!_friendsView) return;
        _friendsReady = true;
        Browser.Visibility = Visibility.Hidden;
        Browser.IsHitTestVisible = false;
        InboxLoadingPanel.Visibility = Visibility.Collapsed;
        FriendsBrowser.Visibility = Visibility.Visible;
        FriendsBrowser.IsHitTestVisible = true;
    }

    private async void FriendsButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_ownProfile))
        {
            MessageBox.Show(
                Text(
                    "계정 정보를 아직 읽지 못했습니다. 채팅 목록이 로드된 뒤 다시 시도해 주세요.",
                    "Account information is not ready yet. Try again after the conversation list loads."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        _friendsView = true;
        UpdateRailSelection();
        UpdateNativeViewLabels();
        ProjectionStatusText.Text = Text("팔로잉 목록을 불러오는 중입니다.", "Loading following list.");
        ProjectionRetryButton.Visibility = Visibility.Collapsed;
        InboxLoadingPanel.Visibility = Visibility.Visible;
        Browser.Visibility = Visibility.Hidden;
        Browser.IsHitTestVisible = false;

        try
        {
            if (FriendsBrowser.CoreWebView2 is null)
            {
                var environment = await WebViewProfile.CreateEnvironmentAsync();
                await FriendsBrowser.EnsureCoreWebView2Async(environment);
                // Instagram only renders the following link in its desktop layout, so the
                // friends view is zoomed out until the CSS viewport clears that breakpoint.
                // The shell scales itself back up, so nothing looks smaller on screen.
                FriendsBrowser.ZoomFactor = FriendsZoom;
                ConfigureFriendsWebView();
            }

            var profileUri = new Uri($"https://www.instagram.com/{_ownProfile}/");
            if (_friendsReady && FriendsBrowser.Source?.AbsoluteUri == profileUri.AbsoluteUri)
            {
                ShowFriendsView();
                return;
            }

            FriendsBrowser.CoreWebView2?.Navigate(profileUri.AbsoluteUri);
        }
        catch (Exception ex)
        {
            ShowProjectionError("friends", ex.Message);
        }
    }

    private void ConfigureFriendsWebView()
    {
        var core = FriendsBrowser.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.ProcessFailed += Core_ProcessFailed;
        core.NewWindowRequested += (_, args) => args.Handled = true;
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.WebMessageReceived += Core_WebMessageReceived;
        core.NavigationStarting += (_, args) =>
        {
            if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
                || !NavigationPolicy.IsAllowedTopLevelUri(uri))
            {
                args.Cancel = true;
            }
        };
        core.NavigationCompleted += async (_, args) =>
        {
            if (!args.IsSuccess) return;
            await FriendsBrowser.CoreWebView2.ExecuteScriptAsync(
                FriendsScript.Build(
                    AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors),
                    1 / FriendsZoom,
                    _settings.Language));

            // Hand over the cached list; the view only collects it again when empty.
            if (_roster.Count == 0) return;
            FriendsBrowser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "friends-seed",
                people = _roster.Select(person => new
                {
                    handle = person.Handle,
                    name = person.Name,
                    avatar = person.Avatar,
                }),
            }));
        };
    }

    // The inbox matches room identities. Friends match account handles.
    private void PushNicknames()
    {
        if (!_nicknamesHooked)
        {
            _nicknamesHooked = true;
            AliasBook.Changed += () => Dispatcher.BeginInvoke(new Action(PushNicknames));
        }

        try
        {
            Browser.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "nicknames",
                map = AliasBook.ByThread(_roster, _threadUrls, _threadTitles),
            }));
            FriendsBrowser.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "nicknames",
                map = AliasBook.ByHandle(),
            }));
        }
        catch (Exception ex)
        {
            App.Log("nicknames", ex);
        }
    }

    private void ChatButton_Click(object sender, RoutedEventArgs e)
    {
        SearchBox.Text = string.Empty;
        ShowChatView();
        NavigateToInbox(force: !_inboxProjected);
    }

    private void ClearSearchButton_Click(object sender, RoutedEventArgs e)
    {
        SearchBox.Text = string.Empty;
        SearchBox.Focus();
    }

    private void SearchBox_TextChanged(object sender, System.Windows.Controls.TextChangedEventArgs e)
    {
        SendThreadFilter(SearchBox.Text);
    }

    private void HandleFriendsRoster(JsonElement root)
    {
        if (!root.TryGetProperty("people", out var people) || people.ValueKind != JsonValueKind.Array) return;

        _roster.Clear();
        foreach (var person in people.EnumerateArray())
        {
            var handle = TryGetString(person, "handle");
            var name = TryGetString(person, "name");
            if (string.IsNullOrWhiteSpace(handle) || string.IsNullOrWhiteSpace(name)) continue;
            _roster.Add(new FriendEntry(handle, name, TryGetString(person, "avatar") ?? string.Empty));
        }

        FriendsStore.Save(_roster);
    }

    // Instagram lets you find someone by handle or by display name; conversation rows
    // carry only the name, so a handle query is translated into matching names.
    private string[] AliasesFor(string query)
    {
        var trimmed = query.Trim();
        if (trimmed.Length < 2 || _roster.Count == 0) return Array.Empty<string>();

        return _roster
            .Where(person => person.Handle.Contains(trimmed, StringComparison.OrdinalIgnoreCase))
            .Select(person => person.Name)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(20)
            .ToArray();
    }

    private void SendThreadFilter(string query)
    {
        if (_friendsView)
        {
            FriendsBrowser.CoreWebView2?.PostWebMessageAsJson(
                JsonSerializer.Serialize(new { type = "friends-filter", query }));
            return;
        }

        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        Browser.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "filter-threads", query, aliases = AliasesFor(query) }));
    }

    private void SettingsButton_Click(object sender, RoutedEventArgs e) => OpenSettings();

    public async void OpenSettings()
    {
        if (_installingUpdate) return;
        if (OwnedWindows.OfType<SettingsWindow>().FirstOrDefault() is { } openSettings)
        {
            openSettings.Activate();
            return;
        }

        var dialog = new SettingsWindow(_settings) { Owner = this };
        if (dialog.ShowDialog() != true) return;

        var previousLanguageCode = AppLanguageChoice.InstagramCode(_settings.Language);
        _settings = dialog.SavedSettings;
        ApplyTheme();
        ApplyLanguage();
        UpdateTrayQuickSettings();
        RefreshWebViewsForSettings();

        if (previousLanguageCode != AppLanguageChoice.InstagramCode(_settings.Language))
        {
            _friendsReady = false;
            _instagramLanguageChecked = false;
            _languageSwitchAttempts = 0;
            BeginInstagramLanguageChange();
        }

        switch (dialog.RequestedAction)
        {
            case SettingsWindow.SettingsAction.SwitchAccount:
                OpenAccountPanel();
                break;
            case SettingsWindow.SettingsAction.Logout:
                await LogoutAsync();
                break;
        }
    }

    private void ResetIdentityViews()
    {
        _identityResetting = true;
        _instagramLanguageChecked = false;
        _languageSwitchAttempts = 0;
        foreach (var chat in new List<ChatWindow>(_chatWindows.Values)) chat.ForceClose();
        _chatWindows.Clear();
        _threadUrls.Clear();
        foreach (var pair in ThreadStore.Load()) _threadUrls[pair.Key] = pair.Value;
        _threadTitles.Clear();
        _roster.Clear();
        _roster.AddRange(FriendsStore.Load());
        AliasBook.ReloadIdentity();
        _friendsReady = false;
        FriendsBrowser.CoreWebView2?.Stop();
        _pendingCallMode = null;
        _inboxCount = _unreadCount = 0;
        _inboxCountKnown = false;
        Title = "OnlyDM";
        _trayIconService.UpdateUnreadCount(0);
        HeaderHint.Text = Text("더블클릭으로 새 채팅창", "Double-click to open a chat");
        SearchBox.Text = string.Empty;
        HideBrowserForProjection();
        ShowChatView();
        NavigateToInbox(force: true);
    }

    private void OpenAccountPanel()
    {
        if (_installingUpdate || _refreshAccountChooserLanguage is not null || _restarting || Application.Current is not App) return;

        OpenFromTray();
        var accounts = AccountStore.Current;
        var ids = accounts.AccountIds;
        var palette = AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors);
        var textBrush = AppTheme.Brush(palette.Text);
        var mutedBrush = AppTheme.Brush(palette.MutedText);
        var buttonBrush = AppTheme.Brush(palette.SurfaceAlt);
        var borderBrush = AppTheme.Brush(palette.Border);
        var list = new StackPanel();
        var panel = new StackPanel { Margin = new Thickness(16) };
        var instructions = new TextBlock
        {
            Foreground = mutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 12),
        };
        panel.Children.Add(instructions);
        panel.Children.Add(new ScrollViewer { Content = list, MaxHeight = 260, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        var dialog = new Window
        {
            Owner = this,
            Width = 340,
            SizeToContent = SizeToContent.Height,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = AppTheme.Brush(palette.WindowBackground),
            Content = panel,
        };

        Button MakeButton() => new()
        {
            Foreground = textBrush,
            Background = buttonBrush,
            BorderBrush = borderBrush,
            MinHeight = 32,
        };

        Guid? selected = null;
        Button AddChoice(StackPanel host, Guid? id)
        {
            var button = MakeButton();
            button.Margin = new Thickness(0, 0, 0, 6);
            button.Click += (_, _) =>
            {
                selected = id;
                dialog.DialogResult = true;
            };
            host.Children.Add(button);
            return button;
        }

        Action? refreshAccountNames = null;
        for (var i = 0; i < ids.Count; i++)
        {
            var id = ids[i];
            var handle = accounts.HandleFor(id);
            var number = i + 1;
            string AccountName() => handle is null ? Text($"계정 {number}", $"Account {number}") : $"@{handle}";
            if (id == accounts.SelectedId)
            {
                var current = new TextBlock
                {
                    Foreground = textBrush,
                    TextAlignment = TextAlignment.Center,
                    Padding = new Thickness(0, 8, 0, 10),
                };
                list.Children.Add(current);
                refreshAccountNames += () =>
                {
                    var label = AccountName();
                    current.Text = Text($"{label} (현재 사용 중)", $"{label} (current)");
                };
            }
            else
            {
                var button = AddChoice(list, id);
                refreshAccountNames += () => button.Content = AccountName();
            }
        }
        var chooseInstagramProfile = false;
        var instagram = MakeButton();
        instagram.IsEnabled = _webViewReady && NavigationPolicy.IsInboxUri(Browser.Source);
        instagram.Margin = new Thickness(0, 0, 0, 6);
        instagram.Click += (_, _) =>
        {
            chooseInstagramProfile = true;
            dialog.DialogResult = false;
        };
        panel.Children.Add(instagram);
        var add = AddChoice(panel, null);
        var close = MakeButton();
        close.IsCancel = true;
        panel.Children.Add(close);

        _refreshAccountChooserLanguage = () =>
        {
            dialog.Title = Text("Instagram 계정", "Instagram accounts");
            instructions.Text = Text("연결된 프로필은 ‘프로필 전환’으로 고르세요. 다른 로그인만 별도로 추가하세요.",
                "Choose linked profiles with Switch profile. Add another sign-in only for a separate login.");
            instagram.Content = Text("프로필 전환…", "Switch profile…");
            add.Content = Text("다른 로그인 추가…", "Add another sign-in…");
            close.Content = Text("닫기", "Close");
            refreshAccountNames?.Invoke();
        };
        try
        {
            _refreshAccountChooserLanguage();
            var accepted = dialog.ShowDialog() == true;
            if (_restarting) return;
            if (chooseInstagramProfile)
            {
                ShowChatView();
                Browser.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "open-account-panel" }));
                return;
            }
            if (!accepted) return;
        }
        catch (Exception ex)
        {
            App.Log("account-switch", ex);
            MessageBox.Show(this, Text("계정 선택을 저장하지 못했습니다.", "Could not save the account selection."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }
        finally
        {
            _refreshAccountChooserLanguage = null;
        }

        SwitchAccount(selected);
    }

    private void SwitchAccount(Guid? selected)
    {
        if (_installingUpdate || _restarting || _allowClose || Application.Current is not App app) return;
        try { AccountStore.Current.SelectForNextLaunch(selected); }
        catch (Exception ex)
        {
            App.Log("account-switch", ex);
            MessageBox.Show(this, Text("계정 선택을 저장하지 못했습니다.", "Could not save the account selection."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        _restarting = true;
        app.RestartForAccountSwitch(_settings.Language);
        RequestExit();
    }

    private async Task LogoutAsync()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;

        var confirmed = MessageBox.Show(
            Text(
                "OnlyDM에서 현재 계정의 Instagram 로그인 정보를 지웁니다.\n\n로그아웃하시겠습니까?",
                "This clears the Instagram sign-in for the current account.\n\nLog out?"),
            "OnlyDM",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question);
        if (confirmed != MessageBoxResult.Yes) return;

        foreach (var chat in new List<ChatWindow>(_chatWindows.Values)) chat.ForceClose();
        _chatWindows.Clear();

        try
        {
            await Browser.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.AllSite);
        }
        catch (Exception ex)
        {
            App.Log("logout", ex);
            MessageBox.Show(Text("로그아웃하지 못했습니다.", "Could not log out."), "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        _ownProfile = NavigationPolicy.OwnProfileUsername = null;
        _friendsReady = false;
        HideBrowserForProjection();
        ShowChatView();
        NavigateToInbox(force: true);
    }

    private void OpenSettingsFromTray()
    {
        OpenFromTray();
        OpenSettings();
    }

    private void Tray_ThemeChanged(ThemeKind theme)
    {
        if (_settings.Theme == theme) return;
        _settings.Theme = theme;
        SettingsStore.Save(_settings);
        ApplyTheme();
        UpdateTrayQuickSettings();
        RefreshWebViewsForSettings();
    }

    private void Tray_AutoStartChanged(bool enabled)
    {
        try
        {
            StartupManager.SetEnabled(enabled);
        }
        catch (Exception ex)
        {
            App.Log("startup-setting", ex);
            MessageBox.Show(Text("자동 실행 설정을 변경하지 못했습니다.", "Could not change the startup setting."), "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        UpdateTrayQuickSettings();
    }

    private void Tray_NotificationsChanged(bool enabled)
    {
        _settings.NotificationsEnabled = enabled;
        SettingsStore.Save(_settings);
        UpdateTrayQuickSettings();
    }

    private void Tray_NotificationPreviewChanged(bool enabled)
    {
        _settings.NotificationPreviewEnabled = enabled;
        SettingsStore.Save(_settings);
        UpdateTrayQuickSettings();
    }

    private void Tray_WorkModeChanged(bool enabled)
    {
        _settings.WorkModeEnabled = enabled;
        SettingsStore.Save(_settings);
        UpdateTrayQuickSettings();
    }

    private void UpdateTrayQuickSettings()
    {
        _trayIconService.UpdateQuickSettings(_settings, StartupManager.IsEnabled());
        RefreshAccountWatchers();
    }

    private void RefreshAccountWatchers()
    {
        if (!_webViewReady || !_settings.NotificationsEnabled || _restarting || _allowClose)
        {
            StopAccountWatchers();
            return;
        }

        var desired = AccountStore.Current.InactiveNotificationIds.ToHashSet();
        foreach (var id in _accountWatchers.Keys.Where(id => !desired.Contains(id)).ToArray())
        {
            _accountWatchers[id].Dispose();
            _accountWatchers.Remove(id);
        }

        var now = Environment.TickCount64;
        foreach (var id in desired)
        {
            if (_accountWatchers.TryGetValue(id, out var previous))
            {
                if (!previous.IsRetryDue(now)) continue;
                previous.Dispose();
            }
            var script = WebViewScripts.BuildInboxScript(
                AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors), _settings.Language, 0.25, notificationsOnly: true);
            var watcher = new AccountInboxWatcher(script, (title, payload) => HandleAccountNotification(id, title, payload));
            _accountWatchers[id] = watcher;
            _ = StartAccountWatcherAsync(id, watcher);
        }

        if (_accountWatchers.Count == 0) _accountWatcherRetry.Stop();
        else _accountWatcherRetry.Start();
    }

    private static async Task StartAccountWatcherAsync(Guid id, AccountInboxWatcher watcher)
    {
        try { await watcher.StartAsync(await WebViewProfile.CreateEnvironmentAsync(id)); }
        catch (Exception ex)
        {
            watcher.FailInitialization();
            App.Log("account-watcher", ex);
        }
    }

    private void StopAccountWatchers()
    {
        _accountWatcherRetry.Stop();
        foreach (var watcher in _accountWatchers.Values) watcher.Dispose();
        _accountWatchers.Clear();
    }

    private void HandleAccountNotification(Guid id, string title, JsonElement payload)
    {
        if (!_settings.NotificationsEnabled || _restarting || _allowClose
            || !AccountStore.Current.InactiveNotificationIds.Contains(id)) return;
        var accounts = AccountStore.Current;
        var number = accounts.AccountIds.ToList().IndexOf(id) + 1;
        var label = accounts.HandleFor(id) is string handle ? $"@{handle}" : Text($"계정 {number}", $"Account {number}");
        _trayIconService.ShowNotification(TrimNotificationText($"{label} · {title}"), NotificationBody(payload),
            () => Dispatcher.BeginInvoke(new Action(() =>
            {
                if (_settings.NotificationsEnabled) SwitchAccount(id);
            })));
    }

    private string NotificationBody(JsonElement payload)
    {
        if (_settings.NotificationPreviewEnabled)
        {
            var preview = payload.TryGetProperty("caption", out var caption) && caption.ValueKind == JsonValueKind.Object
                ? TryGetString(caption, AppLanguageChoice.InstagramCode(_settings.Language))
                : null;
            if (string.IsNullOrWhiteSpace(preview)) preview = TryGetString(payload, "preview");
            if (!string.IsNullOrWhiteSpace(preview)) return TrimNotificationText(preview);
        }
        return Text("새 메시지가 도착했습니다.", "A new message has arrived.");
    }

    private void RefreshWebViewsForSettings()
    {
        var palette = AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors);

        // Reloading to repaint would re-harvest every conversation, so the palette is
        // pushed into the running projection instead.
        if (_webViewReady && Browser.CoreWebView2 is not null)
        {
            Browser.CoreWebView2.PostWebMessageAsJson(WebViewScripts.BuildInboxThemeMessage(palette));
            FriendsBrowser.CoreWebView2?.PostWebMessageAsJson(WebViewScripts.BuildInboxThemeMessage(palette));
        }

        foreach (var chat in new List<ChatWindow>(_chatWindows.Values))
        {
            chat.ApplySettings(_settings);
        }
    }

    private string Text(string korean, string english) =>
        AppLanguageChoice.Text(_settings.Language, korean, english);

    private async Task CheckForUpdatesAsync()
    {
        if (_checkingForUpdate || _installingUpdate || _allowClose) return;
        _checkingForUpdate = true;
        try
        {
            var update = await _updates.CheckAsync(_updateLifetime.Token);
            if (!_allowClose) SetAvailableUpdate(update);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { App.Log("update-check", ex); }
        finally { _checkingForUpdate = false; }
    }

    private void SetAvailableUpdate(AppUpdateRelease? update)
    {
        _availableUpdate = update;
        UpdateUpdateButton();
    }

    private void UpdateUpdateButton()
    {
        UpdateButton.Visibility = _availableUpdate is null ? Visibility.Collapsed : Visibility.Visible;
        UpdateButton.IsEnabled = !_installingUpdate;
        UpdateButton.ToolTip = _installingUpdate
            ? Text("업데이트를 준비하는 중입니다.", "Preparing update.")
            : _availableUpdate is { } update
                ? Text($"{update.Version.ToString(3)} 업데이트 · 설치 후 다시 시작", $"Update to {update.Version.ToString(3)} · restarts the app")
                : Text("업데이트", "Update");
    }

    private async void UpdateButton_Click(object sender, RoutedEventArgs e)
    {
        if (_installingUpdate || _availableUpdate is not { } update) return;
        _installingUpdate = true;
        UpdateUpdateButton();
        var inputState = CaptureUpdateInputState();
        try
        {
            PauseInputForUpdate(inputState);
            var chats = Application.Current.Windows.OfType<ChatWindow>().ToArray();
            var drafts = await Task.WhenAll(chats.Select(chat => chat.HasUnsentDraftAsync()));
            if (drafts.Any(draft => draft != false))
            {
                var detail = drafts.Any(draft => draft == true)
                    ? Text("보내지 않은 메시지가 있습니다. 업데이트하면 앱이 다시 시작되어 초안이 사라집니다. 계속할까요?",
                        "There are unsent messages. Updating restarts the app and discards drafts. Continue?")
                    : Text("초안을 확인하지 못했습니다. 업데이트하면 입력 중인 내용이 사라질 수 있습니다. 계속할까요?",
                        "Drafts could not be checked. Updating may discard unsent content. Continue?");
                if (MessageBox.Show(this, detail, "OnlyDM", MessageBoxButton.OKCancel,
                        MessageBoxImage.Warning, MessageBoxResult.Cancel) != MessageBoxResult.OK) return;
            }

            await _updates.StartAsync(update);
            _restarting = true;
            RequestExit();
        }
        catch (Exception ex)
        {
            App.Log("update-start", ex);
            MessageBox.Show(this, Text("업데이트를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
                "Could not start the update. Please try again shortly."), "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            if (!_allowClose)
            {
                RestoreInputAfterUpdate(inputState);
                _installingUpdate = false;
                UpdateUpdateButton();
            }
        }
    }

    private readonly record struct UpdateWindowState(Window Window, bool WasEnabled, IntPtr Handle, bool WasNativeEnabled);

    private UpdateWindowState[] CaptureUpdateInputState() =>
        Application.Current.Windows.Cast<Window>().Select(window =>
        {
            var handle = new WindowInteropHelper(window).Handle;
            return new UpdateWindowState(window, window.IsEnabled, handle,
                handle != IntPtr.Zero && IsWindowEnabled(handle));
        }).ToArray();

    private void PauseInputForUpdate(UpdateWindowState[] inputState)
    {
        // Keep the draft snapshot valid until exit, including during helper readiness.
        _pendingCallMode = null;
        foreach (var state in inputState)
        {
            state.Window.IsEnabled = false;
            // WebView2 has a native child HWND; WPF's IsEnabled alone leaves it interactive.
            if (state.Handle != IntPtr.Zero) EnableWindow(state.Handle, false);
        }
    }

    private void RestoreInputAfterUpdate(UpdateWindowState[] inputState)
    {
        foreach (var state in inputState)
        {
            if (!Application.Current.Windows.Cast<Window>().Contains(state.Window)) continue;
            state.Window.IsEnabled = state.WasEnabled;
            if (state.Handle != IntPtr.Zero && new WindowInteropHelper(state.Window).Handle == state.Handle)
                EnableWindow(state.Handle, state.WasNativeEnabled);
        }
    }

    private void StopUpdateChecks()
    {
        _updateTimer.Stop();
        if (!_updateLifetime.IsCancellationRequested) _updateLifetime.Cancel();
    }

    private void ApplyLanguage()
    {
        WpfLanguage.Apply(this, _settings.Language);
        MinimizeButton.ToolTip = Text("최소화", "Minimize");
        CloseButton.ToolTip = Text("닫기", "Close");
        ClearSearchButton.ToolTip = Text("검색 지우기", "Clear search");
        UpdateMaximizeButton();
        UpdateNativeViewLabels();
        UpdateUpdateButton();

        foreach (var picker in OwnedWindows.OfType<NewChatWindow>())
            picker.ApplyLanguage(_settings.Language);
        _refreshAccountChooserLanguage?.Invoke();
    }

    private void UpdateNativeViewLabels()
    {
        var search = _friendsView ? Text("친구 검색", "Search friends") : Text("채팅 검색", "Search chats");
        SearchBox.ToolTip = SearchPlaceholder.Text = search;
        if (_authenticationVisible)
        {
            HeaderTitle.Text = Text("로그인 · 인증", "Sign in · Verify");
            HeaderHint.Text = Text("Instagram에서 인증을 완료해 주세요.", "Complete verification on Instagram.");
        }
        else if (_friendsView)
        {
            HeaderTitle.Text = Text("친구", "Friends");
            HeaderHint.Text = string.Empty;
        }
        else
        {
            HeaderTitle.Text = Text("채팅", "Chats");
            UpdateInboxHeader();
        }
    }

    private void ApplyTheme()
    {
        var palette = AppTheme.GetPalette(_settings.Theme, _settings.CustomAppColors);
        var text = AppTheme.Brush(palette.Text);
        var muted = AppTheme.Brush(palette.MutedText);
        var accent = AppTheme.Brush(palette.Accent);
        var surfaceAlt = AppTheme.Brush(palette.SurfaceAlt);
        Resources["ShellTextBrush"] = text;
        Resources["ShellHoverBrush"] = AppTheme.Brush(palette.Border);
        Resources["ShellAccentBrush"] = accent;
        foreach (var chrome in new[] { AppTitleBar, RailBorder })
        {
            chrome.Resources["ShellTextBrush"] = AppTheme.Brush(palette.ChromeText);
            chrome.Resources["ShellHoverBrush"] = AppTheme.Brush(palette.ChromeHover);
        }
        AppTitleBar.Background = AppTheme.Brush(palette.ChromeBackground);
        RootGrid.Background = AppTheme.Brush(palette.WindowBackground);
        ContentFrame.Background = AppTheme.Brush(palette.Surface);
        RailBorder.Background = AppTheme.Brush(palette.RailBackground);
        HeaderTitle.Foreground = text;
        HeaderHint.Foreground = muted;
        SearchBoxBorder.Background = surfaceAlt;
        SearchIcon.Stroke = muted;
        SearchPlaceholder.Foreground = muted;
        SearchBox.Foreground = text;
        SearchBox.CaretBrush = text;
        SearchBox.SelectionBrush = accent;
        ClearSearchButton.Foreground = muted;
        ProjectionStatusText.Foreground = muted;
        ProjectionRetryButton.Background = accent;
        ProjectionRetryButton.Foreground = AppTheme.Brush(palette.AccentText);
        ProjectionRetryButton.BorderBrush = accent;
        InboxProgressBar.Foreground = accent;
        InboxProgressBar.Background = surfaceAlt;
        UpdateRailSelection();
    }

    private void HideBrowserForProjection()
    {
        _inboxProjected = false;
        Browser.Visibility = Visibility.Hidden;
        Browser.IsHitTestVisible = false;
        ProjectionStatusText.Text = Text("채팅 목록을 불러오는 중입니다.", "Loading conversations.");
        ProjectionRetryButton.Visibility = Visibility.Collapsed;
        InboxLoadingPanel.Visibility = Visibility.Visible;
    }

    private void ShowProjectionError(string stage, string message)
    {
        if (_friendsView && stage == "threads") return;
        if (_inboxProjected && stage == "open")
        {
            App.Log("projection", $"[{stage}] {message}");
            HeaderHint.Text = Text("채팅방을 열지 못했습니다. 다시 시도해 주세요.", "Could not open the chat. Try again.");
            return;
        }
        // Once the list is on screen a transient script hiccup must not replace it
        // with an error panel; the next render simply corrects itself.
        if (_inboxProjected && (stage != "threads" || _inboxCount > 0)) return;

        App.Log("projection", $"[{stage}] {message}");
        _inboxProjected = false;
        Browser.Visibility = Visibility.Hidden;
        Browser.IsHitTestVisible = false;
        ProjectionStatusText.Text = Text("채팅 목록을 불러오지 못했습니다. 다시 시도해 주세요.", "Could not load conversations. Try again.");
        ProjectionRetryButton.Visibility = Visibility.Visible;
        InboxLoadingPanel.Visibility = Visibility.Visible;
    }

    private void ProjectionRetryButton_Click(object sender, RoutedEventArgs e)
    {
        if (!_instagramLanguageChecked || NavigationPolicy.IsLanguageSettingsUri(Browser.Source))
        {
            _languageSwitchAttempts = 0;
            BeginInstagramLanguageChange();
            return;
        }
        NavigateToInbox(force: true);
    }

    private void ShowAuthentication()
    {
        _instagramProfilePanelOpen = false;
        _instagramLanguageChecked = false;
        _languageSwitchAttempts = 0;
        _authenticationVisible = true;
        _inboxProjected = false;
        _inboxCountKnown = false;
        ShowChatView();
        Browser.ZoomFactor = 1;
        Browser.Visibility = Visibility.Visible;
        Browser.IsHitTestVisible = true;
        InboxLoadingPanel.Visibility = Visibility.Collapsed;
        SearchBox.IsEnabled = false;
        NewChatButton.IsEnabled = false;
        FriendsButton.IsEnabled = false;
    }

    private void ShowProjectedInbox()
    {
        if (NavigationPolicy.IsLoginUri(Browser.Source))
        {
            ShowAuthentication();
            return;
        }
        _authenticationVisible = false;
        SearchBox.IsEnabled = true;
        NewChatButton.IsEnabled = true;
        FriendsButton.IsEnabled = true;
        UpdateNativeViewLabels();
        _inboxProjected = true;
        Browser.Visibility = Visibility.Visible;
        Browser.IsHitTestVisible = true;
        InboxLoadingPanel.Visibility = Visibility.Collapsed;
    }

    private void NavigateToInbox(bool force = false)
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;
        if (!force && Browser.Source?.AbsoluteUri == NavigationPolicy.InboxUri.AbsoluteUri) return;
        HideBrowserForProjection();
        Browser.CoreWebView2.Navigate(NavigationPolicy.InboxUri.AbsoluteUri);
    }

    public void OpenFromTray()
    {
        if (_allowClose || _restarting) return;
        ContentRendered -= HideOnFirstRender;
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    public void RequestExit()
    {
        _allowClose = true;
        StopUpdateChecks();
        StopAccountWatchers();
        foreach (var chat in new List<ChatWindow>(_chatWindows.Values))
        {
            chat.ForceClose();
        }
        _chatWindows.Clear();
        _trayIconService.Dispose();
        Application.Current.Shutdown();
    }

    internal void AllowCloseForSessionEnding()
    {
        _allowClose = true;
        StopUpdateChecks();
        StopAccountWatchers();
        _trayIconService.Dispose();
    }

    protected override void OnClosed(EventArgs e)
    {
        StopUpdateChecks();
        _updateLifetime.Dispose();
        StopAccountWatchers();
        Browser.Dispose();
        FriendsBrowser.Dispose();
        base.OnClosed(e);
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        Hide();
    }
}
