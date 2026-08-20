using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace OnlyDM;

// Remembers the address of every conversation that has been opened. Finding a room by
// scrolling Instagram's hidden list costs seconds; going straight to a known address
// costs about a second, which is what makes it affordable to close idle windows.
public static class ThreadStore
{
    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OnlyDM",
        "threads.json");

    public static Dictionary<string, string> Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new Dictionary<string, string>(StringComparer.Ordinal);
            var payload = File.ReadAllText(FilePath);
            var json = LocalDataProtection.Unprotect(payload);
            var threads = JsonSerializer.Deserialize<Dictionary<string, string>>(json)
                          ?? new Dictionary<string, string>(StringComparer.Ordinal);
            if (!LocalDataProtection.IsProtected(payload)) Save(threads);
            return new Dictionary<string, string>(threads, StringComparer.Ordinal);
        }
        catch (Exception)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
    }

    public static void Save(IReadOnlyDictionary<string, string> threads)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, LocalDataProtection.Protect(JsonSerializer.Serialize(threads)));
        }
        catch (Exception)
        {
            // Losing the cache only costs one slow open per conversation.
        }
    }
}
