from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

install = (ROOT / 'install.ps1').read_text(encoding='utf-8')
package = (ROOT / 'scripts' / 'package.ps1').read_text(encoding='utf-8')
verify = (ROOT / 'scripts' / 'verify.ps1').read_text(encoding='utf-8')
package_json = (ROOT / 'package.json').read_text(encoding='utf-8')
node_cli = (ROOT / 'cli' / 'odm.js').read_text(encoding='utf-8')
workflow = (ROOT / '.github' / 'workflows' / 'release.yml').read_text(encoding='utf-8')
odm = (ROOT / 'cli' / 'odm.ps1').read_text(encoding='utf-8')
webview_service = (ROOT / 'src' / 'OnlyDM' / 'WebView2DependencyService.cs').read_text(encoding='utf-8')
thread_store = (ROOT / 'src' / 'OnlyDM' / 'ThreadStore.cs').read_text(encoding='utf-8')
friends_store = (ROOT / 'src' / 'OnlyDM' / 'FriendsStore.cs').read_text(encoding='utf-8')
alias_book = (ROOT / 'src' / 'OnlyDM' / 'AliasBook.cs').read_text(encoding='utf-8')

assert '--self-contained true' in package, 'Release must bundle .NET runtime'
assert 'Test-WebView2RuntimeInstalled' in install, 'Installer must detect WebView2 Runtime'
assert 'Install-WebView2Runtime' in install, 'Installer must install WebView2 Runtime when missing'
assert 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' in install, 'Installer must use Microsoft WebView2 bootstrapper'
assert 'odm.ps1' in package, 'Release package must include ODM PowerShell wrapper'
assert 'odm.cmd' in package, 'Release package must include ODM command wrapper'
assert 'Ensure-OnlyDMDependencies' in (ROOT / 'cli' / 'odm.ps1').read_text(encoding='utf-8'), 'odm start must check dependencies'
assert 'Invoke-BootstrapScript' not in odm, 'Installed maintenance must not fetch mutable branch scripts'
assert 'InstallScriptPath' in odm and 'UninstallScriptPath' in odm
assert 'ReleaseTag' in install and 'Test-MicrosoftAuthenticodeSignature' in install
assert 'Test-MicrosoftAuthenticodeSignature' in odm
assert 'IsMicrosoftSigned' in webview_service
assert 'LocalDataProtection.Protect' in thread_store
assert 'LocalDataProtection.Protect' in friends_store
assert 'LocalDataProtection.Protect' in alias_book
assert 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' in workflow
assert 'actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68' in workflow
assert 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' in workflow
assert 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c' in workflow
assert 'persist-credentials: false' in workflow
assert 'RELEASE_TAG' in workflow and "-notmatch '^v[0-9]+\\.[0-9]+\\.[0-9]+$'" in workflow
assert '"odm": "cli/odm.js"' in package_json, 'npm package must expose odm command'
assert 'cli\\odm.ps1' in verify or 'cli/odm.ps1' in verify, 'verify script must check ODM wrapper'
assert '\"name\": \"@thisnorm/onlydm\"' in package_json, 'npm package must expose the scoped OnlyDM name'
assert '\"access\": \"public\"' in package_json, 'scoped npm package must be publishable publicly'
assert "command === 'start'" in node_cli and 'install.ps1' in node_cli, 'odm start must bootstrap a missing app install'
print('PASS: distribution dependency and ODM contracts')
