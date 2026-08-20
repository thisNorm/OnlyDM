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
    private readonly ToolStripMenuItem _classicThemeItem;
    private readonly ToolStripMenuItem _dmThemeItem;
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly ToolStripMenuItem _notificationsItem;
    private readonly ToolStripMenuItem _notificationPreviewItem;
    private Action? _pendingNotificationClick;
    private bool _updatingMenu;
    private bool _disposed;

    public TrayIconService(Action openAction, Action settingsAction, Action exitAction)
    {
        ArgumentNullException.ThrowIfNull(openAction);
        ArgumentNullException.ThrowIfNull(settingsAction);
        ArgumentNullException.ThrowIfNull(exitAction);

        _menu = new ContextMenuStrip();

        var openItem = new ToolStripMenuItem("OnlyDM 열기");
        openItem.Click += (_, _) => openAction();
        var settingsItem = new ToolStripMenuItem("설정");
        settingsItem.Click += (_, _) => settingsAction();

        var themeMenu = new ToolStripMenuItem("테마");
        _classicThemeItem = new ToolStripMenuItem("Classic") { CheckOnClick = true };
        _dmThemeItem = new ToolStripMenuItem("DM") { CheckOnClick = true };
        _classicThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.Classic);
        _dmThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.DM);
        themeMenu.DropDownItems.Add(_classicThemeItem);
        themeMenu.DropDownItems.Add(_dmThemeItem);

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

        var exitItem = new ToolStripMenuItem("종료");
        exitItem.Click += (_, _) => exitAction();

        _menu.Items.Add(openItem);
        _menu.Items.Add(settingsItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(themeMenu);
        _menu.Items.Add(_autoStartItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_notificationsItem);
        _menu.Items.Add(_notificationPreviewItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(exitItem);

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
        _notifyIcon.Text = unread > 0 ? $"OnlyDM - 읽지 않은 대화 {unread}개" : "OnlyDM";
    }

    public void ShowNotification(string title, string body, Action clickAction)
    {
        if (_disposed) return;
        _pendingNotificationClick = clickAction;
        _notifyIcon.BalloonTipTitle = string.IsNullOrWhiteSpace(title) ? "OnlyDM" : title;
        _notifyIcon.BalloonTipText = string.IsNullOrWhiteSpace(body) ? "새 메시지가 도착했습니다." : body;
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
