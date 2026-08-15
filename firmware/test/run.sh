#!/usr/bin/env bash
# Host-side tests. No board, no car, no ESP32 core needed - the transport code is
# extracted from the sketch and compiled against fake TWAI/ELM327 shims, and the
# dashboard logic is pulled out of the served pages and run under node.
set -euo pipefail

cd "$(dirname "$0")"

echo "== extracting transport code from NexonOBD.ino =="
python3 extract.py ../NexonOBD/NexonOBD.ino isotp_extract.h

echo "== ISO-TP + mode 01 =="
g++ -std=c++17 -I. -Wall -Wextra -Wno-unused-parameter -o isotp_test test_isotp.cpp
./isotp_test

echo
echo "== dashboard =="
node test_dashboard.mjs
