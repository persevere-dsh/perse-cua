#!/usr/bin/env bash
# Build the menu-bar indicator into packages/perse-cua/bin/PerseCuaIndicator.app
# Requires the Xcode command line tools (swiftc). Run from the repo root.
# Local builds sign ad-hoc. A release build passes --sign-identity so the app carries a
# Developer ID with a secure timestamp and the hardened runtime, which Apple requires for
# code nested inside a notarized installer.
set -euo pipefail
sign_identity='-'
require_developer_id=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sign-identity)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo 'Missing value for --sign-identity' >&2
        exit 1
      fi
      sign_identity="$2"
      shift 2
      ;;
    --require-developer-id)
      require_developer_id=true
      shift
      ;;
    *)
      echo "Unsupported argument: $1" >&2
      exit 1
      ;;
  esac
done
if [[ "$require_developer_id" == true && "$sign_identity" == '-' ]]; then
  echo 'Developer ID verification requires an explicit signing identity' >&2
  exit 1
fi
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
sign_args=(--force --sign "$sign_identity")
if [[ "$sign_identity" != '-' ]]; then
  sign_args+=(--timestamp --options runtime)
fi
codesign "${sign_args[@]}" "$staged"
codesign --verify --deep --strict "$staged"
if [[ "$require_developer_id" == true ]]; then
  # Read the whole report before matching: `grep -q` would close the pipe and make
  # codesign fail under pipefail, reporting a valid Developer ID as missing.
  signature="$(codesign --display --verbose=4 "$staged" 2>&1)"
  if [[ "$signature" != *"Authority=Developer ID Application:"* ]]; then
    echo 'Indicator is not signed with a Developer ID Application certificate' >&2
    exit 1
  fi
fi
# Sign outside synchronized workspaces, whose Finder metadata can invalidate verification.
# The archive is verified again after extraction before delivery.
rm -rf "$out"
cp -R "$staged" "$out"
echo "built: $out ($(lipo -archs "$out/Contents/MacOS/perse-cua-indicator"))"
