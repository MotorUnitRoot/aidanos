#!/usr/bin/env bash
# Keep a quick Cloudflare tunnel on PORT (default 3847). Shop use — not the forever host.
set -euo pipefail
PORT_N="${PORT:-3847}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="${CLOUDFLARED_BIN:-cloudflared}"
if [[ -x /workspace/cloudflared ]]; then BIN=/workspace/cloudflared; fi
LOG="${ROOT}/logs/tunnel.log"
mkdir -p "${ROOT}/logs"
echo "keep-tunnel: pointing at http://127.0.0.1:${PORT_N}" | tee -a "$LOG"
exec "$BIN" tunnel --url "http://127.0.0.1:${PORT_N}" --no-autoupdate 2>&1 | tee -a "$LOG"
