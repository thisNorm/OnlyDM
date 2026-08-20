using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OnlyDM;

public static class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OnlyDM",
        "settings.json");

    public static AppSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
            {
                return new AppSettings();
            }

            // Builds before the theme was renamed wrote "Kakao"; an unknown enum name
            // would throw and quietly reset every other setting with it.
            var json = File.ReadAllText(SettingsPath).Replace("\"Kakao\"", "\"Classic\"");
            return JsonSerializer.Deserialize<AppSettings>(json, JsonOptions) ?? new AppSettings();
        }
        catch
        {
            return new AppSettings();
        }
    }

    public static void Save(AppSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var directory = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(directory);
        var tempPath = SettingsPath + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(tempPath, SettingsPath, overwrite: true);
    }
}
