#!/usr/bin/env bash
# Build NexonOBD locally and leave an OTA-ready image in firmware/build/.
#
# Installs arduino-cli and the ESP32 core into firmware/.toolchain/ on first run
# (~6 GB unpacked, several minutes) and reuses them afterwards. Nothing is written
# outside this repo, so removing firmware/.toolchain/ undoes the whole install.
#
# Usage:
#   firmware/build.sh              # compile
#   firmware/build.sh --upload     # compile, then flash over USB
#
# Upload port: set PORT=/dev/ttyACM0 (or COM3 under Git Bash) to override the guess.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
TC="$HERE/.toolchain"
OUT="$HERE/build"
# PSRAM is off by default on this board; the scan hit list and the JSON it builds
# both live there rather than competing with the web server for the 320 KB heap.
FQBN="esp32:esp32:XIAO_ESP32S3:PSRAM=opi"

export ARDUINO_DIRECTORIES_DATA="$TC/data"
export ARDUINO_DIRECTORIES_DOWNLOADS="$TC/downloads"
export ARDUINO_DIRECTORIES_USER="$TC/user"
CLI="$TC/bin/arduino-cli"

# Behind a proxy that terminates TLS, point Go's HTTP client at its CA bundle.
if [ -z "${SSL_CERT_FILE:-}" ] && [ -f /root/.ccr/ca-bundle.crt ]; then
  export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
fi

mkdir -p "$TC/bin" "$ARDUINO_DIRECTORIES_DATA" "$ARDUINO_DIRECTORIES_DOWNLOADS" \
         "$ARDUINO_DIRECTORIES_USER"

if [ ! -x "$CLI" ]; then
  echo "==> installing arduino-cli into firmware/.toolchain/"
  case "$(uname -s)" in
    Darwin) case "$(uname -m)" in
              arm64) PKG=macOS_ARM64 ;;
              *)     PKG=macOS_64bit ;;
            esac ;;
    *)      case "$(uname -m)" in
              aarch64|arm64) PKG=Linux_ARM64 ;;
              *)             PKG=Linux_64bit ;;
            esac ;;
  esac
  curl -fsSL --retry 3 \
    "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_${PKG}.tar.gz" \
    -o "$TC/acli.tar.gz"
  tar -xzf "$TC/acli.tar.gz" -C "$TC/bin" arduino-cli
  chmod +x "$CLI"
  rm -f "$TC/acli.tar.gz"
fi

if ! "$CLI" core list 2>/dev/null | grep -q '^esp32:esp32'; then
  echo "==> installing the ESP32 core (slow the first time, ~6 GB unpacked)"
  "$CLI" config init --overwrite >/dev/null
  "$CLI" config add board_manager.additional_urls \
    https://espressif.github.io/arduino-esp32/package_esp32_index.json
  "$CLI" core update-index
  "$CLI" core install esp32:esp32
fi

echo "==> host tests"
"$HERE/test/run.sh"

VERSION=$(sed -n 's/.*#define[[:space:]]\+FW_VERSION[[:space:]]\+"\([^"]*\)".*/\1/p' \
          "$HERE/NexonOBD/version.h")
[ -n "$VERSION" ] || { echo "could not read FW_VERSION from version.h" >&2; exit 1; }

echo "==> compiling v$VERSION"
"$CLI" compile --fqbn "$FQBN" --output-dir "$OUT" --warnings default "$HERE/NexonOBD"

# Name the image after the version so a .bin sitting in a downloads folder still
# says which build it is. arduino-cli always writes NexonOBD.ino.bin, so copy.
IMAGE="$OUT/NexonOBD-v$VERSION.bin"
cp "$OUT/NexonOBD.ino.bin" "$IMAGE"

echo
echo "OTA image: $IMAGE"
ls -lh "$IMAGE"
echo
echo "Upload it at http://192.168.4.1/update after joining the board's Wi-Fi."
echo "The dashboard header shows v$VERSION once it boots, so you can confirm it took."
echo "NexonOBD.ino.merged.bin is a full-flash image for USB recovery - do NOT"
echo "feed that one to /update, it is not an OTA app image."

if [ "${1:-}" = "--upload" ]; then
  PORT="${PORT:-$(ls /dev/ttyACM* /dev/ttyUSB* /dev/cu.usbmodem* 2>/dev/null | head -1 || true)}"
  if [ -z "$PORT" ]; then
    echo "No serial port found. Set PORT=... and re-run." >&2
    exit 1
  fi
  echo "==> uploading over USB on $PORT"
  "$CLI" upload -p "$PORT" --fqbn "$FQBN" --input-dir "$OUT" "$HERE/NexonOBD"
fi
