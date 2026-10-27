#!/bin/sh
# Build editor/bin/dirfd-tool-$os-$arch when that file is absent.
# The Node server never runs this. A binary that is already in the tree stays
# byte-for-byte, so its pinned SHA-256 does not change.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) osname=linux ;;
  Darwin) osname=darwin ;;
  *) echo "unsupported os: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) archname=x64 ;;
  aarch64|arm64) archname=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
out="$root/editor/bin/dirfd-tool-${osname}-${archname}"
mkdir -p "$root/editor/bin"
chmod 755 "$root/editor" "$root/editor/bin"
if [ -e "$out" ]; then
  chmod 755 "$out"
  echo "present $out"
else
  tmp=$(mktemp "$root/editor/bin/.dirfd-tool.XXXXXX")
  cc -O2 -o "$tmp" "$root/editor/dirfd-tool.c"
  chmod 755 "$tmp"
  mv "$tmp" "$out"
  echo "built $out"
  echo "BEGIN DIRFD BASE64"
  base64 < "$out"
  echo "END DIRFD BASE64"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$out"
else
  shasum -a 256 "$out"
fi
