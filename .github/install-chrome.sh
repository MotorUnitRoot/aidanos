#!/usr/bin/env bash
# Fixed Chrome for Testing archives, not the runner's auto-updating browser.
# Hashes were recorded from Google's HTTPS downloads on 2026-11-10 (TOFU).
# Google publishes no independent SHA256 signatures: reviewer must approve pins.
set -euo pipefail
version=157.0.8103.50
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux64; expected=d17167bc092eb495a3b768c7467f27e35f625aa03834233a1663af67dcb668c9; binary='chrome-linux64/chrome' ;;
  Darwin/arm64) platform=mac-arm64; expected=aceb0578a1cc3631358b164dbbef04bf8936f96c690fb78c3ac25b7655e795e8; binary='chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' ;;
  Darwin/x86_64) platform=mac-x64; expected=7b1c12bee8024f1193b28754aa0d46b7eaa08394de51bef84fd65a6cf08d61dc; binary='chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' ;;
  *) echo 'Unsupported Chrome test platform' >&2; exit 1 ;;
esac
base="${RUNNER_TEMP:-${TMPDIR:?Set TMPDIR or RUNNER_TEMP}}"
install=$(mktemp -d "$base/aidanos-ci-chrome.XXXXXX")
archive="$install/chrome.zip"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL   "https://storage.googleapis.com/chrome-for-testing-public/$version/$platform/chrome-$platform.zip"   -o "$archive"
# Check the committed checksum BEFORE extracting or executing any archive content.
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
  echo 'Chrome SHA256 mismatch; refusing to extract or execute' >&2
  exit 1
fi
unzip -q "$archive" -d "$install"
chrome="$install/$binary"
reported=$("$chrome" --version)
reported="${reported%${reported##*[![:space:]]}}"
printf '%s\n' "$reported"
case "$reported" in
  *" $version") ;;
  *) echo 'Unexpected Chrome version' >&2; exit 1 ;;
esac
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CHROME_PATH=%s\n' "$chrome" >> "$GITHUB_ENV"
else
  printf 'CHROME_PATH=%s\n' "$chrome"
fi
