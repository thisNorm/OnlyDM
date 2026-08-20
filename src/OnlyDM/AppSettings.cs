namespace OnlyDM;

public sealed class AppSettings
{
    public ThemeKind Theme { get; set; } = ThemeKind.Classic;
    public bool NotificationsEnabled { get; set; } = true;
    public bool NotificationPreviewEnabled { get; set; } = true;
    public bool StartInTray { get; set; }
}
