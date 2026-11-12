using OnlyDM;
using System.IO;

var failures = 0;

void PassOrFail(string name, bool passed, string detail)
{
    if (passed)
    {
        Console.WriteLine($"PASS: {name}");
        return;
    }

    failures++;
    Console.Error.WriteLine($"FAIL: {name} {detail}");
}

double Luminance(string hex)
{
    static double Channel(int value)
    {
        var normalized = value / 255d;
        return normalized <= 0.04045
            ? normalized / 12.92
            : Math.Pow((normalized + 0.055) / 1.055, 2.4);
    }

    var value = hex.TrimStart('#');
    var red = Convert.ToInt32(value[..2], 16);
    var green = Convert.ToInt32(value.Substring(2, 2), 16);
    var blue = Convert.ToInt32(value.Substring(4, 2), 16);
    return 0.2126 * Channel(red) + 0.7152 * Channel(green) + 0.0722 * Channel(blue);
}

double Contrast(string first, string second)
{
    var a = Luminance(first);
    var b = Luminance(second);
    return (Math.Max(a, b) + 0.05) / (Math.Min(a, b) + 0.05);
}

var hasLight = Enum.TryParse<ThemeKind>("Light", out var lightTheme);
var hasDark = Enum.TryParse<ThemeKind>("Dark", out var darkTheme);
PassOrFail("Light theme exists", hasLight, $"themes={string.Join(',', Enum.GetNames<ThemeKind>())}");
PassOrFail("Dark theme exists", hasDark, $"themes={string.Join(',', Enum.GetNames<ThemeKind>())}");
PassOrFail("Legacy themes removed",
    !Enum.GetNames<ThemeKind>().Contains("Classic") && !Enum.GetNames<ThemeKind>().Contains("DM"),
    $"themes={string.Join(',', Enum.GetNames<ThemeKind>())}");
PassOrFail("New settings default to light", new AppSettings().Theme.ToString() == "Light",
    $"actual={new AppSettings().Theme}");

if (hasLight && hasDark)
{
    var light = AppTheme.GetPalette(lightTheme);
    var dark = AppTheme.GetPalette(darkTheme);
    PassOrFail("Light surface is bright", Luminance(light.Surface) >= 0.80,
        $"surface={light.Surface}");
    PassOrFail("Dark surface is charcoal", Luminance(dark.Surface) <= 0.03,
        $"surface={dark.Surface}");
    PassOrFail("Light text contrast", Contrast(light.Surface, light.Text) >= 4.5,
        $"ratio={Contrast(light.Surface, light.Text):0.00}");
    PassOrFail("Dark text contrast", Contrast(dark.Surface, dark.Text) >= 4.5,
        $"ratio={Contrast(dark.Surface, dark.Text):0.00}");
    PassOrFail("Light outgoing bubble contrast", Contrast(light.OutgoingBubble, light.OutgoingText) >= 4.5,
        $"ratio={Contrast(light.OutgoingBubble, light.OutgoingText):0.00}");
    PassOrFail("Dark outgoing bubble contrast", Contrast(dark.OutgoingBubble, dark.OutgoingText) >= 4.5,
        $"ratio={Contrast(dark.OutgoingBubble, dark.OutgoingText):0.00}");
}

var languageCases = new (string Name, AppLanguage Preference, string? WindowsLanguage, AppLanguage Expected)[]
{
    ("Auto follows Korean Windows", AppLanguage.Auto, "ko-KR", AppLanguage.Korean),
    ("Auto falls back to English", AppLanguage.Auto, "fr-FR", AppLanguage.English),
    ("Korean overrides English Windows", AppLanguage.Korean, "en-US", AppLanguage.Korean),
    ("English overrides Korean Windows", AppLanguage.English, "ko-KR", AppLanguage.English),
};

var languageValueCases = new (string Name, AppLanguage Preference, string WindowsLanguage, string ExpectedCode, string ExpectedText)[]
{
    ("Korean values", AppLanguage.Korean, "en-US", "ko", "한국어 문구"),
    ("English values", AppLanguage.English, "ko-KR", "en", "English text"),
    ("Auto values", AppLanguage.Auto, "en-US", "en", "English text"),
};

var translationCases = new (string Name, AppLanguage Preference, string Source, string Expected)[]
{
    ("Main label to English", AppLanguage.English, "채팅", "Chats"),
    ("Settings label to English", AppLanguage.English, "OnlyDM 설정", "OnlyDM Settings"),
    ("Language label to English", AppLanguage.English, "언어", "Language"),
    ("Language description to English", AppLanguage.English, "OnlyDM과 Instagram 표시 언어를 함께 변경합니다.", "Change the display language for OnlyDM and Instagram together."),
    ("English label back to Korean", AppLanguage.Korean, "Friends", "친구"),
    ("Unknown label is preserved", AppLanguage.English, "OnlyDM", "OnlyDM"),
};

