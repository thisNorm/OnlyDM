using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;
using System.Windows.Threading;
using WpfApplication = System.Windows.Application;

namespace OnlyDM;

public sealed class TrayIconService : IDisposable
{
    private const string AppIconAsset = "OnlyDM.ico";
    private static readonly (string Korean, string English)[] WorkModeMessages =
    [
        ("점검이 필요합니다.", "A check is required."),
        ("처리 대기 중인 항목이 있습니다.", "An item is pending."),
        ("작업 상태를 확인해 주세요.", "Check the task status."),
        ("새로운 확인 요청이 있습니다.", "A new review has been requested."),
        ("다음 점검 일정을 확인해 주세요.", "Check the next scheduled review."),
    ];

    private readonly NotifyIcon _notifyIcon;
    private readonly ContextMenuStrip _menu;
    private readonly Font _menuFont = new("Segoe UI", 10);
    private readonly Icon _icon;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _settingsItem;
    private readonly ToolStripMenuItem _themeMenu;
    private readonly ToolStripMenuItem _exitItem;
    private readonly ToolStripMenuItem _lightThemeItem;
    private readonly ToolStripMenuItem _darkThemeItem;
    private readonly ToolStripMenuItem _customThemeItem;
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly ToolStripMenuItem _notificationsItem;
    private readonly ToolStripMenuItem _notificationPreviewItem;
    private readonly ToolStripMenuItem _workModeItem;
    private readonly Queue<(string Title, string Body, Action Click, bool WorkMode)> _pendingNotifications = new();
    private readonly DispatcherTimer _notificationTimeout = new(DispatcherPriority.Background)
    {
        // The shell can suppress a balloon without reporting that it ended.
        Interval = TimeSpan.FromSeconds(30),
    };
    private DispatcherOperation? _notificationDispatch;
    private NotifyIcon? _fallbackIcon;
    private Action? _activeNotificationClick;
    private int _notificationCancellationVersion;
    private int _unreadCount;
    private bool _trayBalloonShown;
    private bool _useFallbackIcon;
    private bool _notificationsEnabled = true;
    private bool _notificationPreviewEnabled = true;
    private bool _updatingMenu;
    private bool _disposed;
    private bool _workModeEnabled;
    private AppLanguage _language = AppLanguage.Auto;

