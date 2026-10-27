#!/bin/sh
# Rebuild the directory helper twice from editor/dirfd-tool.c and require both
# results to be byte-for-byte identical to the committed
# editor/bin/dirfd-tool-$os-$arch. A mismatch fails the job. This script does
# not replace the committed file. The Node server never runs it.
#
# Linux, ubuntu-latest, x64. Compiler: gcc (not cc: on some images cc is clang).
#   SOURCE_DATE_EPOCH=0
#   ZERO_AR_DATE=1
#   gcc -O2 -fno-ident -ffile-prefix-map=$ROOT=srcroot -frandom-seed=aidanos-dirfd \
#       -Wl,--build-id=none -o OUT editor/dirfd-tool.c
#
# macOS, macos-latest, arm64. Compiler: cc (Apple clang).
#   SOURCE_DATE_EPOCH=0
#   ZERO_AR_DATE=1
#   MACOSX_DEPLOYMENT_TARGET=12.0
#   cc -O2 -fno-ident -ffile-prefix-map=$ROOT=srcroot -frandom-seed=aidanos-dirfd \
#       -Wl,-no_uuid -Wl,-no_adhoc_codesign -o OUT editor/dirfd-tool.c
#
# CFLAGS, CXXFLAGS, CPPFLAGS, LDFLAGS, and CC are ignored. The helper source
# must not call getenv, and the rebuild must not reference getenv or environ.
set -eu

set +u
unset CFLAGS
unset CXXFLAGS
unset CPPFLAGS
unset LDFLAGS
unset CC
unset CPATH
unset LIBRARY_PATH
set -u

export SOURCE_DATE_EPOCH=0
export ZERO_AR_DATE=1

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

if [ "$osname" = linux ]; then
  compiler=gcc
  flags="-O2 -fno-ident -ffile-prefix-map=$root=srcroot -frandom-seed=aidanos-dirfd -Wl,--build-id=none"
else
  compiler=cc
  export MACOSX_DEPLOYMENT_TARGET=12.0
  flags="-O2 -fno-ident -ffile-prefix-map=$root=srcroot -frandom-seed=aidanos-dirfd -Wl,-no_uuid -Wl,-no_adhoc_codesign"
fi

echo "uname: $(uname -s) $(uname -m) $(uname -r)"
echo "compiler: $compiler"
"$compiler" --version
echo "flags: $flags"
echo "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
echo "ZERO_AR_DATE=$ZERO_AR_DATE"
if [ "$osname" = darwin ]; then
  echo "MACOSX_DEPLOYMENT_TARGET=$MACOSX_DEPLOYMENT_TARGET"
fi

if grep -n -E '(^|[^A-Za-z0-9_])(getenv|environ)([^A-Za-z0-9_]|$)' "$root/editor/dirfd-tool.c"; then
  echo "dirfd-tool.c reads the environment" >&2
  exit 1
fi
if ! grep -q 'env: {}' "$root/editor/dirfd.mjs"; then
  echo "dirfd.mjs does not pass an empty environment to the helper" >&2
  exit 1
fi

pinned="$root/editor/bin/dirfd-tool-${osname}-${archname}"
if [ ! -f "$pinned" ]; then
  echo "pinned helper is missing: $pinned" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

compile() {
  # shellcheck disable=SC2086
  "$compiler" $flags -o "$1" "$root/editor/dirfd-tool.c"
}

# Same output path both times, so a path embedded by the linker is not a
# difference. A timestamp or UUID that survives the flags above still is.
compile "$work/tool"
cp "$work/tool" "$work/first"
rm -f "$work/tool"
compile "$work/tool"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

first=$(hash_file "$work/first")
second=$(hash_file "$work/tool")
echo "rebuild-1 $first"
echo "rebuild-2 $second"
if [ "$first" != "$second" ]; then
  echo "not reproducible" >&2
  exit 1
fi

if ! command -v nm >/dev/null 2>&1; then
  echo "nm is required to check that the helper does not reference the environment" >&2
  exit 1
fi
if nm -u "$work/tool" 2>/dev/null | grep -E '(^|[^A-Za-z0-9_])_?(getenv|environ)(@|[^A-Za-z0-9_]|$)'; then
  echo "rebuilt helper references the environment" >&2
  exit 1
fi

expect_status() {
  expected=$1
  shift
  set +e
  "$work/tool" "$@" >/dev/null 2>&1
  status=$?
  set -e
  if [ "$status" -ne "$expected" ]; then
    echo "helper $* exited $status, expected $expected" >&2
    exit 1
  fi
}

expect_status 2 creat
expect_status 2 creat name 0 extra
expect_status 2 creat name -1
expect_status 2 stat name extra
expect_status 2 unlink name 1 2 extra
expect_status 2 unlink-self name
expect_status 2 nope name

pinned_hash=$(hash_file "$pinned")
echo "pinned $pinned_hash"
if [ "$first" != "$pinned_hash" ]; then
  echo "rebuild does not match the pinned helper" >&2
  echo "BEGIN DIRFD BASE64"
  if base64 -w 0 </dev/null >/dev/null 2>&1; then
    base64 -w 0 < "$work/tool"
  else
    base64 < "$work/tool" | tr -d '\n'
  fi
  echo
  echo "END DIRFD BASE64"
  exit 1
fi

echo "pinned helper matches"
