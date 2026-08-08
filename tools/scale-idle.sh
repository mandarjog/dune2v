#!/usr/bin/env bash
# Scale dune2v down to the cheap baseline (shared CPU).
# Restarts the machine — active in-memory matches will drop.
set -euo pipefail
APP="${FLY_APP:-dune2v}"

echo "→ Scaling $APP to shared-cpu-1x (1 shared vCPU, 512MB RAM)…"
echo "  Warning: machine restart — open multiplayer rooms will be lost."
fly scale vm shared-cpu-1x --memory 512 -a "$APP"
echo
fly scale show -a "$APP"
echo
fly status -a "$APP"
echo
echo "Done. Health: https://${APP}.fly.dev/health"
echo "Size up for MP:  ./tools/scale-mp.sh"
