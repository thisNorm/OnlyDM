using System.Diagnostics;
using System.ComponentModel;
using System.Text.Json.Nodes;
using OnlyDM;

// Only a disposable process is used as the updater's parent in the helper fixture.
if (args is ["--dummy-parent", var stopFile])
{
    var deadline = Stopwatch.StartNew();
    while (!File.Exists(stopFile) && deadline.Elapsed < TimeSpan.FromSeconds(55))
        Thread.Sleep(25);
    return 0;
}

var failures = 0;
var checks = 0;
void Check(string name, Action test)
{
    checks++;
    try
    {
        test();
        Console.WriteLine($"PASS: {name}");
    }
    catch (Exception exception)
    {
        failures++;
        Console.Error.WriteLine($"FAIL: {name}: {exception.Message}");
    }
}

void Require(bool value, string message = "unexpected result")
{
    if (!value)
        throw new InvalidOperationException(message);
}

JsonObject Release(string tag = "v1.2.4", params string[] runtimes)
{
    var assets = new JsonArray();
    foreach (var runtime in runtimes.Length == 0 ? ["win-x64"] : runtimes)
        foreach (var name in new[] { $"OnlyDM-{runtime}.zip", $"OnlyDM-{runtime}.zip.sha256" })
            assets.Add(new JsonObject
            {
                ["name"] = name,
                ["state"] = "uploaded",
                ["size"] = 123,
                ["browser_download_url"] = $"https://github.com/thisNorm/OnlyDM/releases/download/{tag}/{name}"
            });
    return new JsonObject
    {
        ["tag_name"] = tag,
        ["draft"] = false,
        ["prerelease"] = false,
        ["published_at"] = "2024-04-05T12:00:00Z",
        ["html_url"] = $"https://github.com/thisNorm/OnlyDM/releases/tag/{tag}",
        ["assets"] = assets
    };
}

AppUpdateRelease? Parse(JsonObject release, string runtime = "win-x64", Version? current = null) =>
    AppUpdateService.ParseRelease(release.ToJsonString(), current ?? new Version(1, 2, 3), runtime);

void Reject(string name, Action<JsonObject> mutate)
{
    Check(name, () =>
    {
        var release = Release();
        mutate(release);
        Require(Parse(release) is null, "unsafe release was offered");
    });
}

Check("new stable release returns normalized version and pinned tag", () =>
    Require(Parse(Release()) == new AppUpdateRelease(new Version(1, 2, 4), "v1.2.4")));
Check("current executable version wins over entry assembly and drops revision", () =>
    Require(AppUpdateService.CurrentVersion == new Version(7, 5, 3), $"actual={AppUpdateService.CurrentVersion}"));
foreach (var tag in new[] { "v1.2.3", "v1.2.2", "v0.99.99" })
    Check($"does not offer current/older {tag}", () => Require(Parse(Release(tag)) is null));
Check("installed four-part version is compared as three parts", () =>
{
    Require(Parse(Release("v1.2.3"), current: new Version(1, 2, 3, 99)) is null);
    Require(Parse(Release(), current: new Version(1, 2, 3, 99)) is not null);
});
Check("two-part installed version defaults missing patch to zero", () =>
    Require(Parse(Release("v1.2.1"), current: new Version(1, 2)) is not null));
foreach (var runtime in new[] { "win-x64", "win-arm64" })
{
    Check($"valid {runtime} pair", () => Require(Parse(Release("v1.2.4", runtime), runtime) is not null));
    Check($"selects {runtime} from both architecture pairs", () =>
        Require(Parse(Release("v1.2.4", "win-x64", "win-arm64"), runtime) is not null));
}
Check("other architecture alone is unavailable", () => Require(Parse(Release("v1.2.4", "win-arm64")) is null));
foreach (var runtime in new[] { "", "WIN-X64", "win-x86", "linux-x64", "../win-x64" })
    Check($"unsupported runtime '{runtime}' fails closed", () => Require(Parse(Release(), runtime) is null));
foreach (var tag in new[]
{
    "1.2.4", "V1.2.4", "v1.2", "v1.2.4.0", "v1.2.4-beta.1", "v1.2.4+build", "v01.2.4",
    "v1.02.4", "v1.2.04", "v-1.2.4", "v2147483648.2.4", "v1.2.4\n", " v1.2.4", "v1.2.4;whoami"
})
    Check($"noncanonical/unstable tag '{tag.Replace("\n", "\\n")}' rejected", () => Require(Parse(Release(tag)) is null));
