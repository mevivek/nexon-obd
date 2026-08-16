#!/usr/bin/env bash
# Build the frontend and upload it to the board.
#
#   web/deploy.sh [host]        default host 192.168.4.1
#
# Join the board's Wi-Fi first. This replaces the installed bundle; it does not
# touch the firmware, and it cannot brick the board - /ui is compiled into flash,
# so it stays reachable whatever state the bundle ends up in, and the firmware
# falls back to its own pages whenever no bundle is installed.
#
# Only the gzipped copies are uploaded. Every browser accepts gzip, the firmware
# serves them with Content-Encoding, and it roughly halves what the bundle costs on
# a partition shared with trip logs.
set -euo pipefail

HOST="${1:-192.168.4.1}"
cd "$(dirname "$0")"

echo "==> building"
npm run build

echo
echo "==> checking the board answers at $HOST"
if ! curl -fsS --max-time 5 "http://$HOST/ui/manifest" >/dev/null; then
  echo "no answer from http://$HOST/ui/manifest" >&2
  echo "join the board's Wi-Fi, or pass its address: web/deploy.sh <host>" >&2
  exit 1
fi

# Clearing first keeps the budget honest: the build emits content-hashed names, so
# without this every deploy would leave the previous bundle's files behind.
echo "==> removing the installed bundle"
curl -fsS "http://$HOST/ui/clear" >/dev/null

echo "==> uploading"
shopt -s nullglob
for f in dist/*.gz; do
  name="/$(basename "$f")"
  printf '    %-28s ' "$name"
  # One file per request: the board has a single-threaded web server and a modest
  # heap, and concurrent multipart uploads are how a deploy fails halfway.
  resp=$(curl -fsS -F "f=@$f;filename=$name" "http://$HOST/ui/upload")
  case "$resp" in
    *'"ok":true'*) echo "ok" ;;
    *) echo "FAILED: $resp" >&2; exit 1 ;;
  esac
done

echo
echo "==> installed"
curl -fsS "http://$HOST/ui/manifest"
echo
echo
echo "Open http://$HOST/ - the board serves the bundle when one is installed,"
echo "and its own pages when none is. http://$HOST/ui manages it."
