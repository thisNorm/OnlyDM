using System.IO;
using System.Reflection;
using System.Text;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using OnlyDM;

internal static class Program
{
    private static readonly FieldInfo ControllerField =
        typeof(AccountInboxWatcher).GetField("_controller", BindingFlags.Instance | BindingFlags.NonPublic)!;
    private static int _failures;

    [STAThread]
    private static int Main()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var root = Directory.CreateTempSubdirectory("onlydm-watcher-tests-").FullName;
        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", root, EnvironmentVariableTarget.Process);
        Console.WriteLine($"Synthetic WebView2 profile: {root}");
        app.Startup += async (_, _) =>
        {
            AccountInboxWatcher? watcher = null;
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, root,
                    new CoreWebView2EnvironmentOptions
                    {
                        // All document responses are fixtures; an unexpected request can only fail locally.
                        AdditionalBrowserArguments = "--proxy-server=http://127.0.0.1:9 --disable-background-timer-throttling --disable-backgrounding-occluded-windows",
                    });
                Require(Path.GetFullPath(environment.UserDataFolder).TrimEnd(Path.DirectorySeparatorChar) == root,
                    "WebView2 changed the synthetic profile directory.");

                using (var canceled = new AccountInboxWatcher("", (_, _) => throw new InvalidOperationException("Canceled watcher delivered an alert.")))
                {
                    canceled.Dispose();
                    await canceled.StartAsync(environment);
                    Check("stop before initialization cannot create a controller", ControllerField.GetValue(canceled) is null);
                }

                using (var canceled = new AccountInboxWatcher("", (_, _) => throw new InvalidOperationException("Canceled watcher delivered an alert.")))
                {
                    var initializing = canceled.StartAsync(environment);
                    canceled.Dispose();
                    await initializing;
                    Check("stop during controller creation closes the late controller", ControllerField.GetValue(canceled) is null);
                }

                var delivered = new TaskCompletionSource<bool>();
                var alerts = 0;
                const string script = """window.chrome.webview.postMessage({type:"thread-notification",title:"Fixture sender",preview:"fixture message"});""";
                watcher = new AccountInboxWatcher(script, (title, preview) =>
                {
                    Require(title == "Fixture sender" && preview == "fixture message", "Wrong notification payload.");
                    alerts++;
                    delivered.TrySetResult(true);
                });
                await watcher.StartAsync(environment);
                var controller = (CoreWebView2Controller?)ControllerField.GetValue(watcher)
                    ?? throw new InvalidOperationException("No fixture controller.");
                var core = controller.CoreWebView2;
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (_, args) => args.Response = environment.CreateWebResourceResponse(
                    new MemoryStream(Encoding.UTF8.GetBytes("<!doctype html><title>Offline OnlyDM fixture</title>")),
                    200, "OK", "Content-Type: text/html; charset=utf-8");
                core.Navigate(NavigationPolicy.InboxUri.AbsoluteUri);
                try { await delivered.Task.WaitAsync(TimeSpan.FromSeconds(15)); }
                catch
                {
                    Console.Error.WriteLine($"Stopped={ControllerField.GetValue(watcher) is null}; source={core.Source}");
                    throw;
                }
                Check("the sized notification controller stays hidden at quarter zoom",
                    !controller.IsVisible && controller.Bounds.Width == 390 && controller.Bounds.Height == 720 && controller.ZoomFactor == 0.25);
                Check("official inbox notification reaches the native callback", alerts >= 1);

                var before = alerts;
                await core.ExecuteScriptAsync("""window.chrome.webview.postMessage({type:"thread-notification",title:5}); window.chrome.webview.postMessage({type:"open-thread",title:"ignored"});""");
                await Dispatcher.Yield(DispatcherPriority.ApplicationIdle);
                Check("unrelated or malformed IPC is ignored", alerts == before);

