namespace OnlyDM;

public sealed class AppSettings
{
    public AppLanguage Language { get; set; } = AppLanguage.Auto;
    public ThemeKind Theme { get; set; } = ThemeKind.Light;
    public bool NotificationsEnabled { get; set; } = true;
    public bool NotificationPreviewEnabled { get; set; } = true;
    public bool StartInTray { get; set; }
}
