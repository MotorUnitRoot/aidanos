#!/usr/bin/env bash
# Fail when the optional native CBOR packages are in the installed tree.
# cbor-x uses them when present and its JavaScript decoder when they are not.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

hits=()
for path in \
  node_modules/cbor-extract/package.json \
  node_modules/detect-libc/package.json \
  node_modules/node-gyp-build-optional-packages/package.json
do
  if [[ -e "$path" ]]; then
    hits+=("$path")
  fi
done
if [[ -d node_modules/@cbor-extract ]]; then
  while IFS= read -r path; do
    hits+=("$path")
  done < <(find node_modules/@cbor-extract -name package.json -print)
fi
if [[ ${#hits[@]} -gt 0 ]]; then
  printf 'optional native package installed: %s\n' "${hits[@]}" >&2
  exit 1
fi
# npm ls exits 1 for an incomplete tree. Keep its listing either way, and
# fail only when a forbidden package name is actually present.
list="$(npm ls --all --parseable || true)"
if printf '%s\n' "$list" | grep -E '/(cbor-extract|detect-libc|node-gyp-build-optional-packages)$|/@cbor-extract/'; then
  echo "npm ls still lists an optional native package" >&2
  exit 1
fi
