using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace OnlyDM;

// A message-only parent keeps the inactive inbox invisible even while it initializes.
internal sealed class AccountInboxWatcher : IDisposable
{
    internal static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(15);

    private readonly Dispatcher _dispatcher = Dispatcher.CurrentDispatcher;
    private readonly string _script;
    private readonly Action<string, string?> _notify;
    private CoreWebView2Controller? _controller;
    private bool _stopped;
    private long? _retryAfter;

    public string? StopReason { get; private set; }
    public bool CanRetry => _retryAfter.HasValue;
    public bool IsRetryDue(long now) => _controller is null && _retryAfter <= now;

    public void FailInitialization() => Stop("initialization", retry: true);

    public AccountInboxWatcher(string script, Action<string, string?> notify)
    {
        _script = script;
        _notify = notify;
    }

    public async Task StartAsync(CoreWebView2Environment environment)
    {
        if (_stopped) return;
        var controller = await environment.CreateCoreWebView2ControllerAsync(new IntPtr(-3)); // HWND_MESSAGE
        if (_stopped)
        {
            CloseController(controller);
            return;
        }

        _controller = controller;
        controller.IsVisible = false;
        controller.Bounds = new Rectangle(0, 0, 390, 720);
        controller.ZoomFactor = 0.25;
        var core = controller.CoreWebView2;
        core.IsMuted = true;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDefaultScriptDialogsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.NewWindowRequested += (_, args) => args.Handled = true;
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
        ulong navigationId = 0;
        core.NavigationStarting += (_, args) =>
        {
            if (IsInbox(args.Uri))
            {
                navigationId = args.NavigationId;
                return;
            }
            args.Cancel = true;
            StopForRoute(args.Uri);
        };
        core.SourceChanged += (_, args) =>
        {
            // A failed document can show a browser error page. NavigationCompleted classifies it.
            if (!args.IsNewDocument && !IsInbox(core.Source)) StopForRoute(core.Source);
        };
        core.ProcessFailed += (_, args) => Stop($"process:{args.ProcessFailedKind}", retry: true);
        core.NavigationCompleted += async (_, args) =>
        {
            if (_stopped || args.NavigationId != navigationId) return;
            if (!args.IsSuccess)
            {
                var error = args.WebErrorStatus;
                if (args.HttpStatusCode is 401 or 407)
                {
                    Stop("authentication");
                    return;
                }

                if (error is CoreWebView2WebErrorStatus.OperationCanceled or CoreWebView2WebErrorStatus.ConnectionAborted)
                {
                    // WebView2 can report cancellation before it raises the replacement navigation.
                    await Task.Delay(250);
                    if (_stopped || args.NavigationId != navigationId) return;
                }
                Stop($"navigation:{error}", retry: true);
                return;
            }
            if (!IsInbox(core.Source))
            {
                StopForRoute(core.Source);
                return;
            }

            try { await core.ExecuteScriptAsync(_script); }
            catch (Exception ex)
            {
                if (_stopped || args.NavigationId != navigationId) return;
                App.Log("account-watcher-script", ex);
                Stop("script", retry: true);
            }
        };
        core.WebMessageReceived += async (_, args) =>
        {
            if (_stopped || !IsInbox(args.Source) || !IsInbox(core.Source)) return;
            try
            {
                using var message = JsonDocument.Parse(args.WebMessageAsJson);
                var root = message.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String
                    || type.GetString() != "thread-notification"
                    || !root.TryGetProperty("title", out var title) || title.ValueKind != JsonValueKind.String)
                    return;
                var preview = root.TryGetProperty("preview", out var text) && text.ValueKind == JsonValueKind.String
                    ? text.GetString() : null;
                var senderTitle = title.GetString()!;
                // SourceChanged can arrive after an SPA's queued message.
                var location = JsonSerializer.Deserialize<string>(await core.ExecuteScriptAsync("location.href"));
                if (!_stopped && location is not null && IsInbox(location))
                    _notify(senderTitle, preview);
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or COMException) { }
        };
        core.Navigate(NavigationPolicy.InboxUri.AbsoluteUri);
    }

    private static bool IsInbox(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && NavigationPolicy.IsInboxUri(uri);

    private void StopForRoute(string value) =>
        Stop(Uri.TryCreate(value, UriKind.Absolute, out var uri) && NavigationPolicy.IsLoginUri(uri)
            ? "authentication"
            : "outside-inbox");

    private void Stop(string reason, bool retry = false)
    {
        if (_stopped) return;
        _stopped = true;
        StopReason = reason;
        if (retry) _retryAfter = Environment.TickCount64 + (long)RetryInterval.TotalMilliseconds;
        // WebView2 must leave its callback before the controller closes.
        _dispatcher.BeginInvoke(new Action(ReleaseController));
    }

    public void Dispose()
    {
        _stopped = true;
        _retryAfter = null;
        ReleaseController();
    }

    private void ReleaseController()
    {
        var controller = _controller;
        _controller = null;
        CloseController(controller);
    }

    private static void CloseController(CoreWebView2Controller? controller)
    {
        try { controller?.Close(); }
        catch (Exception ex) when (ex is COMException or InvalidOperationException) { }
    }
}
