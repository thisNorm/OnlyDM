using System;
using System.Drawing;
using System.Windows.Forms;
using WpfApplication = System.Windows.Application;

namespace OnlyDM;

public sealed class TrayIconService : IDisposable
{
    private const string AppIconAsset = "OnlyDM.ico";

    private readonly NotifyIcon _notifyIcon;
    private readonly ContextMenuStrip _menu;
    private readonly Icon _icon;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _settingsItem;
    private readonly ToolStripMenuItem _themeMenu;
    private readonly ToolStripMenuItem _exitItem;
    private readonly ToolStripMenuItem _classicThemeItem;
    private readonly ToolStripMenuItem _dmThemeItem;
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly ToolStripMenuItem _notificationsItem;
    private readonly ToolStripMenuItem _notificationPreviewItem;
    private Action? _pendingNotificationClick;
    private bool _updatingMenu;
    private bool _disposed;
    private AppLanguage _language = AppLanguage.Auto;

    public TrayIconService(Action openAction, Action settingsAction, Action exitAction)
    {
        ArgumentNullException.ThrowIfNull(openAction);
        ArgumentNullException.ThrowIfNull(settingsAction);
        ArgumentNullException.ThrowIfNull(exitAction);

        _menu = new ContextMenuStrip();

        _openItem = new ToolStripMenuItem("OnlyDM 열기");
        _openItem.Click += (_, _) => openAction();
        _settingsItem = new ToolStripMenuItem("설정");
        _settingsItem.Click += (_, _) => settingsAction();

        _themeMenu = new ToolStripMenuItem("테마");
        _classicThemeItem = new ToolStripMenuItem("Classic") { CheckOnClick = true };
        _dmThemeItem = new ToolStripMenuItem("DM") { CheckOnClick = true };
        _classicThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.Classic);
        _dmThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.DM);
        _themeMenu.DropDownItems.Add(_classicThemeItem);
        _themeMenu.DropDownItems.Add(_dmThemeItem);

        _autoStartItem = new ToolStripMenuItem("Windows 시작 시 자동 실행") { CheckOnClick = true };
        _autoStartItem.Click += (_, _) =>
        {
            if (_updatingMenu) return;
            AutoStartChanged?.Invoke(_autoStartItem.Checked);
        };

        _notificationPreviewItem = new ToolStripMenuItem("메시지 내용 표시") { CheckOnClick = true };
        _notificationsItem = new ToolStripMenuItem("알림 받기") { CheckOnClick = true };
        _notificationsItem.Click += (_, _) =>
        {
            if (_updatingMenu) return;
            _notificationPreviewItem.Enabled = _notificationsItem.Checked;
            NotificationsChanged?.Invoke(_notificationsItem.Checked);
        };

        _notificationPreviewItem.Click += (_, _) =>
        {
            if (_updatingMenu) return;
            NotificationPreviewChanged?.Invoke(_notificationPreviewItem.Checked);
        };

        _exitItem = new ToolStripMenuItem("종료");
        _exitItem.Click += (_, _) => exitAction();

        _menu.Items.Add(_openItem);
        _menu.Items.Add(_settingsItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_themeMenu);
        _menu.Items.Add(_autoStartItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_notificationsItem);
        _menu.Items.Add(_notificationPreviewItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_exitItem);

        _icon = LoadIcon();
        _notifyIcon = new NotifyIcon
        {
            Text = "OnlyDM",
            Icon = _icon,
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => openAction();
        _notifyIcon.BalloonTipClicked += (_, _) =>
        {
            var action = _pendingNotificationClick;
            _pendingNotificationClick = null;
            action?.Invoke();
        };
        _notifyIcon.BalloonTipClosed += (_, _) => _pendingNotificationClick = null;
    }

    public event Action<ThemeKind>? ThemeChanged;
    public event Action<bool>? AutoStartChanged;
    public event Action<bool>? NotificationsChanged;
    public event Action<bool>? NotificationPreviewChanged;

    public void UpdateQuickSettings(AppSettings settings, bool autoStartEnabled)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _updatingMenu = true;
        try
        {
            _language = settings.Language;
            ApplyLanguage();
            _classicThemeItem.Checked = settings.Theme == ThemeKind.Classic;
            _dmThemeItem.Checked = settings.Theme == ThemeKind.DM;
            _autoStartItem.Checked = autoStartEnabled;
            _notificationsItem.Checked = settings.NotificationsEnabled;
            _notificationPreviewItem.Checked = settings.NotificationPreviewEnabled;
            _notificationPreviewItem.Enabled = settings.NotificationsEnabled;
        }
        finally
        {
            _updatingMenu = false;
        }
    }

    public void UpdateUnreadCount(int unread)
    {
        // NotifyIcon.Text is capped at 63 characters by the shell.
        _notifyIcon.Text = unread > 0
            ? Text($"OnlyDM - 읽지 않은 대화 {unread}개", $"OnlyDM - {unread} unread")
            : "OnlyDM";
    }

    public void ShowNotification(string title, string body, Action clickAction)
    {
        if (_disposed) return;
        _pendingNotificationClick = clickAction;
        _notifyIcon.BalloonTipTitle = string.IsNullOrWhiteSpace(title) ? "OnlyDM" : title;
        _notifyIcon.BalloonTipText = string.IsNullOrWhiteSpace(body)
            ? Text("새 메시지가 도착했습니다.", "A new message has arrived.")
            : body;
        _notifyIcon.BalloonTipIcon = ToolTipIcon.None;
        _notifyIcon.ShowBalloonTip(5000);
    }

    private void SetThemeFromTray(ThemeKind theme)
    {
        if (_updatingMenu) return;
        _updatingMenu = true;
        try
        {
            _classicThemeItem.Checked = theme == ThemeKind.Classic;
            _dmThemeItem.Checked = theme == ThemeKind.DM;
        }
        finally
        {
            _updatingMenu = false;
        }
        ThemeChanged?.Invoke(theme);
    }

    private string Text(string korean, string english) =>
        AppLanguageChoice.Text(_language, korean, english);

    private void ApplyLanguage()
    {
        _openItem.Text = Text("OnlyDM 열기", "Open OnlyDM");
        _settingsItem.Text = Text("설정", "Settings");
        _themeMenu.Text = Text("테마", "Theme");
        _autoStartItem.Text = Text("Windows 시작 시 자동 실행", "Start with Windows");
        _notificationsItem.Text = Text("알림 받기", "Notifications");
        _notificationPreviewItem.Text = Text("메시지 내용 표시", "Show message previews");
        _exitItem.Text = Text("종료", "Exit");
    }

    private static Icon LoadIcon()
    {
        var uri = new Uri($"pack://application:,,,/Assets/{AppIconAsset}", UriKind.Absolute);
        var streamInfo = WpfApplication.GetResourceStream(uri);
        if (streamInfo?.Stream is not null)
        {
            using var source = new Icon(streamInfo.Stream);
            return (Icon)source.Clone();
        }

        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("OnlyDM executable path is unavailable.");
        return Icon.ExtractAssociatedIcon(executable)
            ?? throw new InvalidOperationException("OnlyDM tray icon could not be loaded.");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _pendingNotificationClick = null;
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menu.Dispose();
        _icon.Dispose();
    }
}
