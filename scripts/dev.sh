#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_PROCESSOR=false

for arg in "$@"; do
	case "$arg" in
		-h | --help)
			echo "Usage: ./scripts/dev.sh [--no-processor]"
			echo ""
			echo "Starts local dev stack:"
			echo "  Processor  http://localhost:8080  (Docker)"
			echo "  API        http://localhost:8787"
			echo "  Frontend   http://localhost:5173"
			exit 0
			;;
		--no-processor)
			SKIP_PROCESSOR=true
			;;
	esac
done

if [[ ! -f "$ROOT/.dev.vars" ]]; then
	echo "==> Creating .dev.vars from example"
	cp "$ROOT/.dev.vars.example" "$ROOT/.dev.vars"
fi

# shellcheck disable=SC1091
set -a
source "$ROOT/.dev.vars"
set +a

STARTED_PROCESSOR=false

cleanup() {
	local pid
	for pid in $(jobs -p); do
		kill "$pid" 2>/dev/null || true
	done
	if [[ "$STARTED_PROCESSOR" == true ]]; then
		echo "==> Stopping processor"
		docker compose -f "$ROOT/docker-compose.yml" down 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

if [[ "$SKIP_PROCESSOR" == false ]]; then
	if ! command -v docker >/dev/null 2>&1; then
		echo "Error: docker is required. Install Docker or run with --no-processor." >&2
		exit 1
	fi
	echo "==> Starting processor on http://localhost:8080"
	docker compose -f "$ROOT/docker-compose.yml" up --build -d processor
	STARTED_PROCESSOR=true
fi

echo "==> Starting API on http://localhost:8787"
# Watch mode reloads when BE/shared imports change (plain tsx keeps a stale module graph).
npx tsx watch --clear-screen=false "$ROOT/BE/src/dev-server.ts" &

echo "==> Starting frontend on http://localhost:5173"
npm run dev --prefix "$ROOT/FE" &

wait
