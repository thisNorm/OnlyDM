using System;
using System.Windows;
using MessageBox = System.Windows.MessageBox;

namespace OnlyDM;

public partial class SettingsWindow : Window
{
    private readonly AppSettings _settings;
    private ThemeKind _selectedTheme;

    public SettingsWindow(AppSettings settings)
    {
        InitializeComponent();
        _settings = new AppSettings
        {
            Theme = settings.Theme,
            NotificationsEnabled = settings.NotificationsEnabled,
            StartInTray = settings.StartInTray,
            NotificationPreviewEnabled = settings.NotificationPreviewEnabled,
        };
        _selectedTheme = _settings.Theme;
        AutoStartCheckBox.IsChecked = StartupManager.IsEnabled();
        NotificationEnabledCheckBox.IsChecked = _settings.NotificationsEnabled;
        NotificationPreviewCheckBox.IsChecked = _settings.NotificationPreviewEnabled;
        StartInTrayCheckBox.IsChecked = _settings.StartInTray;
        RefreshSelection();
        RefreshNotificationControls();
    }

    public AppSettings SavedSettings => _settings;

    public enum SettingsAction
    {
        None,
        SwitchAccount,
        Logout,
    }

    public SettingsAction RequestedAction { get; private set; } = SettingsAction.None;

    private void SwitchAccountButton_Click(object sender, RoutedEventArgs e)
    {
        RequestedAction = SettingsAction.SwitchAccount;
        SaveButton_Click(sender, e);
    }

    private void LogoutButton_Click(object sender, RoutedEventArgs e)
    {
        RequestedAction = SettingsAction.Logout;
        SaveButton_Click(sender, e);
    }

    private void ClassicThemeButton_Click(object sender, RoutedEventArgs e)
    {
        _selectedTheme = ThemeKind.Classic;
        RefreshSelection();
    }

    private void DmThemeButton_Click(object sender, RoutedEventArgs e)
    {
        _selectedTheme = ThemeKind.DM;
        RefreshSelection();
    }

    private void RefreshSelection()
    {
        var classicSelected = AppTheme.Brush("#F0B800");
        var dmSelected = AppTheme.Brush("#5B5CF6");
        var normal = AppTheme.Brush("#E2E5EA");

        ClassicThemeCard.BorderBrush = _selectedTheme == ThemeKind.Classic ? classicSelected : normal;
        ClassicThemeCard.BorderThickness = new Thickness(_selectedTheme == ThemeKind.Classic ? 2 : 1.5);
        DmThemeCard.BorderBrush = _selectedTheme == ThemeKind.DM ? dmSelected : normal;
        DmThemeCard.BorderThickness = new Thickness(_selectedTheme == ThemeKind.DM ? 2 : 1.5);
    }

    private void NotificationEnabledCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        RefreshNotificationControls();
    }

    private void RefreshNotificationControls()
    {
        if (NotificationPreviewCheckBox is null) return;
        NotificationPreviewCheckBox.IsEnabled = NotificationEnabledCheckBox.IsChecked == true;
    }

    private void SaveButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            _settings.Theme = _selectedTheme;
            _settings.NotificationsEnabled = NotificationEnabledCheckBox.IsChecked == true;
            _settings.NotificationPreviewEnabled = NotificationPreviewCheckBox.IsChecked == true;
            _settings.StartInTray = StartInTrayCheckBox.IsChecked == true;
            SettingsStore.Save(_settings);
            StartupManager.SetEnabled(AutoStartCheckBox.IsChecked == true);
            DialogResult = true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"설정을 저장하지 못했습니다.\n\n{ex.Message}",
                "OnlyDM 설정",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
