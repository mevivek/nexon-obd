#!/usr/bin/env bash
# Host-side tests. No board, no car, no ESP32 core needed - the transport code is
# extracted from the sketch and compiled against fake TWAI/ELM327 shims, and the
# rest of the sketch is asserted against its own source under node.
#
# The frontend is not tested here: it lives in web/ and has its own Vitest suite
# (npm --prefix web test). The one exception is the all-values table, which needs a
# real browser and is driven against the built bundle by test_table.mjs below.
set -euo pipefail

cd "$(dirname "$0")"

echo "== extracting transport code from Obdurate.ino =="
python3 extract.py ../Obdurate/Obdurate.ino isotp_extract.h

echo "== ISO-TP + mode 01 =="
g++ -std=c++17 -I. -Wall -Wextra -Wno-unused-parameter -o isotp_test test_isotp.cpp
./isotp_test

echo
echo "== firmware source =="
node test_dashboard.mjs

echo
echo "== laptop dashboard =="
# tools/dashboard.html is served by obd_dashboard.ps1 on a PC, not by the board, so
# it did not move into web/ and keeps its own copy of the merge/hold/flag logic.
# Nothing else covers it.
node test_laptop.mjs

echo
echo "== all-values table =="
# Needs a real browser: the pairing between a row definition and the cell that shows
# it is only observable once rendered, so nothing short of a browser can tell a
# correctly wired table from a broken one. Builds web/dist if it is missing, and
# skips itself, without failing, where playwright is not installed.
node test_table.mjs
