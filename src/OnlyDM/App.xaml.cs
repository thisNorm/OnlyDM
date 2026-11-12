using System;
using System.IO;
using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public partial class App : Application
{
    private const string AccountSwitchArgument = "--account-switch";
    private AppLanguage? _restartForAccountSwitch;
    internal bool ShowOnAccountSwitch { get; private set; }

    internal void RestartForAccountSwitch(AppLanguage language) => _restartForAccountSwitch = language;

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
        try
        {
            _ = AccountStore.Current;
        }
        catch (Exception ex)
        {
            Log("account-selection", ex);
            MessageBox.Show(AppLanguageChoice.Text(AppLanguage.Auto,
                "저장된 계정 목록을 읽을 수 없어 OnlyDM을 열지 못했습니다.",
                "Could not open OnlyDM because its saved account list could not be read."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
            return;
        }

        ShowOnAccountSwitch = e.Args.Contains(AccountSwitchArgument);
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        base.OnStartup(e);
        MainWindow = new MainWindow();
        MainWindow.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        base.OnExit(e);
        if (_restartForAccountSwitch is not { } language) return;

        // WPF has closed the old windows before starting the selected profile.
        try
        {
            var exe = Environment.ProcessPath ?? throw new InvalidOperationException("OnlyDM executable path is unavailable.");
            var start = new ProcessStartInfo(exe) { WorkingDirectory = AppContext.BaseDirectory };
            if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            {
                start.ArgumentList.Add(typeof(App).Assembly.Location);
            }
            start.ArgumentList.Add(AccountSwitchArgument);
            using var process = Process.Start(start);
        }
        catch (Exception ex)
        {
            Log("account-restart", ex);
            MessageBox.Show(AppLanguageChoice.Text(language,
                "선택한 계정으로 전환하려면 OnlyDM을 다시 열어 주세요.",
                "Reopen OnlyDM to finish switching accounts."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
        }
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
