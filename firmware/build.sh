#!/usr/bin/env bash
# Build Obdurate locally and leave an OTA-ready image in firmware/build/.
#
# Uses an arduino-cli already on this machine when it already has the ESP32 core -
# an Arduino IDE install counts. Only when there is none does it install a private
# one into firmware/.toolchain/ (~6 GB unpacked, several minutes), and that install
# writes nothing outside this repo, so deleting the directory undoes it completely.
#
# Usage:
#   firmware/build.sh              # compile
#   firmware/build.sh --upload     # compile, then flash over USB
#
# Environment:
#   PORT=COM3                # upload port; guessed from `arduino-cli board list`
#   ARDUINO_CLI=/path/to/it  # a specific arduino-cli to prefer
#   OBDURATE_ISOLATED=1      # ignore any system install; use firmware/.toolchain/
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
TC="$HERE/.toolchain"
OUT="$HERE/build"
# PSRAM is off by default on this board; the scan hit list and the JSON it builds
# both live there rather than competing with the web server for the 320 KB heap.
FQBN="esp32:esp32:XIAO_ESP32S3:PSRAM=opi"

# Git Bash reports MINGW64_NT-... and runs .exe files, so the tool has a suffix
# there and nowhere else.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE=".exe" ;;
  *)                    EXE="" ;;
esac

# Behind a proxy that terminates TLS, point Go's HTTP client at its CA bundle.
if [ -z "${SSL_CERT_FILE:-}" ] && [ -f /root/.ccr/ca-bundle.crt ]; then
  export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
fi

# Reuse an arduino-cli that this machine already has, when it already has the ESP32
# core. The private toolchain below is a ~6 GB download, and paying it next to an
# existing Arduino install is pure waste - which is exactly what happened the first
# time this script ran on the development machine, where the IDE's core was sitting
# in ~/AppData/Local/Arduino15 the whole time.
#
# Reused, never written to. If the existing install has no ESP32 core we fall back
# to the private one rather than installing into a shared directory - the promise
# that this script writes nothing outside the repo still holds.
#
# OBDURATE_ISOLATED=1 forces the private toolchain, which is what CI wants: a build
# that depends on whatever happens to be on the machine is not reproducible.
CLI=""
if [ "${OBDURATE_ISOLATED:-0}" != "1" ]; then
  for c in "${ARDUINO_CLI:-}" arduino-cli \
           "/c/Program Files/Arduino CLI/arduino-cli$EXE" \
           "$HOME/.local/bin/arduino-cli" \
           "/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"; do
    [ -n "$c" ] || continue
    command -v "$c" >/dev/null 2>&1 || continue
    if "$c" core list 2>/dev/null | grep -q '^esp32:esp32'; then
      CLI="$c"
      echo "==> using the arduino-cli already on this machine, with its ESP32 core"
      echo "    $CLI"
      echo "    (OBDURATE_ISOLATED=1 to build against a private toolchain instead)"
      break
    fi
  done
fi

if [ -z "$CLI" ]; then
  export ARDUINO_DIRECTORIES_DATA="$TC/data"
  export ARDUINO_DIRECTORIES_DOWNLOADS="$TC/downloads"
  export ARDUINO_DIRECTORIES_USER="$TC/user"
  CLI="$TC/bin/arduino-cli$EXE"
  PRIVATE_TC=1
  mkdir -p "$TC/bin" "$ARDUINO_DIRECTORIES_DATA" "$ARDUINO_DIRECTORIES_DOWNLOADS" \
           "$ARDUINO_DIRECTORIES_USER"
fi

