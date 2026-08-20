using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public static class WebView2DependencyService
{
    private const string BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    public static async Task<bool> EnsureInstalledWithConsentAsync(Window owner)
    {
        if (IsInstalled()) return true;

        const string message =
            "Microsoft Edge WebView2 Runtime is required to run OnlyDM.\n" +
            "It is not currently installed on this computer.\n\n" +
            "Would you like to install it now?";

        var result = MessageBox.Show(
            owner,
            message,
            "OnlyDM Setup",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question,
            MessageBoxResult.Yes);

        if (result != MessageBoxResult.Yes) return false;

        await InstallAsync();
        for (var attempt = 0; attempt < 10; attempt++)
        {
            if (IsInstalled()) return true;
            await Task.Delay(500);
        }

        throw new InvalidOperationException("Microsoft Edge WebView2 Runtime installation could not be verified.");
    }

    public static bool IsInstalled()
    {
        try
        {
            return !string.IsNullOrWhiteSpace(CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            return false;
        }
    }

    private static async Task InstallAsync()
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), $"OnlyDM-WebView2-{Guid.NewGuid():N}");
        var installerPath = Path.Combine(tempDirectory, "MicrosoftEdgeWebview2Setup.exe");
        Directory.CreateDirectory(tempDirectory);

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
            await using (var source = await client.GetStreamAsync(BootstrapperUrl))
            await using (var destination = File.Create(installerPath))
            {
                await source.CopyToAsync(destination);
            }

            if (!IsMicrosoftSigned(installerPath))
            {
                throw new InvalidOperationException(
                    "The downloaded WebView2 installer is not a valid Microsoft-signed executable.");
            }

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = installerPath,
                Arguments = "/silent /install",
                UseShellExecute = true,
            }) ?? throw new InvalidOperationException("WebView2 installer could not be started.");

            await process.WaitForExitAsync();
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException($"WebView2 installer exited with code {process.ExitCode}.");
            }
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempDirectory)) Directory.Delete(tempDirectory, recursive: true);
            }
            catch
            {
                // Temporary installer cleanup is best-effort and does not change installation status.
            }
        }
    }

    private static bool IsMicrosoftSigned(string path)
    {
        try
        {
            using var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            using var chain = new X509Chain();
           chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
           chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            return certificate.GetNameInfo(X509NameType.SimpleName, forIssuer: false)
                       .Equals("Microsoft Corporation", StringComparison.OrdinalIgnoreCase)
               && chain.Build(certificate);
        }
        catch (CryptographicException)
        {
            return false;
        }
        catch (Win32Exception)
        {
            return false;
        }
    }
}
