using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace OnlyDM;

public sealed record FriendEntry(string Handle, string Name, string Avatar = "");

// The following list barely changes, so it is collected once and kept on disk.
// Refreshing is a deliberate action, not something every launch pays for.
public static class FriendsStore
{
    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OnlyDM",
        "friends.json");

    public static List<FriendEntry> Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new List<FriendEntry>();
            var payload = File.ReadAllText(FilePath);
            var json = LocalDataProtection.Unprotect(payload);
            var friends = JsonSerializer.Deserialize<List<FriendEntry>>(json) ?? new List<FriendEntry>();
            if (!LocalDataProtection.IsProtected(payload)) Save(friends);
            return friends;
        }
        catch (Exception)
        {
            // A damaged cache is not worth failing over; it is rebuilt on next refresh.
            return new List<FriendEntry>();
        }
    }

    public static void Save(IEnumerable<FriendEntry> friends)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, LocalDataProtection.Protect(JsonSerializer.Serialize(friends)));
        }
        catch (Exception)
        {
            // Losing the cache only costs one more harvest.
        }
    }
}
