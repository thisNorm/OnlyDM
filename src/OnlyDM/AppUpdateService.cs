using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace OnlyDM;

internal sealed record AppUpdateRelease(Version Version, string Tag);

internal sealed class AppUpdateService
{
    private const string RepositoryUrl = "https://github.com/thisNorm/OnlyDM";
    private const int MaxReleaseLength = 1_048_576;
    private static readonly HttpClient ReleaseClient = CreateReleaseClient();
    private readonly Func<ProcessStartInfo, Process?> startHelper;

    internal AppUpdateService() : this(Process.Start) { }
    internal AppUpdateService(Func<ProcessStartInfo, Process?> startHelper) => this.startHelper = startHelper;

    internal static Version CurrentVersion { get; } = GetCurrentVersion();

    public async Task<AppUpdateRelease?> CheckAsync(CancellationToken cancellationToken = default)
    {
        var runtime = GetRuntime();
        if (!OperatingSystem.IsWindows() || runtime is null)
            return null;

        try
        {
            var json = await ReleaseClient.GetStringAsync(
                "https://api.github.com/repos/thisNorm/OnlyDM/releases/latest", cancellationToken).ConfigureAwait(false);
            return ParseRelease(json, CurrentVersion, runtime);
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException or IOException)
        {
            return null;
        }
    }

