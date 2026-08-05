#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MONITOR_PORT:-5193}"
API_ORIGIN="${MONITOR_API_ORIGIN:-https://globe.rgb.sk}"

for arg in "$@"; do
	case "$arg" in
		-h | --help)
			echo "Usage: ./scripts/dev-monitor.sh"
			echo ""
			echo "Serves monitor/ with Vite (auto-reload on file changes)."
			echo "  Monitor    http://localhost:${PORT}/?origin=${API_ORIGIN}"
			echo ""
			echo "Env overrides:"
			echo "  MONITOR_PORT         (default: 5193)"
			echo "  MONITOR_API_ORIGIN   (default: https://globe.rgb.sk)"
			exit 0
			;;
	esac
done

VITE_BIN="$ROOT/FE/node_modules/.bin/vite"
THREE_PKG="$ROOT/FE/node_modules/three"
if [[ ! -x "$VITE_BIN" || ! -d "$THREE_PKG" ]]; then
	echo "Error: FE deps missing (vite/three). Run: npm run install:all" >&2
	exit 1
fi

export MONITOR_PORT="$PORT"
export MONITOR_API_ORIGIN="$API_ORIGIN"

echo "==> Globe monitor  http://localhost:${PORT}/?origin=${API_ORIGIN}"
echo "    Pointing at API ${API_ORIGIN} (Vite auto-reload)"
echo ""

exec "$VITE_BIN" --config "$ROOT/monitor/vite.config.js"