var cases = new (string Name, string? Url, bool Expected)[]
{
    ("DM inbox", "https://www.instagram.com/direct/inbox/", true),
    ("DM thread", "https://instagram.com/direct/t/123456789/", true),
    ("Direct root", "https://www.instagram.com/direct", true),
    ("Login", "https://www.instagram.com/accounts/login/", true),
    ("Feed", "https://www.instagram.com/", false),
    ("Reels", "https://www.instagram.com/reels/", false),
    ("Profile", "https://www.instagram.com/example-user/", false),
    ("HTTP", "http://www.instagram.com/direct/inbox/", false),
    ("External", "https://example.com/direct/inbox/", false),
    ("Lookalike domain", "https://instagram.com.evil.example/direct/inbox/", false),
    ("Null", null, false),
};

// The friends list needs exactly one profile page: the signed-in user's own.
NavigationPolicy.OwnProfileUsername = "example_self";
var ownProfileCases = new (string Name, string Url, bool Expected)[]
{
    ("Own profile", "https://www.instagram.com/example_self/", true),
    ("Other profile", "https://www.instagram.com/someone_else/", false),
    ("Own profile subpage", "https://www.instagram.com/example_self/tagged/", false),
};

var languageUriCases = new (string Name, string Url, bool Expected)[]
{
    ("Instagram language settings", "https://www.instagram.com/accounts/language/", true),
    ("Other account settings", "https://www.instagram.com/accounts/edit/", false),
    ("External language lookalike", "https://example.com/accounts/language/", false),
};

var loginUriCases = new (string Name, string Url, bool Expected)[]
{
    ("Fresh login redirect", "https://www.instagram.com/accounts/login/?next=https%3A%2F%2Fwww.instagram.com%2Fdirect%2Finbox%2F%3F__coig_login%3D1", true),
    ("Login two-factor step", "https://www.instagram.com/accounts/login/two_factor/", true),
    ("Dedicated two-factor step", "https://www.instagram.com/accounts/two_factor/", true),
    ("Login info prompt", "https://www.instagram.com/accounts/onetap/", true),
    ("Challenge", "https://www.instagram.com/challenge/example/", true),
    ("Checkpoint", "https://instagram.com/checkpoint/", true),
    ("Other account page is not login", "https://www.instagram.com/accounts/edit/", false),
    ("Similar challenge path is blocked", "https://www.instagram.com/challenge-info/", false),
    ("Non-login subpage is blocked", "https://www.instagram.com/accounts/onetap/unrelated/", false),
    ("External challenge is blocked", "https://instagram.com.example.com/challenge/", false),
    ("Insecure login is blocked", "http://www.instagram.com/accounts/login/", false),
    ("Nonstandard port is blocked", "https://www.instagram.com:8443/accounts/login/", false),
    ("Userinfo URL is blocked", "https://example.com@www.instagram.com/challenge/", false),
};

foreach (var testCase in languageCases)
{
    var actual = AppLanguageChoice.Resolve(testCase.Preference, testCase.WindowsLanguage);
    if (actual == testCase.Expected)
    {
        Console.WriteLine($"PASS: {testCase.Name}");
        continue;
    }

    failures++;
    Console.Error.WriteLine($"FAIL: {testCase.Name} expected={testCase.Expected} actual={actual}");
}

foreach (var testCase in languageValueCases)
{
    var code = AppLanguageChoice.InstagramCode(testCase.Preference, testCase.WindowsLanguage);
    var text = AppLanguageChoice.Text(testCase.Preference, "한국어 문구", "English text", testCase.WindowsLanguage);
    if (code == testCase.ExpectedCode && text == testCase.ExpectedText)
    {
        Console.WriteLine($"PASS: {testCase.Name}");
        continue;
    }

    failures++;
    Console.Error.WriteLine(
        $"FAIL: {testCase.Name} expected={testCase.ExpectedCode}/{testCase.ExpectedText} actual={code}/{text}");
}

foreach (var testCase in translationCases)
{
    var actual = AppLanguageChoice.Translate(testCase.Preference, testCase.Source);
    if (actual == testCase.Expected)
    {
        Console.WriteLine($"PASS: {testCase.Name}");
        continue;
    }

    failures++;
    Console.Error.WriteLine($"FAIL: {testCase.Name} expected={testCase.Expected} actual={actual}");
}

