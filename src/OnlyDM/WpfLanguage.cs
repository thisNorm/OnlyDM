using System.Windows;
using System.Windows.Controls;

namespace OnlyDM;

public static class WpfLanguage
{
    public static void Apply(DependencyObject root, AppLanguage language)
    {
        if (root is Window window) window.Title = AppLanguageChoice.Translate(language, window.Title);
        if (root is TextBlock text) text.Text = AppLanguageChoice.Translate(language, text.Text);
        if (root is ContentControl content && content.Content is string label)
            content.Content = AppLanguageChoice.Translate(language, label);
        if (root is FrameworkElement element && element.ToolTip is string tip)
            element.ToolTip = AppLanguageChoice.Translate(language, tip);

        foreach (var child in LogicalTreeHelper.GetChildren(root))
            if (child is DependencyObject dependency) Apply(dependency, language);
    }
}
