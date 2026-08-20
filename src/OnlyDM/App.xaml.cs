using System;
using System.IO;
using System.Windows;
using System.Windows.Threading;
using Application = System.Windows.Application;

namespace OnlyDM;

public partial class App : Application
{
    private static string LogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OnlyDM",
        "error.log");

    internal static void Log(string stage, object detail)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"{DateTime.Now:s} [{stage}] {detail}{Environment.NewLine}");
        }
        catch (Exception)
        {
            // Losing the log is not worth a second failure.
        }
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        base.OnStartup(e);
    }

    // A failure while handling a click used to end the process, which is how a dead
    // WebView took the tray icon down with it. The app stays up and writes it down.
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        Log("unhandled", e.Exception);
        e.Handled = true;
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        if (MainWindow is OnlyDM.MainWindow mainWindow)
        {
            mainWindow.AllowCloseForSessionEnding();
        }

        base.OnSessionEnding(e);
    }
}
