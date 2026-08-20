using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using Brushes = System.Windows.Media.Brushes;
using Button = System.Windows.Controls.Button;
using FontFamily = System.Windows.Media.FontFamily;
using Grid = System.Windows.Controls.Grid;
using HorizontalAlignment = System.Windows.HorizontalAlignment;
using Orientation = System.Windows.Controls.Orientation;
using TextBox = System.Windows.Controls.TextBox;
using VerticalAlignment = System.Windows.VerticalAlignment;

namespace OnlyDM;

// Picks who a new conversation is with. One person makes a direct chat, several make a
// group; Instagram reuses an existing room when one already matches those people.
public sealed class NewChatWindow : Window
{
    private readonly List<Row> _rows = new();
    private readonly TextBox _search;
    private readonly StackPanel _list;
    private readonly TextBlock _count;
    private readonly Button _confirm;
    private readonly AppThemePalette _palette;

    private sealed class Row
    {
        public required Border Container { get; init; }
        public required Ellipse Check { get; init; }
        public required string Handle { get; init; }
        public required string Label { get; init; }
        public bool Selected { get; set; }
    }

    public NewChatWindow(IReadOnlyList<FriendEntry> people, AppThemePalette palette)
    {
        _palette = palette;
        Title = "대화상대 선택";
        Width = 400;
        Height = 640;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = AppTheme.Brush(palette.Surface);

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition());
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        // header: title on the left, close on the right
        var close = new Button
        {
            Content = "",
            FontFamily = new FontFamily("Segoe MDL2 Assets"),
            FontSize = 11,
            Width = 40,
            Height = 36,
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            Foreground = AppTheme.Brush(palette.MutedText),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 6, 6, 0),
        };
        close.Click += (_, _) => DialogResult = false;

        var heading = new TextBlock
        {
            Text = "대화상대 선택",
            FontSize = 19,
            FontWeight = FontWeights.SemiBold,
            Foreground = AppTheme.Brush(palette.Text),
            Margin = new Thickness(22, 30, 22, 0),
        };

        var header = new Grid();
        header.Children.Add(heading);
        header.Children.Add(close);
        Grid.SetRow(header, 0);

        // rounded search field with a magnifier
        _search = new TextBox
        {
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            Foreground = AppTheme.Brush(palette.Text),
            FontSize = 13,
            VerticalContentAlignment = VerticalAlignment.Center,
            Margin = new Thickness(30, 0, 12, 0),
        };
        _search.TextChanged += (_, _) => ApplyFilter();

        var glass = new TextBlock
        {
            Text = "",
            FontFamily = new FontFamily("Segoe MDL2 Assets"),
            FontSize = 13,
            Foreground = AppTheme.Brush(palette.MutedText),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };

        var searchInner = new Grid();
        searchInner.Children.Add(glass);
        searchInner.Children.Add(_search);

        var searchBox = new Border
        {
            CornerRadius = new CornerRadius(20),
            BorderThickness = new Thickness(1),
            BorderBrush = AppTheme.Brush(palette.Border),
            Height = 40,
            Margin = new Thickness(22, 18, 22, 0),
            Child = searchInner,
        };
        Grid.SetRow(searchBox, 1);

        _count = new TextBlock
        {
            FontSize = 12,
            Foreground = AppTheme.Brush(palette.MutedText),
            Margin = new Thickness(24, 16, 22, 6),
        };
        Grid.SetRow(_count, 2);

        _list = new StackPanel { Margin = new Thickness(10, 0, 6, 0) };
        var scroller = new ScrollViewer
        {
            Content = _list,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
        Grid.SetRow(scroller, 3);

        foreach (var person in people) _list.Children.Add(BuildRow(person));

        _confirm = new Button
        {
            Content = "확인",
            Width = 104,
            Height = 42,
            Margin = new Thickness(0, 0, 10, 0),
            BorderThickness = new Thickness(0),
            IsEnabled = false,
            Background = AppTheme.Brush(palette.SurfaceAlt),
            Foreground = AppTheme.Brush(palette.MutedText),
        };
        _confirm.Click += (_, _) =>
        {
            if (SelectedHandles.Count == 0) return;
            DialogResult = true;
        };

        var cancel = new Button
        {
            Content = "취소",
            Width = 104,
            Height = 42,
            Background = AppTheme.Brush(palette.Surface),
            Foreground = AppTheme.Brush(palette.Text),
            BorderBrush = AppTheme.Brush(palette.Border),
            BorderThickness = new Thickness(1),
        };
        cancel.Click += (_, _) => DialogResult = false;

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(22, 14, 22, 18),
        };
        actions.Children.Add(_confirm);
        actions.Children.Add(cancel);

        var footer = new Border
        {
            BorderThickness = new Thickness(0, 1, 0, 0),
            BorderBrush = AppTheme.Brush(palette.Border),
            Child = actions,
        };
        Grid.SetRow(footer, 4);

        root.Children.Add(header);
        root.Children.Add(searchBox);
        root.Children.Add(_count);
        root.Children.Add(scroller);
        root.Children.Add(footer);
        Content = root;

        Loaded += (_, _) => MainWindow.RoundCorners(this);
        UpdateCount();
    }

    public List<string> SelectedHandles =>
        _rows.Where(row => row.Selected).Select(row => row.Handle).ToList();

    private Border BuildRow(FriendEntry person)
    {
        var check = new Ellipse
        {
            Width = 22,
            Height = 22,
            StrokeThickness = 1.4,
            Stroke = AppTheme.Brush(_palette.Border),
            Fill = Brushes.Transparent,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 14, 0),
        };

        var name = new TextBlock
        {
            Text = person.Name,
            FontSize = 14,
            Foreground = AppTheme.Brush(_palette.Text),
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(66, 0, 46, 0),
        };

        var grid = new Grid { Height = 62 };
        grid.Children.Add(BuildAvatar(person));
        grid.Children.Add(name);
        grid.Children.Add(check);

        var container = new Border
        {
            Child = grid,
            CornerRadius = new CornerRadius(10),
            Background = Brushes.Transparent,
            Cursor = System.Windows.Input.Cursors.Arrow,
        };

        var row = new Row { Container = container, Check = check, Handle = person.Handle, Label = $"{person.Name} {person.Handle}" };
        _rows.Add(row);

        container.MouseLeftButtonUp += (_, _) => Toggle(row);
        container.MouseEnter += (_, _) => container.Background = AppTheme.Brush(_palette.SurfaceAlt);
        container.MouseLeave += (_, _) => container.Background = row.Selected
            ? AppTheme.Brush(_palette.SurfaceAlt)
            : Brushes.Transparent;

        return container;
    }

    private UIElement BuildAvatar(FriendEntry person)
    {
        var circle = new Ellipse
        {
            Width = 46,
            Height = 46,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(12, 0, 0, 0),
            Fill = AppTheme.Brush(_palette.SurfaceAlt),
        };

        if (string.IsNullOrWhiteSpace(person.Avatar)) return circle;

        try
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.UriSource = new Uri(person.Avatar, UriKind.Absolute);
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.EndInit();
            circle.Fill = new ImageBrush(image) { Stretch = Stretch.UniformToFill };
        }
        catch (Exception)
        {
            // Instagram's picture links expire; the plain circle is the fallback.
        }

        return circle;
    }

    private void Toggle(Row row)
    {
        row.Selected = !row.Selected;
        row.Check.Fill = row.Selected ? AppTheme.Brush(_palette.Accent) : Brushes.Transparent;
        row.Check.Stroke = row.Selected ? AppTheme.Brush(_palette.Accent) : AppTheme.Brush(_palette.Border);
        row.Container.Background = row.Selected ? AppTheme.Brush(_palette.SurfaceAlt) : Brushes.Transparent;
        UpdateCount();
    }

    private void ApplyFilter()
    {
        var query = _search.Text.Trim();
        foreach (var row in _rows)
        {
            row.Container.Visibility = query.Length == 0
                || row.Label.Contains(query, StringComparison.OrdinalIgnoreCase)
                    ? Visibility.Visible
                    : Visibility.Collapsed;
        }

        UpdateCount();
    }

    private void UpdateCount()
    {
        var selected = SelectedHandles.Count;
        var shown = _rows.Count(row => row.Container.Visibility == Visibility.Visible);

        _count.Text = selected switch
        {
            0 => $"친구  {shown}",
            1 => $"친구  {shown}   ·   1명 선택 (개인 채팅)",
            _ => $"친구  {shown}   ·   {selected}명 선택 (단체 채팅)",
        };

        _confirm.IsEnabled = selected > 0;
        _confirm.Background = selected > 0
            ? AppTheme.Brush(_palette.Accent)
            : AppTheme.Brush(_palette.SurfaceAlt);
        _confirm.Foreground = selected > 0
            ? AppTheme.Brush(_palette.AccentText)
            : AppTheme.Brush(_palette.MutedText);
    }
}
