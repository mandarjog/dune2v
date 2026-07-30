# Dune II — Browser Skirmish

Unofficial single-page HTML clone inspired by *Dune II: The Building of a Dynasty* (Westwood, 1992).

**Not affiliated** with the rights holders. Fan project for education/fun. Procedural art only — no original Westwood assets.

License: **MIT** (code).

## Play (dev)

Recommended — Node server (same stack as production, includes `/ws`):

```bash
cd /Users/mjog/dev/dune2
npm install
npm start
# → http://localhost:8080/
# → ws://localhost:8080/ws
```

Or a plain static server / `file://`:

```bash
python3 -m http.server 8080
# open index.html via file:// (multiplayer WS unavailable)
```

## Deploy (Fly.io)

Production host: **static game + WebSocket** on one Fly app (not Vercel).

```bash
# once: create app (name must be unique on Fly)
fly apps create dune2v   # skip if app already exists

fly deploy
# → https://dune2v.fly.dev/
# → wss://dune2v.fly.dev/ws
```

Health check: `GET /health` → `{ "ok": true }`.

### Multiplayer (shared room)

1. Open the game on Fly (or `npm start`).
2. Enter **your name**, then **Host room** → copy the link (`?room=ABC123`).
3. Friend opens the link → enters **their name** → **Join match** (Harkonnen / red if host is already in).
4. Match auto-starts when the second player connects. Names show in the lobby and sidebar.

**Server** runs the simulation (real-time, not turn-based) and holds full match state in memory. Both browsers only send orders and render snapshots. AI is off in MP.

**Reconnect:** if you drop mid-match, reopen the same room link within ~15 minutes with the same browser (stable `playerId` in localStorage) to reclaim your seat; the sim keeps running. Intentional **Cancel/Leave** frees the seat. Keep a single Fly machine so both players share the same room process.

**Chat:** in multiplayer, use the sidebar chat box (or press Enter) to message your opponent. Chat appears top-left on the map.

**Speed:** single-player `+` / `-` keys. Multiplayer: speed dropdown requests a change; opponent must Accept (server clock).

**Replays:** multiplayer matches are recorded on the server. Main menu → **Watch replays**.

**Help:** `?` or Help button (top-right / menu).

**Feedback:** top-right **Feedback** or main menu → posts to `POST /api/feedback` (logged on the server).

Config: [`fly.toml`](./fly.toml) — `min_machines_running = 1`, `auto_stop_machines = off` so multiplayer rooms are not cold-stopped mid-match. Tweak region/size there.

```bash
fly status
fly logs
fly apps open
```

### Query flags

| Flag | Effect |
|------|--------|
| `?debug=1` | Cheats: **F1** +credits, **F2** spawn enemy army, **F4** reveal map, F3 overlay |
| `?ai=0` | Disable enemy AI |
| `?fog=0` | Disable fog of war |

## Controls

| Input | Action |
|-------|--------|
| LMB | Select / box select |
| Double-click unit | Select all of type |
| RMB | Move / attack enemy / harvest spice |
| Ctrl+RMB | Attack-move |
| **E** | Deploy MCV → Construction Yard |
| **H** | Harvester → nearest spice |
| **X** / **.** | Stop |
| Ctrl+1–9 | Assign control group |
| 1–9 | Recall group |
| WASD / arrows | Pan camera |
| Minimap click | Jump camera |
| Esc | Pause (also saves) |
| F3 | Debug overlay |
| F5 | Quicksave |

### Save / refresh

The game **autosaves** while you play (~15s), on pause, and when the tab closes. After a refresh, use **Continue** on the main menu (not “New Skirmish”).

Credits are capped by spice storage (`1000` base + `1000` per Silo). A Combat Tank is `600¢`, Harvester `800¢`, MCV `2000¢` — build **Silos** before expensive units.

## Release pack (single file)

```bash
chmod +x tools/pack.sh
./tools/pack.sh
# → dist/index.html  (open via file:// offline)
```

## Architecture

See [DESIGN.md](./DESIGN.md). Vanilla JS + Canvas 2D map + DOM sidebar. Fixed **20 Hz** simulation (`dt = 0.05s`), rAF render.

```
js/     simulation + presentation modules (Dune2.* namespaces)
maps/   embedded skirmish map
css/    sidebar chrome
tools/  pack.sh → dist/index.html
tests/  node --test pure-sim tests
```

## Tests

```bash
node --test tests/*.test.js
```

## MVP goal

1v1 skirmish: harvest spice → build base → army → destroy enemy CY (and MCV).  
Sandworms default **off**. Full campaign / house uniques are post-MVP.
