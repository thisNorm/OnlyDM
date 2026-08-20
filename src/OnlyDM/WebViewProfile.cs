using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace OnlyDM;

public static class WebViewProfile
{
    private static readonly object Sync = new();
    private static Task<CoreWebView2Environment>? _environmentTask;

    public static Task<CoreWebView2Environment> CreateEnvironmentAsync()
    {
        lock (Sync)
        {
            return _environmentTask ??= CreateCoreAsync();
        }
    }

    private static async Task<CoreWebView2Environment> CreateCoreAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OnlyDM",
            "WebView2");
        Directory.CreateDirectory(userDataFolder);

        // OnlyDM lives in the tray, so its pages are usually hidden or occluded. Chromium
        // throttles those to roughly one timer tick a minute, which stalled the list and
        // stopped new messages from being noticed at all.
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = string.Join(' ',
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=CalculateNativeWinOcclusion"),
        };

        return await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userDataFolder,
            options: options);
    }
}
