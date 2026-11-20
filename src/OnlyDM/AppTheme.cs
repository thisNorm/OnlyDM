namespace OnlyDM;

public enum ThemeKind
{
    Light,
    Dark,
    Custom,
}

public sealed record ChatColors(string Background, string Incoming, string Outgoing)
{
    public static ChatColors Default { get; } = new("#FFFFFF", "#F0F2F4", "#4257C9");

    public static bool TryNormalizeHex(string? value, out string hex)
    {
        var digits = value?.Trim() ?? string.Empty;
        if (digits.StartsWith('#')) digits = digits[1..];
        if (digits.Length == 6 && digits.All(char.IsAsciiHexDigit))
        {
            hex = "#" + digits.ToUpperInvariant();
            return true;
        }
        hex = string.Empty;
        return false;
    }

    public ChatColors Normalize() => new(
        TryNormalizeHex(Background, out var bg) ? bg : Default.Background,
        TryNormalizeHex(Incoming, out var incoming) ? incoming : Default.Incoming,
        TryNormalizeHex(Outgoing, out var outgoing) ? outgoing : Default.Outgoing);

    public static string TextOn(string validHex)
    {
        static double Linear(int channel)
        {
            var value = channel / 255.0;
            return value <= 0.04045 ? value / 12.92 : Math.Pow((value + 0.055) / 1.055, 2.4);
        }
        var luminance = 0.2126 * Linear(Convert.ToInt32(validHex.Substring(1, 2), 16))
            + 0.7152 * Linear(Convert.ToInt32(validHex.Substring(3, 2), 16))
            + 0.0722 * Linear(Convert.ToInt32(validHex.Substring(5, 2), 16));
        return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
    }
}

public sealed record AppColors(string Chrome, string Background)
{
    public static AppColors Default { get; } = new("#EEF1F5", "#FFFFFF");

    public AppColors Normalize() => new(
        ChatColors.TryNormalizeHex(Chrome, out var chrome) ? chrome : Default.Chrome,
        ChatColors.TryNormalizeHex(Background, out var background) ? background : Default.Background);
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
    string OutgoingText)
{
    public string IncomingText { get; init; } = Text;
    public string ChromeBackground { get; init; } = Surface;
    public string ChromeText { get; init; } = Text;
    public string ChromeMutedText { get; init; } = MutedText;
    public string ChromeHover { get; init; } = Border;
}

public static class AppTheme
{
    public static AppThemePalette GetPalette(ThemeKind theme, AppColors? colors = null)
    {
        if (theme == ThemeKind.Custom)
        {
            var custom = (colors ?? AppColors.Default).Normalize();
            var text = ChatColors.TextOn(custom.Background);
            var chromeText = ChatColors.TextOn(custom.Chrome);
            return GetPalette(text == "#FFFFFF" ? ThemeKind.Dark : ThemeKind.Light) with
            {
                WindowBackground = custom.Background,
                Surface = custom.Background,
                SurfaceAlt = Tint(custom.Background, 0.07),
                Text = text,
                MutedText = text,
                Border = Tint(custom.Background, 0.18),
                RailBackground = custom.Chrome,
                ChromeBackground = custom.Chrome,
                ChromeText = chromeText,
                ChromeMutedText = chromeText,
                ChromeHover = Tint(custom.Chrome, 0.12),
            };
        }

        return theme switch
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
            ChatBackground: ChatColors.Default.Background,
            IncomingBubble: ChatColors.Default.Incoming,
            OutgoingBubble: ChatColors.Default.Outgoing,
            OutgoingText: "#FFFFFF"),
        };
    }

    private static string Tint(string background, double amount)
    {
        var text = ChatColors.TextOn(background);
        string Mix(string toward)
        {
            var channels = new int[3];
            for (var index = 0; index < channels.Length; index++)
            {
                var start = 1 + index * 2;
                var from = Convert.ToInt32(background.Substring(start, 2), 16);
                var to = Convert.ToInt32(toward.Substring(start, 2), 16);
                channels[index] = (int)Math.Round(from + (to - from) * amount);
            }
            return $"#{channels[0]:X2}{channels[1]:X2}{channels[2]:X2}";
        }
        var tinted = Mix(text);
        // Preserve text contrast even when the chosen color is near mid-gray.
        return ChatColors.TextOn(tinted) == text ? tinted : Mix(text == "#FFFFFF" ? "#000000" : "#FFFFFF");
    }

    public static AppThemePalette GetChatPalette(ThemeKind theme, ChatColors? colors)
    {
        if (theme != ThemeKind.Custom) return GetPalette(theme);
        var custom = (colors ?? ChatColors.Default).Normalize();
        var text = ChatColors.TextOn(custom.Background);
        var basePalette = GetPalette(text == "#FFFFFF" ? ThemeKind.Dark : ThemeKind.Light);
        return basePalette with
        {
            ChatBackground = custom.Background,
            IncomingBubble = custom.Incoming,
            OutgoingBubble = custom.Outgoing,
            Text = text,
            IncomingText = ChatColors.TextOn(custom.Incoming),
            OutgoingText = ChatColors.TextOn(custom.Outgoing),
            MutedText = text,
        };
    }

    public static System.Windows.Media.SolidColorBrush Brush(string hex)
    {
        var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(hex)!;
        return new System.Windows.Media.SolidColorBrush(color);
    }
}
