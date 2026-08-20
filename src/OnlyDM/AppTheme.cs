namespace OnlyDM;

public enum ThemeKind
{
    Classic,
    DM,
}

public sealed record AppThemePalette(
    string Accent,
    string AccentText,
    string WindowBackground,
    string RailBackground,
    string Surface,
    string SurfaceAlt,
    string Text,
    string MutedText,
    string Border,
    string ChatBackground,
    string IncomingBubble,
    string OutgoingBubble,
    string OutgoingText);

public static class AppTheme
{
    public static AppThemePalette GetPalette(ThemeKind theme) => theme switch
    {
        ThemeKind.DM => new AppThemePalette(
            Accent: "#5B5CF6",
            AccentText: "#FFFFFF",
            WindowBackground: "#F7F8FC",
            RailBackground: "#FFFFFF",
            Surface: "#FFFFFF",
            SurfaceAlt: "#F1F3F8",
            Text: "#151821",
            MutedText: "#7A8191",
            Border: "#E6E9F0",
            ChatBackground: "#FFFFFF",
            IncomingBubble: "#F1F2F5",
            OutgoingBubble: "#5B5CF6",
            OutgoingText: "#FFFFFF"),
        // The classic theme keeps its blue-grey chrome so switching themes is actually visible;
        // DM stays white. Both previously shared a white surface and looked identical.
        _ => new AppThemePalette(
            Accent: "#FEE500",
            AccentText: "#191919",
            WindowBackground: "#9BB2C6",
            RailBackground: "#E7EDF2",
            Surface: "#EDF1F5",
            SurfaceAlt: "#DCE5ED",
            Text: "#191919",
            MutedText: "#6E757D",
            Border: "#CFD9E2",
            ChatBackground: "#B2C7D9",
            IncomingBubble: "#FFFFFF",
            OutgoingBubble: "#FEE500",
            OutgoingText: "#191919"),
    };

    public static System.Windows.Media.SolidColorBrush Brush(string hex)
    {
        var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(hex)!;
        return new System.Windows.Media.SolidColorBrush(color);
    }
}
