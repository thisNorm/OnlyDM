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

        // /direct/t/<id> -> handle, learned from the conversation itself.
        public Dictionary<string, string> Handles { get; set; } = new(StringComparer.Ordinal);

        // /direct/t/<id> -> the name to show for that conversation. Group chats have no
        // single account to hang a name on, so the room itself is the key.
        public Dictionary<string, string> Rooms { get; set; } = new(StringComparer.Ordinal);
    }

    private static readonly object Gate = new();
    private static Book _book = Load();

    public static event Action? Changed;

    private static string FilePath => Path.Combine(AccountStore.Current.CacheDirectory, "aliases.json");

    internal static void ReloadIdentity()
    {
        lock (Gate) _book = Load();
        Changed?.Invoke();
    }

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

    private static bool Save(Book book)
    {
        try
        {
            AccountStore.WriteAtomically(FilePath,
                LocalDataProtection.Protect(JsonSerializer.Serialize(book, new JsonSerializerOptions { WriteIndented = true })));
            return true;
        }
        catch (Exception ex)
        {
            App.Log("alias-save", ex);
            return false;
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
            Save(_book);
        }
        Changed?.Invoke();
    }

    public static bool Link(string? threadKey, string? handle)
    {
        if (string.IsNullOrWhiteSpace(threadKey) || !AccountStore.IsDisplayHandle(handle)) return false;
        lock (Gate)
        {
            _book.Handles.TryGetValue(threadKey, out var known);
            if (known == handle) return true;

            var next = new Book
            {
                Names = new(_book.Names),
                Handles = new(_book.Handles) { [threadKey] = handle },
                Rooms = new(_book.Rooms),
            };
            // Only the first verified link may move a room alias to a person.
            if (next.Rooms.Remove(threadKey, out var pending) && !AccountStore.IsDisplayHandle(known)
                && !string.IsNullOrWhiteSpace(pending))
                next.Names[handle] = pending;

            if (!Save(next)) return false;
            _book = next;
        }
        Changed?.Invoke();
        return true;
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
            Save(_book);
        }
        Changed?.Invoke();
    }

    public static Dictionary<string, string> ByHandle()
    {
        lock (Gate) return new Dictionary<string, string>(_book.Names, StringComparer.Ordinal);
    }

    public static Dictionary<string, string> ByThread(
        IEnumerable<FriendEntry> roster,
        IReadOnlyDictionary<string, string> threadUrls,
        IReadOnlyDictionary<string, string> threadTitles)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        lock (Gate)
        {
            // Addressed rows must resolve from saved aliases before any conversation is opened.
            foreach (var path in _book.Rooms.Keys.Concat(_book.Handles.Keys).Distinct(StringComparer.Ordinal))
            {
                if (!path.StartsWith("/direct/t/", StringComparison.Ordinal)) continue;
                _book.Rooms.TryGetValue(path, out var name);
                if (_book.Handles.TryGetValue(path, out var handle)
                    && _book.Names.TryGetValue(handle, out var alias)) name = alias;
                if (string.IsNullOrEmpty(name)) continue;
                map[path] = name;
                map["https://www.instagram.com" + path] = name;
                map["https://instagram.com" + path] = name;
            }

            foreach (var (rowKey, url) in threadUrls)
            {
                if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && NavigationPolicy.IsDirectUri(uri)
                    && map.TryGetValue(ThreadKey(uri), out var alias)) map[rowKey] = alias;
            }

            foreach (var (threadKey, title) in threadTitles)
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
