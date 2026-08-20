using System;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public partial class ChatWindow : Window
{
    private readonly Uri _threadUri;
    private readonly AppSettings _settings;
    private bool _ready;
    private bool _allowClose;

    // Whose conversation this is, as reported by the page itself. Without it there is
    // nothing to hang a nickname on, which is the case for group chats.
    private string _personHandle = string.Empty;

    public ChatWindow(Uri threadUri, AppSettings settings, string? threadTitle = null)
    {
        if (!NavigationPolicy.IsDirectUri(threadUri))
        {
            throw new ArgumentException("Only Instagram Direct thread URLs can be opened.", nameof(threadUri));
        }

        InitializeComponent();
        _threadUri = threadUri;
        _settings = new AppSettings { Theme = settings.Theme };
        ApplyTheme();

        if (!string.IsNullOrWhiteSpace(threadTitle)) SetThreadTitle(threadTitle);

        AliasBook.Changed += OnNicknamesChanged;
        Closed += (_, _) => AliasBook.Changed -= OnNicknamesChanged;
    }

    public string ThreadTitle { get; private set; } = string.Empty;
    public string ThreadIdentity => AliasBook.ThreadKey(_threadUri);

    private bool _chatReady;
    private string? _pendingCall;

    // Set when the friends card asked for a call. A call can only be placed once the
    // conversation is on screen, but a window that is already open never reports ready
    // again, so assigning this later has to fire it immediately.
    public string? PendingCall
    {
        get => _pendingCall;
        set
        {
            _pendingCall = value;
            if (_chatReady) StartPendingCall();
        }
    }

    public DateTime LastUsedUtc { get; private set; } = DateTime.UtcNow;

    public void MarkUsed() => LastUsedUtc = DateTime.UtcNow;

    // Closing would destroy the WebView along with whatever the user was typing, so the
    // window is only hidden. It is disposed for real when OnlyDM exits or is evicted.
    public void ForceClose()
    {
        _allowClose = true;
        Close();
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        Hide();
    }

    private void SetThreadTitle(string title)
    {
        // Match MainWindow: compose Hangul so window titles never show loose jamo.
        ThreadTitle = title.IsNormalized() ? title : title.Normalize();
        AliasBook.Link(ThreadIdentity, _personHandle);
        ShowThreadName();
    }

    // Instagram's name for the conversation is what everything is keyed by; the name on
    // screen is whatever the user decided to call this person.
    private void ShowThreadName()
    {
        var shown = AliasBook.AliasFor(_personHandle)
            ?? AliasBook.RoomAlias(AliasBook.ThreadKey(_threadUri))
            ?? AliasBook.Display(ThreadIdentity, ThreadTitle);
        if (ChatTitle.Text != shown) ChatTitle.Text = shown;
        Title = $"{shown} - OnlyDM";
        ChatTitle.ToolTip = _personHandle.Length > 0
            ? $"@{_personHandle} · 이름을 눌러 바꾸세요 (내 화면에만 적용)"
            : "이름을 눌러 바꾸세요 (내 화면에만 적용)";
        SendNames(shown);
    }

    // The page draws the same names inside the conversation: its own header and, when
    // the details panel is open, the member list. Both follow what the user chose.
    private void SendNames(string shown)
    {
        if (!_ready || ChatBrowser.CoreWebView2 is null) return;
        try
        {
            ChatBrowser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "names",
                title = ThreadTitle,
                shown,
                people = AliasBook.ByHandle(),
            }));
        }
        catch (Exception ex)
        {
            App.Log("chat-names", ex);
        }
    }

    private void OnNicknamesChanged()
    {
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (ChatTitle.IsKeyboardFocusWithin) return;
            ShowThreadName();
        }));
    }

    private void ChatTitle_MouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
    {
        ChatTitle.IsReadOnly = false;
        ChatTitle.Background = AppTheme.Brush(AppTheme.GetPalette(_settings.Theme).SurfaceAlt);
    }

    private void ChatTitle_MouseLeave(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (ChatTitle.IsKeyboardFocusWithin) return;
        ChatTitle.IsReadOnly = true;
        ChatTitle.Background = System.Windows.Media.Brushes.Transparent;
    }

    private void ChatTitle_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Enter)
        {
            e.Handled = true;
            CommitThreadName();
            System.Windows.Input.Keyboard.ClearFocus();
            ChatBrowser.Focus();
            return;
        }

        if (e.Key == System.Windows.Input.Key.Escape)
        {
            e.Handled = true;
            ShowThreadName();
            System.Windows.Input.Keyboard.ClearFocus();
            ChatBrowser.Focus();
        }
    }

    private void ChatTitle_LostFocus(object sender, RoutedEventArgs e)
    {
        CommitThreadName();
        ChatTitle.IsReadOnly = true;
        ChatTitle.Background = System.Windows.Media.Brushes.Transparent;
    }

    // Typing the original name back, or clearing the box, drops the local name. A
    // one-to-one conversation renames the person, so the friends list follows; a group
    // renames only itself.
    private void CommitThreadName()
    {
        var typed = ChatTitle.Text.Trim();
        var next = typed == ThreadTitle ? string.Empty : typed;
        if (_personHandle.Length > 0) AliasBook.Set(_personHandle, next);
        else AliasBook.SetRoom(AliasBook.ThreadKey(_threadUri), next);
        ShowThreadName();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        MainWindow.RoundCorners(this);
        if (_ready) return;

        try
        {
            var environment = await WebViewProfile.CreateEnvironmentAsync();
            await ChatBrowser.EnsureCoreWebView2Async(environment);
            ConfigureWebView();
            _ready = true;
            HideBrowserForProjection();
            ChatBrowser.CoreWebView2.Navigate(_threadUri.AbsoluteUri);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"채팅창을 열지 못했습니다.\n\n{ex.Message}", "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            ForceClose();
        }
    }

    private async void Core_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            ShowProjectionError("navigation", $"Instagram navigation failed: {e.WebErrorStatus}");
            return;
        }

        await RunChatProjectionAsync();
    }

    private async System.Threading.Tasks.Task RunChatProjectionAsync()
    {
        if (!_ready || ChatBrowser.CoreWebView2 is null) return;

        try
        {
            ChatProjectionStatusText.Text = "채팅방을 불러오는 중입니다.";
            var palette = AppTheme.GetPalette(_settings.Theme);
            await ChatBrowser.CoreWebView2.ExecuteScriptAsync(WebViewScripts.BuildChatScript(palette));
        }
        catch (Exception ex)
        {
            ShowProjectionError("execute", ex.Message);
        }
    }

    public void ApplySettings(AppSettings settings)
    {
        _settings.Theme = settings.Theme;
        ApplyTheme();
        if (!_ready || ChatBrowser.CoreWebView2 is null) return;

        // Repaint in place: reloading would drop the reader's place in the conversation.
        ChatBrowser.CoreWebView2.PostWebMessageAsJson(
            WebViewScripts.BuildChatThemeMessage(AppTheme.GetPalette(_settings.Theme)));
    }

    // Esc is also handled inside the projection: the WebView swallows keys while it
    // holds focus, so this only covers the WPF header.
    private void Window_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != System.Windows.Input.Key.Escape) return;
        e.Handled = true;
        Hide();
    }

    private void StartPendingCall()
    {
        var mode = _pendingCall;
        _pendingCall = null;
        if (string.IsNullOrWhiteSpace(mode) || ChatBrowser.CoreWebView2 is null) return;

        ChatBrowser.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(new { type = "start-call", mode }));
    }

    private void ChatMinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    // Hides rather than closes so an unsent draft survives, same as Esc.
    private void ChatCloseButton_Click(object sender, RoutedEventArgs e) => Hide();

    private void ConfigureWebView()
    {
        var core = ChatBrowser.CoreWebView2;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.Settings.IsStatusBarEnabled = false;
        UseBrowserUserAgent(core);
        core.NavigationStarting += Core_NavigationStarting;
        core.NavigationCompleted += Core_NavigationCompleted;
        // A call is a real Instagram page (/call/?...), not an overlay, so it always
        // wants its own window. Hosting it ourselves keeps it an OnlyDM window instead
        // of a bare browser popup; everything that is not Instagram stays blocked.
        core.NewWindowRequested += OnNewWindowRequested;
        // A call is the most likely thing to take the renderer down with it; reloading
        // the conversation is cheaper than losing the window.
        core.ProcessFailed += (_, args) =>
        {
            App.Log("chat-process-failed", args.ProcessFailedKind);
            if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
            {
                try { ChatBrowser.Reload(); } catch (Exception ex) { App.Log("chat-reload", ex); }
            }
        };

        // A call needs the microphone (and the camera for video). Only Instagram is
        // granted, and only from a conversation window.
        core.PermissionRequested += (_, args) =>
        {
            var media = args.PermissionKind is CoreWebView2PermissionKind.Microphone
                or CoreWebView2PermissionKind.Camera;
            args.State = media && IsInstagramCallUri(args.Uri)
                ? CoreWebView2PermissionState.Allow
                : CoreWebView2PermissionState.Deny;
        };
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.DocumentTitleChanged += Core_DocumentTitleChanged;
        core.WebMessageReceived += Core_WebMessageReceived;
    }

    // WebView2 advertises an Edg/ token, and Instagram treats that context differently:
    // it opens calls in a popup window instead of the in-conversation overlay. Dropping
    // just that token keeps the same Chromium version while looking like plain Chrome.
    private static void UseBrowserUserAgent(CoreWebView2 core)
    {
        try
        {
            var agent = core.Settings.UserAgent;
            if (string.IsNullOrWhiteSpace(agent)) return;

            var cleaned = System.Text.RegularExpressions.Regex
                .Replace(agent, @"\s*Edg/[\d.]+", string.Empty)
                .Trim();

            if (cleaned.Length > 0 && cleaned != agent) core.Settings.UserAgent = cleaned;
        }
        catch (NotSupportedException)
        {
            // Older WebView2 runtimes cannot change the agent; calls still work as popups.
        }
    }

    private async void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        if (!IsInstagramCallUri(args.Uri))
        {
            args.Handled = true;
            return;
        }

        var deferral = args.GetDeferral();
        try
        {
            // A voice call has no picture worth a large window, so it is shown as a
            // compact panel floating over the conversation instead.
            var voiceOnly = args.Uri.Contains("has_video=false", StringComparison.OrdinalIgnoreCase);

            var view = new Microsoft.Web.WebView2.Wpf.WebView2();
            var host = new Window
            {
                Title = "OnlyDM 통화",
                // Measured: the call layout needs ~1010 CSS px before anything is cut off.
                Width = voiceOnly ? 1040 : 1040,
                Height = voiceOnly ? 660 : 660,
                MinWidth = 1020,
                MinHeight = 560,
                WindowStyle = WindowStyle.None,
                Topmost = voiceOnly,
                Owner = this,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Background = System.Windows.Media.Brushes.Black,
            };

            // The window is frameless, so it needs its own way out: a title strip with
            // a close button, since Esc alone is not discoverable.
            var layout = new System.Windows.Controls.Grid();
            layout.RowDefinitions.Add(new System.Windows.Controls.RowDefinition { Height = new GridLength(36) });
            layout.RowDefinitions.Add(new System.Windows.Controls.RowDefinition());

            var header = new System.Windows.Controls.Grid
            {
                Background = new System.Windows.Media.SolidColorBrush(
                    System.Windows.Media.Color.FromRgb(0x1A, 0x1A, 0x1A)),
            };
            var caption = new System.Windows.Controls.TextBlock
            {
                Text = "통화",
                Foreground = System.Windows.Media.Brushes.White,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = System.Windows.VerticalAlignment.Center,
                Margin = new Thickness(14, 0, 0, 0),
            };
            var close = new System.Windows.Controls.Button
            {
                Content = "",
                FontFamily = new System.Windows.Media.FontFamily("Segoe MDL2 Assets"),
                FontSize = 10,
                Width = 40,
                Height = 36,
                Foreground = System.Windows.Media.Brushes.White,
                Background = System.Windows.Media.Brushes.Transparent,
                BorderThickness = new Thickness(0),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
            };
            close.Click += (_, _) => host.Close();
            System.Windows.Shell.WindowChrome.SetIsHitTestVisibleInChrome(close, true);
            header.Children.Add(caption);
            header.Children.Add(close);

            System.Windows.Controls.Grid.SetRow(header, 0);
            System.Windows.Controls.Grid.SetRow(view, 1);
            layout.Children.Add(header);
            layout.Children.Add(view);
            host.Content = layout;

            {
                System.Windows.Shell.WindowChrome.SetWindowChrome(host, new System.Windows.Shell.WindowChrome
                {
                    CaptionHeight = 36,
                    ResizeBorderThickness = new Thickness(4),
                    GlassFrameThickness = new Thickness(0),
                    CornerRadius = new CornerRadius(0),
                    UseAeroCaptionButtons = false,
                });
            }

            host.PreviewKeyDown += (_, key) =>
            {
                if (key.Key != System.Windows.Input.Key.Escape) return;
                key.Handled = true;
                host.Close();
            };
            host.Closed += (_, _) => view.Dispose();
            host.Show();

            var environment = await WebViewProfile.CreateEnvironmentAsync();
            await view.EnsureCoreWebView2Async(environment);

            var child = view.CoreWebView2;
            child.Settings.IsStatusBarEnabled = false;
            // A call window whose renderer dies is a black rectangle; close it instead.
            child.ProcessFailed += (_, failure) =>
            {
                App.Log("call-process-failed", failure.ProcessFailedKind);
                try { host.Close(); } catch (Exception ex) { App.Log("call-close", ex); }
            };

            // Zoom is not reliable here: a popup WebView resets it when the opener
            // attaches its content, which left the layout cut off. The window is simply
            // sized to what the fixed layout needs instead.
            UseBrowserUserAgent(child);
            child.PermissionRequested += (_, permission) =>
            {
                var media = permission.PermissionKind is CoreWebView2PermissionKind.Microphone
                    or CoreWebView2PermissionKind.Camera;
                permission.State = media && IsInstagramCallUri(permission.Uri)
                    ? CoreWebView2PermissionState.Allow
                    : CoreWebView2PermissionState.Deny;
            };
            child.WindowCloseRequested += (_, _) => host.Close();

            child.NavigationStarting += (_, nav) =>
            {
                if (!IsInstagramCallUri(nav.Uri))
                {
                    nav.Cancel = true;
                    host.Dispatcher.BeginInvoke(new Action(host.Close));
                }
            };
            child.WebMessageReceived += (_, message) =>
            {
                if (message.WebMessageAsJson.Contains("call-ended"))
                {
                    host.Dispatcher.BeginInvoke(new Action(host.Close));
                }
            };
            await child.AddScriptToExecuteOnDocumentCreatedAsync(CallWatcherScript);
            child.NewWindowRequested += (_, nested) => nested.Handled = true;
            child.DownloadStarting += (_, download) => download.Cancel = true;

            args.NewWindow = child;
            args.Handled = true;
        }
        catch (Exception)
        {
            args.Handled = true;
        }
        finally
        {
            deferral.Complete();
        }
    }

    // Watches the call surface: once its controls are gone for a moment the call is
    // finished (or was cancelled) and the window should not linger as a black frame.
    private const string CallWatcherScript = """
(() => {
  let emptyFor = 0;
  setInterval(() => {
    const text = document.body ? document.body.innerText.trim() : '';
    // Cancelling leaves a short "취소되었습니다" notice behind instead of closing.
    const finished = /취소|종료되었|연결이 끊|통화가 끝|call ended|cancell?ed/i.test(text);
    const alive = !finished
      && (document.querySelector('svg[aria-label]') || document.querySelector('video') || text.length > 0);
    emptyFor = alive ? 0 : emptyFor + 1;
    if (emptyFor >= 3) {
      try { window.chrome?.webview?.postMessage({ type: 'call-ended' }); } catch (_) { }
      emptyFor = -1000;
    }
  }, 700);
})();
""";

    private static bool IsInstagramCallUri(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && (uri.Host.Equals("instagram.com", StringComparison.OrdinalIgnoreCase)
                || uri.Host.Equals("www.instagram.com", StringComparison.OrdinalIgnoreCase))
            && uri.AbsolutePath.Contains("/call/", StringComparison.OrdinalIgnoreCase);
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && NavigationPolicy.IsAllowedTopLevelUri(uri))
        {
            return;
        }
        e.Cancel = true;
    }

    private void Core_DocumentTitleChanged(object? sender, object e)
    {
        if (!string.IsNullOrWhiteSpace(ThreadTitle)) return;

        var title = ChatBrowser.CoreWebView2.DocumentTitle;
        if (!string.IsNullOrWhiteSpace(title) && !title.Contains("Instagram", StringComparison.OrdinalIgnoreCase))
        {
            SetThreadTitle(title);
        }
    }

    private void Core_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var json = JsonDocument.Parse(e.WebMessageAsJson);
            if (!json.RootElement.TryGetProperty("type", out var type)) return;

            var messageType = type.GetString();
            if (messageType == "chat-ready")
            {
                _chatReady = true;
                ShowProjectedChat();
                StartPendingCall();
                return;
            }

            if (messageType == "close-window")
            {
                Dispatcher.BeginInvoke(new Action(Hide));
                return;
            }

            if (messageType == "projection-error")
            {
                var stage = json.RootElement.TryGetProperty("stage", out var stageElement) ? stageElement.GetString() : "script";
                var detail = json.RootElement.TryGetProperty("message", out var messageElement) ? messageElement.GetString() : "Unknown projection error";
                ShowProjectionError(stage ?? "script", detail ?? "Unknown projection error");
                return;
            }

            if (messageType == "thread-person"
                && json.RootElement.TryGetProperty("handle", out var handleElement))
            {
                var handle = handleElement.GetString() ?? string.Empty;
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    _personHandle = handle;
                    AliasBook.Link(ThreadIdentity, handle);
                    ShowThreadName();
                }));
                return;
            }

            if (messageType == "thread-title"
                && json.RootElement.TryGetProperty("title", out var titleElement))
            {
                var title = titleElement.GetString();
                if (!string.IsNullOrWhiteSpace(ThreadTitle) || string.IsNullOrWhiteSpace(title)) return;
                SetThreadTitle(title);
            }
        }
        catch (JsonException)
        {
            // Presentation messages are best-effort and never affect Instagram messaging.
        }
    }

    private void HideBrowserForProjection()
    {
        ChatBrowser.Visibility = Visibility.Hidden;
        ChatBrowser.IsHitTestVisible = false;
        ChatProjectionStatusText.Text = "채팅방을 불러오는 중입니다.";
        ChatLoadingPanel.Visibility = Visibility.Visible;
    }

    private void ShowProjectionError(string stage, string message)
    {
        ChatBrowser.Visibility = Visibility.Hidden;
        ChatBrowser.IsHitTestVisible = false;
        ChatProjectionStatusText.Text = $"채팅방을 불러오지 못했습니다.\n[{stage}] {message}";
        ChatLoadingPanel.Visibility = Visibility.Visible;
    }

    private void ShowProjectedChat()
    {
        ChatBrowser.Visibility = Visibility.Visible;
        ChatBrowser.IsHitTestVisible = true;
        ChatLoadingPanel.Visibility = Visibility.Collapsed;
    }

    private void ApplyTheme()
    {
        var palette = AppTheme.GetPalette(_settings.Theme);
        RootGrid.Background = AppTheme.Brush(palette.ChatBackground);
        HeaderBorder.Background = AppTheme.Brush(palette.Surface);
        HeaderBorder.BorderBrush = AppTheme.Brush(palette.Border);
        ChatTitle.Foreground = AppTheme.Brush(palette.Text);
        // The name doubles as an edit box, and the default caret is black: invisible on
        // any dark theme.
        ChatTitle.CaretBrush = AppTheme.Brush(palette.Text);
        ChatTitle.SelectionBrush = AppTheme.Brush(palette.Accent);
        ChatSubtitle.Foreground = AppTheme.Brush(palette.MutedText);
        ThemeBadgeText.Foreground = AppTheme.Brush(palette.AccentText);
        ThemeBadgeBorder.Background = AppTheme.Brush(palette.Accent);
    }
}
