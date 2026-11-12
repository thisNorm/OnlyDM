#!/usr/bin/env bash
set -euo pipefail
umask 022

die() { printf 'package-deb: %s\n' "$*" >&2; exit 1; }

linux_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
electron_dir="$linux_dir/node_modules/electron"
electron_dist="$electron_dir/dist"
license="$linux_dir/../LICENSE"
icon=${ONLYDM_ICON:-"$linux_dir/../src/OnlyDM/Assets/OnlyDM.png"}

[[ $(uname -s) == Linux && $(dpkg --print-architecture) == amd64 ]] ||
  die 'Run this script on Ubuntu amd64.'
[[ -f "$linux_dir/package.json" && -d "$linux_dir/src" ]] || die 'Missing app sources.'
[[ -f "$license" ]] || die "Missing license: $license"
[[ -f "$icon" ]] || die "Missing icon: $icon (set ONLYDM_ICON to a PNG)"
shopt -s nullglob
generated=("$linux_dir"/generated/*.js)
(("${#generated[@]}" > 0)) || die 'Run npm run build in linux/ first.'

version=$(node -p 'require(process.argv[1]).version.replace("-", "~")' "$linux_dir/package.json")
dpkg --validate-version "$version"

if [[ ! -x "$electron_dist/electron" ]]; then
  [[ -f "$electron_dir/install.js" ]] || die 'Run npm ci in linux/ first.'
  node "$electron_dir/install.js"
fi
[[ -f "$electron_dist/electron" && -x "$electron_dist/electron" ]] ||
  die "Missing Electron executable: $electron_dist/electron"
[[ -f "$electron_dist/chrome-sandbox" && ! -L "$electron_dist/chrome-sandbox" ]] ||
  die "Missing Electron sandbox helper: $electron_dist/chrome-sandbox"

out_dir="$linux_dir/dist"
deb="onlydm_${version}_amd64.deb"
mkdir -p -- "$out_dir"
tmp=$(mktemp -d -- "$out_dir/.package-deb.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pkg="$tmp/root"
runtime="$pkg/opt/onlydm"
app="$runtime/resources/app"
mkdir -p -- "$pkg/DEBIAN" "$runtime" "$pkg/usr/share/applications"
cp -a -- "$electron_dist/." "$runtime/"
mv -- "$runtime/electron" "$runtime/onlydm"
# dpkg-deb records root ownership for the setuid sandbox helper.
chmod 4755 -- "$runtime/chrome-sandbox"

mkdir -p -- "$app/generated"
install -m 0644 -- "$linux_dir/package.json" "$license" "$app/"
cp -R -- "$linux_dir/src" "$app/"
install -m 0644 -- "${generated[@]}" "$app/generated/"

install -Dm 0644 -- "$icon" "$pkg/usr/share/pixmaps/onlydm.png"
cat > "$pkg/usr/share/applications/onlydm.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=OnlyDM
Exec=/opt/onlydm/onlydm
Icon=onlydm
Terminal=false
Categories=Network;InstantMessaging;
EOF

cat > "$pkg/DEBIAN/control" <<EOF
Package: onlydm
Version: $version
Section: net
Priority: optional
Architecture: amd64
Maintainer: thisNorm
Homepage: https://github.com/thisNorm/OnlyDM
Depends: ca-certificates, fonts-liberation, libasound2t64, libatk-bridge2.0-0t64,
 libatk1.0-0t64, libatspi2.0-0t64, libc6, libcairo2, libcups2t64, libdbus-1-3,
 libdrm2, libexpat1, libgbm1, libglib2.0-0t64, libgtk-3-0t64 | libgtk-4-1,
 libnspr4, libnss3, libpango-1.0-0, libpangocairo-1.0-0, libstdc++6, libudev1,
 libuuid1, libx11-6, libx11-xcb1, libxcb-dri3-0, libxcb1, libxcomposite1,
 libxcursor1, libxdamage1, libxext6, libxfixes3, libxi6, libxkbcommon0,
 libxrandr2, libxrender1, libxshmfence1, libxss1, libxtst6, xdg-utils
Description: OnlyDM for Ubuntu
EOF

dpkg-deb --root-owner-group --build "$pkg" "$tmp/$deb"
mv -fT -- "$tmp/$deb" "$out_dir/$deb"
printf 'Built %s\n' "$out_dir/$deb"
