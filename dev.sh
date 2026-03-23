#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Colores
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo -e "${CYAN}Starting a11y Crawler (v3 — API + Worker + local Chromium)${RESET}"
echo ""

# --- PostgreSQL (Docker) ---
if ! docker ps --format '{{.Names}}' | grep -q '^postgres-dev$'; then
  if docker ps -a --format '{{.Names}}' | grep -q '^postgres-dev$'; then
    echo -e "${GREEN}▶ PostgreSQL → starting existing container${RESET}"
    docker start postgres-dev > /dev/null
  else
    echo -e "${GREEN}▶ PostgreSQL → creating container on port 5433${RESET}"
    docker run -d --name postgres-dev -p 5433:5432 \
      -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=a11y \
      postgres:16-alpine > /dev/null
  fi
  # Wait for PostgreSQL to be ready
  echo -n "  Waiting for PostgreSQL..."
  for i in $(seq 1 30); do
    if docker exec postgres-dev pg_isready -U postgres > /dev/null 2>&1; then
      echo -e " ${GREEN}ready${RESET}"
      break
    fi
    sleep 0.5
    echo -n "."
  done
else
  echo -e "${GREEN}▶ PostgreSQL → already running${RESET}"
fi

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:dev@localhost:5433/a11y}"

# --- Kill previous processes on dev ports ---
fuser -k 3000/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true

PIDS=()

# --- API Server ---
echo -e "${GREEN}▶ API Server → http://localhost:3000${RESET}"
bun run "$ROOT/src/server/index.ts" &
PIDS+=($!)

# --- Worker (no BROWSERLESS_URL → launches local Chromium) ---
echo -e "${GREEN}▶ Worker     → local Chromium, polling DB${RESET}"
bun run "$ROOT/src/worker/index.ts" &
PIDS+=($!)

# --- Frontend ---
echo -e "${GREEN}▶ Frontend   → http://localhost:5173${RESET}"
cd "$ROOT/frontend" && bun run dev &
PIDS+=($!)

echo ""
echo -e "${CYAN}All services started. Ctrl+C to stop.${RESET}"

# Ctrl+C → stop all
cleanup() {
  echo ""
  echo -e "${YELLOW}Stopping services...${RESET}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  echo -e "${GREEN}Done.${RESET}"
  exit 0
}
trap cleanup INT TERM

wait
