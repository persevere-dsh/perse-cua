#!/usr/bin/env bash
# Build the menu-bar indicator into packages/perse-cua/bin/PerseCuaIndicator.app
# Requires the Xcode command line tools (swiftc). Run from the repo root.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/packages/perse-cua/bin/PerseCuaIndicator.app"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

swiftc -O -target arm64-apple-macos13 -o "$tmp/ind-arm64" "$root/src/indicator/main.swift"
if swiftc -O -target x86_64-apple-macos13 -o "$tmp/ind-x86" "$root/src/indicator/main.swift" 2>/dev/null; then
  lipo -create "$tmp/ind-arm64" "$tmp/ind-x86" -o "$tmp/perse-cua-indicator"
else
  cp "$tmp/ind-arm64" "$tmp/perse-cua-indicator"
fi

rm -rf "$out"
mkdir -p "$out/Contents/MacOS"
cp "$tmp/perse-cua-indicator" "$out/Contents/MacOS/perse-cua-indicator"
chmod +x "$out/Contents/MacOS/perse-cua-indicator"
cat > "$out/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>perse-cua-indicator</string>
  <key>CFBundleIdentifier</key><string>dsh.perse.cua.indicator</string>
  <key>CFBundleName</key><string>perse-cua-indicator</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$out" 2>/dev/null || true
echo "built: $out ($(lipo -archs "$out/Contents/MacOS/perse-cua-indicator"))"
