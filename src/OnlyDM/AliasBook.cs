using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace OnlyDM;

// Names the user chose for people, kept on this machine only. Instagram never sees them
// and neither does the other person; the account handle is what they are filed under, so
// renaming in a conversation and renaming in the friends list land on the same entry.
public static class AliasBook
{
    private sealed class Book
    {
        // handle -> the name to show instead
        public Dictionary<string, string> Names { get; set; } = new(StringComparer.Ordinal);

        // conversation title -> handle, learned from the conversation itself. The DM list
        // only knows display names, so without this an alias could never reach it.
        public Dictionary<string, string> Handles { get; set; } = new(StringComparer.Ordinal);

        // /direct/t/<id> -> the name to show for that conversation. Group chats have no
        // single account to hang a name on, so the room itself is the key.
        public Dictionary<string, string> Rooms { get; set; } = new(StringComparer.Ordinal);
    }

    private static readonly object Gate = new();
    private static Book _book = Load();

    public static event Action? Changed;

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OnlyDM",
        "aliases.json");

    private static Book Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new Book();
            var payload = File.ReadAllText(FilePath);
            var json = LocalDataProtection.Unprotect(payload);
            var book = JsonSerializer.Deserialize<Book>(json) ?? new Book();
            if (!LocalDataProtection.IsProtected(payload)) File.WriteAllText(FilePath, LocalDataProtection.Protect(json));
            return book;
        }
        catch (Exception)
        {
            return new Book();
        }
    }

    private static void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(
                FilePath,
                LocalDataProtection.Protect(JsonSerializer.Serialize(_book, new JsonSerializerOptions { WriteIndented = true })));
        }
        catch (Exception ex)
        {
            App.Log("alias-save", ex);
        }
    }

    public static string? AliasFor(string? handle)
    {
        if (string.IsNullOrWhiteSpace(handle)) return null;
        lock (Gate) return _book.Names.TryGetValue(handle, out var alias) ? alias : null;
    }

    public static string? HandleForThread(string? threadKey)
    {
        if (string.IsNullOrWhiteSpace(threadKey)) return null;
        lock (Gate) return _book.Handles.TryGetValue(threadKey, out var handle) ? handle : null;
    }

    // An empty name means "go back to what Instagram calls them".
    public static void Set(string? handle, string? alias)
    {
        if (string.IsNullOrWhiteSpace(handle)) return;
        var trimmed = (alias ?? string.Empty).Trim();
        lock (Gate)
        {
            if (trimmed.Length == 0) _book.Names.Remove(handle);
            else _book.Names[handle] = trimmed;
            Save();
        }
        Changed?.Invoke();
    }

    public static void Link(string? threadKey, string? handle)
    {
        if (string.IsNullOrWhiteSpace(threadKey) || string.IsNullOrWhiteSpace(handle)) return;
        lock (Gate)
        {
            if (_book.Handles.TryGetValue(threadKey, out var known) && known == handle) return;
            _book.Handles[threadKey] = handle;
            Save();
        }
        Changed?.Invoke();
    }

    public static string ThreadKey(Uri? threadUri) =>
        threadUri is null ? string.Empty : threadUri.AbsolutePath.TrimEnd('/');

    public static string? RoomAlias(string? threadKey)
    {
        if (string.IsNullOrWhiteSpace(threadKey)) return null;
        lock (Gate) return _book.Rooms.TryGetValue(threadKey, out var name) ? name : null;
    }

    public static void SetRoom(string? threadKey, string? name)
    {
        if (string.IsNullOrWhiteSpace(threadKey)) return;
        var trimmed = (name ?? string.Empty).Trim();
        lock (Gate)
        {
            if (trimmed.Length == 0) _book.Rooms.Remove(threadKey);
            else _book.Rooms[threadKey] = trimmed;
            Save();
        }
        Changed?.Invoke();
    }

    public static Dictionary<string, string> ByHandle()
    {
        lock (Gate) return new Dictionary<string, string>(_book.Names, StringComparer.Ordinal);
    }

    // What the DM list needs: display name -> alias. Titles come from conversations that
    // told us their handle, plus the friends list, where the name is known up front.
    public static Dictionary<string, string> ByDisplayName(
        IEnumerable<FriendEntry> roster,
        IReadOnlyDictionary<string, string>? threadUrls = null,
        IReadOnlyDictionary<string, string>? threadTitles = null)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        lock (Gate)
        {
            foreach (var (threadKey, url) in threadUrls ?? new Dictionary<string, string>())
            {
                if (threadTitles?.TryGetValue(threadKey, out var title) != true) continue;
                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) continue;
                // The list files a conversation under whatever identity its row carries,
                // which is not always the address; both look up through the address.
                var path = uri.AbsolutePath.TrimEnd('/');
                if (_book.Rooms.TryGetValue(path, out var room)) map[threadKey] = room;
                if (_book.Handles.TryGetValue(path, out var handle)
                    && _book.Names.TryGetValue(handle, out var alias)) map[threadKey] = alias;
           }

            foreach (var (threadKey, title) in threadTitles ?? new Dictionary<string, string>())
            {
                if (map.ContainsKey(threadKey)) continue;
                var person = roster.FirstOrDefault(candidate => candidate.Name == title);
                if (person is not null && _book.Names.TryGetValue(person.Handle, out var alias))
                {
                    map[threadKey] = alias;
                }
            }

        }
        return map;
    }

    public static string Display(
        string? threadKey,
        string? title,
        IEnumerable<FriendEntry>? roster = null)
    {
        if (string.IsNullOrWhiteSpace(title)) return title ?? string.Empty;
        var alias = AliasFor(HandleForThread(threadKey));
        if (alias is not null) return alias;
        var match = roster?.FirstOrDefault(person => person.Name == title);
        return (match is null ? null : AliasFor(match.Handle)) ?? title;
    }
}
