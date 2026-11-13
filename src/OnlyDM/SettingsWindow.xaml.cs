using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using MessageBox = System.Windows.MessageBox;
using RadioButton = System.Windows.Controls.RadioButton;

namespace OnlyDM;

public partial class SettingsWindow : Window
{
    private AppLanguage _selectedLanguage;
    private ThemeKind _selectedTheme;
    private ChatColors _draftChatColors;
    private bool _syncingSwatches;

    public SettingsWindow(AppSettings settings)
    {
        InitializeComponent();
        SavedSettings = settings;
        _selectedLanguage = settings.Language;
        _selectedTheme = settings.Theme is ThemeKind.Dark or ThemeKind.Custom ? settings.Theme : ThemeKind.Light;
        _draftChatColors = (settings.CustomChatColors ?? ChatColors.Default).Normalize();
        AutoStartCheckBox.IsChecked = StartupManager.IsEnabled();
        NotificationEnabledCheckBox.IsChecked = settings.NotificationsEnabled;
        WorkModeCheckBox.IsChecked = settings.WorkModeEnabled;
        NotificationPreviewCheckBox.IsChecked = settings.NotificationPreviewEnabled;
        StartInTrayCheckBox.IsChecked = settings.StartInTray;
        WpfLanguage.Apply(this, _selectedLanguage);

        foreach (var option in new[] { LightThemeOption, DarkThemeOption, CustomThemeOption })
        {
            option.IsChecked = (ThemeKind)option.Tag == _selectedTheme;
            option.Checked += ThemeOption_Checked;
        }
        RefreshThemeSelection();
        RefreshColorEditor();

        foreach (var option in new[] { BackgroundColorOption, IncomingColorOption, OutgoingColorOption })
            option.Checked += ColorField_Checked;
        foreach (RadioButton swatch in ColorSwatches.Children)
            swatch.Checked += ColorSwatch_Checked;
        ChatHexInput.TextChanged += ChatHexInput_TextChanged;
        ChatHexInput.LostKeyboardFocus += ChatHexInput_LostKeyboardFocus;

        NotificationEnabledCheckBox.Checked += NotificationOptions_Changed;
        NotificationEnabledCheckBox.Unchecked += NotificationOptions_Changed;
        WorkModeCheckBox.Checked += NotificationOptions_Changed;
        WorkModeCheckBox.Unchecked += NotificationOptions_Changed;
        RefreshNotificationControls();
    }

    public AppSettings SavedSettings { get; private set; }

    public enum SettingsAction
    {
        None,
        SwitchAccount,
        Logout,
    }

    public SettingsAction RequestedAction { get; private set; } = SettingsAction.None;

    private void SwitchAccountButton_Click(object sender, RoutedEventArgs e) => SaveSettings(SettingsAction.SwitchAccount);

    private void LogoutButton_Click(object sender, RoutedEventArgs e) => SaveSettings(SettingsAction.Logout);

    private void ThemeOption_Checked(object sender, RoutedEventArgs e)
    {
        _selectedTheme = (ThemeKind)((RadioButton)sender).Tag;
        RefreshThemeSelection();
        RefreshColorEditor();
    }

    private void AutoLanguageButton_Click(object sender, RoutedEventArgs e) => SelectLanguage(AppLanguage.Auto);
    private void KoreanLanguageButton_Click(object sender, RoutedEventArgs e) => SelectLanguage(AppLanguage.Korean);
    private void EnglishLanguageButton_Click(object sender, RoutedEventArgs e) => SelectLanguage(AppLanguage.English);