    public async Task StartAsync(AppUpdateRelease release)
    {
        ArgumentNullException.ThrowIfNull(release);
        if (!TryParseTag(release.Tag, out var version) || release.Version != version || version <= CurrentVersion)
            throw new ArgumentException("The update must be a newer stable OnlyDM release with a matching tag and version.", nameof(release));
        if (!OperatingSystem.IsWindows() || GetRuntime() is null)
            throw new PlatformNotSupportedException("One-click updates require Windows x64 or ARM64.");

        var originalExecutable = Environment.ProcessPath;
        if (string.IsNullOrEmpty(originalExecutable) || !File.Exists(originalExecutable))
            throw new FileNotFoundException("The running OnlyDM executable could not be located.");
        var installDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "OnlyDM");
        var installer = Path.Combine(AppContext.BaseDirectory, "install.ps1");
        if (!File.Exists(installer))
            installer = Path.Combine(installDirectory, "install.ps1");
        if (!File.Exists(installer))
            throw new FileNotFoundException("OnlyDM's bundled install.ps1 is missing. Reinstall OnlyDM to enable updates.", installer);

        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell))
            throw new FileNotFoundException("Windows PowerShell could not be located.", powershell);

        var stagingDirectory = Path.Combine(Path.GetTempPath(), $"OnlyDM-update-{Guid.NewGuid():N}");
        using (var identity = WindowsIdentity.GetCurrent())
        {
            var user = identity.User ?? throw new InvalidOperationException("The current Windows user could not be identified.");
            var permissions = new DirectorySecurity();
            permissions.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            permissions.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(stagingDirectory).Create(permissions);
        }
        Process? process = null;
        try
        {
            var copiedInstaller = Path.Combine(stagingDirectory, "install.ps1");
            File.Copy(installer, copiedInstaller);
            var helper = Path.Combine(stagingDirectory, "Update-OnlyDM.ps1");
            using (var resource = typeof(AppUpdateService).Assembly.GetManifestResourceStream("OnlyDM.UpdateInstaller.ps1")
                ?? throw new InvalidOperationException("The OnlyDM update helper is missing from this build."))
            using (var output = new FileStream(helper, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                resource.CopyTo(output);

            using var parent = Process.GetCurrentProcess();
            var start = new ProcessStartInfo(powershell)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = stagingDirectory
            };
            foreach (var argument in new[]
            {
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", helper,
                "-ParentProcessId", parent.Id.ToString(CultureInfo.InvariantCulture),
                "-ParentStartTimeUtcTicks", parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
                "-ReleaseTag", release.Tag, "-InstallerPath", copiedInstaller,
                "-FallbackExecutablePath", originalExecutable
            })
                start.ArgumentList.Add(argument);

            process = startHelper(start)
                ?? throw new InvalidOperationException("Windows did not start the OnlyDM update helper.");
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(5))
            {
                if (process.HasExited)
                    throw new InvalidOperationException($"The update helper exited before readiness (exit code {process.ExitCode}). Windows policy or security software may have blocked it.");
                if (File.Exists(Path.Combine(stagingDirectory, "ready")))
                {
                    if (process.HasExited)
                        throw new InvalidOperationException("The update helper exited while signaling readiness.");
                    // The caller owns graceful shutdown, only after the helper is ready.
                    return;
                }
                await Task.Delay(50).ConfigureAwait(false);
            }
            throw new TimeoutException("The OnlyDM update helper did not become ready within five seconds.");
        }
        catch (Exception exception)
        {
            var stopError = "";
            try { File.WriteAllText(Path.Combine(stagingDirectory, "cancelled"), "cancelled"); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            if (process is not null)
            {
                try
                {
                    // This is our helper, still before installation while the caller lives.
                    if (!process.HasExited)
                    {
                        process.Kill(entireProcessTree: false);
                        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
                    }
                }
                catch (Exception error) when (error is Win32Exception or InvalidOperationException or TimeoutException)
                {
                    stopError = $" The helper could not be stopped: {error.Message}";
                }
            }
            var log = Path.Combine(stagingDirectory, "update.log");
            var message = $"{exception.Message}{stopError} OnlyDM has been left running. Diagnostic log: {log}";
            try { File.AppendAllText(log, $"{DateTime.UtcNow:O} {message}{Environment.NewLine}"); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            throw new InvalidOperationException(message, exception);
        }
        finally { process?.Dispose(); }
    }

    internal static AppUpdateRelease? ParseRelease(string json, Version currentVersion, string runtime)
    {
        if (runtime is not ("win-x64" or "win-arm64") || string.IsNullOrEmpty(json) || json.Length > MaxReleaseLength)
            return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !HasUniqueProperties(root)
                || !root.TryGetProperty("tag_name", out var tagElement) || tagElement.ValueKind != JsonValueKind.String
                || !TryParseTag(tagElement.GetString(), out var version) || version <= Normalize(currentVersion)
                || !root.TryGetProperty("draft", out var draft) || draft.ValueKind != JsonValueKind.False
                || !root.TryGetProperty("prerelease", out var prerelease) || prerelease.ValueKind != JsonValueKind.False
                || !root.TryGetProperty("published_at", out var published) || published.ValueKind != JsonValueKind.String
                || !published.TryGetDateTimeOffset(out var publishedAt) || publishedAt > DateTimeOffset.UtcNow)
                return null;

            var tag = tagElement.GetString()!;
            if (!root.TryGetProperty("html_url", out var html) || html.ValueKind != JsonValueKind.String
                || html.GetString() != $"{RepositoryUrl}/releases/tag/{tag}"
                || !root.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array)
                return null;

            var archiveName = $"OnlyDM-{runtime}.zip";
            var checksumName = $"{archiveName}.sha256";
            var archiveCount = 0;
            var checksumCount = 0;
            foreach (var asset in assets.EnumerateArray())
            {
                if (asset.ValueKind != JsonValueKind.Object || !HasUniqueProperties(asset)
                    || !asset.TryGetProperty("name", out var nameElement) || nameElement.ValueKind != JsonValueKind.String)
                    return null;
                var name = nameElement.GetString()!;
                var isArchive = name.Equals(archiveName, StringComparison.OrdinalIgnoreCase);
                var isChecksum = name.Equals(checksumName, StringComparison.OrdinalIgnoreCase);
                if (!isArchive && !isChecksum)
                    continue;
                // PowerShell's installer matches names without case sensitivity.
                if (name != (isArchive ? archiveName : checksumName)
                    || !asset.TryGetProperty("state", out var state) || state.ValueKind != JsonValueKind.String
                    || state.GetString() != "uploaded"
                    || (asset.TryGetProperty("size", out var size)
                        && (size.ValueKind != JsonValueKind.Number || !size.TryGetInt64(out var bytes) || bytes <= 0))
                    || !asset.TryGetProperty("browser_download_url", out var url) || url.ValueKind != JsonValueKind.String
                    || url.GetString() != $"{RepositoryUrl}/releases/download/{tag}/{name}")
                    return null;
                if (isArchive) archiveCount++;
                else checksumCount++;
            }
            return archiveCount == 1 && checksumCount == 1 ? new AppUpdateRelease(version, tag) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool HasUniqueProperties(JsonElement element)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return element.EnumerateObject().All(property => names.Add(property.Name));
    }

    private static bool TryParseTag(string? tag, out Version version)
    {
        version = new Version(0, 0, 0);
        if (tag is null || tag.Length is < 6 or > 40 || tag[0] != 'v'
            || !Version.TryParse(tag[1..], out var parsed) || parsed.Build < 0 || parsed.Revision >= 0
            || tag != $"v{parsed.ToString(3)}")
            return false;
        version = parsed;
        return true;
    }

    private static Version Normalize(Version version) => new(version.Major, version.Minor, Math.Max(0, version.Build));

    private static Version GetCurrentVersion()
    {
        try
        {
            if (Environment.ProcessPath is { } path)
            {
                var info = FileVersionInfo.GetVersionInfo(path);
                if (!string.IsNullOrEmpty(info.FileVersion))
                    return new Version(Math.Max(0, info.FileMajorPart), Math.Max(0, info.FileMinorPart), Math.Max(0, info.FileBuildPart));
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or Win32Exception or ArgumentException) { }
        return Normalize(Assembly.GetEntryAssembly()?.GetName().Version ?? new Version(0, 0, 0));
    }

    private static string? GetRuntime() => RuntimeInformation.OSArchitecture switch
    {
        Architecture.X64 => "win-x64",
        Architecture.Arm64 => "win-arm64",
        _ => null
    };

    private static HttpClient CreateReleaseClient()
    {
        var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        {
            Timeout = TimeSpan.FromSeconds(12),
            MaxResponseContentBufferSize = MaxReleaseLength
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("OnlyDM-AppUpdate/1.0");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }
}
