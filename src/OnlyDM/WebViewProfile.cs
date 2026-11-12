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
            return _environmentTask ??= CreateCoreAsync(AccountStore.Current.DataDirectory);
        }
    }

    internal static Task<CoreWebView2Environment> CreateEnvironmentAsync(Guid accountId) =>
        CreateCoreAsync(AccountStore.Current.DirectoryFor(accountId));

    private static async Task<CoreWebView2Environment> CreateCoreAsync(string dataDirectory)
    {
        var userDataFolder = Path.Combine(dataDirectory, "WebView2");
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

        var environment = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userDataFolder,
            options: options);

        // A machine or process override must not attach another account's data folder.
        if (!Path.TrimEndingDirectorySeparator(Path.GetFullPath(environment.UserDataFolder))
                .Equals(userDataFolder, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("WebView2 is configured to use a different data folder.");
        }
        return environment;
    }
}
