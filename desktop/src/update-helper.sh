#!/bin/bash
# Arguments are private data files, never sourced or evaluated as shell code.
set -euo pipefail
umask 077
export LC_ALL=C PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset BASH_ENV ENV CDPATH

swap_only=0
if [[ ${1:-} == --mac-swap ]]; then swap_only=1; shift; fi
[[ $# == 1 && $1 == /* && -d $1 && ! -L $1 ]] || exit 1
work=$(cd -- "$1" && pwd -P)
[[ $work == "$1" && ${work##*/} == OnlyDM-update-* ]] || exit 1
system=$(/usr/bin/uname -s)
case $system in
  Linux) owner=$(/usr/bin/stat -c %u "$work"); permissions=$(/usr/bin/stat -c %a "$work") ;;
  Darwin) owner=$(/usr/bin/stat -f %u "$work"); permissions=$(/usr/bin/stat -f %Lp "$work") ;;
  *) exit 1 ;;
esac
[[ $permissions == 700 && ( $owner == "$EUID" || ( $swap_only == 1 && $EUID == 0 && $system == Darwin ) ) ]] || exit 1

read_arg() {
  local file="$work/$1"
  [[ -f $file && ! -L $file && $(/usr/bin/wc -c < "$file") -le 4096 ]] || return 1
  REPLY=''
  IFS= read -r REPLY < "$file" || [[ -n $REPLY ]]
}
for key in platform arch version current-version executable pid stamp token mode sha256; do
  read_arg "$key" || exit 1
  case $key in current-version) current_version=$REPLY ;; *) printf -v "$key" '%s' "$REPLY" ;; esac
done
[[ $token =~ ^[a-f0-9]{48}$ && $sha256 =~ ^[a-f0-9]{64}$ && $pid =~ ^[1-9][0-9]*$ ]] || exit 1
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1
[[ $mode == parent || $mode == foreground ]] || exit 1
[[ -f $work/update.log && ! -L $work/update.log ]] || exit 1
if [[ $mode == foreground ]]; then
  # The native sudo prompt and installer retain the caller's terminal. Only
  # diagnostic output is redirected to the private log; no credentials are read.
  exec 3>&1 4>&2
fi
exec >> "$work/update.log" 2>&1
printf 'OnlyDM update %s (%s/%s)\n' "$version" "$platform" "$arch"

failure='Update validation failed.'
package=''
mounted=0
safe_restart=0
installed=0

alert_failure() {
  local message="OnlyDM update failed. $failure Log: $work/update.log"
  if [[ $system == Darwin ]]; then
    /usr/bin/osascript - "$message" <<'APPLESCRIPT' &
on run argv
  display alert "OnlyDM update failed" message (item 1 of argv) as critical
end run
APPLESCRIPT
  elif [[ -x /usr/bin/zenity ]]; then
    /usr/bin/zenity --error --title=OnlyDM --text="$message" </dev/null &
  elif [[ -x /usr/bin/notify-send ]]; then
    /usr/bin/notify-send --urgency=critical 'OnlyDM update failed' "$message" </dev/null &
  fi
  return 0
}

cleanup() {
  local status=$?
  trap - EXIT
  if (( mounted )); then /usr/bin/hdiutil detach "$work/mount" || true; fi
  if [[ -d $work/staged.app && ! -L $work/staged.app ]]; then /bin/rm -rf -- "$work/staged.app"; fi
  if [[ -n $package && -f $package && ! -L $package ]]; then /bin/rm -f -- "$package"; fi
  if (( status != 0 )); then
    printf '%s\n' "$failure" > "$work/failed"
    printf 'FAILED: %s\n' "$failure"
    if [[ -f $work/accepted || $mode == foreground ]]; then alert_failure; fi
  fi
  exit "$status"
}

die() { failure=$1; printf '%s\n' "$failure" >&2; exit 1; }
require_tools() { local tool; for tool in "$@"; do [[ -x $tool ]] || die "Required OS tool unavailable: $tool"; done; }
cancelled() { [[ -e $work/cancelled ]]; }

