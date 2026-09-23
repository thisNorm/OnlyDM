using OnlyDM;

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

return failures == 0 ? 0 : 1;
