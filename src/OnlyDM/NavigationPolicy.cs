namespace OnlyDM;

public static class NavigationPolicy
{
    public static Uri InboxUri { get; } = new("https://www.instagram.com/direct/inbox/");

    public static bool IsAllowedTopLevelUri(Uri? uri)
    {
        if (!IsInstagramHttpsUri(uri))
        {
            return false;
        }

        return IsDirectUri(uri) || IsLoginUri(uri) || IsOwnProfileUri(uri);
    }

    // The friends list only exists on the signed-in user's own profile. That one page
    // is allowed so it can be read in the background; it is never shown, and every
    // other profile, the feed and reels stay blocked.
    public static string? OwnProfileUsername { get; set; }

    public static bool IsOwnProfileUri(Uri? uri)
    {
        if (!IsInstagramHttpsUri(uri) || string.IsNullOrWhiteSpace(OwnProfileUsername))
        {
            return false;
        }

        var path = NormalizePath(uri!.AbsolutePath);
        return path.Equals($"/{OwnProfileUsername}", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsDirectUri(Uri? uri)
    {
        if (!IsInstagramHttpsUri(uri))
        {
            return false;
        }

        var path = NormalizePath(uri!.AbsolutePath);
        return path.Equals("/direct", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/direct/", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsLoginUri(Uri? uri)
    {
        if (!IsInstagramHttpsUri(uri))
        {
            return false;
        }

        var path = NormalizePath(uri!.AbsolutePath);
        return path.Equals("/accounts/login", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/accounts/login/", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsInstagramHttpsUri(Uri? uri)
    {
        if (uri is null || !uri.IsAbsoluteUri)
        {
            return false;
        }

        if (!uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return uri.Host.Equals("instagram.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("www.instagram.com", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return "/";
        }

        return path.Length > 1 ? path.TrimEnd('/') : path;
    }
}