    public TrayIconService(Action openAction, Action settingsAction, Action exitAction)
    {
        ArgumentNullException.ThrowIfNull(openAction);
        ArgumentNullException.ThrowIfNull(settingsAction);
        ArgumentNullException.ThrowIfNull(exitAction);

        _menu = new ContextMenuStrip
        {
            Font = _menuFont,
            Padding = new Padding(5),
            ShowImageMargin = false,
        };

        _openItem = new ToolStripMenuItem("OnlyDM 열기");
        _openItem.Click += (_, _) => openAction();
        _settingsItem = new ToolStripMenuItem("설정");
        _settingsItem.Click += (_, _) => settingsAction();

        _themeMenu = new ToolStripMenuItem("테마");
        _lightThemeItem = new ToolStripMenuItem("Light") { CheckOnClick = true };
        _darkThemeItem = new ToolStripMenuItem("Dark") { CheckOnClick = true };
        _customThemeItem = new ToolStripMenuItem("사용자 지정") { CheckOnClick = true };
        _lightThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.Light);
        _darkThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.Dark);
        _customThemeItem.Click += (_, _) => SetThemeFromTray(ThemeKind.Custom);
        _themeMenu.DropDownItems.Add(_lightThemeItem);
        _themeMenu.DropDownItems.Add(_darkThemeItem);
        _themeMenu.DropDownItems.Add(_customThemeItem);
        if (_themeMenu.DropDown is ToolStripDropDownMenu themeMenu)
        {
            themeMenu.Padding = _menu.Padding;
            themeMenu.ShowImageMargin = false;
            themeMenu.ShowCheckMargin = true;
        }

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
            NotificationsChanged?.Invoke(_notificationsItem.Checked);
        };

        _notificationPreviewItem.Click += (_, _) =>
        {
            if (_updatingMenu) return;
            NotificationPreviewChanged?.Invoke(_notificationPreviewItem.Checked);
        };

        _workModeItem = new ToolStripMenuItem("열일 모드") { CheckOnClick = true };
        _workModeItem.Click += (_, _) =>
        {
            if (_updatingMenu) return;
            WorkModeChanged?.Invoke(_workModeItem.Checked);
        };

        _exitItem = new ToolStripMenuItem("종료");
        _exitItem.Click += (_, _) => exitAction();

        _menu.Items.Add(_openItem);
        _menu.Items.Add(_settingsItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_notificationsItem);
        _menu.Items.Add(_workModeItem);
        _menu.Items.Add(_notificationPreviewItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_themeMenu);
        _menu.Items.Add(_autoStartItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_exitItem);

        foreach (var item in new[] { _openItem, _settingsItem, _notificationsItem, _workModeItem,
                     _notificationPreviewItem, _themeMenu, _autoStartItem, _exitItem, _lightThemeItem, _darkThemeItem, _customThemeItem })
            item.Padding = new Padding(9, 5, 12, 5);

        _icon = LoadIcon();
        _notifyIcon = CreateNotificationIcon();
        _notifyIcon.ContextMenuStrip = _menu;
        _notifyIcon.DoubleClick += (_, _) => openAction();
        _notifyIcon.BalloonTipShown += (_, _) =>
        {
            if (!_useFallbackIcon && _activeNotificationClick is not null) _trayBalloonShown = true;
        };
        _notifyIcon.Visible = true;
        _notificationTimeout.Tick += (_, _) => CompleteNotification(clicked: false, useFallback: true);
    }

    public event Action<ThemeKind>? ThemeChanged;
    public event Action<bool>? AutoStartChanged;
    public event Action<bool>? NotificationsChanged;
    public event Action<bool>? NotificationPreviewChanged;
    public event Action<bool>? WorkModeChanged;

    public void UpdateQuickSettings(AppSettings settings, bool autoStartEnabled)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _updatingMenu = true;
        try
        {
            _language = settings.Language;
            ApplyLanguage();
            UpdateUnreadCount(_unreadCount);
            _lightThemeItem.Checked = settings.Theme == ThemeKind.Light;
            _darkThemeItem.Checked = settings.Theme == ThemeKind.Dark;
            _customThemeItem.Checked = settings.Theme == ThemeKind.Custom;
            ApplyTheme(settings.Theme, settings.CustomAppColors);
            _autoStartItem.Checked = autoStartEnabled;
            _notificationsEnabled = _notificationsItem.Checked = settings.NotificationsEnabled;
            if (!_notificationsEnabled)
            {
                _pendingNotifications.Clear();
                _notificationCancellationVersion++;
                CompleteNotification(clicked: false, useFallback: true);
            }
            _workModeEnabled = settings.WorkModeEnabled;
            _workModeItem.Checked = _workModeEnabled;
            _workModeItem.Enabled = settings.NotificationsEnabled;
            _notificationPreviewEnabled = _notificationPreviewItem.Checked = settings.NotificationPreviewEnabled;
            _notificationPreviewItem.Enabled = settings.NotificationsEnabled && !_workModeEnabled;
            foreach (var item in new[] { _notificationsItem, _workModeItem, _notificationPreviewItem, _autoStartItem })
                item.ShortcutKeyDisplayString = item.Checked ? Text("켬", "On") : Text("끔", "Off");
            if (settings.NotificationsEnabled && _workModeEnabled)
                _notificationPreviewItem.ShortcutKeyDisplayString = Text("일시 중지", "Paused");
        }
        finally
        {
            _updatingMenu = false;
        }
    }

    public void UpdateUnreadCount(int unread)
    {
        _unreadCount = unread;
        // NotifyIcon.Text is capped at 63 characters by the shell.
        _notifyIcon.Text = unread > 0
            ? Text($"OnlyDM - 읽지 않은 대화 {unread}개", $"OnlyDM - {unread} unread")
            : "OnlyDM";
    }

    public void ShowNotification(string title, string body, Action clickAction)
    {
        if (_disposed || !_notificationsEnabled) return;
        ArgumentNullException.ThrowIfNull(clickAction);

        _pendingNotifications.Enqueue((
            _workModeEnabled ? string.Empty : title,
            _workModeEnabled || !_notificationPreviewEnabled ? string.Empty : body,
            clickAction,
            _workModeEnabled));
        ScheduleNextNotification();
    }

    private NotifyIcon CreateNotificationIcon()
    {
        var icon = new NotifyIcon { Text = "OnlyDM", Icon = _icon };
        icon.BalloonTipClicked += (sender, _) => OnBalloonEnded(sender, clicked: true);
        icon.BalloonTipClosed += (sender, _) => OnBalloonEnded(sender, clicked: false);
        return icon;
    }

    private void ScheduleNextNotification()
    {
        if (_disposed || _activeNotificationClick is not null || _notificationDispatch is not null
            || _pendingNotifications.Count == 0) return;

        _notificationDispatch = Dispatcher.CurrentDispatcher.BeginInvoke(
            DispatcherPriority.Background, new Action(ShowNextNotification));
    }

    private void ShowNextNotification()
    {
        _notificationDispatch = null;
        if (_disposed || !_notificationsEnabled || !_pendingNotifications.TryDequeue(out var notification)) return;

        var (title, body, click, workMode) = notification;
        _trayBalloonShown = false;
        _activeNotificationClick = click;

        // An unresolved tray balloon can still send callbacks. Isolate later requests
        // for this tray session with one temporary callback target per balloon.
        if (_useFallbackIcon)
        {
            var cancellationVersion = _notificationCancellationVersion;
            _fallbackIcon = CreateNotificationIcon();
            _fallbackIcon.Visible = true;
            if (_disposed || cancellationVersion != _notificationCancellationVersion) return;
        }

        if (_workModeEnabled || workMode)
        {
            var notice = WorkModeMessages[Random.Shared.Next(WorkModeMessages.Length)];
            title = Text("시스템", "System");
            body = Text(notice.Korean, notice.English);
        }
        else if (!_notificationPreviewEnabled || string.IsNullOrWhiteSpace(body))
        {
            body = Text("새 메시지가 도착했습니다.", "A new message has arrived.");
        }

        _notificationTimeout.Start();
        (_fallbackIcon ?? _notifyIcon).ShowBalloonTip(
            5000, string.IsNullOrWhiteSpace(title) ? "OnlyDM" : title, body, ToolTipIcon.None);
    }

    private void OnBalloonEnded(object? sender, bool clicked)
    {
        if (!ReferenceEquals(sender, _fallbackIcon ?? _notifyIcon)) return;
        if (_fallbackIcon is null && !_trayBalloonShown) return;

        // On Windows 10 a balloon can stay in Notification Center after its banner.
        var mayRemainInHistory = !clicked && _fallbackIcon is null
            && !OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000);
        CompleteNotification(clicked, useFallback: mayRemainInHistory);
    }

    private void CompleteNotification(bool clicked, bool useFallback)
    {
        if (_disposed || _activeNotificationClick is not { } action) return;

        var cancellationVersion = _notificationCancellationVersion;
        _activeNotificationClick = null;
        _notificationTimeout.Stop();
        _useFallbackIcon |= useFallback;

        // Hold the dispatcher slot until click routing returns, including nested dispatch.
        _notificationDispatch = Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
        {
            try
            {
                _fallbackIcon?.Dispose();
                _fallbackIcon = null;
                if (clicked && cancellationVersion == _notificationCancellationVersion) action();
            }
            finally
            {
                _notificationDispatch = null;
                ScheduleNextNotification();
            }
        }));
    }

    private void SetThemeFromTray(ThemeKind theme)
    {
        if (_updatingMenu) return;
        _updatingMenu = true;
        try
        {
            _lightThemeItem.Checked = theme == ThemeKind.Light;
            _darkThemeItem.Checked = theme == ThemeKind.Dark;
            _customThemeItem.Checked = theme == ThemeKind.Custom;
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
        _lightThemeItem.Text = Text("라이트", "Light");
        _darkThemeItem.Text = Text("다크", "Dark");
        _customThemeItem.Text = Text("사용자 지정", "Custom");
        _autoStartItem.Text = Text("Windows 시작 시 자동 실행", "Start with Windows");
        _notificationsItem.Text = Text("알림 받기", "Notifications");
        _notificationPreviewItem.Text = Text("메시지 내용 표시", "Show message previews");
        _workModeItem.Text = Text("열일 모드", "Work mode");
        _exitItem.Text = Text("종료", "Exit");
    }

    private void ApplyTheme(ThemeKind theme, AppColors? colors)
    {
        var palette = AppTheme.GetPalette(theme, colors);
        var highContrast = SystemInformation.HighContrast;
        _menu.Renderer = highContrast ? new ToolStripSystemRenderer() : new TrayMenuRenderer(palette);
        _menu.BackColor = highContrast ? SystemColors.Menu : ColorTranslator.FromHtml(palette.Surface);
        _menu.ForeColor = highContrast ? SystemColors.MenuText : ColorTranslator.FromHtml(palette.Text);
        foreach (ToolStripItem item in _menu.Items)
        {
            item.BackColor = _menu.BackColor;
            item.ForeColor = _menu.ForeColor;
        }
        _themeMenu.DropDown.BackColor = _menu.BackColor;
        _themeMenu.DropDown.ForeColor = _menu.ForeColor;
        _themeMenu.DropDown.Renderer = _menu.Renderer;
        _lightThemeItem.BackColor = _darkThemeItem.BackColor = _menu.BackColor;
        _lightThemeItem.ForeColor = _darkThemeItem.ForeColor = _menu.ForeColor;
        _customThemeItem.BackColor = _menu.BackColor;
        _customThemeItem.ForeColor = _menu.ForeColor;
    }

    private sealed class TrayMenuRenderer(AppThemePalette palette) : ToolStripProfessionalRenderer(new TrayMenuColors(palette))
    {
        private readonly Color _muted = ColorTranslator.FromHtml(palette.MutedText);
        private readonly Color _text = ColorTranslator.FromHtml(palette.Text);

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? _text : _muted;
            base.OnRenderItemText(e);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = e.Item?.Enabled == true ? _text : _muted;
            base.OnRenderArrow(e);
        }
    }

    private sealed class TrayMenuColors(AppThemePalette palette) : ProfessionalColorTable
    {
        private readonly Color _surface = ColorTranslator.FromHtml(palette.Surface);
        private readonly Color _hover = ColorTranslator.FromHtml(palette.SurfaceAlt);
        private readonly Color _border = ColorTranslator.FromHtml(palette.Border);

        public override Color ToolStripDropDownBackground => _surface;
        public override Color MenuBorder => _border;
        public override Color MenuItemSelected => _hover;
        public override Color MenuItemBorder => _hover;
        public override Color MenuItemSelectedGradientBegin => _hover;
        public override Color MenuItemSelectedGradientEnd => _hover;
        public override Color ImageMarginGradientBegin => _surface;
        public override Color ImageMarginGradientMiddle => _surface;
        public override Color ImageMarginGradientEnd => _surface;
        public override Color SeparatorDark => _border;
        public override Color SeparatorLight => _surface;
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
        _pendingNotifications.Clear();
        _notificationDispatch?.Abort();
        _notificationDispatch = null;
        _activeNotificationClick = null;
        _notificationTimeout.Stop();
        _fallbackIcon?.Dispose();
        _fallbackIcon = null;
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menu.Dispose();
        _menuFont.Dispose();
        _icon.Dispose();
    }
}
