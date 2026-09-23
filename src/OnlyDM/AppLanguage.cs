using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace OnlyDM;

public enum AppLanguage
{
    Auto,
    Korean,
    English,
}

public static class AppLanguageChoice
{
    private static readonly IReadOnlyDictionary<string, string> KoreanToEnglish =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["채팅"] = "Chats",
            ["친구"] = "Friends",
            ["설정"] = "Settings",
            ["새 채팅"] = "New chat",
            ["채팅 검색"] = "Search chats",
            ["채팅 목록을 불러오는 중입니다."] = "Loading conversations.",
            ["다시 시도"] = "Try again",
            ["더블클릭으로 새 채팅창"] = "Double-click to open",
            ["OnlyDM 채팅"] = "OnlyDM Chat",
            ["대화"] = "Conversation",
            ["채팅방을 불러오는 중입니다."] = "Loading conversation.",
            ["OnlyDM 설정"] = "OnlyDM Settings",
            ["언어"] = "Language",
            ["OnlyDM과 Instagram 표시 언어를 함께 변경합니다."] =
                "Change the display language for OnlyDM and Instagram together.",
            ["라이트"] = "Light",
            ["다크"] = "Dark",
            ["안녕하세요!"] = "Hello!",
            ["네, 반가워요 :)"] = "Nice to meet you :)",
            ["밝고 정돈된 화면"] = "Bright and clean",
            ["눈부심을 줄인 차콜 화면"] = "Low-glare charcoal",
            ["Windows 시작 시 자동 실행"] = "Start with Windows",
            ["로그인하면 OnlyDM이 자동으로 실행됩니다."] = "OnlyDM starts automatically when you sign in.",
            ["트레이로 시작"] = "Start in tray",
            ["실행할 때 창을 열지 않고 트레이에만 둡니다."] = "Start OnlyDM in the tray without opening its window.",
            ["계정"] = "Account",
            ["Instagram 계정 전환 창을 엽니다. 로그인은 Instagram 화면에서 직접 진행됩니다."] =
                "Open Instagram's account switcher. Sign-in happens directly on Instagram.",
            ["계정 전환"] = "Switch account",
            ["로그아웃"] = "Log out",
            ["알림 받기"] = "Notifications",
            ["새 DM이 오면 Windows 알림을 표시합니다."] = "Show a Windows notification when a new DM arrives.",
            ["알림에 메시지 내용 표시"] = "Show message previews",
            ["끄면 보낸 사람만 표시하고 내용은 숨깁니다."] = "When off, show only the sender and hide the message.",
            ["취소"] = "Cancel",
            ["저장"] = "Save",
            ["대화상대 선택"] = "Select people",
            ["확인"] = "OK",
        };

    private static readonly IReadOnlyDictionary<string, string> EnglishToKorean =
        KoreanToEnglish.ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);

    public static AppLanguage Resolve(AppLanguage preference, string? windowsLanguage = null)
    {
        if (preference != AppLanguage.Auto) return preference;
        var language = windowsLanguage ?? CultureInfo.CurrentUICulture.Name;
        return language.StartsWith("ko", StringComparison.OrdinalIgnoreCase)
            ? AppLanguage.Korean
            : AppLanguage.English;
    }

    public static string InstagramCode(AppLanguage preference, string? windowsLanguage = null) =>
        Resolve(preference, windowsLanguage) == AppLanguage.Korean ? "ko" : "en";

    public static string Text(
        AppLanguage preference,
        string korean,
        string english,
        string? windowsLanguage = null) =>
        Resolve(preference, windowsLanguage) == AppLanguage.Korean ? korean : english;

    public static string Translate(AppLanguage preference, string value, string? windowsLanguage = null)
    {
        var source = Resolve(preference, windowsLanguage) == AppLanguage.Korean
            ? EnglishToKorean
            : KoreanToEnglish;
        return source.TryGetValue(value, out var translated) ? translated : value;
    }
}
