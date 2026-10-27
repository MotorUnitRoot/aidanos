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
# The default UUID is a content hash on this linker, so two builds match.
# -Wl,-no_uuid also matched, then macOS abort-trapped the binary before main,
# so that flag is not used. -Wl,-no_adhoc_codesign abort-trapped as well.
# Executing /dev/fd returns EACCES. The server executes the checked path.
#
# The same macOS job also builds the x64 helper, for a Node that is Intel
# even when the runner is arm64:
#   cc -arch x86_64 -O2 -fno-ident -ffile-prefix-map=$ROOT=srcroot \
#       -frandom-seed=aidanos-dirfd -o OUT editor/dirfd-tool.c
# The hash is compared even when this CPU cannot run x86_64. A bad CPU type
# skips the exec probe and does not fail the hash check.
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

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

print_base64() {
  echo "BEGIN DIRFD BASE64"
  if base64 -w 0 </dev/null >/dev/null 2>&1; then
    base64 -w 0 < "$1"
  else
    base64 < "$1" | tr -d '\n'
  fi
  echo
  echo "END DIRFD BASE64"
}

# Same output path both times, so a path embedded by the linker is not a
# difference. A timestamp or UUID that survives the flags above still is.
# $1 arch name, $2 extra compiler flags, $3 "run" to exec the binary.
check_arch() {
  archname=$1
  extra=$2
  run_probe=$3
  pinned="$root/editor/bin/dirfd-tool-${osname}-${archname}"
  echo "---- ${osname}-${archname}"
  echo "extra: ${extra:-<none>}"
  # shellcheck disable=SC2086
  "$compiler" $flags $extra -o "$work/tool" "$root/editor/dirfd-tool.c"
  cp "$work/tool" "$work/first"
  rm -f "$work/tool"
  # shellcheck disable=SC2086
  "$compiler" $flags $extra -o "$work/tool" "$root/editor/dirfd-tool.c"
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
  runnable=no
  if [ "$run_probe" = run ]; then
    set +e
    "$work/tool" creat >/dev/null 2>"$work/cpuerr"
    status=$?
    set -e
    if grep -i -q "bad cpu" "$work/cpuerr"; then
      echo "skip exec probe: $(tr '\n' ' ' < "$work/cpuerr")"
    elif [ "$status" -gt 128 ]; then
      echo "skip exec probe: exit $status"
    else
      runnable=yes
    fi
  fi
  if [ "$runnable" = yes ]; then
    expect_status() {
      expected=$1
      shift
      set +e
      "$work/tool" "$@" >/dev/null 2>"$work/err"
      status=$?
      set -e
      if [ "$status" -ne "$expected" ]; then
        echo "helper $* exited $status, expected $expected" >&2
        echo "stderr: $(tr '\n' ' ' < "$work/err")" >&2
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
  fi
  if [ ! -f "$pinned" ]; then
    echo "pinned helper is missing: $pinned" >&2
    echo "rebuild does not match the pinned helper" >&2
    print_base64 "$work/tool"
    exit 1
  fi
  pinned_hash=$(hash_file "$pinned")
  echo "pinned $pinned_hash"
  if [ "$first" != "$pinned_hash" ]; then
    echo "rebuild does not match the pinned helper" >&2
    print_base64 "$work/tool"
    exit 1
  fi
  chmod 755 "$root/editor" "$root/editor/bin" "$pinned"
  echo "pinned helper matches"
}

if [ "$osname" = darwin ] && [ "$archname" = arm64 ]; then
  check_arch arm64 "" run
  check_arch x64 "-arch x86_64" run
elif [ "$osname" = darwin ] && [ "$archname" = x64 ]; then
  check_arch x64 "-arch x86_64" run
else
  check_arch "$archname" "" run
fi
