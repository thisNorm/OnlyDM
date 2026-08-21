using System;
using System.Collections.Generic;
using System.Linq;
using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public partial class MainWindow : Window
{
    private readonly TrayIconService _trayIconService;
    private readonly Dictionary<string, ChatWindow> _chatWindows = new(StringComparer.OrdinalIgnoreCase);
    private AppSettings _settings;
    private bool _webViewReady;
    private bool _inboxProjected;
    private bool _friendsReady;
    private bool _friendsView;
    private string? _ownProfile;
    private string? _pendingCallMode;
    private readonly List<FriendEntry> _roster = new();
    private readonly Dictionary<string, string> _threadUrls = ThreadStore.Load();
    private readonly Dictionary<string, string> _threadTitles = new(StringComparer.Ordinal);
    private static bool _restarting;
    private bool _nicknamesHooked;

    // 0.4 turns a ~330px control into a ~820px CSS viewport, past Instagram's 736px
    // desktop breakpoint.
    private const double FriendsZoom = 0.4;
    private bool _allowClose;

    public MainWindow()
    {
        InitializeComponent();
        _settings = SettingsStore.Load();
        _roster.AddRange(FriendsStore.Load());
        _trayIconService = new TrayIconService(OpenFromTray, OpenSettingsFromTray, RequestExit);
        _trayIconService.ThemeChanged += Tray_ThemeChanged;
        _trayIconService.AutoStartChanged += Tray_AutoStartChanged;
        _trayIconService.NotificationsChanged += Tray_NotificationsChanged;
        _trayIconService.NotificationPreviewChanged += Tray_NotificationPreviewChanged;
        ApplyTheme();
        UpdateTrayQuickSettings();

        // StartupUri shows the window, so tray-start hides it again on first layout.
        if (_settings.StartInTray)
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

    private void HideOnFirstRender(object? sender, EventArgs e)
    {
        ContentRendered -= HideOnFirstRender;
        Hide();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        RoundCorners(this);
        if (_webViewReady) return;

        try
        {
            if (!await WebView2DependencyService.EnsureInstalledWithConsentAsync(this))
            {
                RequestExit();
                return;
            }

            var environment = await WebViewProfile.CreateEnvironmentAsync();
            await Browser.EnsureCoreWebView2Async(environment);
            ConfigureWebView();
            _webViewReady = true;
            NavigateToInbox();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                "Microsoft Edge WebView2 Runtime is required. Run OnlyDM with the 'odm start' command to install it with your consent.",
                "OnlyDM",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            RequestExit();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"OnlyDM을 초기화하지 못했습니다.\n\n{ex.Message}", "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
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
        App.Log("process-failed", e.ProcessFailedKind);
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
        {
            try { (sender as CoreWebView2)?.Reload(); } catch (Exception ex) { App.Log("reload", ex); }
            return;
        }

        if (_restarting) return;
        _restarting = true;
        // Restarting only helps something that was working a moment ago; a failure right
        // after launch would otherwise restart forever.
        var uptime = DateTime.Now - Process.GetCurrentProcess().StartTime;
        if (uptime > TimeSpan.FromSeconds(30) && Environment.ProcessPath is string exe)
        {
            try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true }); }
            catch (Exception ex) { App.Log("restart", ex); }
        }
        else
        {
            MessageBox.Show(
                "브라우저 구성 요소가 중지되어 OnlyDM을 종료합니다.",
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
        }

        AllowCloseForSessionEnding();
        Application.Current.Shutdown();
    }

    private async void Core_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            ShowProjectionError("navigation", $"Instagram navigation failed: {e.WebErrorStatus}");
            return;
        }

        await RunInboxProjectionAsync();
    }

    private async Task RunInboxProjectionAsync()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;

        try
        {
            ProjectionStatusText.Text = "채팅 목록을 불러오는 중입니다.";
            ProjectionRetryButton.Visibility = Visibility.Collapsed;
            var palette = AppTheme.GetPalette(_settings.Theme);
            await Browser.CoreWebView2.ExecuteScriptAsync(WebViewScripts.BuildInboxScript(palette));
        }
        catch (Exception ex)
        {
            ShowProjectionError("execute", ex.Message);
        }
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        Dispatcher.BeginInvoke(new Action(HideBrowserForProjection));

        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) || !NavigationPolicy.IsAllowedTopLevelUri(uri))
        {
            e.Cancel = true;
            Dispatcher.BeginInvoke(new Action(() => NavigateToInbox()));
            return;
        }

        if (IsThreadUri(uri))
        {
            e.Cancel = true;
            Dispatcher.BeginInvoke(new Action(() => NavigateToInbox()));
        }
    }

    private void Core_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            if (!message.RootElement.TryGetProperty("type", out var typeElement)) return;

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
                    _ownProfile = TryGetString(message.RootElement, "username");
                    NavigationPolicy.OwnProfileUsername = _ownProfile;
                    break;
                case "friends-roster":
                    HandleFriendsRoster(message.RootElement);
                    break;
                case "friends-ready":
                    ShowFriendsView();
                    PushNicknames();
                    break;
                case "switch-account":
                    OpenAccountPanel();
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
        var title = TryGetString(root, "title");
        if (TryGetThreadUri(root, out var direct))
        {
            OpenThread(direct, title);
            return;
        }

        var key = TryGetString(root, "key");
        if (string.IsNullOrWhiteSpace(key) && string.IsNullOrWhiteSpace(title)) return;

        // Instagram keeps only a handful of conversation rows in the page at a time, so
        // asking it to open one means scrolling the hidden list until that row exists
        // again - slow, and it fails outright when the row will not come back. An
        // address learned from a previous visit skips all of that.
        if (!string.IsNullOrWhiteSpace(key)
            && _threadUrls.TryGetValue(key, out var known)
            && Uri.TryCreate(known, UriKind.Absolute, out var cached)
            && NavigationPolicy.IsDirectUri(cached))
        {
            OpenThread(cached, title);
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

        if (changed) ThreadStore.Save(_threadUrls);
    }

    private void HandleOpenThreadMessage(JsonElement root)
    {
        if (!TryGetThreadUri(root, out var uri)) return;
        RememberThread(TryGetString(root, "title"), uri, TryGetString(root, "key"));
        OpenThread(uri, TryGetString(root, "title"));

        // The projection walks itself back to the inbox through the SPA so the harvested
        // conversations survive; it asks for a real navigation only if that fails.

    }

    private void HandleThreadNotification(JsonElement root)
    {
        var title = TryGetString(root, "title") ?? "OnlyDM";
        Uri? threadUri = TryGetThreadUri(root, out var parsedUri) ? parsedUri : null;
        var key = threadUri is null ? TryGetString(root, "key") : AliasBook.ThreadKey(threadUri);
        if (!_settings.NotificationsEnabled || IsThreadWindowActive(key, title)) return;

        var preview = TryGetString(root, "preview");
        var body = _settings.NotificationPreviewEnabled && !string.IsNullOrWhiteSpace(preview)
            ? TrimNotificationText(preview)
            : "새 메시지가 도착했습니다.";

        _trayIconService.ShowNotification(title, body, () =>
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                if (threadUri is not null) OpenThread(threadUri, title);
                else OpenThreadByKey(key, title);
            }));
        });
    }

    private void HandleInboxCount(JsonElement root)
    {
        var count = root.TryGetProperty("count", out var countElement) ? countElement.GetInt32() : 0;
        var unread = root.TryGetProperty("unread", out var unreadElement) ? unreadElement.GetInt32() : 0;

        HeaderHint.Text = unread > 0 ? $"대화 {count} · 안 읽음 {unread}" : $"대화 {count}";
        Title = unread > 0 ? $"OnlyDM ({unread})" : "OnlyDM";
        _trayIconService.UpdateUnreadCount(unread);
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
        if (!root.TryGetProperty(propertyName, out var element)) return null;
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

    private void EvictOldChatWindows()
    {
        while (_chatWindows.Count > MaxChatWindows)
        {
            var oldest = default(KeyValuePair<string, ChatWindow>);
            foreach (var pair in _chatWindows)
            {
                if (pair.Value.IsVisible) continue;
                if (oldest.Value is null || pair.Value.LastUsedUtc < oldest.Value.LastUsedUtc) oldest = pair;
            }

            if (oldest.Value is null) return;
            _chatWindows.Remove(oldest.Key);
            oldest.Value.ForceClose();
        }
    }

    private void OpenThread(Uri threadUri, string? title = null)
    {
        var key = ThreadKey(threadUri);
        if (_chatWindows.TryGetValue(key, out var existing))
        {
            existing.PendingCall = _pendingCallMode;
            _pendingCallMode = null;
            RestoreChatWindow(existing);
            return;
        }

        var chatWindow = new ChatWindow(threadUri, _settings, title) { PendingCall = _pendingCallMode };
        _pendingCallMode = null;
        _chatWindows[key] = chatWindow;
        chatWindow.Closed += (_, _) => _chatWindows.Remove(key);
        chatWindow.Show();
        chatWindow.Activate();
        EvictOldChatWindows();
    }

    // Esc/Enter are also handled inside the projection, because the WebView swallows
    // keys whenever it holds focus. This covers the WPF chrome (search box, rail).
    private void Window_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
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
        if (_roster.Count == 0)
        {
            MessageBox.Show(
                "친구 목록을 먼저 불러와 주세요. 친구 탭을 한 번 열면 목록이 준비됩니다.",
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var picker = new NewChatWindow(_roster, AppTheme.GetPalette(_settings.Theme)) { Owner = this };
        if (picker.ShowDialog() != true) return;

        var handles = picker.SelectedHandles;
        if (handles.Count == 0 || !_webViewReady || Browser.CoreWebView2 is null) return;

        ShowChatView();
        Browser.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "new-room", handles }));
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    // Same as the title-bar X used to do: OnlyDM keeps running in the tray.
    private void CloseButton_Click(object sender, RoutedEventArgs e) => Hide();

    // A friend is reached through the conversation list: the projection scrolls to the
    // matching conversation and opens it; a call is then started inside that window.
    private void HandleFriendChat(JsonElement root, string? callMode)
    {
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
        ShowChatView();
        MessageBox.Show(
            $"팔로잉 목록을 불러오지 못했습니다.\n\n[{stage}] {message}",
            "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void UpdateRailSelection()
    {
        var palette = AppTheme.GetPalette(_settings.Theme);
        var active = AppTheme.Brush(palette.SurfaceAlt);
        ChatButton.Background = _friendsView ? System.Windows.Media.Brushes.Transparent : active;
        FriendsButton.Background = _friendsView ? active : System.Windows.Media.Brushes.Transparent;
    }

    private void ShowChatView()
    {
        _friendsView = false;
        UpdateRailSelection();
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
                "계정 정보를 아직 읽지 못했습니다. 채팅 목록이 로드된 뒤 다시 시도해 주세요.",
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        _friendsView = true;
        UpdateRailSelection();
        ProjectionStatusText.Text = "팔로잉 목록을 불러오는 중입니다.";
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
                FriendsScript.Build(AppTheme.GetPalette(_settings.Theme), 1 / FriendsZoom));

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

    // The DM list only knows display names and the friends list only knows handles, so
    // each gets the same nicknames keyed the way it can actually use them.
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
                map = AliasBook.ByDisplayName(_roster, _threadUrls, _threadTitles),
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
        NavigateToInbox();
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
        var dialog = new SettingsWindow(_settings) { Owner = this };
        if (dialog.ShowDialog() != true) return;

        _settings = dialog.SavedSettings;
        ApplyTheme();
        UpdateTrayQuickSettings();
        RefreshWebViewsForSettings();

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

    // OnlyDM only asks Instagram to show its own switcher; the user signs in on
    // Instagram's real form and OnlyDM never sees or stores credentials.
    private void OpenAccountPanel()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;

        // The switcher lives in the conversation view. Asking for it from the friends
        // tab used to open it inside the hidden inbox, so nothing appeared.
        ShowChatView();
        OpenFromTray();
        Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "open-account-panel" }));
    }

    private async Task LogoutAsync()
    {
        if (!_webViewReady || Browser.CoreWebView2 is null) return;

        var confirmed = MessageBox.Show(
            "OnlyDM에 저장된 Instagram 로그인 정보를 지웁니다.\n\n로그아웃하시겠습니까?",
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
            MessageBox.Show($"로그아웃하지 못했습니다.\n\n{ex.Message}", "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        HideBrowserForProjection();
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
            MessageBox.Show($"자동 실행 설정을 변경하지 못했습니다.\n\n{ex.Message}", "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
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

    private void UpdateTrayQuickSettings()
    {
        _trayIconService.UpdateQuickSettings(_settings, StartupManager.IsEnabled());
    }

    private void RefreshWebViewsForSettings()
    {
        var palette = AppTheme.GetPalette(_settings.Theme);

        // Reloading to repaint would re-harvest every conversation, so the palette is
        // pushed into the running projection instead.
        if (_webViewReady && Browser.CoreWebView2 is not null)
        {
            Browser.CoreWebView2.PostWebMessageAsJson(WebViewScripts.BuildInboxThemeMessage(palette));
        }

        foreach (var chat in new List<ChatWindow>(_chatWindows.Values))
        {
            chat.ApplySettings(_settings);
        }
    }

    private void ApplyTheme()
    {
        var palette = AppTheme.GetPalette(_settings.Theme);
        RootGrid.Background = AppTheme.Brush(palette.WindowBackground);
        RailBorder.Background = AppTheme.Brush(palette.RailBackground);
        RailBorder.BorderBrush = AppTheme.Brush(palette.Border);
        HeaderBorder.Background = AppTheme.Brush(palette.Surface);
        HeaderBorder.BorderBrush = AppTheme.Brush(palette.Border);
        HeaderHint.Foreground = AppTheme.Brush(palette.MutedText);
        SearchPanel.Background = AppTheme.Brush(palette.Surface);
        SearchPanel.BorderBrush = AppTheme.Brush(palette.Border);
        SearchBoxBorder.Background = AppTheme.Brush(palette.SurfaceAlt);
        BrowserBorder.Background = AppTheme.Brush(palette.Surface);
        // Accent on the rail was near-invisible (Classic yellow on white); the active tab
        // is marked with a filled pill instead.
        ChatButton.Foreground = AppTheme.Brush(palette.Text);
        FriendsButton.Foreground = AppTheme.Brush(palette.Text);
        SettingsButton.Foreground = AppTheme.Brush(palette.Text);
        UpdateRailSelection();
    }

    private void HideBrowserForProjection()
    {
        _inboxProjected = false;
        Browser.Visibility = Visibility.Hidden;
        Browser.IsHitTestVisible = false;
        ProjectionStatusText.Text = "채팅 목록을 불러오는 중입니다.";
        ProjectionRetryButton.Visibility = Visibility.Collapsed;
        InboxLoadingPanel.Visibility = Visibility.Visible;
    }

    private void ShowProjectionError(string stage, string message)
    {
        // Once the list is on screen a transient script hiccup must not replace it
        // with an error panel; the next render simply corrects itself.
        if (_inboxProjected) return;

        Browser.Visibility = Visibility.Hidden;
        Browser.IsHitTestVisible = false;
        ProjectionStatusText.Text = $"채팅 목록을 불러오지 못했습니다.\n[{stage}] {message}";
        ProjectionRetryButton.Visibility = Visibility.Visible;
        InboxLoadingPanel.Visibility = Visibility.Visible;
    }

    private async void ProjectionRetryButton_Click(object sender, RoutedEventArgs e)
    {
        HideBrowserForProjection();
        await RunInboxProjectionAsync();
    }

    private void ShowProjectedInbox()
    {
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
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    public void RequestExit()
    {
        _allowClose = true;
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
        _trayIconService.Dispose();
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        Hide();
    }
}
