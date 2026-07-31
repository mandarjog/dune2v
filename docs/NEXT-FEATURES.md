# Next features — sketch

| Field | Value |
|-------|-------|
| **Date** | 2026-07-31 |
| **Status** | Draft → implement in order below |
| **Context** | Feedback asked for live spectate; we also want a larger map and stronger multiplayer |

Implementation order (this doc):

1. **Bigger grid / skirmish map**
2. **Live spectate + match list**
3. **Multiplayer expansion** (beyond fixed 1v1 seats — phased)

---

## 1. Bigger grid

### Why
64×64 feels tight once both sides boom. More rock, spice, and approach lanes improves harvester wars and flanking.

### Options

| Size | Tiles | vs 64² | Notes |
|------|-------|--------|--------|
| **96×96** | 9 216 | 2.25× | Recommended first step |
| 128×128 | 16 384 | 4× | Heavier pathfinding / fog; later |
| Two maps | 64 + 96 | — | Lobby map pick |

### Design (v1 = 96×96 default skirmish)

- New map def `skirmish_large` (or regenerate `skirmish1` at 96).
- **Spawns:** keep 2 corners (NW / SE or classic bottom-left / top-right), farther apart than today.
- **Spice:** 2–3 major fields + a few contested mid patches.
- **Rock:** larger plateaus so both sides can expand without instant wall-in.
- **Pathfinding:** raise `path.maxNodes` (e.g. 512 → 2048) and keep repath budget sane.
- **Minimap / camera:** already tile-relative; verify clamp and FOW arrays size with map.
- **MP + SP + AI + replay:** all consume `D.MAPS.*`; room start sends `map: 'skirmish_large'`.
- **Recording:** init blob already stores full map; old 64² replays still load.

### Non-goals (this step)
- Procedural map gen UI
- 4+ spawn points (see MP expansion)
- Naval / special terrain

### Acceptance
- [x] New skirmish is 96×96 (or configurable), playable SP vs AI
- [x] MP room starts on large map
- [x] Harvesters path across map; no OOM from fog (`2 * w * h` bytes is fine at 96)
- [x] Replay of new matches works
  - Map id: `skirmish_large` (`maps/skirmish_large.js`); classic 64² kept as `skirmish1` / `skirmish_classic`
  - `path.maxNodes` raised to 2048; SP/MP default to large map

---

## 2. Live spectate + match list

### Why
Feedback:

> `/live` should show current matches… ask permission to view… see what they are doing.

### Goals
- Discover **in-progress** rooms on this server.
- Join as **spectator** (no seat, no commands, FOW off or dual-view).
- Optional: **host must approve** spectate requests (polite default).

### Architecture

```
Browser                  Server
   |                        |
   | GET /api/live          |  list rooms: code, names, phase, age, spectators
   |----------------------->|
   |                        |
   | WS { type: spectate,   |
   |       room, name }     |
   |----------------------->|  if room.allowSpectate || approved
   |                        |  slot role=spectator (not in MAX_SEATS)
   |   state snapshots      |  same as players (or lean)
   |<-----------------------|
   |   (ignore cmd from     |
   |    spectator seat)     |
```

### UX

1. **Main menu → “Live matches”** (and route `/?live=1` or `/live` if we add static rewrite).
2. **List:** room code, `mjog vs Hellblazer`, elapsed, `1 watching`, Open / Request.
3. **Spectate session:**
   - Sidebar: both houses’ scoreboard (reuse replay scoreboard).
   - FOW **off** (true spectator) — simplest and matches “see what they are doing.”
   - No build menu / no orders; chat optional read-only or “spec chat” later.
   - Banner: `SPECTATING · room AB12`
4. **Permission modes** (config per room, host toggle in lobby):
   - `open` — anyone can spectate (default for v1 if we want speed)
   - `ask` — spectator sends request; host Accept/Decline toast
   - `off` — no spectate

### Server rules
- Spectators **do not** count toward `MAX_SEATS` (still 2 players).
- Cap e.g. **8 spectators** per room.
- `applyCommand` from spectator → reject.
- Disconnect spectator does not end match.
- Do not write spectator actions into recordings.

### Privacy / abuse
- Room codes stay unguessable; list only **started** public rooms (or all non-empty).
- Host can kick spectators later.

### Acceptance
- [x] `/api/live` returns active matches
- [x] Menu list → join as spectator → see both sides live
- [x] Spectator cannot build/order
- [x] Players unaffected; match still records 2 seats only
  - `GET /api/live` · WS `{ type: 'spectate', room, name }` · protocol 6
  - FOW off via `game.spectator`; dual scoreboard; Esc → menu
  - Cap 8 spectators/room; default `allowSpectate: open`

---

## 3. Multiplayer expansion (sketch; after 1–2)

### Today
- Exactly **2 seats**: `player` (Atreides blue) / `enemy` (Harkonnen red).
- Server sim, cmd stream recording, reconnect by `playerId`.

### Directions (pick later)

| Mode | Seats | Notes |
|------|-------|--------|
| **A. Better 1v1** | 2 | Map pick, timed games, ranked later — low risk |
| **B. FFA 3** | 3 | Atreides / Ordos / Harkonnen; 3 spawns; win = last CY standing |
| **C. 2v2** | 4 | Teams, shared vision optional, much more UI |

**Recommendation:** finish **large map + spectate**, then **timed 1v1** (already discussed), then **FFA 3** if demand holds.

### FFA 3 sketch (not in first implement pass)
- Seats: `p0`, `p1`, `p2` with house colors blue / green / red.
- `MAX_SEATS = 3`; start when 3 connected (or 2 + AI fill — later).
- Win: only one owner has CY or MCV.
- Fog per owner; minimap colors per seat.
- Recording: `names` map + cmds tagged by seat (already).
- AI: only for empty seats in “vs AI” skirmish, not ranked MP.

### Bigger MP checklist (when started)
- [ ] Generalize `localOwner` / seat list beyond player|enemy
- [ ] Lobby roster N names
- [ ] Map spawns N
- [ ] `checkWinLoss` last-team / last-player alive
- [ ] Net protocol bump if seat enums change

---

## Implementation plan (this session)

| Step | Deliverable | Subagent |
|------|-------------|----------|
| **1** | 96×96 skirmish map, wire SP/MP/AI, path limits | implement-map |
| **2** | Live list + spectator join + FOW-off view | implement-spectate |
| **3** | (Deferred) FFA3 / timed mode — design only unless time left | — |

### Risks
- Large map pathfinding cost → raise `maxNodes`, profile harvester paths.
- Spectate state bandwidth → same as 2 clients already; cap spectator count.
- Seat rename breaks old clients → keep `player`/`enemy` until FFA work.

---

## Open questions
1. Spectate default **open** or **ask host**? → **open** for v1, host toggle later.
2. Large map replace default or second choice? → **default large**, keep 64 as `skirmish_classic` if easy.
3. Wall-clock vs sim-time for future timed mode? → sim-time (prior discussion).
