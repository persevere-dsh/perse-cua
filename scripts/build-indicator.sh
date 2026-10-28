#!/usr/bin/env bash
# Build the menu-bar indicator into packages/perse-cua/bin/PerseCuaIndicator.app
# Requires the Xcode command line tools (swiftc). Run from the repo root.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/packages/perse-cua/bin/PerseCuaIndicator.app"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
staged="$tmp/PerseCuaIndicator.app"
version="$(node -p "require(process.argv[1]).version" "$root/packages/perse-cua/package.json")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo 'Invalid package version for indicator metadata' >&2
  exit 1
fi

swiftc -O -target arm64-apple-macos13 -o "$tmp/ind-arm64" "$root/src/indicator/main.swift"
swiftc -O -target x86_64-apple-macos13 -o "$tmp/ind-x86" "$root/src/indicator/main.swift"
lipo -create "$tmp/ind-arm64" "$tmp/ind-x86" -o "$tmp/perse-cua-indicator"

mkdir -p "$staged/Contents/MacOS"
cp "$tmp/perse-cua-indicator" "$staged/Contents/MacOS/perse-cua-indicator"
chmod +x "$staged/Contents/MacOS/perse-cua-indicator"
cat > "$staged/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>perse-cua-indicator</string>
  <key>CFBundleIdentifier</key><string>dsh.perse.cua.indicator</string>
  <key>CFBundleName</key><string>perse-cua-indicator</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version%%-*}</string>
  <key>CFBundleVersion</key><string>${version%%-*}</string>
  <key>PerseCuaPackageVersion</key><string>$version</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$staged"
codesign --verify --deep --strict "$staged"
# Sign outside synchronized workspaces, whose Finder metadata can invalidate verification.
# The archive is verified again after extraction before delivery.
rm -rf "$out"
cp -R "$staged" "$out"
echo "built: $out ($(lipo -archs "$out/Contents/MacOS/perse-cua-indicator"))"
