using System;
using System.IO;
using System.Diagnostics;
using System.Security.Principal;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public partial class App : Application
{
    private const string AccountSwitchArgument = "--account-switch";
    private const string InstanceNamePrefix = @"Local\thisNorm.OnlyDM.Instance.";
    private Mutex? _instanceMutex;
    private EventWaitHandle? _activationSignal;
    private RegisteredWaitHandle? _activationWait;
    private bool _ownsInstance;
    private AppLanguage? _restartForAccountSwitch;
    private bool _restartAfterBrowserFailure;
    internal bool ShowOnAccountSwitch { get; private set; }

    internal void RestartForAccountSwitch(AppLanguage language) => _restartForAccountSwitch = language;

    internal void RestartAfterBrowserFailure() => _restartAfterBrowserFailure = true;

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
            if (!AcquireInstance())
            {
                Shutdown();
                return;
            }
        }
        catch (Exception ex)
        {
            Log("single-instance", ex);
            Shutdown(1);
            return;
        }

        try
        {
            _ = AccountStore.Current;
        }
        catch (Exception ex)
        {
            Log("account-selection", ex);
            MessageBox.Show(AppLanguageChoice.Text(SettingsStore.Load().Language,
                "저장된 계정 목록을 읽을 수 없어 OnlyDM을 열지 못했습니다.",
                "Could not open OnlyDM because its saved account list could not be read."),
                "OnlyDM", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
            return;
        }

        ShowOnAccountSwitch = e.Args.Contains(AccountSwitchArgument);
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        base.OnStartup(e);
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
        _activationWait = ThreadPool.RegisterWaitForSingleObject(_activationSignal!, (_, _) =>
        {
            if (!Dispatcher.HasShutdownStarted) _ = Dispatcher.InvokeAsync(window.OpenFromTray);
        }, null, Timeout.Infinite, executeOnlyOnce: false);
    }

    private bool AcquireInstance()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var user = identity.User ?? throw new InvalidOperationException("The current Windows user could not be identified.");
        var name = InstanceNamePrefix + user.Value;
        // Create the signal first so a launch during startup can request a window too.
        _activationSignal = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Activate");
        _instanceMutex = new Mutex(initiallyOwned: false, name);
        try { _ownsInstance = _instanceMutex.WaitOne(0); }
        catch (AbandonedMutexException) { _ownsInstance = true; }
        if (!_ownsInstance) _activationSignal.Set();
        return _ownsInstance;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        base.OnExit(e);
        _activationWait?.Unregister(null);
        _activationSignal?.Dispose();
        if (_ownsInstance) _instanceMutex?.ReleaseMutex();
        _instanceMutex?.Dispose();

        var language = _restartForAccountSwitch;
        if (language is null && !_restartAfterBrowserFailure) return;

        // The old window and its tray icon have closed and released the instance lock.
        try
        {
            var exe = Environment.ProcessPath ?? throw new InvalidOperationException("OnlyDM executable path is unavailable.");
            var start = new ProcessStartInfo(exe) { WorkingDirectory = AppContext.BaseDirectory };
            if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            {
                start.ArgumentList.Add(typeof(App).Assembly.Location);
            }
            if (language.HasValue) start.ArgumentList.Add(AccountSwitchArgument);
            using var process = Process.Start(start);
        }
        catch (Exception ex)
        {
            Log(language.HasValue ? "account-restart" : "restart", ex);
            if (language is { } selectedLanguage)
                MessageBox.Show(AppLanguageChoice.Text(selectedLanguage,
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
