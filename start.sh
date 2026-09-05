#!/usr/bin/env bash
# Honors PORT and AIDANOS_HOST (default 127.0.0.1). Phone/LAN: AIDANOS_HOST=0.0.0.0 ./start.sh — see PHONE.md
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
if [ -z "${AIDANOS_VAULT:-}" ]; then
  unset AIDANOS_VAULT
fi
PIDF=logs/aidanos.pid
LOGF=logs/aidanos.log
PORT_N="${PORT:-3847}"
HEALTH=http://127.0.0.1:${PORT_N}/api/health
SIT=32457
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
hcode() { curl -sS -o /dev/null -w "%{http_code}" --max-time 2 "$HEALTH" 2>/dev/null || echo 000; }
if [ "$(hcode)" = 200 ] && [ -f "$PIDF" ]; then
  old=$(cat "$PIDF" || true)
  if alive "$old"; then exit 0; fi
fi
if [ -f "$PIDF" ]; then
  old=$(cat "$PIDF" || true)
  if alive "$old"; then
    pkill -P "$old" 2>/dev/null || true
    kill "$old" 2>/dev/null || true
    n=0
    while [ "$n" -lt 20 ] && alive "$old"; do sleep 0.1; n=$((n+1)); done
    alive "$old" && kill -9 "$old" 2>/dev/null || true
    pkill -9 -P "$old" 2>/dev/null || true
  fi
fi
if alive "$SIT"; then
  cmd=$(ps -p "$SIT" -o args= 2>/dev/null || true)
  on=0
  ss -tlnp 2>/dev/null | grep ":${PORT_N}" | grep -q "pid=$SIT" && on=1
  case "$cmd" in
    *node\ server.mjs*)
      if [ "$on" = 1 ]; then
        kill "$SIT" 2>/dev/null || true
        n=0
        while [ "$n" -lt 20 ] && alive "$SIT"; do sleep 0.1; n=$((n+1)); done
        alive "$SIT" && kill -9 "$SIT" 2>/dev/null || true
      fi
      ;;
  esac
fi
n=0
while [ "$n" -lt 20 ] && [ "$(hcode)" = 200 ]; do sleep 0.1; n=$((n+1)); done
setsid npm start </dev/null >>"$LOGF" 2>&1 &
echo $! > "$PIDF"
n=0
ok=0
while [ "$n" -lt 40 ]; do
  if [ "$(hcode)" = 200 ]; then ok=1; break; fi
  sleep 0.25
  n=$((n+1))
done
if [ "$ok" != 1 ]; then
  echo "start.sh: http://127.0.0.1:${PORT_N}/api/health not 200" >&2
  exit 1
fi
