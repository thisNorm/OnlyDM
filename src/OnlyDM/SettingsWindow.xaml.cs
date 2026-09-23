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
            Language = settings.Language,
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
        WpfLanguage.Apply(this, _settings.Language);
        RefreshSelection();
        RefreshLanguageSelection();
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

    private void LightThemeButton_Click(object sender, RoutedEventArgs e)
    {
        _selectedTheme = ThemeKind.Light;
        RefreshSelection();
    }

    private void DarkThemeButton_Click(object sender, RoutedEventArgs e)
    {
        _selectedTheme = ThemeKind.Dark;
        RefreshSelection();
    }

    private void AutoLanguageButton_Click(object sender, RoutedEventArgs e) => SelectLanguage(AppLanguage.Auto);
    private void KoreanLanguageButton_Click(object sender, RoutedEventArgs e) => SelectLanguage(AppLanguage.Korean);
    private void EnglishLanguageButton_Click(object sender, RoutedEventArgs e) => SelectLanguage(AppLanguage.English);

    private void SelectLanguage(AppLanguage language)
    {
        _settings.Language = language;
        WpfLanguage.Apply(this, language);
        RefreshLanguageSelection();
    }

    private void RefreshLanguageSelection()
    {
        var palette = AppTheme.GetPalette(_selectedTheme);
        foreach (var (button, value) in new[]
                 {
                     (AutoLanguageButton, AppLanguage.Auto),
                     (KoreanLanguageButton, AppLanguage.Korean),
                     (EnglishLanguageButton, AppLanguage.English),
                 })
        {
            var selected = _settings.Language == value;
            button.Background = selected ? AppTheme.Brush(palette.Accent) : System.Windows.Media.Brushes.Transparent;
            button.Foreground = selected ? AppTheme.Brush(palette.AccentText) : AppTheme.Brush(palette.MutedText);
        }
    }

    private void RefreshSelection()
    {
        var palette = AppTheme.GetPalette(_selectedTheme);
        ApplyWindowTheme(palette);
        var selected = AppTheme.Brush(palette.Accent);
        var normal = AppTheme.Brush(palette.Border);

        LightThemeCard.BorderBrush = _selectedTheme == ThemeKind.Light ? selected : normal;
        LightThemeCard.BorderThickness = new Thickness(_selectedTheme == ThemeKind.Light ? 2 : 1.5);
        DarkThemeCard.BorderBrush = _selectedTheme == ThemeKind.Dark ? selected : normal;
        DarkThemeCard.BorderThickness = new Thickness(_selectedTheme == ThemeKind.Dark ? 2 : 1.5);
        RefreshLanguageSelection();
    }

    private void ApplyWindowTheme(AppThemePalette palette)
    {
        Resources["ThemeWindowBrush"] = AppTheme.Brush(palette.WindowBackground);
        Resources["ThemeSurfaceBrush"] = AppTheme.Brush(palette.Surface);
        Resources["ThemeSurfaceAltBrush"] = AppTheme.Brush(palette.SurfaceAlt);
        Resources["ThemeTextBrush"] = AppTheme.Brush(palette.Text);
        Resources["ThemeMutedBrush"] = AppTheme.Brush(palette.MutedText);
        Resources["ThemeBorderBrush"] = AppTheme.Brush(palette.Border);
        SaveButton.Background = AppTheme.Brush(palette.Accent);
        SaveButton.Foreground = AppTheme.Brush(palette.AccentText);
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
                $"{AppLanguageChoice.Text(_settings.Language, "설정을 저장하지 못했습니다.", "Could not save settings.")}\n\n{ex.Message}",
                AppLanguageChoice.Text(_settings.Language, "OnlyDM 설정", "OnlyDM Settings"),
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
