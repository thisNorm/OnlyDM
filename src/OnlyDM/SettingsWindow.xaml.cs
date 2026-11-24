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
    private AppColors _draftAppColors;
    private bool _syncingSwatches;
    private bool _syncingSpectrum;
    private bool _pickingSpectrum;
    private double _spectrumHue, _spectrumSaturation, _spectrumValue;

    public SettingsWindow(AppSettings settings)
    {
        InitializeComponent();
        SavedSettings = settings;
        _selectedLanguage = settings.Language;
        _selectedTheme = settings.Theme is ThemeKind.Dark or ThemeKind.Custom ? settings.Theme : ThemeKind.Light;
        _draftChatColors = (settings.CustomChatColors ?? ChatColors.Default).Normalize();
        _draftAppColors = (settings.CustomAppColors ?? AppColors.Default).Normalize();
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

        foreach (var option in new[] { ChromeColorOption, AppBackgroundColorOption, BackgroundColorOption, IncomingColorOption, OutgoingColorOption })
            option.Checked += ColorField_Checked;
        foreach (RadioButton swatch in ColorSwatches.Children)
            swatch.Checked += ColorSwatch_Checked;
        ChatHexInput.TextChanged += ChatHexInput_TextChanged;
        ChatHexInput.LostKeyboardFocus += ChatHexInput_LostKeyboardFocus;
        SpectrumHueSlider.ValueChanged += SpectrumHueSlider_ValueChanged;

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
        var palette = AppTheme.GetPalette(_selectedTheme, _draftAppColors);
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
        var palette = AppTheme.GetPalette(_selectedTheme, _draftAppColors);
        ApplyWindowTheme(palette);
        CustomColorsPanel.Visibility = _selectedTheme == ThemeKind.Custom ? Visibility.Visible : Visibility.Collapsed;
        AppThemePreview.Background = AppTheme.Brush(palette.Surface);
        AppChromePreview.Background = AppRailPreview.Background = AppTheme.Brush(palette.ChromeBackground);
        AppPreviewTitle.Foreground = AppTheme.Brush(palette.ChromeText);
        AppPreviewText.Foreground = AppTheme.Brush(palette.Text);
        ChromeColorOption.Tag = AppTheme.Brush(_draftAppColors.Chrome);
        AppBackgroundColorOption.Tag = AppTheme.Brush(_draftAppColors.Background);
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
        var color = ChromeColorOption.IsChecked == true ? _draftAppColors.Chrome
            : AppBackgroundColorOption.IsChecked == true ? _draftAppColors.Background
            : IncomingColorOption.IsChecked == true ? _draftChatColors.Incoming
            : OutgoingColorOption.IsChecked == true ? _draftChatColors.Outgoing
            : _draftChatColors.Background;
        ChatHexInput.Text = color;
        RefreshColorSpectrum(color);
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

        if (ChromeColorOption.IsChecked == true) _draftAppColors = _draftAppColors with { Chrome = color };
        else if (AppBackgroundColorOption.IsChecked == true) _draftAppColors = _draftAppColors with { Background = color };
        else _draftChatColors = IncomingColorOption.IsChecked == true ? _draftChatColors with { Incoming = color }
                : OutgoingColorOption.IsChecked == true ? _draftChatColors with { Outgoing = color }
                : _draftChatColors with { Background = color };
        RefreshThemeSelection();
        if (!_pickingSpectrum) RefreshColorSpectrum(color);
    }

    private void ChatHexInput_LostKeyboardFocus(object sender, KeyboardFocusChangedEventArgs e)
    {
        if (ChatColors.TryNormalizeHex(ChatHexInput.Text, out var color) && color != ChatHexInput.Text)
            ChatHexInput.Text = color;
    }

    private void RefreshColorSpectrum(string hex)
    {
        var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(hex)!;
        var red = color.R / 255d;
        var green = color.G / 255d;
        var blue = color.B / 255d;
        var max = Math.Max(red, Math.Max(green, blue));
        var delta = max - Math.Min(red, Math.Min(green, blue));
        _spectrumValue = max;
        _spectrumSaturation = max == 0 ? 0 : delta / max;
        if (delta > 0)
        {
            var sector = max == red ? (green - blue) / delta : max == green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
            _spectrumHue = (sector * 60 + 360) % 360;
        }
        _syncingSpectrum = true;
        SpectrumHueSlider.Value = _spectrumHue;
        _syncingSpectrum = false;
        UpdateSpectrumMarker();
    }

    private static string SpectrumHex(double hue, double saturation, double value)
    {
        var chroma = value * saturation;
        var sector = (hue % 360) / 60;
        var second = chroma * (1 - Math.Abs(sector % 2 - 1));
        var offset = value - chroma;
        var (red, green, blue) = sector switch
        {
            < 1 => (chroma, second, 0d),
            < 2 => (second, chroma, 0d),
            < 3 => (0d, chroma, second),
            < 4 => (0d, second, chroma),
            < 5 => (second, 0d, chroma),
            _ => (chroma, 0d, second),
        };
        return $"#{(int)Math.Round((red + offset) * 255):X2}{(int)Math.Round((green + offset) * 255):X2}{(int)Math.Round((blue + offset) * 255):X2}";
    }

    private void UpdateSpectrumMarker()
    {
        SpectrumHueSurface.Background = AppTheme.Brush(SpectrumHex(_spectrumHue, 1, 1));
        Canvas.SetLeft(SpectrumMarker, _spectrumSaturation * ColorSpectrum.ActualWidth - SpectrumMarker.Width / 2);
        Canvas.SetTop(SpectrumMarker, (1 - _spectrumValue) * ColorSpectrum.ActualHeight - SpectrumMarker.Height / 2);
    }

    private void ApplySpectrumColor()
    {
        _pickingSpectrum = true;
        try { ChatHexInput.Text = SpectrumHex(_spectrumHue, _spectrumSaturation, _spectrumValue); }
        finally { _pickingSpectrum = false; }
        UpdateSpectrumMarker();
    }

    private void PickSpectrum(System.Windows.Point position)
    {
        if (ColorSpectrum.ActualWidth <= 0 || ColorSpectrum.ActualHeight <= 0) return;
        _spectrumSaturation = Math.Clamp(position.X / ColorSpectrum.ActualWidth, 0, 1);
        _spectrumValue = 1 - Math.Clamp(position.Y / ColorSpectrum.ActualHeight, 0, 1);
        ApplySpectrumColor();
    }

    private void ColorSpectrum_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        ColorSpectrum.Focus();
        ColorSpectrum.CaptureMouse();
        PickSpectrum(e.GetPosition(ColorSpectrum));
        e.Handled = true;
    }

    private void ColorSpectrum_MouseMove(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (ColorSpectrum.IsMouseCaptured && e.LeftButton == MouseButtonState.Pressed) PickSpectrum(e.GetPosition(ColorSpectrum));
    }

    private void ColorSpectrum_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (!ColorSpectrum.IsMouseCaptured) return;
        PickSpectrum(e.GetPosition(ColorSpectrum));
        ColorSpectrum.ReleaseMouseCapture();
        e.Handled = true;
    }

    private void ColorSpectrum_SizeChanged(object sender, SizeChangedEventArgs e) => UpdateSpectrumMarker();

    private void ColorSpectrum_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        var step = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) ? 0.1 : 0.01;
        switch (e.Key)
        {
            case Key.Left: _spectrumSaturation = Math.Max(0, _spectrumSaturation - step); break;
            case Key.Right: _spectrumSaturation = Math.Min(1, _spectrumSaturation + step); break;
            case Key.Down: _spectrumValue = Math.Max(0, _spectrumValue - step); break;
            case Key.Up: _spectrumValue = Math.Min(1, _spectrumValue + step); break;
            default: return;
        }
        ApplySpectrumColor();
        e.Handled = true;
    }

    private void SpectrumHueSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_syncingSpectrum) return;
        _spectrumHue = e.NewValue;
        ApplySpectrumColor();
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
                CustomAppColors = saveTheme ? _draftAppColors : SavedSettings.CustomAppColors,
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
            App.Log("save-settings", ex);
            MessageBox.Show(
                AppLanguageChoice.Text(_selectedLanguage, "설정을 저장하지 못했습니다.", "Could not save settings."),
                AppLanguageChoice.Text(_selectedLanguage, "OnlyDM 설정", "OnlyDM Settings"),
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }
}
