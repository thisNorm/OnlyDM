namespace OnlyDM;

public enum ThemeKind
{
    Light,
    Dark,
}

public sealed record AppThemePalette(
    bool IsDark,
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
        ThemeKind.Dark => new AppThemePalette(
            IsDark: true,
            Accent: "#4257C9",
            AccentText: "#FFFFFF",
            WindowBackground: "#15181D",
            RailBackground: "#111318",
            Surface: "#1F232B",
            SurfaceAlt: "#2A303A",
            Text: "#F2F4F8",
            MutedText: "#AAB1BD",
            Border: "#343B47",
            ChatBackground: "#181C22",
            IncomingBubble: "#2A303A",
            OutgoingBubble: "#4257C9",
            OutgoingText: "#FFFFFF"),
        _ => new AppThemePalette(
            IsDark: false,
            Accent: "#4257C9",
            AccentText: "#FFFFFF",
            WindowBackground: "#F3F5F8",
            RailBackground: "#EEF1F5",
            Surface: "#FFFFFF",
            SurfaceAlt: "#EEF1F5",
            Text: "#171A21",
            MutedText: "#687080",
            Border: "#DEE3EA",
            ChatBackground: "#E9EEF4",
            IncomingBubble: "#FFFFFF",
            OutgoingBubble: "#4257C9",
            OutgoingText: "#FFFFFF"),
    };

    public static System.Windows.Media.SolidColorBrush Brush(string hex)
    {
        var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(hex)!;
        return new System.Windows.Media.SolidColorBrush(color);
    }
}