foreach (var testCase in languageUriCases)
{
    var actual = NavigationPolicy.IsLanguageSettingsUri(new Uri(testCase.Url, UriKind.Absolute));
    if (actual == testCase.Expected)
    {
        Console.WriteLine($"PASS: {testCase.Name}");
        continue;
    }

    failures++;
    Console.Error.WriteLine($"FAIL: {testCase.Name} expected={testCase.Expected} actual={actual}");
}

foreach (var testCase in loginUriCases)
{
    var actual = NavigationPolicy.IsLoginUri(new Uri(testCase.Url, UriKind.Absolute));
    PassOrFail(testCase.Name, actual == testCase.Expected,
        $"expected={testCase.Expected} actual={actual}");
}

foreach (var (url, expected) in new[]
{
    ("https://www.instagram.com/direct/inbox/?source=fixture", true),
    ("https://instagram.com/direct/", true),
    ("https://www.instagram.com/direct/t/123/", false),
    ("https://www.instagram.com/accounts/login/", false),
    ("https://instagram.com.example.com/direct/inbox/", false),
})
{
    PassOrFail($"Own-profile event inbox source: {url}", NavigationPolicy.IsInboxUri(new Uri(url)) == expected,
        $"expected={expected}");
}

foreach (var testCase in ownProfileCases)
{
    var actual = NavigationPolicy.IsAllowedTopLevelUri(new Uri(testCase.Url, UriKind.Absolute));
    if (actual == testCase.Expected)
    {
        Console.WriteLine($"PASS: {testCase.Name}");
        continue;
    }

    failures++;
    Console.Error.WriteLine($"FAIL: {testCase.Name} expected={testCase.Expected} actual={actual}");
}
NavigationPolicy.OwnProfileUsername = null;

foreach (var testCase in cases)
{
    Uri? uri = testCase.Url is null ? null : new Uri(testCase.Url, UriKind.Absolute);
    var actual = NavigationPolicy.IsAllowedTopLevelUri(uri);

    if (actual == testCase.Expected)
    {
        Console.WriteLine($"PASS: {testCase.Name}");
        continue;
    }

    failures++;
    Console.Error.WriteLine(
        $"FAIL: {testCase.Name} expected={testCase.Expected} actual={actual} url={testCase.Url ?? "<null>"}");
}

AccountProfiles();
return failures == 0 ? 0 : 1;

