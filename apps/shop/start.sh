#!/usr/bin/env bash
# Sri Nachiya Medicals — starts the shop's billing app on this computer.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node is not installed. Install Node 22 or newer, then run this again."; exit 1; }
(sleep 1; command -v xdg-open >/dev/null && xdg-open http://localhost:8123 || open http://localhost:8123) >/dev/null 2>&1 &
exec node server.js
