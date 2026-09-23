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

            // v0.2.7 and older offered two visual styles. They both migrate to the new
            // light appearance so an update never turns a user's app dark unexpectedly.
            var json = File.ReadAllText(SettingsPath)
                .Replace("\"Kakao\"", "\"Light\"")
                .Replace("\"Classic\"", "\"Light\"")
                .Replace("\"DM\"", "\"Light\"");
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
