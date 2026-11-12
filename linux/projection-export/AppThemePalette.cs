namespace OnlyDM;

// Match the Windows projection colors without bringing in AppTheme's WPF dependency.
public sealed record AppThemePalette(
    bool IsDark,
    string Accent,
    string AccentText,
    string Surface,
    string SurfaceAlt,
    string Text,
    string MutedText,
    string Border,
    string ChatBackground,
    string IncomingBubble,
    string OutgoingBubble,
    string OutgoingText)
{
    public static AppThemePalette Light { get; } = new(
        IsDark: false,
        Accent: "#4257C9",
        AccentText: "#FFFFFF",
        Surface: "#FFFFFF",
        SurfaceAlt: "#EEF1F5",
        Text: "#171A21",
        MutedText: "#687080",
        Border: "#DEE3EA",
        ChatBackground: "#E9EEF4",
        IncomingBubble: "#FFFFFF",
        OutgoingBubble: "#4257C9",
        OutgoingText: "#FFFFFF");

    public static AppThemePalette Dark { get; } = new(
        IsDark: true,
        Accent: "#4257C9",
        AccentText: "#FFFFFF",
        Surface: "#1F232B",
        SurfaceAlt: "#2A303A",
        Text: "#F2F4F8",
        MutedText: "#AAB1BD",
        Border: "#343B47",
        ChatBackground: "#181C22",
        IncomingBubble: "#2A303A",
        OutgoingBubble: "#4257C9",
        OutgoingText: "#FFFFFF");
}
