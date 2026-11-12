using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OnlyDM;

internal sealed class AccountStore
{
    private sealed record Selection(
        [property: JsonRequired] Guid SelectedId,
        [property: JsonRequired] Guid[] AccountIds);

    private static readonly Lazy<AccountStore> Local = new(() => new AccountStore(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OnlyDM")));

    private readonly string _root;
    private readonly Selection _selection;
    private string? _cacheOwner;
    private string? _currentHandle;
    private string SelectionPath => Path.Combine(_root, "accounts.json");

    // Keep the selection fixed for the whole process, including pending work during shutdown.
    public static AccountStore Current => Local.Value;

    public AccountStore(string root)
    {
        _root = root;
        _selection = LoadSelection();
        _currentHandle = HandleFor(SelectedId);
        _cacheOwner = ReadDisplayHandle(CacheOwnerPath) ?? _currentHandle;
    }

    public Guid SelectedId => _selection.SelectedId;
    public IReadOnlyList<Guid> AccountIds => Array.AsReadOnly(_selection.AccountIds);
    public string DataDirectory => DirectoryFor(SelectedId);
    private string CacheOwnerPath => Path.Combine(DataDirectory, "account-cache-owner.txt");
    public string CacheDirectory => _currentHandle is null || _cacheOwner is null
        || _currentHandle.Equals(_cacheOwner, StringComparison.OrdinalIgnoreCase)
        ? DataDirectory
        : Path.Combine(DataDirectory, "IdentityCaches",
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_currentHandle.ToLowerInvariant()))));

    internal string DirectoryFor(Guid id) => id == Guid.Empty
        ? _root
        : Path.Combine(_root, "Accounts", id.ToString("N"));

    public IEnumerable<Guid> InactiveNotificationIds
    {
        get
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (HandleFor(SelectedId) is string current) seen.Add(current);
            foreach (var id in AccountIds)
            {
                if (id == SelectedId) continue;
                var handle = HandleFor(id);
                if (handle is null || seen.Add(handle)) yield return id;
            }
        }
    }

    private string HandlePath(Guid id) => Path.Combine(DirectoryFor(id), "account-handle.txt");

    public static bool IsDisplayHandle([NotNullWhen(true)] string? handle) =>
        handle is { Length: > 0 and <= 30 }
        && handle.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_')
        && handle.Any(c => c != '.')
        && handle.ToLowerInvariant() is not ("accounts" or "challenge" or "checkpoint" or "direct" or "explore" or "reels" or "stories");

    public string? HandleFor(Guid id) => ReadDisplayHandle(HandlePath(id));

    private static string? ReadDisplayHandle(string path)
    {
        try
        {
            var handle = File.ReadAllText(path);
            return IsDisplayHandle(handle) ? handle : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void RememberHandle(string? handle)
    {
        if (!IsDisplayHandle(handle)) return;
        _cacheOwner ??= _currentHandle ?? handle;
        _currentHandle = handle;
        if (ReadDisplayHandle(CacheOwnerPath) is null) WriteAtomically(CacheOwnerPath, _cacheOwner);
        if (HandleFor(SelectedId) != handle) WriteAtomically(HandlePath(SelectedId), handle);
    }

    private Selection LoadSelection()
    {
        try
        {
            var selection = JsonSerializer.Deserialize<Selection>(File.ReadAllText(SelectionPath));
            if (selection?.AccountIds is not { Length: > 0 } ids
                || ids[0] != Guid.Empty
                || !ids.Contains(selection.SelectedId)
                || ids.Distinct().Count() != ids.Length)
            {
                throw new InvalidDataException("Invalid OnlyDM account selection.");
            }
            return selection;
        }
        catch (FileNotFoundException) { return new Selection(Guid.Empty, [Guid.Empty]); }
        catch (DirectoryNotFoundException) { return new Selection(Guid.Empty, [Guid.Empty]); }
    }

    // A null ID adds a slot; the new process picks it up from the same atomic write.
    public void SelectForNextLaunch(Guid? id)
    {
        var ids = LoadSelection().AccountIds;
        var selectedId = id ?? Guid.NewGuid();
        if (id is null) ids = [.. ids, selectedId];
        else if (!ids.Contains(selectedId)) throw new ArgumentException("Unknown OnlyDM account.", nameof(id));

        WriteAtomically(SelectionPath, JsonSerializer.Serialize(new Selection(selectedId, ids)));
    }

    private static void WriteAtomically(string path, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tempPath, value);
            File.Move(tempPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }
}