foreach (var field in new[] { "draft", "prerelease" })
{
    Reject($"{field} rejected", release => release[field] = true);
    Reject($"missing {field} rejected", release => release.Remove(field));
    Reject($"string {field} rejected", release => release[field] = "false");
    Reject($"null {field} rejected", release => release[field] = null);
}
foreach (var field in new[] { "published_at", "tag_name", "html_url", "assets" })
{
    Reject($"missing {field} rejected", release => release.Remove(field));
    Reject($"null {field} rejected", release => release[field] = null);
    Reject($"wrong type {field} rejected", release => release[field] = 1);
}
foreach (var date in new[] { "", "not a date", "04/05/2024", "2999-01-01T00:00:00Z" })
    Reject($"unpublished/invalid date '{date}' rejected", release => release["published_at"] = date);
foreach (var url in new[]
{
    "http://github.com/thisNorm/OnlyDM/releases/tag/v1.2.4",
    "https://github.com.evil.test/thisNorm/OnlyDM/releases/tag/v1.2.4",
    "https://github.com/other/OnlyDM/releases/tag/v1.2.4",
    "https://github.com/thisNorm/OnlyDM/releases/tag/v1.2.5",
    "https://github.com/thisNorm/OnlyDM/releases/tag/v1.2.4?download=1",
    "https://github.com/thisNorm/OnlyDM/releases/tag/v1.2.4#tag",
    "https://user@github.com/thisNorm/OnlyDM/releases/tag/v1.2.4",
    "https://github.com:443/thisNorm/OnlyDM/releases/tag/v1.2.4",
    "https://github.com/thisNorm/OnlyDM/releases/tag/%761.2.4"
})
    Reject($"wrong HTML URL '{url}' rejected", release => release["html_url"] = url);
Reject("empty assets rejected", release => release["assets"] = new JsonArray());
Reject("missing archive rejected", release => release["assets"]!.AsArray().RemoveAt(0));
Reject("missing checksum rejected", release => release["assets"]!.AsArray().RemoveAt(1));
Reject("non-object asset rejected", release => release["assets"]!.AsArray().Add(1));
foreach (var index in new[] { 0, 1 })
{
    Reject($"duplicate asset {index} rejected", release => release["assets"]!.AsArray().Add(release["assets"]![index]!.DeepClone()));
    Reject($"case-variant duplicate {index} rejected", release =>
    {
        var duplicate = release["assets"]![index]!.DeepClone();
        duplicate["name"] = duplicate["name"]!.GetValue<string>().ToUpperInvariant();
        release["assets"]!.AsArray().Add(duplicate);
    });
    Reject($"wrong case asset {index} rejected", release =>
        release["assets"]![index]!["name"] = release["assets"]![index]!["name"]!.GetValue<string>().ToUpperInvariant());
    foreach (var transform in new Func<string, string>[]
    {
        url => url.Replace("https:", "http:"), url => url.Replace("github.com", "evil.test"),
        url => url.Replace("thisNorm/OnlyDM", "attacker/OnlyDM"), url => url.Replace("v1.2.4/", "v1.2.5/"),
        url => url + "?token=abc", url => url + "#fragment", url => url.Replace("github.com/", "user@github.com/"),
        url => url.Replace("github.com/", "github.com:443/"), url => url.Replace("download/", "download/../download/")
    })
        Reject($"malformed download URL {index}/{transform.Method.Name} rejected", release =>
            release["assets"]![index]!["browser_download_url"] = transform(release["assets"]![index]!["browser_download_url"]!.GetValue<string>()));
    Reject($"missing download URL {index} rejected", release => release["assets"]![index]!.AsObject().Remove("browser_download_url"));
    foreach (var state in new[] { "new", "open", "uploading", "UPLOADED", "" })
        Reject($"incomplete asset {index} state '{state}' rejected", release => release["assets"]![index]!["state"] = state);
    Reject($"missing upload state {index} rejected", release => release["assets"]![index]!.AsObject().Remove("state"));
    Reject($"null upload state {index} rejected", release => release["assets"]![index]!["state"] = null);
    Reject($"wrong upload state type {index} rejected", release => release["assets"]![index]!["state"] = true);
    Reject($"zero-size asset {index} rejected", release => release["assets"]![index]!["size"] = 0);
    Reject($"negative-size asset {index} rejected", release => release["assets"]![index]!["size"] = -1);
    Reject($"wrong size type {index} rejected", release => release["assets"]![index]!["size"] = "123");
    Check($"uploaded asset {index} without optional size accepted", () =>
    {
        var release = Release();
        release["assets"]![index]!.AsObject().Remove("size");
        Require(Parse(release) is not null);
    });
}
foreach (var json in new[] { "", "null", "[]", "1", "\"release\"", "{", "{\"draft\":false,}", new string('x', 1_048_577) })
    Check($"malformed JSON length {json.Length} fails closed", () =>
        Require(AppUpdateService.ParseRelease(json, new Version(1, 2, 3), "win-x64") is null));
