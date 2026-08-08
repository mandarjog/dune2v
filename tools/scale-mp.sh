#!/usr/bin/env bash
# Scale dune2v up for multiplayer (dedicated CPU).
# Restarts the machine — active in-memory matches will drop.
set -euo pipefail
APP="${FLY_APP:-dune2v}"

echo "→ Scaling $APP to performance-1x (1 dedicated vCPU, 2GB RAM)…"
echo "  Warning: machine restart — open multiplayer rooms will be lost."
fly scale vm performance-1x --memory 2048 -a "$APP"
echo
fly scale show -a "$APP"
echo
fly status -a "$APP"
echo
echo "Done. Health: https://${APP}.fly.dev/health"
echo "Size down later:  ./tools/scale-idle.sh"
