# 개인정보 이야기

짧게 먼저 말씀드리면 — **OnlyDM은 서버가 없습니다.** 모아서 보낼 곳이 아예 없습니다.

OnlyDM은 인스타그램 웹 위에 메신저 화면을 그립니다. Windows는 WebView2, Ubuntu 미리보기는 내장 Chromium을 사용합니다. 메시지는 PC와 인스타그램 사이에서 오갑니다.

## 무엇이 어디에 저장되나요

Windows 데이터는 `%LOCALAPPDATA%\OnlyDM`에 있습니다. 추가 계정의 브라우저 데이터와 캐시는 별도 하위 폴더에 저장됩니다.

| 파일 | 들어 있는 것 | 보호 |
| --- | --- | --- |
| `WebView2\` | 인스타그램 로그인 세션. 브라우저가 쿠키를 들고 있는 것과 같습니다 | WebView2가 관리 |
| `settings.json` | 테마, 알림, 자동 시작 설정 | 평문 |
| `accounts.json`, `account-handle.txt` | 로컬 계정 슬롯, 선택한 슬롯, 계정 메뉴에 표시할 Instagram 아이디 | 평문 |
| `threads.json` | 열어본 대화방의 주소 | DPAPI |
| `friends.json` | 팔로잉 목록 캐시 (아이디·이름·프로필 사진 주소) | DPAPI |
| `aliases.json` | 직접 지어준 이름 | DPAPI |
| `error.log` | 오류가 났을 때의 예외 메시지 | 평문 |

DPAPI는 윈도우가 제공하는 잠금 장치입니다. **지금 로그인한 윈도우 계정에서만 풀립니다.** 파일만 따로 복사해 다른 PC나 다른 계정으로 가져가면 열리지 않습니다.

`error.log`는 앱 오류를 확인하는 데 사용합니다.

Ubuntu 미리보기는 사용자 설정 폴더의 OnlyDM 데이터에 계정별 브라우저 프로필을 두고, `profiles.json`에 로컬 계정 슬롯과 표시 아이디를, `settings.json`에 열일 모드의 켜짐 여부를 저장합니다. 두 플랫폼 모두 기존 브라우저나 다른 기기의 로그인 데이터를 가져오지 않습니다.

## 화면을 그리려고 읽는 것

인스타그램이 이미 그려둔 대화 목록에서 이만큼을 읽습니다.

- 대화 상대 표시 이름
- 프로필 사진 주소
- 마지막 메시지 미리보기와 시간
- 대화방 주소

이걸로 OnlyDM 창의 목록을 그립니다. 앱을 켜 둔 동안 다른 로그인 계정의 받은편지함에서도 새 DM을 확인합니다. Windows에서는 설정이나 트레이에서 알림과 미리보기를 끌 수 있고, Ubuntu 미리보기의 알림에는 메시지 미리보기를 표시하지 않습니다. 두 플랫폼 모두 열일 모드를 켜면 새 알림의 제목과 본문을 일반 안내 문구로 바꿉니다.

## 이름 바꾸기

채팅창이나 프로필에서 바꾼 이름은 `aliases.json`에만 적힙니다. 인스타그램으로 올라가지 않고, **상대방 화면에는 아무 변화도 없습니다.** 인스타그램의 "별명" 기능은 상대에게도 보이기 때문에 OnlyDM에서는 일부러 감춰두고, 로컬 이름으로 대체했습니다.

## 하지 않는 일

- 비밀번호·쿠키·토큰을 따로 꺼내거나 저장하지 않습니다. 로그인 정보는 각 계정의 내장 브라우저가 관리합니다
- 대화 내용을 모으거나 파일로 뽑지 않습니다
- 사용 기록·통계·분석을 수집하지 않습니다. 텔레메트리 코드가 없습니다
- 광고나 제3자 SDK가 없습니다

## 어디에 접속하나요

| 대상 | 언제 |
| --- | --- |
| `instagram.com` | 앱을 쓰는 동안 내장 브라우저가 접속 |
| `api.github.com` · `github.com` | 설치·업데이트할 때 릴리스 파일을 받으려고 |
| `go.microsoft.com` | WebView2 런타임이 없어서 설치할 때, 동의를 받은 뒤에만 |

인스타그램 웹의 이미지나 로그인에 필요한 리소스는 내장 브라우저에서 불러옵니다.

## Windows에서 지우고 싶으면

```powershell
odm uninstall
```

앱, 시작 메뉴 바로가기, `%LOCALAPPDATA%\OnlyDM` 폴더를 전부 지웁니다. 로그인 세션도 같이 사라집니다. 실행하기 전에 OnlyDM은 닫아주세요.

폴더만 직접 지워도 됩니다. 다음에 실행하면 처음 설치한 것처럼 로그인부터 시작합니다.

## 직접 확인해 보세요

말로만 하는 약속보다 코드가 낫습니다. 궁금한 부분은 여기 있습니다.

- [`src/OnlyDM/LocalDataProtection.cs`](src/OnlyDM/LocalDataProtection.cs) — DPAPI로 잠그는 부분
- [`src/OnlyDM/NavigationPolicy.cs`](src/OnlyDM/NavigationPolicy.cs) — 어떤 주소만 열어주는지
- [`src/OnlyDM/WebViewScripts.cs`](src/OnlyDM/WebViewScripts.cs) — 화면에서 무엇을 읽어 오는지
- [`src/OnlyDM/AliasBook.cs`](src/OnlyDM/AliasBook.cs) — 바꾼 이름을 어떻게 보관하는지

`scripts\verify.ps1`을 실행하면 이동 정책 테스트까지 직접 돌려볼 수 있습니다.

---

OnlyDM은 개인이 만든 비공식 프로그램입니다. Instagram, Meta와 아무 관계가 없습니다.