    private void SelectLanguage(AppLanguage language)
    {
        _selectedLanguage = language;
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
            var selected = _selectedLanguage == value;
            button.Background = selected ? AppTheme.Brush(palette.Accent) : System.Windows.Media.Brushes.Transparent;
            button.Foreground = selected ? AppTheme.Brush(palette.AccentText) : AppTheme.Brush(palette.MutedText);
        }
    }

    private void RefreshThemeSelection()
    {
        ApplyWindowTheme(AppTheme.GetPalette(_selectedTheme));
        CustomColorsPanel.Visibility = _selectedTheme == ThemeKind.Custom ? Visibility.Visible : Visibility.Collapsed;
        RefreshChatPreview();
        RefreshLanguageSelection();
    }

    private void RefreshChatPreview()
    {
        var palette = AppTheme.GetChatPalette(_selectedTheme, _draftChatColors);
        ChatThemePreview.Background = AppTheme.Brush(palette.ChatBackground);
        ChatPreviewTitle.Foreground = AppTheme.Brush(palette.Text);
        IncomingPreviewBubble.Background = AppTheme.Brush(palette.IncomingBubble);
        IncomingPreviewText.Foreground = AppTheme.Brush(palette.IncomingText);
        OutgoingPreviewBubble.Background = AppTheme.Brush(palette.OutgoingBubble);
        OutgoingPreviewText.Foreground = AppTheme.Brush(palette.OutgoingText);

        BackgroundColorOption.Tag = AppTheme.Brush(_draftChatColors.Background);
        IncomingColorOption.Tag = AppTheme.Brush(_draftChatColors.Incoming);
        OutgoingColorOption.Tag = AppTheme.Brush(_draftChatColors.Outgoing);
    }

    private void ColorField_Checked(object sender, RoutedEventArgs e) => RefreshColorEditor();

    private void RefreshColorEditor()
    {
        var color = IncomingColorOption.IsChecked == true ? _draftChatColors.Incoming
            : OutgoingColorOption.IsChecked == true ? _draftChatColors.Outgoing
            : _draftChatColors.Background;
        ChatHexInput.Text = color;
        RefreshSwatchSelection(color);
    }

    private void RefreshSwatchSelection(string? color)
    {
        _syncingSwatches = true;
        foreach (RadioButton swatch in ColorSwatches.Children)
            swatch.IsChecked = Equals(swatch.Content, color);
        _syncingSwatches = false;
    }

    private void ColorSwatch_Checked(object sender, RoutedEventArgs e)
    {
        if (!_syncingSwatches)
            ChatHexInput.Text = (string)((RadioButton)sender).Content;
    }

    private void ChatHexInput_TextChanged(object sender, TextChangedEventArgs e)
    {
        var valid = ChatColors.TryNormalizeHex(ChatHexInput.Text, out var color);
        ChatHexError.Visibility = valid ? Visibility.Collapsed : Visibility.Visible;
        RefreshSwatchSelection(valid ? color : null);
        if (!valid) return;

        _draftChatColors = IncomingColorOption.IsChecked == true ? _draftChatColors with { Incoming = color }
            : OutgoingColorOption.IsChecked == true ? _draftChatColors with { Outgoing = color }
            : _draftChatColors with { Background = color };
        RefreshChatPreview();
    }

    private void ChatHexInput_LostKeyboardFocus(object sender, KeyboardFocusChangedEventArgs e)
    {
        if (ChatColors.TryNormalizeHex(ChatHexInput.Text, out var color) && color != ChatHexInput.Text)
            ChatHexInput.Text = color;
    }

    private void ApplyWindowTheme(AppThemePalette palette)
    {
        Resources["ThemeWindowBrush"] = AppTheme.Brush(palette.WindowBackground);
        Resources["ThemeSurfaceBrush"] = AppTheme.Brush(palette.Surface);
        Resources["ThemeSurfaceAltBrush"] = AppTheme.Brush(palette.SurfaceAlt);
        Resources["ThemeTextBrush"] = AppTheme.Brush(palette.Text);
        Resources["ThemeMutedBrush"] = AppTheme.Brush(palette.MutedText);
        Resources["ThemeBorderBrush"] = AppTheme.Brush(palette.Border);
        Resources["ThemeAccentBrush"] = AppTheme.Brush(palette.Accent);
        Resources["ThemeAccentTextBrush"] = AppTheme.Brush(palette.AccentText);
        SaveButton.Background = AppTheme.Brush(palette.Accent);
        SaveButton.Foreground = AppTheme.Brush(palette.AccentText);
    }

    private void NotificationOptions_Changed(object sender, RoutedEventArgs e)
    {
        RefreshNotificationControls();
    }

    private void RefreshNotificationControls()
    {
        var notificationsEnabled = NotificationEnabledCheckBox.IsChecked == true;
        WorkModeCheckBox.IsEnabled = notificationsEnabled;
        NotificationPreviewCheckBox.IsEnabled = notificationsEnabled && WorkModeCheckBox.IsChecked != true;
    }

    private void SaveButton_Click(object sender, RoutedEventArgs e) => SaveSettings(SettingsAction.None);

    private void SaveSettings(SettingsAction action)
    {
        var saveTheme = action == SettingsAction.None;
        if (saveTheme && _selectedTheme == ThemeKind.Custom && !ChatColors.TryNormalizeHex(ChatHexInput.Text, out _))
        {
            ChatHexInput.Focus();
            ChatHexInput.BringIntoView();
            return;
        }

        try
        {
            var settings = new AppSettings
            {
                Language = _selectedLanguage,
                Theme = saveTheme ? _selectedTheme : SavedSettings.Theme,
                CustomChatColors = saveTheme ? _draftChatColors : SavedSettings.CustomChatColors,
                NotificationsEnabled = NotificationEnabledCheckBox.IsChecked == true,
                NotificationPreviewEnabled = NotificationPreviewCheckBox.IsChecked == true,
                WorkModeEnabled = WorkModeCheckBox.IsChecked == true,
                StartInTray = StartInTrayCheckBox.IsChecked == true,
            };
            SettingsStore.Save(settings);
            StartupManager.SetEnabled(AutoStartCheckBox.IsChecked == true);
            SavedSettings = settings;
            RequestedAction = action;
            DialogResult = true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"{AppLanguageChoice.Text(_selectedLanguage, "설정을 저장하지 못했습니다.", "Could not save settings.")}\n\n{ex.Message}",
                AppLanguageChoice.Text(_selectedLanguage, "OnlyDM 설정", "OnlyDM Settings"),
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }
}
