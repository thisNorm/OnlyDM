using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Data;

namespace OnlyDM;

public static class WpfLanguage
{
    public static void Apply(DependencyObject root, AppLanguage language)
    {
        if (root is Window window) TranslateProperty(window, Window.TitleProperty, language);
        if (root is TextBlock text) TranslateProperty(text, TextBlock.TextProperty, language);
        if (root is ContentControl content) TranslateProperty(content, ContentControl.ContentProperty, language);
        if (root is FrameworkElement element)
        {
            TranslateProperty(element, FrameworkElement.ToolTipProperty, language);
            TranslateProperty(element, AutomationProperties.NameProperty, language);
        }

        foreach (var child in LogicalTreeHelper.GetChildren(root))
            if (child is DependencyObject dependency) Apply(dependency, language);
    }

    internal static void ApplyStatus(TextBlock status, AppLanguage language)
    {
        // The first line is OnlyDM copy. Everything after it is the original diagnostic.
        var value = status.Text;
        var newline = value.IndexOf('\n');
        if (newline >= 0)
            status.Text = AppLanguageChoice.Translate(language, value[..newline]) + value[newline..];
    }

    private static void TranslateProperty(DependencyObject target, DependencyProperty property, AppLanguage language)
    {
        if (target.GetValue(property) is not string value || BindingOperations.IsDataBound(target, property)) return;
        var translated = AppLanguageChoice.Translate(language, value);
        if (translated != value) target.SetCurrentValue(property, translated);
    }
}