bundle_valid() {
  local app=$1 expected_version=$2
  [[ -d $app && ! -L $app && -f $app/Contents/Info.plist && ! -L $app/Contents/Info.plist
    && -x $app/Contents/MacOS/OnlyDM && ! -L $app/Contents/MacOS/OnlyDM ]] || return 1
  [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist") == org.thisnorm.onlydm
    && $(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist") == OnlyDM
    && $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist") == "$expected_version" ]] || return 1
  /usr/bin/codesign --verify --deep --strict "$app"
}

mac_target() {
  [[ $executable == /*/OnlyDM.app/Contents/MacOS/OnlyDM && $executable != *$'\n'* && $executable != *'/../'*
    && $executable != *'/AppTranslocation/'* && $executable != /Volumes/* ]] || return 1
  target=${executable%/Contents/MacOS/OnlyDM}
  parent=${target%/*}
  [[ -d $parent && ! -L $target && $(cd -- "$parent" && pwd -P) == "$parent" ]] || return 1
  candidate="$parent/.OnlyDM-update-$token.app"
  backup="$parent/.OnlyDM-backup-$token.app"
}

swap_mac() {
  cancelled && return 1
  mac_target || return 1
  if (( swap_only )); then [[ $parent == /Applications || $parent == /Applications/* ]] || return 1; fi
  [[ ! -e $candidate && ! -L $candidate && ! -e $backup && ! -L $backup ]] || return 1
  bundle_valid "$work/staged.app" "$version" || return 1
  /bin/mkdir "$candidate" || return 1
  if ! /usr/bin/ditto --rsrc --extattr --acl "$work/staged.app" "$candidate" || ! bundle_valid "$candidate" "$version"; then
    /bin/rm -rf -- "$candidate"
    return 1
  fi
  # A privileged mkdir under umask 077 must still yield a user-launchable app.
  /bin/chmod 755 "$candidate" || return 1
  if cancelled; then /bin/rm -rf -- "$candidate"; return 1; fi
  local had_old=0
  [[ ! -e $target ]] || had_old=1
  printf '%s' "$token" > "$work/unsafe"
  if (( had_old )) && ! /bin/mv "$target" "$backup"; then
    /bin/rm -f -- "$work/unsafe"
    /bin/rm -rf -- "$candidate"
    return 1
  fi
  if ! /bin/mv "$candidate" "$target"; then
    if (( had_old )); then /bin/mv "$backup" "$target" || return 1; fi
    /bin/rm -f -- "$work/unsafe"
    /bin/rm -rf -- "$candidate"
    return 1
  fi
  if ! bundle_valid "$target" "$version"; then
    /bin/mv "$target" "$candidate" || return 1
    if (( had_old )); then /bin/mv "$backup" "$target" || return 1; fi
    /bin/rm -f -- "$work/unsafe"
    /bin/rm -rf -- "$candidate"
    return 1
  fi
  /bin/rm -f -- "$work/unsafe"
  if (( had_old )); then /bin/rm -rf -- "$backup" || printf 'Previous app backup retained: %s\n' "$backup"; fi
}

if (( swap_only )); then
  [[ $system == Darwin && $platform == darwin && ( $arch == arm64 || $arch == x64 ) ]] || exit 1
  swap_mac
  exit $?
fi
trap cleanup EXIT

runtime_hash() {
  [[ -d /opt/onlydm && ! -L /opt/onlydm ]] || return 1
  /usr/bin/tar --sort=name --numeric-owner -cf - -C /opt onlydm | /usr/bin/sha256sum
}

if [[ $system == Linux && $platform == linux && $arch == x64 && $executable == /opt/onlydm/onlydm ]]; then
  package="$work/OnlyDM-linux-x64.deb"
  require_tools /usr/bin/apt-get /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/sha256sum /usr/bin/tar /usr/bin/nohup
  if [[ $mode == parent ]]; then
    require_tools /usr/bin/pkexec
  elif ! (( EUID == 0 )); then
    require_tools /usr/bin/sudo
  fi
  if [[ $mode == parent && ! -x /usr/bin/zenity && ! -x /usr/bin/notify-send ]]; then
    die 'A native error dialog requires zenity or notify-send; install one before updating from the app.'
  fi
  [[ -f $package && ! -L $package && $(/usr/bin/stat -c %s "$package") -le 536870912 ]] || die 'Invalid Linux package.'
  actual=$(/usr/bin/sha256sum "$package"); actual=${actual%% *}
  [[ $actual == "$sha256" ]] || die 'Linux package checksum mismatch.'
  [[ $(/usr/bin/dpkg-deb -f "$package" Package) == onlydm
    && $(/usr/bin/dpkg-deb -f "$package" Version) == "$version"
    && $(/usr/bin/dpkg-deb -f "$package" Architecture) == amd64 ]] || die 'Linux package identity/version/architecture mismatch.'
  before_status=$(/usr/bin/dpkg-query -W '-f=${Status}\n${Version}' onlydm 2>/dev/null || true)
  before_hash=''
  if [[ -e $executable ]]; then
    [[ -x $executable && ! -L $executable && $before_status == $'install ok installed\n'"$current_version" ]] || die 'Existing Linux installation is not a healthy matching package.'
    before_hash=$(runtime_hash) || die 'Could not verify the existing Linux runtime.'
    safe_restart=1
  else
    [[ $current_version == 0.0.0 && ! -e /opt/onlydm && -z $before_status ]] || die 'First installation conflicts with an existing Linux package.'
  fi
elif [[ $system == Darwin && $platform == darwin && ( $arch == arm64 || $arch == x64 ) ]]; then
  mac_target || die 'Invalid installed macOS app path (install in Applications first).'
  package="$work/OnlyDM-mac-$arch.dmg"
  require_tools /usr/bin/hdiutil /usr/bin/codesign /usr/bin/ditto /usr/libexec/PlistBuddy /usr/bin/shasum /usr/bin/open /usr/bin/osascript
  [[ -f $package && ! -L $package && $(/usr/bin/stat -f %z "$package") -le 536870912 ]] || die 'Invalid macOS image.'
  actual=$(/usr/bin/shasum -a 256 "$package"); actual=${actual%% *}
  [[ $actual == "$sha256" ]] || die 'macOS image checksum mismatch.'
  if [[ -e $target ]]; then
    bundle_valid "$target" "$current_version" || die 'Existing macOS bundle failed verification.'
    safe_restart=1
  else
    [[ $current_version == 0.0.0 ]] || die 'Installed macOS app is missing.'
  fi
  if [[ ! -w $parent ]]; then
    [[ $parent == /Applications || $parent == /Applications/* ]] || die 'The app directory is not writable.'
  fi
  /usr/bin/hdiutil verify "$package" || die 'Disk image verification failed.'
  /bin/mkdir "$work/mount"
  # Mark before attach so even a partially successful mount is detached on failure.
  mounted=1
  /usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$work/mount" "$package" || die 'Could not mount the verified image.'
  bundle_valid "$work/mount/OnlyDM.app" "$version" || die 'New macOS bundle failed verification.'
  /usr/bin/ditto --rsrc --extattr --acl "$work/mount/OnlyDM.app" "$work/staged.app" || die 'Could not stage the new app.'
  bundle_valid "$work/staged.app" "$version" || die 'Staged macOS bundle failed verification.'
  /usr/bin/hdiutil detach "$work/mount" || die 'Could not detach the update image.'
  mounted=0
else
  die 'Unsupported updater platform, architecture or executable.'
fi

origin_alive() {
  local value rest
  if [[ $system == Linux ]]; then
    [[ -r /proc/$pid/stat ]] || return 1
    IFS= read -r value < "/proc/$pid/stat" || return 1
    rest=${value##*) }
    local -a fields
    read -r -a fields <<< "$rest"
    [[ ${fields[0]:-} != Z && ${fields[0]:-} != X && ${fields[19]:-} == "$stamp" ]]
  else
    value=$(/bin/ps -p "$pid" -o lstart= 2>/dev/null) || return 1
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ $value == "$stamp" ]]
  fi
}

cancelled && die 'Update was cancelled before readiness.'
if [[ $mode == parent ]]; then origin_alive || die 'Originating app exited before accepting the update.'; fi
printf '%s' "$token" > "$work/ready.pending"
/bin/mv "$work/ready.pending" "$work/ready"
WAIT_SECONDS=30
end=$((SECONDS + WAIT_SECONDS))
if [[ $mode == parent ]]; then
  while origin_alive; do
    cancelled && die 'Update was cancelled by the originating app.'
    (( SECONDS < end )) || die 'The originating app did not exit within 30 seconds; nothing was installed.'
    /bin/sleep 0.1
  done
else
  # CLI completion must be explicitly accepted too: a readiness timeout can
  # otherwise race the last validation command and trigger an unwanted install.
  while ! { read_arg accepted && [[ $REPLY == "$token" ]]; }; do
    cancelled && die 'Update was cancelled before the CLI accepted readiness.'
    (( SECONDS < end )) || die 'The CLI did not accept the helper handshake within 30 seconds.'
    /bin/sleep 0.1
  done
fi
read_arg accepted && [[ $REPLY == "$token" ]] || die 'The originating caller did not accept the helper handshake.'
cancelled && die 'Update was cancelled before installation.'

relaunch() {
  if [[ $system == Darwin ]]; then
    /usr/bin/open -n "$target"
  else
    [[ -x $executable && ! -L $executable ]] || return 1
    /usr/bin/nohup "$executable" </dev/null >> "$work/update.log" 2>&1 &
  fi
}

install_linux() {
  # APT resolves the local package's dependencies and refuses package removals.
  # CLI elevation uses only sudo's native terminal authentication, never -S/-A.
  if [[ $mode == parent ]]; then
    /usr/bin/pkexec /usr/bin/apt-get install --yes --no-remove --no-install-recommends "$package"
  elif (( EUID == 0 )); then
    /usr/bin/apt-get install --yes --no-remove --no-install-recommends "$package" >&3 2>&4
  else
    /usr/bin/sudo -- /usr/bin/apt-get install --yes --no-remove --no-install-recommends "$package" >&3 2>&4
  fi
}

if [[ $system == Linux ]]; then
  failure='Linux package installation failed or OS authorization was declined.'
  if install_linux; then
    after_status=$(/usr/bin/dpkg-query -W '-f=${Status}\n${Version}' onlydm 2>/dev/null || true)
    [[ $after_status == $'install ok installed\n'"$version" && -x $executable && ! -L $executable ]] || die 'The package manager did not confirm a healthy new installation.'
    installed=1
  elif (( safe_restart )); then
    after_status=$(/usr/bin/dpkg-query -W '-f=${Status}\n${Version}' onlydm 2>/dev/null || true)
    after_hash=$(runtime_hash) || after_hash=''
    if [[ $after_status == "$before_status" && $after_hash == "$before_hash" ]]; then
      relaunch || true
    else
      failure='Linux installation failed after changing package files; automatic restart was withheld. Repair the onlydm package with the OS package manager.'
    fi
    die "$failure"
  else
    die "$failure"
  fi
else
  failure='macOS installation failed or OS authorization was declined.'
  swap_status=0
  if [[ -w $parent ]]; then
    swap_mac || swap_status=$?
  else
    # Only the OS authorization dialog sees credentials. No password is read by OnlyDM.
    /usr/bin/osascript - "$work/update-helper.sh" "$work" <<'APPLESCRIPT' || swap_status=$?
on run argv
  do shell script "/bin/bash " & quoted form of (item 1 of argv) & " --mac-swap " & quoted form of (item 2 of argv) with administrator privileges
end run
APPLESCRIPT
  fi
  if (( swap_status != 0 )); then
    if (( safe_restart )) && [[ ! -e $work/unsafe ]] && bundle_valid "$target" "$current_version"; then relaunch || true; fi
    die "$failure"
  fi
  installed=1
fi

(( installed )) || die 'Installation was not confirmed.'
printf '%s' "$token" > "$work/installed"
relaunch || die 'The update was installed, but OnlyDM could not be relaunched.'
printf 'Installed and relaunched OnlyDM %s.\n' "$version"
exit 0
