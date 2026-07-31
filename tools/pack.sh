#!/usr/bin/env bash
# Pack multi-file dev tree into a single offline dist/index.html
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/index.html"
mkdir -p "$ROOT/dist"

CSS="$ROOT/css/styles.css"
SCRIPTS=(
  "$ROOT/js/config.js"
  "$ROOT/js/seats.js"
  "$ROOT/js/rng.js"
  "$ROOT/js/sprites.js"
  "$ROOT/js/map.js"
  "$ROOT/js/pathfinding.js"
  "$ROOT/js/entities.js"
  "$ROOT/js/orders.js"
  "$ROOT/js/economy.js"
  "$ROOT/js/combat.js"
  "$ROOT/js/ai.js"
  "$ROOT/js/game.js"
  "$ROOT/js/renderer.js"
  "$ROOT/js/input.js"
  "$ROOT/js/ui.js"
  "$ROOT/js/loop.js"
  "$ROOT/js/save.js"
  "$ROOT/js/net.js"
  "$ROOT/maps/skirmish1.js"
  "$ROOT/maps/skirmish_large.js"
  "$ROOT/js/main.js"
)

{
  cat <<'HDR'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Dune II — Browser Skirmish</title>
<style>
HDR
  cat "$CSS"
  cat <<'MID'
</style>
</head>
<body>
<div id="app">
  <div id="game-wrap">
    <canvas id="game-canvas"></canvas>
    <div id="debug-overlay"></div>
  </div>
  <aside id="sidebar">
    <h1>Dune II</h1>
    <div class="stat-row"><span class="label">Credits</span><span class="value" id="stat-credits">0 / 1000</span></div>
    <div class="stat-row"><span class="label">Power</span><span class="value" id="stat-power">0 / 0</span></div>
    <div id="power-bar"><div id="power-fill"></div></div>
    <div class="section-title">Minimap</div>
    <canvas id="minimap" width="200" height="200"></canvas>
    <div id="selection-info"><div class="meta">No selection</div></div>
    <div id="unit-menu"></div>
    <div id="build-menu"></div>
    <div class="hint">LMB select · RMB move/attack · E deploy · H harvest · Esc pause · F3 debug</div>
    <div id="messages"></div>
  </aside>
</div>
<div id="menu-modal" class="modal-backdrop">
  <div class="modal">
    <h2>Dune II</h2>
    <p>Unofficial browser skirmish inspired by Westwood’s Dune II.</p>
    <div class="actions">
      <button id="btn-continue" type="button" style="display:none">Continue</button>
      <button id="btn-start" type="button">New Skirmish</button>
    </div>
  </div>
</div>
<div id="pause-modal" class="modal-backdrop hidden">
  <div class="modal">
    <h2>Paused</h2>
    <div class="actions">
      <button id="btn-resume" type="button">Resume</button>
      <button id="btn-restart" type="button">Restart</button>
    </div>
  </div>
</div>
<div id="end-modal" class="modal-backdrop hidden">
  <div class="modal">
    <h2>Victory</h2>
    <p></p>
    <div class="actions">
      <button id="btn-end-restart" type="button">Play Again</button>
      <button id="btn-end-menu" type="button">Main Menu</button>
    </div>
  </div>
</div>
<script>
MID
  for f in "${SCRIPTS[@]}"; do
    echo "/* ---- $(basename "$f") ---- */"
    # strip sourceURL noise; keep as-is
    cat "$f"
    echo
  done
  cat <<'FTR'
</script>
</body>
</html>
FTR
} >"$OUT"

echo "Packed → $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
