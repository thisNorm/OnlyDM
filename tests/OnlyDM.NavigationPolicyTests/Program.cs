using OnlyDM;

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

var failures = 0;
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
