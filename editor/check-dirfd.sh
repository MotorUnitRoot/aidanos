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
#       -o OUT editor/dirfd-tool.c
# -Wl,-no_uuid produced two identical binaries, and macOS abort-trapped both
# before main. -Wl,-no_adhoc_codesign did the same. The check tries the
# default link and a fixed -Wl,-uuid. It accepts the first candidate whose
# two builds match and which exits 2 on a short command. If none does, the
# check fails. It does not hash only part of the file.
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
  flags="-O2 -fno-ident -ffile-prefix-map=$root=srcroot -frandom-seed=aidanos-dirfd"
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
trap 'rm -rf "$work"; rm -f "$root/editor/bin/.dirfd-exec-probe"' EXIT

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Build twice to the same path. A timestamp or UUID that the flags do not
# fix makes the two hashes differ.
# Returns 0 when the two builds match and a short command exits 2.
# The hash is written to $work/$name/hash.
build_pair() {
  name=$1
  extra=$2
  dir="$work/$name"
  mkdir -p "$dir"
  echo "candidate $name"
  echo "candidate-flags $flags $extra"
  set +e
  # shellcheck disable=SC2086
  "$compiler" $flags $extra -o "$dir/tool" "$root/editor/dirfd-tool.c" >"$dir/build.err" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "candidate $name compile failed" >&2
    cat "$dir/build.err" >&2
    return 1
  fi
  cp "$dir/tool" "$dir/first"
  rm -f "$dir/tool"
  set +e
  # shellcheck disable=SC2086
  "$compiler" $flags $extra -o "$dir/tool" "$root/editor/dirfd-tool.c" >"$dir/build.err" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "candidate $name second compile failed" >&2
    cat "$dir/build.err" >&2
    return 1
  fi
  one=$(hash_file "$dir/first")
  two=$(hash_file "$dir/tool")
  echo "candidate $name rebuild-1 $one"
  echo "candidate $name rebuild-2 $two"
  if [ "$one" != "$two" ]; then
    echo "candidate $name not reproducible" >&2
    return 1
  fi
  if command -v otool >/dev/null 2>&1; then
    otool -l "$dir/tool" | awk '/LC_UUID/{show=1} show && /uuid /{print "candidate '"$name"' " $0; exit}' || true
  fi
  if command -v codesign >/dev/null 2>&1; then
    codesign -dv "$dir/tool" 2>&1 | awk -v n="$name" '{print "candidate " n " codesign " $0}' || true
  fi
  set +e
  "$dir/tool" creat >"$dir/out" 2>"$dir/err"
  status=$?
  set -e
  echo "candidate $name exec-status $status"
  echo "candidate $name exec-stderr $(tr '\n' ' ' < "$dir/err")"
  cp "$dir/tool" "$root/editor/bin/.dirfd-exec-probe"
  chmod 755 "$root/editor/bin/.dirfd-exec-probe"
  set +e
  "$root/editor/bin/.dirfd-exec-probe" creat >"$dir/out2" 2>"$dir/err2"
  status2=$?
  set -e
  rm -f "$root/editor/bin/.dirfd-exec-probe"
  echo "candidate $name exec-in-tree-status $status2"
  echo "candidate $name exec-in-tree-stderr $(tr '\n' ' ' < "$dir/err2")"
  if [ "$status" -ne 2 ] || [ "$status2" -ne 2 ]; then
    echo "candidate $name does not run" >&2
    return 1
  fi
  hash_file "$dir/tool" > "$dir/hash"
  return 0
}

official=""
if [ "$osname" = linux ]; then
  if ! build_pair linux ""; then
    echo "not reproducible" >&2
    exit 1
  fi
  official=$(cat "$work/linux/hash")
  cp "$work/linux/tool" "$work/tool"
  echo "official linux $official"
else
  # Default link first. A fixed UUID is the fallback that still puts LC_UUID
  # in the file. -no_uuid is recorded and is not accepted: that binary
  # abort-traps. The first candidate that matches itself and runs wins.
  for spec in "default|" "fixed-uuid|-Wl,-uuid,00112233445566778899aabbccddeeff" "no-uuid|-Wl,-no_uuid"; do
    name=${spec%%|*}
    extra=${spec#*|}
    if build_pair "$name" "$extra"; then
      if [ "$name" = "no-uuid" ]; then
        echo "candidate no-uuid ran; refusing it because this OS abort-trapped that flag before and a running copy is unexpected" >&2
        continue
      fi
      official=$(cat "$work/$name/hash")
      cp "$work/$name/tool" "$work/tool"
      echo "official $name $official"
      break
    fi
  done
fi
if [ -z "$official" ] || [ ! -f "$work/tool" ]; then
  echo "not reproducible" >&2
  exit 1
fi
first=$official
second=$official
echo "rebuild-1 $first"
echo "rebuild-2 $second"

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

# The rebuilt binary must perform a directory-fd stat. On macOS this also
# prints whether /dev/fd can be executed. The server does not use that path.
node --input-type=module - "$work/tool" << 'EOF'
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tool = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dirfd-probe-"));
const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const toolFd = fs.openSync(tool, fs.constants.O_RDONLY);
function run(execPath) {
  const result = spawnSync(execPath, ["stat", "missing-name"], {
    stdio: ["ignore", "pipe", "pipe", dirFd, toolFd],
    env: {},
    encoding: "utf8",
  });
  return {
    status: result.status,
    error: result.error && result.error.code,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}
const byPath = run(tool);
console.log("exec-path " + JSON.stringify(byPath));
if (process.platform === "darwin") console.log("exec-devfd " + JSON.stringify(run("/dev/fd/4")));
fs.closeSync(toolFd);
fs.closeSync(dirFd);
fs.rmSync(dir, { recursive: true, force: true });
if (byPath.status !== 0 || byPath.stdout !== "missing") process.exit(1);
EOF

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

chmod 755 "$root/editor" "$root/editor/bin" "$pinned"
echo "pinned helper matches"
