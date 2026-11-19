using System.Text.RegularExpressions;
using OnlyDM;

if (args.Length != 1 || string.IsNullOrWhiteSpace(args[0]))
{
    Console.Error.WriteLine("Usage: dotnet run --project projection-export/Export.csproj -- <output directory>");
    return 1;
}

var scripts = new List<(string Name, string Code)>();
foreach (var (theme, palette) in new[] { ("light", AppThemePalette.Light), ("dark", AppThemePalette.Dark) })
{
    scripts.Add(($"inbox-ko-{theme}.js", WebViewScripts.BuildInboxScript(palette, AppLanguage.Korean, WebViewScripts.InboxZoomFactor)));
    scripts.Add(($"inbox-en-{theme}.js", WebViewScripts.BuildInboxScript(palette, AppLanguage.English, WebViewScripts.InboxZoomFactor)));
    scripts.Add(($"chat-{theme}.js", WebViewScripts.BuildChatScript(palette, forwardExternalLinks: true)));
}

scripts.Add(("notify.js", WebViewScripts.BuildInboxScript(AppThemePalette.Light, AppLanguage.Korean, WebViewScripts.InboxZoomFactor, notificationsOnly: true)));

for (var i = 0; i < scripts.Count; i++)
{
    var (name, code) = scripts[i];
    var adapted = Regex.Replace(code, @"(?<![\w$.])window\.chrome\?\.webview(?![\w$])", "__onlydmBridge");

    // Alternate spellings or aliases of the Windows bridge require review.
    if (Regex.IsMatch(adapted, @"\b(?:chrome|webview)\b"))
    {
        Console.Error.WriteLine($"{name}: unexpected Windows WebView bridge in projection script.");
        return 1;
    }

    scripts[i] = (name, adapted);
}

var outputDirectory = Directory.CreateDirectory(args[0]).FullName;
foreach (var (name, code) in scripts)
    File.WriteAllText(Path.Combine(outputDirectory, name), code);

return 0;