if [ "${PRIVATE_TC:-0}" = "1" ] && [ ! -x "$CLI" ]; then
  echo "==> installing arduino-cli into firmware/.toolchain/"
  # Windows ships as a .zip; everything else as a .tar.gz. Getting this wrong is
  # silent until the moment of use: Git Bash matched the catch-all below and
  # downloaded the Linux build, which unpacks perfectly well and then fails with
  # "cannot execute binary file: Exec format error" on the first call.
  case "$(uname -s)" in
    Darwin)  ARCHIVE=tar.gz
             case "$(uname -m)" in
               arm64) PKG=macOS_ARM64 ;;
               *)     PKG=macOS_64bit ;;
             esac ;;
    MINGW*|MSYS*|CYGWIN*)
             ARCHIVE=zip
             case "$(uname -m)" in
               aarch64|arm64) PKG=Windows_ARM64 ;;
               *)             PKG=Windows_64bit ;;
             esac ;;
    *)       ARCHIVE=tar.gz
             case "$(uname -m)" in
               aarch64|arm64) PKG=Linux_ARM64 ;;
               *)             PKG=Linux_64bit ;;
             esac ;;
  esac
  curl -fsSL --retry 3 \
    "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_${PKG}.${ARCHIVE}" \
    -o "$TC/acli.$ARCHIVE"
  if [ "$ARCHIVE" = zip ]; then
    # Git Bash has no unzip. python3 is already a hard dependency of the host
    # tests this script runs a few lines down, so use it rather than adding one.
    if command -v unzip >/dev/null 2>&1; then
      unzip -oq "$TC/acli.zip" "arduino-cli$EXE" -d "$TC/bin"
    else
      python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])" \
        "$TC/acli.zip" "arduino-cli$EXE" "$TC/bin"
    fi
  else
    tar -xzf "$TC/acli.tar.gz" -C "$TC/bin" arduino-cli
  fi
  chmod +x "$CLI"
  rm -f "$TC/acli.$ARCHIVE"
fi

# Fail here rather than three steps later with a confusing error from a tool that
# was never runnable in the first place.
"$CLI" version >/dev/null 2>&1 || {
  echo "arduino-cli at $CLI will not run - wrong build for this platform?" >&2
  echo "Remove $TC and re-run to reinstall." >&2
  exit 1
}

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
          "$HERE/Obdurate/version.h")
[ -n "$VERSION" ] || { echo "could not read FW_VERSION from version.h" >&2; exit 1; }

echo "==> compiling v$VERSION"
"$CLI" compile --fqbn "$FQBN" --output-dir "$OUT" --warnings default "$HERE/Obdurate"

# Name the image after the version so a .bin sitting in a downloads folder still
# says which build it is. arduino-cli always writes Obdurate.ino.bin, so copy.
IMAGE="$OUT/Obdurate-v$VERSION.bin"
cp "$OUT/Obdurate.ino.bin" "$IMAGE"

# The full-flash image, under the stable name the web flasher's manifest asks for.
# docs/flash/manifest.json points at a release asset rather than a versioned
# filename, so the Install button keeps working across releases without the manifest
# needing a bump - which means the asset has to be named the same every time.
FULL="$OUT/Obdurate-merged.bin"
cp "$OUT/Obdurate.ino.merged.bin" "$FULL"

echo
echo "OTA image: $IMAGE"
ls -lh "$IMAGE"
echo
echo "Upload it at http://192.168.4.1/update after joining the board's Wi-Fi."
echo "The /update page shows \"running v$VERSION\" once the new image boots, so it"
echo "doubles as confirmation. The dashboard header shows the frontend bundle's own"
echo "version instead - the frontend split decoupled the two."
echo "Obdurate.ino.merged.bin is a full-flash image for USB recovery - do NOT"
echo "feed that one to /update, it is not an OTA app image."
echo
echo "For a release, attach BOTH, under exactly these names:"
echo "  $IMAGE"
echo "    the OTA app image - what /update takes over Wi-Fi"
echo "  $FULL"
echo "    the full-flash image - what docs/flash/ hands to a browser over USB."
echo "    Its name is fixed because the flasher manifest points at"
echo "    releases/latest/download/Obdurate-merged.bin and must not change per release."

if [ "${1:-}" = "--upload" ]; then
  # Ask arduino-cli, which knows about COM ports as well as /dev nodes - the glob
  # below finds nothing under Git Bash, where the board is COM3 and there is no
  # /dev/ttyACM0 to match. Take only a port it recognises as an esp32, so a
  # Bluetooth serial port (Windows has several by default) is not flashed at.
  if [ -z "${PORT:-}" ]; then
    PORT="$("$CLI" board list 2>/dev/null \
            | awk '$2 == "serial" && /esp32/ { print $1; exit }' || true)"
  fi
  PORT="${PORT:-$(ls /dev/ttyACM* /dev/ttyUSB* /dev/cu.usbmodem* 2>/dev/null | head -1 || true)}"
  if [ -z "$PORT" ]; then
    echo "No serial port found. Set PORT=... and re-run." >&2
    exit 1
  fi
  echo "==> uploading over USB on $PORT"
  "$CLI" upload -p "$PORT" --fqbn "$FQBN" --input-dir "$OUT" "$HERE/Obdurate"
fi
