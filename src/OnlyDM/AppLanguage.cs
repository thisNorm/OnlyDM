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
            ["화면 및 언어"] = "Appearance and language",
            ["언어"] = "Language",
            ["OnlyDM과 Instagram 표시 언어를 함께 변경합니다."] =
                "Change the display language for OnlyDM and Instagram together.",
            ["라이트"] = "Light",
            ["다크"] = "Dark",
            ["사용자 지정"] = "Custom",
            ["채팅 테마"] = "Chat theme",
            ["채팅 미리보기"] = "Chat preview",
            ["배경"] = "Background",
            ["받은 메시지"] = "Incoming",
            ["보낸 메시지"] = "Outgoing",
            ["색상 팔레트"] = "Color palette",
            ["HEX 색상"] = "HEX color",
            ["#4257C9처럼 6자리 HEX 색상을 입력하세요."] = "Enter a six-digit HEX color, e.g. #4257C9.",
            ["안녕하세요!"] = "Hello!",
            ["네, 반가워요 :)"] = "Nice to meet you :)",
            ["밝고 정돈된 화면"] = "Bright and clean",
            ["눈부심을 줄인 차콜 화면"] = "Low-glare charcoal",
            ["시작 옵션"] = "Startup",
            ["Windows 시작 시 자동 실행"] = "Start with Windows",
            ["로그인하면 OnlyDM이 자동으로 실행됩니다."] = "OnlyDM starts automatically when you sign in.",
            ["트레이로 시작"] = "Start in tray",
            ["실행할 때 창을 열지 않고 트레이에만 둡니다."] = "Start OnlyDM in the tray without opening its window.",
            ["계정"] = "Account",
            ["OnlyDM에서 계정을 추가하거나 전환합니다. 로그인은 Instagram에서 진행합니다."] =
                "Add or switch accounts in OnlyDM. Sign in directly on Instagram.",
            ["계정 전환"] = "Switch account",
            ["로그아웃"] = "Log out",
            ["알림"] = "Desktop alerts",
            ["알림 받기"] = "Notifications",
            ["새 DM이 오면 Windows 알림을 표시합니다."] = "Show a Windows notification when a new DM arrives.",
            ["열일 모드"] = "Work mode",
            ["알림 제목과 본문에서 보낸 사람과 메시지 내용을 가립니다."] = "Hide the sender and message from the notification title and body.",
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
