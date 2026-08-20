using System;
using Microsoft.Win32;

namespace OnlyDM;

public static class StartupManager
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "OnlyDM";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        return key?.GetValue(ValueName) is string value && !string.IsNullOrWhiteSpace(value);
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Windows startup settings could not be opened.");

        if (enabled)
        {
            var executable = Environment.ProcessPath
                ?? throw new InvalidOperationException("OnlyDM executable path is unavailable.");
            key.SetValue(ValueName, $"\"{executable}\"");
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
