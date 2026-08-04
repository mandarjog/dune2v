# Path / move subsystem — requirements & test contract

Automated coverage: `tests/path-movement.test.js`  
Related: `tests/formation.test.js`, `tests/mass-move.test.js`, `tests/pathfinding.test.js`

## Goals

| ID | Requirement | User-visible |
|----|-------------|--------------|
| **R1** | Open-ground mass move: ≥80% of a dense group advances | Army obeys M |
| **R2** | Formation: distinct personal goals; arrive at **slot**, not shared click; no 20-on-1 stack | No death-ball pile |
| **R3** | Cliff edge: paths + motion near / around cliffs | No red freeze at rim |
| **R4** | Base edge: leave / approach rock + buildings without freeze | No wedge at CY |
| **R5** | Spam re-issue: rapid M still advances most units; **ensurePath never wipes** a good path on A* fail | Frustration-click safe |
| **R6** | Empty path recovery: unit does not stay frozen forever | Crawl / repath |
| **R7** | Attack-move keeps marching while auto-firing in range | Not “only 1 unit moved” |

## Invariants (do not break without updating tests)

1. **Issue** assigns a path for almost all movers (flow or A*).
2. **Personal slot** is the arrival condition for group point-moves.
3. **Failed repath** must not clear a non-empty path.
4. **Units do not block** pathfinding (soft stack allowed on the march).
5. **Idle separation** may unstack only when `path` is empty and not mid move-crawl.
6. **Budget**: repaths per tick are capped; recovery may span ticks.
7. **SP + MP** share the same `Orders.tick` / `Path.*` code (server runs sim in MP).

## Known policy stack (current implementation)

```
issue → formationSlots + assignGroupMove (flow|astar) + finishPathAtSlot
tick  → arrive? → ensurePath/recoverPath/stepToward → followPath → stuck stages
```

See conversation notes: these policies interact; change one with full suite green.

## Re-engineering principles (next step)

1. **Single writer of `path`**: issue + one repath module; no silent wipe.
2. **States**: `marching | recovering | arrived | idle` explicit, not flag soup.
3. **Tests first**: any repath change must keep `path-movement` green.
4. **No deploy during live rooms** unless intentional (rooms are in-memory).
5. **Telemetry**: `/api/telemetry` stuck_path / heartbeats for SP visibility.

## Running

```bash
node --test tests/path-movement.test.js
npm test
```