void AccountProfiles()
{
    var root = Directory.CreateTempSubdirectory("onlydm-account-tests-").FullName;
    try
    {
        var originalProfile = Path.Combine(root, "WebView2");
        Directory.CreateDirectory(originalProfile);
        var originalCache = Path.Combine(root, "friends.json");
        var originalBrowserData = Path.Combine(originalProfile, "fixture.txt");
        File.WriteAllText(originalCache, "original friends");
        File.WriteAllText(originalBrowserData, "original session fixture");

        var original = new AccountStore(root);
        PassOrFail("First launch keeps the legacy cache and WebView2 directory",
            original.SelectedId == Guid.Empty && original.DataDirectory == root,
            $"root={original.DataDirectory}");

        original.RememberHandle("original.fixture");
        PassOrFail("A verified handle adds only per-account display metadata",
            original.HandleFor(Guid.Empty) == "original.fixture"
                && File.ReadAllText(Path.Combine(root, "account-handle.txt")) == "original.fixture"
                && !File.Exists(Path.Combine(root, "accounts.json"))
                && File.ReadAllText(originalBrowserData) == "original session fixture",
            "Expected only the original account's display label to be added");

        var ownerThreads = Path.Combine(root, "threads.json");
        File.WriteAllText(ownerThreads, "owner threads");
        original.RememberHandle("another_fixture");
        PassOrFail("An official profile change uses a different cache directory without touching the legacy files",
            original.CacheDirectory != root
                && !File.Exists(Path.Combine(original.CacheDirectory, "friends.json"))
                && File.ReadAllText(originalCache) == "original friends"
                && File.ReadAllText(ownerThreads) == "owner threads"
                && original.DataDirectory == root,
            "A different Instagram identity must not inherit the previous identity's cached lists");
        var switchedIdentity = new AccountStore(root);
        PassOrFail("The changed identity keeps its cache namespace on restart",
            switchedIdentity.CacheDirectory == original.CacheDirectory,
            "The new cache namespace must be persistent");
        original.RememberHandle("original.fixture");
        PassOrFail("Returning to the original identity reuses the original cache paths",
            original.CacheDirectory == root && File.ReadAllText(ownerThreads) == "owner threads",
            "The original account caches must be preserved");

        original.SelectForNextLaunch(null);
        var second = new AccountStore(root);
        PassOrFail("Adding an account persists a different profile for the next launch only",
            original.DataDirectory == root
                && second.SelectedId != Guid.Empty
                && second.AccountIds.SequenceEqual(new[] { Guid.Empty, second.SelectedId })
                && second.DataDirectory != root
                && !File.Exists(Path.Combine(second.DataDirectory, "friends.json"))
                && !File.Exists(Path.Combine(second.DataDirectory, "WebView2", "fixture.txt")),
            "Expected a new profile with no legacy friends or browser data");

        PassOrFail("An added account starts without a label and keeps the original account's label",
            second.HandleFor(second.SelectedId) is null && second.HandleFor(Guid.Empty) == "original.fixture",
            "The new account must use its numeric fallback until its own handle arrives");

        second.RememberHandle("second_fixture");
        foreach (var invalid in new[] { "", "..", "direct", "name/../other", "bad\nline", new string('x', 31) })
        {
            second.RememberHandle(invalid);
        }
        PassOrFail("Unsafe labels cannot replace a saved display handle or affect another account",
            second.HandleFor(second.SelectedId) == "second_fixture"
                && second.HandleFor(Guid.Empty) == "original.fixture",
            "Invalid text should be ignored and labels must stay in their own profiles");

        var secondProfile = Path.Combine(second.DataDirectory, "WebView2");
        Directory.CreateDirectory(secondProfile);
        var secondCache = Path.Combine(second.DataDirectory, "friends.json");
        var secondBrowserData = Path.Combine(secondProfile, "fixture.txt");
        File.WriteAllText(secondCache, "second account friends");
        File.WriteAllText(secondBrowserData, "second session fixture");

        second.SelectForNextLaunch(Guid.Empty);
        var back = new AccountStore(root);
        PassOrFail("Returning to the original keeps its data at the original paths",
            back.SelectedId == Guid.Empty
                && back.DataDirectory == root
                && File.ReadAllText(originalCache) == "original friends"
                && File.ReadAllText(originalBrowserData) == "original session fixture",
            "The switch should leave the original profile untouched");

        back.SelectForNextLaunch(second.SelectedId);
        var again = new AccountStore(root);
        PassOrFail("Returning to the added account reuses its own data and stable position",
            again.SelectedId == second.SelectedId
                && again.DataDirectory == second.DataDirectory
                && again.AccountIds.SequenceEqual(second.AccountIds)
                && again.HandleFor(second.SelectedId) == "second_fixture"
                && again.HandleFor(Guid.Empty) == "original.fixture"
                && File.ReadAllText(secondCache) == "second account friends"
                && File.ReadAllText(secondBrowserData) == "second session fixture",
            "The added profile and its order should survive switching away");

        again.SelectForNextLaunch(null);
        var duplicate = new AccountStore(root);
        duplicate.RememberHandle("ORIGINAL.fixture");
        PassOrFail("A handle matching the active profile does not start another watcher",
            duplicate.InactiveNotificationIds.SequenceEqual(new[] { second.SelectedId }),
            "Handle comparisons must ignore case");
        duplicate.SelectForNextLaunch(second.SelectedId);
        var withDuplicateInactive = new AccountStore(root);
        PassOrFail("Two inactive slots for one handle use only one watcher",
            withDuplicateInactive.InactiveNotificationIds.SequenceEqual(new[] { Guid.Empty }),
            "The first saved slot should supply the inactive account watcher");
        duplicate.RememberHandle("third_fixture");
        PassOrFail("Own-profile reconciliation allows a newly distinct handle to be watched",
            withDuplicateInactive.InactiveNotificationIds.SequenceEqual(new[] { Guid.Empty, duplicate.SelectedId }),
            "Handle labels must be re-read when reconciling watchers");

        var unknownRejected = false;
        try { again.SelectForNextLaunch(Guid.NewGuid()); }
        catch (ArgumentException) { unknownRejected = true; }
        PassOrFail("An unregistered account cannot become selected",
            unknownRejected && new AccountStore(root).SelectedId == second.SelectedId,
            "An invalid selection should leave the last selection intact");

        File.WriteAllText(Path.Combine(again.DataDirectory, "account-handle.txt"), "unsafe label!");
        PassOrFail("An invalid saved handle falls back without affecting account selection",
            again.HandleFor(second.SelectedId) is null && again.HandleFor(Guid.Empty) == "original.fixture",
            "Only valid handles may be shown");

        File.WriteAllText(Path.Combine(root, "accounts.json"),
            """{"SelectedId":"00000000-0000-0000-0000-000000000001","AccountIds":["00000000-0000-0000-0000-000000000000"]}""");
        var invalidRejected = false;
        try { _ = new AccountStore(root); }
        catch (InvalidDataException) { invalidRejected = true; }
        PassOrFail("An invalid selection on disk cannot silently open the original account",
            invalidRejected, "The stored account selection must resolve to a registered profile");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
}