                // A same-document route change exercises SourceChanged as well as top-level navigation gating.
                await core.ExecuteScriptAsync("""
history.pushState({}, '', '/accounts/login/');
window.chrome.webview.postMessage({type:"thread-notification",title:"Fixture sender",preview:"fixture message"});
""");
                await WaitFor(() => ControllerField.GetValue(watcher) is null);
                Check($"leaving the inbox stops the watcher and suppresses stale messages (before={before}, after={alerts})", alerts == before);

                Check("authentication stops are not eligible for automatic retry",
                    !watcher.CanRetry && watcher.StopReason == "authentication");
                watcher.Dispose();
                Check("repeated shutdown is safe", ControllerField.GetValue(watcher) is null);

                using (var offline = new AccountInboxWatcher("", (_, _) => throw new InvalidOperationException("Offline watcher delivered an alert.")))
                {
                    await offline.StartAsync(environment);
                    await WaitFor(() => ControllerField.GetValue(offline) is null, 15000);
                    Check("network failure releases the controller and remains eligible for retry",
                        offline.CanRetry && offline.StopReason?.StartsWith("navigation:", StringComparison.Ordinal) == true);
                    var now = Environment.TickCount64;
                    Check("recovery has a minimum delay and becomes due",
                        !offline.IsRetryDue(now) && offline.IsRetryDue(now + 30000));
                    offline.Dispose();
                    Check("explicit cancellation removes a pending retry", !offline.IsRetryDue(now + 30000));
                }

                var resumed = new TaskCompletionSource<bool>();
                using (var renderer = new AccountInboxWatcher(script, (_, _) => resumed.TrySetResult(true)))
                {
                    await renderer.StartAsync(environment);
                    var rendering = ((CoreWebView2Controller)ControllerField.GetValue(renderer)!).CoreWebView2;
                    rendering.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                    rendering.WebResourceRequested += (_, args) => args.Response = environment.CreateWebResourceResponse(
                        new MemoryStream(Encoding.UTF8.GetBytes("<!doctype html><title>Recovery fixture</title>")),
                        200, "OK", "Content-Type: text/html; charset=utf-8");
                    rendering.Navigate(NavigationPolicy.InboxUri.AbsoluteUri);
                    await resumed.Task.WaitAsync(TimeSpan.FromSeconds(15));
                    try { await rendering.CallDevToolsProtocolMethodAsync("Page.crash", "{}").WaitAsync(TimeSpan.FromSeconds(3)); }
                    catch (Exception) { /* The intentionally crashed renderer may close the CDP request. */ }
                    await WaitFor(() => ControllerField.GetValue(renderer) is null, 15000);
                    Check("renderer failure releases the controller and remains eligible for retry",
                        renderer.CanRetry && renderer.StopReason?.StartsWith("process:", StringComparison.Ordinal) == true);
                    renderer.Dispose();
                    Check("account change or shutdown cancels renderer recovery", !renderer.CanRetry);
                }
                Console.WriteLine($"Account watcher regression: {(_failures == 0 ? "PASS" : "FAIL")}");
            }
            catch (Exception error)
            {
                _failures++;
                Console.Error.WriteLine(error);
            }
            finally
            {
                watcher?.Dispose();
                app.Shutdown();
            }
        };
        app.Run();
        return _failures == 0 ? 0 : 1;
    }

    private static async Task WaitFor(Func<bool> ready, int timeoutMs = 2500)
    {
        for (var attempts = 0; attempts < timeoutMs / 25 && !ready(); attempts++) await Task.Delay(25);
        Require(ready(), "Timed out waiting for the watcher to stop.");
    }

    private static void Check(string name, bool pass)
    {
        Console.WriteLine($"{(pass ? "PASS" : "FAIL")}: {name}");
        if (!pass) _failures++;
    }

    private static void Require(bool pass, string failure)
    {
        if (!pass) throw new InvalidOperationException(failure);
    }
}

namespace OnlyDM
{
    internal static class App
    {
        internal static void Log(string stage, object detail) => Console.Error.WriteLine($"{stage}: {detail}");
    }
}
