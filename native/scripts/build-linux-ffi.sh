#!/usr/bin/env bash
# Build the Automerge engine for Linux and point pkg-config at it.
# The published automerge-swift package refuses to compile on Linux. This
# script checks out the same 0.7.2 sources, removes that refusal, and builds
# the Rust library those sources already ship. Mac and iOS do not use this.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cache="$root/.cache"
src="$cache/automerge-swift"
pkgdir="$cache/pkgconfig"
tag="0.7.2"

mkdir -p "$cache"
if [[ ! -d "$src/.git" ]]; then
  git clone --depth 1 --branch "$tag" https://github.com/automerge/automerge-swift.git "$src"
fi

refusal="$src/Sources/Automerge/_AutomergeLinux.swift"
if [[ -f "$refusal" ]]; then
  rm -f "$refusal"
fi

lib="$src/rust/target/release/libuniffi_automerge.a"
if [[ ! -f "$lib" ]]; then
  cargo build --manifest-path "$src/rust/Cargo.toml" --locked --release
fi

mkdir -p "$pkgdir"
cat > "$pkgdir/_CAutomergeUniffi.pc" <<EOF
prefix=$src
libdir=\${prefix}/rust/target/release
includedir=\${prefix}/Sources/_CAutomergeUniffi/include

Name: _CAutomergeUniffi
Description: Automerge engine built from automerge-swift $tag
Version: $tag
Libs: -L\${libdir} -luniffi_automerge -lpthread -ldl -lm
Cflags: -I\${includedir}
EOF

echo "PKG_CONFIG_PATH=$pkgdir"
echo "Export that before: swift test --package-path $root/AidanCore"