Check("duplicate JSON fields fail closed", () =>
{
    var json = Release().ToJsonString();
    Require(AppUpdateService.ParseRelease(json.Insert(1, "\"draft\":true,"), new Version(1, 2, 3), "win-x64") is null);
    Require(AppUpdateService.ParseRelease(json.Replace("\"draft\":false", "\"Draft\":true,\"draft\":false"), new Version(1, 2, 3), "win-x64") is null);
});
foreach (var release in new[]
{
    new AppUpdateRelease(new Version(9, 0, 0), "v9.0.0;whoami"),
    new AppUpdateRelease(new Version(9, 0, 0), "v9.0.1"),
    new AppUpdateRelease(new Version(9, 0, 0, 1), "v9.0.0"),
    new AppUpdateRelease(new Version(7, 5, 3), "v7.5.3"),
    new AppUpdateRelease(new Version(7, 5, 2), "v7.5.2")
})
    Check($"StartAsync rejects forged/stale release {release}", () =>
    {
        try { new AppUpdateService().StartAsync(release).GetAwaiter().GetResult(); }
        catch (ArgumentException) { return; }
        throw new InvalidOperationException("StartAsync did not reject release before touching any process");
    });

if (!args.Contains("--parser-only"))
{
    var bundledInstaller = Path.Combine(AppContext.BaseDirectory, "install.ps1");
    using (var file = new FileStream(bundledInstaller, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    using (var writer = new StreamWriter(file))
        writer.Write("# Inert update test installer; never executed.\nexit 0\n");
    try
    {
        foreach (var mode in new[] { "ready", "exit-before-ready", "exit-after-ready", "never-ready", "launch-fails" })
            Check($"StartAsync handshake {mode} keeps caller alive", () =>
            {
                Process? child = null;
                string? staging = null;
                ProcessStartInfo? captured = null;
                var callerPid = Environment.ProcessId;
                var service = new AppUpdateService(info =>
                {
                    captured = info;
                    staging = info.WorkingDirectory;
                    var arguments = info.ArgumentList.ToArray();
                    Require(info.FileName == Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                        "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
                    Require(!info.UseShellExecute && info.CreateNoWindow);
                    string Argument(string name) => arguments[Array.IndexOf(arguments, name) + 1];
                    Require(Argument("-ParentProcessId") == callerPid.ToString());
                    Require(Argument("-ParentStartTimeUtcTicks") == Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString());
                    Require(Argument("-ReleaseTag") == "v9.8.7");
                    Require(Argument("-FallbackExecutablePath") == Environment.ProcessPath);
                    Require(Path.GetDirectoryName(Argument("-InstallerPath")) == staging);
                    Require(File.ReadAllText(Argument("-InstallerPath")) == File.ReadAllText(bundledInstaller));
                    var helper = Argument("-File");
                    Require(Path.GetDirectoryName(helper) == staging);
                    Require(File.ReadAllText(helper).Contains("param("), "embedded helper was not staged");
                    if (mode == "launch-fails")
                        throw new Win32Exception(5, "Fixture blocked helper creation");

                    // Replace the staged private script only, at the OS boundary.
                    // It can signal readiness or exit, and never runs an installer.
                    var source = """
                        param([int]$ParentProcessId, [long]$ParentStartTimeUtcTicks, [string]$ReleaseTag,
                              [string]$InstallerPath, [string]$FallbackExecutablePath)
                        """;
                    if (mode == "ready")
                        source += """

                            $ErrorActionPreference = 'Stop'
                            $sample = [IO.Path]::Combine($PSScriptRoot, 'native-hash-sample.txt')
                            [IO.File]::WriteAllText($sample, 'abc')
                            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sample).Hash.ToLowerInvariant()
                            if ($hash -ne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { throw 'Native Get-FileHash failed.' }
                            $nativeModules = [IO.Path]::Combine($PSHOME, 'Modules') + [IO.Path]::DirectorySeparatorChar
                            foreach ($command in @('Get-FileHash', 'Expand-Archive', 'Invoke-WebRequest')) {
                                $module = (Get-Command $command -ErrorAction Stop).Module.Path
                                if (-not $module.StartsWith($nativeModules, [StringComparison]::OrdinalIgnoreCase)) { throw "Foreign module for $command" }
                            }
                            [IO.File]::WriteAllText([IO.Path]::Combine($PSScriptRoot, 'native-commands-passed'), $hash)
                            """;
                    if (mode == "exit-before-ready")
                        source += "\nexit 23\n";
                    else
                    {
                        if (mode != "never-ready")
                            source += """

                                [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready.tmp'), 'ready')
                                [IO.File]::Move((Join-Path $PSScriptRoot 'ready.tmp'), (Join-Path $PSScriptRoot 'ready'))
                                """;
                        source += mode == "exit-after-ready" ? "\nexit 24\n" : """

                            $deadline = [Diagnostics.Stopwatch]::StartNew()
                            while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'fixture-stop')) -and $deadline.Elapsed.TotalSeconds -lt 15) {
                                Start-Sleep -Milliseconds 25
                            }
                            """;
                    }
                    File.WriteAllText(helper, source);
                    var started = Process.Start(info)!;
                    child = Process.GetProcessById(started.Id);
                    if (mode is "exit-before-ready" or "exit-after-ready")
                        Require(started.WaitForExit(3000), "fixture child did not exit");
                    return started;
                });
                try
                {
                    var timer = Stopwatch.StartNew();
                    Exception? failure = null;
                    try
                    {
                        var operation = service.StartAsync(new AppUpdateRelease(new Version(9, 8, 7), "v9.8.7"));
                        if (mode is "ready" or "never-ready")
                            Require(!operation.IsCompleted, "StartAsync did not asynchronously wait for readiness");
                        operation.GetAwaiter().GetResult();
                    }
                    catch (Exception exception) { failure = exception; }
                    Require(Environment.ProcessId == callerPid, "updater changed caller lifecycle");
                    Require(captured is not null && staging is not null);
                    if (mode == "ready")
                    {
                        Require(failure is null, $"ready child was rejected: {failure}");
                        Require(File.Exists(Path.Combine(staging!, "ready")), "StartAsync returned before readiness");
                        Require(child is not null && !child.HasExited, "ready helper was stopped");
                        Require(File.Exists(Path.Combine(staging!, "native-commands-passed")), "native installer commands were not verified");
                    }
                    else
                    {
                        Require(failure is not null, "unready/exited/blocked helper was accepted");
                        Require(File.Exists(Path.Combine(staging!, "update.log")), "failure has no private diagnostic log");
                        if (child is not null)
                            Require(child.WaitForExit(3000), "owned unready helper was left alive");
                        if (mode == "never-ready")
                            Require(timer.Elapsed >= TimeSpan.FromSeconds(4.8) && timer.Elapsed < TimeSpan.FromSeconds(9),
                                $"readiness timeout was not bounded near five seconds: {timer.Elapsed}");
                    }
                }
                finally
                {
                    if (staging is not null && Directory.Exists(staging))
                    {
                        File.WriteAllText(Path.Combine(staging, "fixture-stop"), "exit gracefully");
                        Require(child is null || child.WaitForExit(3000), "fixture child failed to stop");
                        var root = Path.GetFullPath(staging);
                        Require(root.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
                            && Path.GetFileName(root).StartsWith("OnlyDM-update-", StringComparison.Ordinal), "unsafe fixture cleanup path");
                        Directory.Delete(root, recursive: true);
                    }
                    child?.Dispose();
                }
            });
    }
    finally { File.Delete(bundledInstaller); }
}

if (!args.Contains("--parser-only") && !args.Contains("--handshake-only"))
    Check("isolated updater helper fixture", () =>
    {
        var helper = Path.Combine(Path.GetTempPath(), $"OnlyDM-update-test-source-{Guid.NewGuid():N}.ps1");
        using (var stream = typeof(AppUpdateService).Assembly.GetManifestResourceStream("OnlyDM.UpdateInstaller.ps1")!)
        using (var reader = new StreamReader(stream))
            File.WriteAllText(helper, reader.ReadToEnd());
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File",
            Path.Combine(AppContext.BaseDirectory, "Test-UpdaterHelper.ps1"), "-TestExecutable", Environment.ProcessPath!,
            "-HelperPath", helper })
            start.ArgumentList.Add(argument);
        try
        {
            using var process = Process.Start(start) ?? throw new InvalidOperationException("fixture did not start");
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            Require(process.WaitForExit(120_000), "fixture exceeded two minutes");
            Console.Write(output.GetAwaiter().GetResult());
            Console.Error.Write(errors.GetAwaiter().GetResult());
            Require(process.ExitCode == 0, $"helper fixture exited {process.ExitCode}");
        }
        finally { File.Delete(helper); }
    });
Console.WriteLine($"Update tests: {checks - failures}/{checks} passed.");
return failures == 0 ? 0 : 1;
