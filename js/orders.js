/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function clearOrder(u) {
    u.order = null;
    u.orders = [];
    u.path = [];
    u.repathQueued = false;
  }

  function setOrder(u, order) {
    u.orders = [order];
    u.order = order;
    u.path = [];
    u.repathQueued = false;
    u.stuck = false;
    u.stuckReason = null;
    u._stuckSince = 0;
    if (u.harvest && order.type !== 'harvest') {
      u.harvest.state = 'idle';
      u.harvest.refineryId = null;
    }
  }

  function clearStuck(u) {
    u.stuck = false;
    u.stuckReason = null;
    u._stuckSince = 0;
  }

  /**
   * Idle / holding: lock the nearest visible hostile in sight and chase into
   * weapon range. Move-in-progress is left alone (weapon-range free-fire only).
   */
  function autoAcquire(game, u) {
    if (!u || u.hp <= 0) return false;
    if (u.type === 'harvester' || u.type === 'mcv') return false;
    const def = D.config.units[u.type];
    if (!def || !def.weapon) return false;
    if (!D.Combat || !D.Combat.findHostileInRadius) return false;
    const t = D.Combat.findHostileInRadius(game, u, null);
    if (!t) return false;
    setOrder(u, { type: 'attack', targetId: t.id });
    return true;
  }

  /**
   * Unique walkable goal slots around a click (spiral).
   * Prevents whole selection pathing to the exact same tile.
   * @returns {Array<{x:number,y:number}>}
   */
  function formationSlots(map, gx, gy, n) {
    const slots = [];
    if (n <= 0) return slots;
    const spacing =
      (D.config.path && D.config.path.formationSpacing) != null
        ? D.config.path.formationSpacing
        : 0.85;
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    const used = new Set();

    function openness(tx, ty) {
      // Prefer tiles not hugging buildings/cliffs (less wedge at base edges)
      let open = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (D.Map.isWalkable(map, tx + dx, ty + dy)) open++;
        }
      }
      return open;
    }

    function tryAdd(tx, ty) {
      if (!D.Map.isWalkable(map, tx, ty)) return false;
      // Skip tight pockets (need 4+ open neighbors once first slot taken)
      if (openness(tx, ty) < 4 && slots.length > 0) return false;
      const k = ty * 4096 + tx;
      if (used.has(k)) return false;
      used.add(k);
      const jx = ((tx * 17 + ty * 31) % 7) * 0.04 - 0.12;
      const jy = ((tx * 13 + ty * 23) % 7) * 0.04 - 0.12;
      slots.push({ x: tx + 0.5 + jx, y: ty + 0.5 + jy });
      return true;
    }

    // Prefer click tile first
    tryAdd(cx, cy);
    let ring = 1;
    while (slots.length < n && ring < 48) {
      for (let dx = -ring; dx <= ring && slots.length < n; dx++) {
        tryAdd(cx + dx, cy - ring);
        if (slots.length >= n) break;
        tryAdd(cx + dx, cy + ring);
      }
      for (let dy = -ring + 1; dy <= ring - 1 && slots.length < n; dy++) {
        tryAdd(cx - ring, cy + dy);
        if (slots.length >= n) break;
        tryAdd(cx + ring, cy + dy);
      }
      ring++;
    }
    // Fallback: duplicate last walkable with micro-offsets if map is tight
    while (slots.length < n) {
      const base = slots.length ? slots[slots.length - 1] : { x: gx, y: gy };
      const i = slots.length;
      slots.push({
        x: base.x + (i % 3) * 0.2,
        y: base.y + Math.floor(i / 3) * 0.2,
      });
    }
    return slots;
  }

  /** Drop path waypoints very near the end, then append the unit's formation slot. */
  function finishPathAtSlot(path, slot) {
    if (!slot) return path || [];
    const p = path ? path.slice() : [];
    while (p.length) {
      const last = p[p.length - 1];
      if (Math.hypot(last.x - slot.x, last.y - slot.y) < 1.25) p.pop();
      else break;
    }
    p.push({ x: slot.x, y: slot.y });
    return p;
  }

  /**
   * Soft separation for units that are not actively pathing.
   * - Never push units that still have a path (fights followPath / vibration).
   * - Idle units (no move order) get a stronger unstack so group-arrivals don't pile.
   *
   * Runs in the sim (SP + server MP). Pure client-side separation cannot work for
   * multiplayer: the next server snapshot overwrites positions.
   */
  function applySeparation(game, dt) {
    const units = game.units;
    if (!units || units.length < 2) return;
    if ((game.tick | 0) % 3 !== 0) return;

    const r =
      (D.config.path && D.config.path.separationRadius) != null
        ? D.config.path.separationRadius
        : 0.65;
    const strength =
      (D.config.path && D.config.path.separationStrength) != null
        ? D.config.path.separationStrength
        : 0.4;
    const r2 = r * r;
    const cell = 1;
    const buckets = new Map();

    const list = [];
    for (const u of units) {
      if (u.hp <= 0) continue;
      // Critical: no separation while following a path
      if (u.path && u.path.length > 0) continue;
      // Still on a point-move with empty path (crawling) — don't fight crawl
      if (u.order && (u.order.type === 'move' || u.order.type === 'attack-move')) {
        continue;
      }
      list.push(u);
    }
    const n = list.length;
    if (n < 2 || n > 160) return;

    for (let i = 0; i < n; i++) {
      const u = list[i];
      const bx = Math.floor(u.x / cell);
      const by = Math.floor(u.y / cell);
      const key = by * 4096 + bx;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(i);
    }

    const pushX = new Float64Array(n);
    const pushY = new Float64Array(n);
    const fMul = strength * Math.min(1, dt * 12) * 4;

    for (let i = 0; i < n; i++) {
      const a = list[i];
      const bx = Math.floor(a.x / cell);
      const by = Math.floor(a.y / cell);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const neigh = buckets.get((by + oy) * 4096 + (bx + ox));
          if (!neigh) continue;
          for (let k = 0; k < neigh.length; k++) {
            const j = neigh[k];
            if (j <= i) continue;
            const b = list[j];
            if (a.owner !== b.owner) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= r2 || d2 < 1e-8) continue;
            const d = Math.sqrt(d2);
            const pen = (r - d) / r;
            const f = pen * fMul;
            const ux = dx / d;
            const uy = dy / d;
            pushX[i] -= ux * f;
            pushY[i] -= uy * f;
            pushX[j] += ux * f;
            pushY[j] += uy * f;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (pushX[i] === 0 && pushY[i] === 0) continue;
      const u = list[i];
      const nx = u.x + pushX[i];
      const ny = u.y + pushY[i];
      if (D.Map.isWalkable(game.map, Math.floor(nx), Math.floor(ny))) {
        u.x = nx;
        u.y = ny;
      }
    }
  }

  /** True if another living unit (any owner) is near world point. */
  function unitNear(game, x, y, radius, except) {
    const r2 = radius * radius;
    for (const o of game.units) {
      if (o === except || o.hp <= 0) continue;
      const dx = o.x - x;
      const dy = o.y - y;
      if (dx * dx + dy * dy < r2) return o;
    }
    return null;
  }

  /** Pick a walkable alternate goal near (gx,gy) when primary is jammed. */
  function alternateGoal(map, gx, gy, preferAwayFrom, maxR) {
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    const R = maxR != null ? maxR : 10;
    let best = null;
    let bestScore = -1e9;
    for (let r = 1; r <= R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (!D.Map.isWalkable(map, tx, ty)) continue;
          // Prefer open tiles so we don't re-wedge in 1-wide pockets
          let open = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              if (D.Map.isWalkable(map, tx + ox, ty + oy)) open++;
            }
          }
          let score = -r + open * 0.35;
          if (preferAwayFrom) {
            score += Math.hypot(tx + 0.5 - preferAwayFrom.x, ty + 0.5 - preferAwayFrom.y) * 0.12;
          }
          if (score > bestScore) {
            bestScore = score;
            best = { x: tx + 0.5, y: ty + 0.5 };
          }
        }
      }
      if (best && r >= 3 && bestScore > -2) break;
    }
    return best;
  }

  /** If unit is on a blocked tile, snap to nearest walkable (prevents permanent no-path). */
  function unstickStart(game, u) {
    if (!game.map || !D.Map) return false;
    const tx = Math.floor(u.x);
    const ty = Math.floor(u.y);
    if (D.Map.isWalkable(game.map, tx, ty)) return false;
    const n =
      D.Path && D.Path.nearestWalkable
        ? D.Path.nearestWalkable(game.map, u.x, u.y, 5)
        : null;
    if (!n) return false;
    u.x = n.gx + 0.5;
    u.y = n.gy + 0.5;
    return true;
  }

  function followStandoff() {
    return (D.config.path && D.config.path.followStandoff) != null
      ? D.config.path.followStandoff
      : 1.75;
  }

  function followRepathDist() {
    return (D.config.path && D.config.path.followRepathDist) != null
      ? D.config.path.followRepathDist
      : 1.25;
  }

  /**
   * Goal near a follow target: standoff ring, stable per-unit angle to reduce stacking.
   * @param {object} target unit
   * @param {object} follower unit
   * @param {number} [slotIndex] optional group index for ring spacing
   */
  function followGoal(target, follower, slotIndex) {
    const standoff = followStandoff();
    const idx = slotIndex != null ? slotIndex : follower.id || 0;
    const ang = ((idx * 2.399963) % (Math.PI * 2)) + (follower.id || 0) * 0.17;
    let gx = target.x + Math.cos(ang) * standoff;
    let gy = target.y + Math.sin(ang) * standoff;
    return { x: gx, y: gy };
  }

  /** True if follower's owner can see target (friendly always; enemy needs FOW). */
  function canFollowTarget(game, owner, target) {
    if (!target || target.hp <= 0) return false;
    // Buildings not supported in v1
    if (target.tileW != null) return false;
    if (target.owner === owner) return true;
    if (D.Combat && D.Combat.canSee) {
      return D.Combat.canSee(game, owner, target.x, target.y);
    }
    if (D.Map && D.Map.isVisible) {
      return D.Map.isVisible(game, owner, Math.floor(target.x), Math.floor(target.y));
    }
    return true;
  }

  /**
   * Aggressive repath when empty-path / stuck: personal slot → group click → alts.
   * @returns {boolean} true if a non-empty path was assigned
   */
  function recoverPath(game, u, order, allowRepath) {
    if (!D.Path || !game.map) return false;
    unstickStart(game, u);
    if (allowRepath && !allowRepath()) return false;

    const candidates = [];
    if (order.x != null && order.y != null) candidates.push({ x: order.x, y: order.y });
    if (order.groupX != null && order.groupY != null) {
      candidates.push({ x: order.groupX, y: order.groupY });
    }
    const alt1 = alternateGoal(game.map, order.x, order.y, { x: u.x, y: u.y }, 10);
    if (alt1) candidates.push(alt1);
    if (order.groupX != null) {
      const altG = alternateGoal(
        game.map,
        order.groupX,
        order.groupY,
        { x: u.x, y: u.y },
        10
      );
      if (altG) candidates.push(altG);
    }
    // Escape near self toward goal
    const toward = alternateGoal(game.map, u.x, u.y, null, 4);
    if (toward) candidates.push(toward);

    for (const c of candidates) {
      const path = D.Path.find(game.map, u.x, u.y, c.x, c.y);
      if (path && path.length) {
        u.path = path;
        u._lastRepathTick = game.tick;
        // If we had to abandon personal slot, retarget order to reachable point
        if (Math.hypot(c.x - order.x, c.y - order.y) > 0.6) {
          u.order = Object.assign({}, order, { x: c.x, y: c.y });
          u.orders = [u.order];
        }
        return true;
      }
    }
    u.path = [];
    u._lastRepathTick = game.tick;
    return false;
  }

  /**
   * Last-resort crawl: one walkable step toward (tx,ty) so armies never freeze solid
   * when A-star or flow fails (chokes, spam repath budget, bad formation slots).
   * @returns {boolean} true if the unit moved
   */
  function stepToward(game, u, tx, ty, dt) {
    if (!game.map || !D.Map) return false;
    unstickStart(game, u);
    const def = D.config.units[u.type];
    const speed = def ? def.speed : 1;
    const step = Math.min(speed * (dt || 0.05), 0.95);
    const dx = tx - u.x;
    const dy = ty - u.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.08) return false;

    const ux = dx / dist;
    const uy = dy / dist;
    // Toward goal, then diagonals/sides, then any walkable neighbor
    const dirs = [
      [ux, uy],
      [ux - uy * 0.5, uy + ux * 0.5],
      [ux + uy * 0.5, uy - ux * 0.5],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];

    let best = null;
    let bestNd = dist + 1;
    let any = null;
    for (const [sx, sy] of dirs) {
      const len = Math.hypot(sx, sy) || 1;
      const nx = u.x + (sx / len) * step;
      const ny = u.y + (sy / len) * step;
      if (!D.Map.isWalkable(game.map, Math.floor(nx), Math.floor(ny))) continue;
      const nd = Math.hypot(tx - nx, ty - ny);
      if (!any) any = { nx, ny, sx: sx / len, sy: sy / len };
      if (nd < bestNd) {
        bestNd = nd;
        best = { nx, ny, sx: sx / len, sy: sy / len };
      }
    }
    // Prefer progress toward goal; if boxed in, take any walkable step (escape)
    if (!best || bestNd >= dist - 1e-4) best = any;
    if (!best) return false;
    u.x = best.nx;
    u.y = best.ny;
    u.facing = (Math.atan2(best.sy, best.sx) + Math.PI * 2) % (Math.PI * 2);
    // Micro-waypoint ahead so the next tick still has a path to follow
    const mx = u.x + best.sx * 0.9;
    const my = u.y + best.sy * 0.9;
    if (D.Map.isWalkable(game.map, Math.floor(mx), Math.floor(my))) {
      u.path = [{ x: mx, y: my }];
    }
    return true;
  }

  function stuckMessage(u) {
    const name = (D.config.units[u.type] && D.config.units[u.type].name) || u.type;
    const tips = {
      path: name + ' is stuck — no path (clear walls/units or re-order).',
      dock: name + ' waiting — refinery dock is busy.',
      silos: name + ' cannot unload — silos full (build silos or spend credits).',
      deploy:
        name +
        ' cannot deploy — need a clear 2×2 rock pad (move onto rock, then E).',
      blocked: name + ' is stuck.',
    };
    return tips[u.stuckReason] || tips.blocked;
  }

  /**
   * Path a list of units to (gx,gy). If any fail, retry only the failures in
   * smaller subsets down to size 1 (individual A*). Guarantees we always try
   * singles when the whole blob is frozen.
   * @returns {{ ok:number, fail:number }}
   */
  function cascadePathUnits(map, units, gx, gy) {
    if (!units || !units.length || !map || !D.Path) {
      return { ok: 0, fail: 0 };
    }
    const cascade =
      (D.config.path && D.config.path.pathCascade) || [16, 8, 4, 1];
    let pending = units.slice();
    let okTotal = 0;

    // First pass: natural chunk size (or all if small)
    const firstN = Math.min(
      pending.length,
      (D.config.path && D.config.path.massPathChunk) || 24
    );
    const sizes = [firstN].concat(cascade).filter((n, i, a) => n > 0 && a.indexOf(n) === i);
    // Ensure 1 is last
    if (sizes[sizes.length - 1] !== 1) sizes.push(1);

    for (let s = 0; s < sizes.length && pending.length; s++) {
      const size = sizes[s];
      const nextFail = [];
      for (let i = 0; i < pending.length; i += size) {
        const slice = pending.slice(i, i + size);
        if (size === 1) {
          for (const u of slice) {
            // Individual A* + recovery goals — last resort that usually works
            let path = D.Path.find(map, u.x, u.y, gx, gy);
            if (!path || !path.length) {
              const alt = alternateGoal(map, gx, gy, { x: u.x, y: u.y }, 14);
              if (alt) path = D.Path.find(map, u.x, u.y, alt.x, alt.y);
              if (path && path.length && u.order) {
                u.order = Object.assign({}, u.order, { x: alt.x, y: alt.y });
                u.orders = [u.order];
              }
            }
            if (path && path.length) {
              u.path = path;
              okTotal++;
            } else {
              u.path = [];
              nextFail.push(u);
            }
          }
        } else {
          if (D.Path.assignGroupMove) {
            D.Path.assignGroupMove(map, slice, gx, gy);
          } else {
            for (const u of slice) {
              u.path = D.Path.find(map, u.x, u.y, gx, gy) || [];
            }
          }
          for (const u of slice) {
            if (u.path && u.path.length) okTotal++;
            else {
              u.path = [];
              nextFail.push(u);
            }
          }
        }
      }
      pending = nextFail;
      // If this size got nobody, jump toward singles faster
      if (pending.length === units.length && size > 1) continue;
    }
    return { ok: okTotal, fail: pending.length };
  }

  /**
   * Units that should be moving but aren't: empty path or no progress, with a
   * move/attack-move order, not already at goal.
   */
  function collectFrozenMovers(game, owner) {
    const out = [];
    const arrive =
      (D.config.path && D.config.path.arrivalDist) != null
        ? D.config.path.arrivalDist + 0.5
        : 0.6;
    for (const u of game.units) {
      if (u.owner !== owner || u.hp <= 0) continue;
      const o = u.order;
      if (!o || (o.type !== 'move' && o.type !== 'attack-move')) continue;
      const d = Math.hypot(u.x - o.x, u.y - o.y);
      if (d < arrive) continue;
      const empty = !u.path || !u.path.length;
      const stalled = (u._noProgressSec || 0) > 0.55;
      const flagged = !!(u.stuck && u.stuckReason === 'path');
      if (empty || stalled || flagged) out.push(u);
    }
    return out;
  }

  /**
   * Detect "nobody can move" blobs and cascade re-path smaller subsets until
   * someone gets a path. SP + server MP only.
   */
  function helpStuckArmy(game, repathsRef, maxRepaths) {
    if (!game || !game.units || !D.Path || !game.map) return;
    if (game.multiplayer && !game._serverSim) return;
    if (game.replay && !game._serverSim) return;

    const warnN =
      (D.config.path && D.config.path.stuckArmyWarn) != null
        ? D.config.path.stuckArmyWarn
        : 6;
    const checkEvery =
      (D.config.path && D.config.path.stuckArmyCheckTicks) != null
        ? D.config.path.stuckArmyCheckTicks
        : 15;
    const maxPerPulse =
      (D.config.path && D.config.path.stuckArmyRepathChunk) != null
        ? D.config.path.stuckArmyRepathChunk
        : 32;

    // Don't thrash every tick
    if (game._stuckArmyRepathTick && game.tick - game._stuckArmyRepathTick < checkEvery) {
      return;
    }

    const owners =
      game.multiplayer && game._serverSim && D.Seats && D.Seats.active
        ? D.Seats.active(game)
        : [
            D.Game && D.Game.me
              ? D.Game.me(game)
              : game.localOwner || 'player',
          ];

    for (const owner of owners) {
      const frozen = collectFrozenMovers(game, owner);
      if (frozen.length < warnN) continue;

      game._stuckArmyRepathTick = game.tick;

      const local =
        D.Game && D.Game.me ? D.Game.me(game) : game.localOwner || 'player';
      if (
        owner === local &&
        D.Game &&
        D.Game.pushMessage &&
        (!game._stuckArmyMsgTick || game.tick - game._stuckArmyMsgTick > 100)
      ) {
        game._stuckArmyMsgTick = game.tick;
        D.Game.pushMessage(
          game,
          frozen.length +
            ' units frozen — cascading re-path (smaller groups → singles).'
        );
      }

      frozen.sort((a, b) => a.id - b.id);
      // Work a pulse of units; rotate offset so everyone eventually gets a turn
      const off = (game._stuckArmyOffset || 0) % Math.max(1, frozen.length);
      game._stuckArmyOffset = off + maxPerPulse;
      const slice = [];
      for (let i = 0; i < Math.min(maxPerPulse, frozen.length); i++) {
        slice.push(frozen[(off + i) % frozen.length]);
      }

      // Common goal = average of group clicks (or personal)
      let gx = 0;
      let gy = 0;
      let nGoal = 0;
      for (const u of slice) {
        clearStuck(u);
        u.path = [];
        u._noProgressSec = 0;
        u._altGoalTried = false;
        u._groupGoalTried = false;
        u._lastRepathTick = -999;
        const ox = u.order.groupX != null ? u.order.groupX : u.order.x;
        const oy = u.order.groupY != null ? u.order.groupY : u.order.y;
        if (ox != null && oy != null) {
          gx += ox;
          gy += oy;
          nGoal++;
        }
      }
      if (!nGoal) continue;
      gx /= nGoal;
      gy /= nGoal;

      // Point everyone at shared walkable goal first (slots often stack / block)
      for (const u of slice) {
        if (u.order) {
          u.order = Object.assign({}, u.order, {
            x: gx,
            y: gy,
            groupX: u.order.groupX != null ? u.order.groupX : gx,
            groupY: u.order.groupY != null ? u.order.groupY : gy,
          });
          u.orders = [u.order];
        }
      }

      const result = cascadePathUnits(game.map, slice, gx, gy);
      // Last-ditch crawl for anyone still empty
      for (const u of slice) {
        if (u.path && u.path.length) continue;
        recoverPath(game, u, u.order, () => {
          if (repathsRef.count >= maxRepaths) return false;
          repathsRef.count++;
          return true;
        });
        if ((!u.path || !u.path.length) && u.order) {
          // Micro-path one step toward goal so they at least leave the pile
          stepToward(game, u, u.order.x, u.order.y, D.config.DT_SEC || 0.05);
        }
      }
      if (game.stats) {
        game.stats.cascadeRepathOk = result.ok;
        game.stats.cascadeRepathFail = result.fail;
      }
    }
  }

  function dockCenter(ref) {
    return {
      x: (ref.dockTileX != null ? ref.dockTileX : ref.tileX) + 0.5,
      y:
        (ref.dockTileY != null ? ref.dockTileY : ref.tileY + (ref.tileH || 1)) +
        0.5,
    };
  }

  /** Who is currently unloading at this refinery (one pad). */
  function dockUnloader(game, refId, except) {
    for (const o of game.units) {
      if (o === except || o.type !== 'harvester' || !o.harvest) continue;
      if (o.harvest.state === 'unload' && o.harvest.refineryId === refId) return o;
    }
    return null;
  }

  /** Stable queue index among harvesters inbound to the same refinery. */
  function dockQueueIndex(game, u, refId) {
    let i = 0;
    for (const o of game.units) {
      if (o === u || o.type !== 'harvester' || !o.harvest) continue;
      if (o.harvest.refineryId !== refId) continue;
      const st = o.harvest.state;
      if (st !== 'moveToRefinery' && st !== 'seekRefinery') continue;
      if (o.id < u.id) i++;
    }
    return i;
  }

  /** Holding pad next to the dock so waiters don't stack on the unloader. */
  function dockHoldPoint(ref, queueIndex) {
    const c = dockCenter(ref);
    const n = queueIndex + 1;
    const side = n % 2 === 0 ? 1 : -1;
    const ring = Math.ceil(n / 2);
    const ang = Math.PI * 0.5 + side * ring * 0.65;
    const rad = 1.7 + Math.floor(queueIndex / 4) * 0.85;
    return { x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad };
  }

  /** Count harvesters already assigned to a refinery (for load balance). */
  function refineryLoad(game, refId) {
    let n = 0;
    for (const o of game.units) {
      if (o.type !== 'harvester' || !o.harvest) continue;
      if (o.harvest.refineryId === refId && o.harvest.state !== 'idle') n++;
    }
    return n;
  }

  /** Flag unit stuck + throttle a sidebar message (SP / local sim only). */
  function markStuck(game, u, reason, dt) {
    u._stuckSince = (u._stuckSince || 0) + (dt || 0);
    // Path stuck: wait longer — crawl recovery often unsticks within a few seconds
    const need = reason === 'path' ? 3.5 : 2.5;
    if (u._stuckSince < need) return;
    const was = u.stuck;
    const prevReason = u.stuckReason;
    u.stuck = true;
    u.stuckReason = reason || 'blocked';
    // MP server: only set flags (clients announce from snapshots)
    if (game.multiplayer && game._serverSim) return;
    const local = D.Game && D.Game.me ? D.Game.me(game) : 'player';
    if (u.owner !== local) return;
    // Throttle messages harder: ~8s between same-reason toasts
    if (was && prevReason === u.stuckReason && u._stuckMsgAt && game.tick - u._stuckMsgAt < 160) {
      return;
    }
    u._stuckMsgAt = game.tick;
    if (D.Game && D.Game.pushMessage) D.Game.pushMessage(game, stuckMessage(u));
  }

  D.Orders = {
    stuckMessage,

    /** Client: toast when local units become / stay stuck (MP snapshots). */
    announceStuckFromNet(game, localOwner, prevById) {
      if (!game || !game.units || !D.Game.pushMessage) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      game._stuckNetMsgAt = game._stuckNetMsgAt || {};
      for (const u of game.units) {
        if (u.owner !== localOwner || !u.stuck) continue;
        const prev = prevById && prevById[u.id];
        const newly = !prev || !prev.stuck || prev.reason !== u.stuckReason;
        const last = game._stuckNetMsgAt[u.id] || 0;
        // New stuck → always; same stuck → remind every 10s
        if (!newly && now - last < 10000) continue;
        game._stuckNetMsgAt[u.id] = now;
        D.Game.pushMessage(game, stuckMessage(u));
      }
    },

    issue(game, unitIds, order) {
      const pathBatch = !!(D.Path && D.Path.beginBatch);
      if (pathBatch) D.Path.beginBatch();

      /** @type {object[]} units that need a shared point path (move / attack-move) */
      const pointMovers = [];

      for (const id of unitIds) {
        const u = game.units.find((x) => x.id === id);
        if (!u || u.owner !== (order._owner || u.owner)) continue;
        // only issue to living
        if (u.hp <= 0) continue;

        if (order.type === 'deploy') {
          if (u.type !== 'mcv') continue;
          setOrder(u, { type: 'deploy' });
          continue;
        }

        if (order.type === 'detonate') {
          if (u.type !== 'saboteur') continue;
          setOrder(u, { type: 'detonate' });
          continue;
        }

        if (order.type === 'harvest') {
          if (u.type !== 'harvester') continue;
          setOrder(u, { type: 'harvest', tileX: order.tileX, tileY: order.tileY });
          u.harvest.state = 'moveToSpice';
          u.harvest.tileX = order.tileX;
          u.harvest.tileY = order.tileY;
          // Harvest targets differ per unit — always A*
          if (D.Path && game.map && order.tileX != null) {
            u.path = D.Path.find(game.map, u.x, u.y, order.tileX + 0.5, order.tileY + 0.5) || [];
          }
          continue;
        }

        if (order.type === 'stop') {
          clearOrder(u);
          if (u.harvest) u.harvest.state = 'idle';
          continue;
        }

        if (order.type === 'follow' && order.targetId != null && D.Entities) {
          // Never follow yourself
          if (u.id === order.targetId) continue;
          const t = D.Entities.getById(game, order.targetId);
          const owner = order._owner || u.owner;
          if (!canFollowTarget(game, owner, t)) continue;
          setOrder(u, { type: 'follow', targetId: order.targetId });
          const goal = followGoal(t, u);
          if (D.Path && game.map) {
            u.path = D.Path.find(game.map, u.x, u.y, goal.x, goal.y) || [];
          }
          u._followAimX = goal.x;
          u._followAimY = goal.y;
          continue;
        }

        // Point-moves: set provisional order; formation rewrites goals below
        if (
          D.Path &&
          game.map &&
          (order.type === 'move' ||
            order.type === 'attack-move' ||
            order.type === 'attack-ground') &&
          order.x != null &&
          order.y != null
        ) {
          setOrder(u, Object.assign({}, order));
          pointMovers.push(u);
        } else if (order.type === 'attack' && order.targetId != null && D.Entities) {
          setOrder(u, Object.assign({}, order));
          // Unique / moving targets — A*
          const t = D.Entities.getById(game, order.targetId);
          if (t && t.hp > 0) {
            const tc =
              t.tileW != null
                ? D.Entities.buildingCenter(t)
                : { x: t.x, y: t.y };
            u.path = D.Path.find(game.map, u.x, u.y, tc.x, tc.y) || [];
          }
        } else {
          setOrder(u, Object.assign({}, order));
        }
      }

      // Group point-move: unique formation slots + path (flow to click, fan out at end)
      if (pointMovers.length && D.Path && game.map) {
        // Stable order so re-issuing doesn't reshuffle slots randomly
        pointMovers.sort((a, b) => a.id - b.id);
        const slots = formationSlots(game.map, order.x, order.y, pointMovers.length);
        for (let i = 0; i < pointMovers.length; i++) {
          const u = pointMovers[i];
          const slot = slots[i] || { x: order.x, y: order.y };
          // Personal arrival goal (arrival check uses order.x/y)
          u.order = Object.assign({}, order, {
            x: slot.x,
            y: slot.y,
            groupX: order.x,
            groupY: order.y,
          });
          u.orders = [u.order];
          u._altGoalTried = false;
          u._groupGoalTried = false;
          u._noProgressSec = 0;
          u._lastRepathTick = -999;
        }

        // Path to shared click with cascade: big groups → smaller → singles if needed
        const chunkCfg =
          D.config.path && D.config.path.massPathChunk != null
            ? D.config.path.massPathChunk
            : 24;
        if (pointMovers.length > chunkCfg && !game.multiplayer) {
          if (
            D.Game &&
            D.Game.pushMessage &&
            (!game._massPathMsgTick || game.tick - game._massPathMsgTick > 120)
          ) {
            game._massPathMsgTick = game.tick;
            D.Game.pushMessage(
              game,
              'Large army (' +
                pointMovers.length +
                ') — pathing with auto-fallback to smaller groups.'
            );
          }
        }

        // Cascade assigns trunk paths toward the group click
        cascadePathUnits(game.map, pointMovers, order.x, order.y);

        // Pin ends to formation slots when trunk exists; recover empties
        let stillEmpty = 0;
        for (let i = 0; i < pointMovers.length; i++) {
          const u = pointMovers[i];
          const slot = slots[i] || { x: order.x, y: order.y };
          if (u.path && u.path.length) {
            u.path = finishPathAtSlot(u.path, slot);
          } else {
            stillEmpty++;
            // Prefer personal slot, then group, via recover
            recoverPath(game, u, u.order, null);
            if (!u.path.length) {
              // Direct A* to group click (skip bad formation slot)
              const p = D.Path.find(game.map, u.x, u.y, order.x, order.y);
              if (p && p.length) {
                u.path = p;
                u.order = Object.assign({}, u.order, {
                  x: order.x,
                  y: order.y,
                });
                u.orders = [u.order];
                stillEmpty--;
              }
            } else {
              stillEmpty--;
            }
          }
        }
        // If still a big freeze after cascade, one more singles pass on empties
        if (stillEmpty >= 4) {
          const empties = pointMovers.filter((u) => !u.path || !u.path.length);
          cascadePathUnits(game.map, empties, order.x, order.y);
        }
      }

      if (pathBatch && game && game.stats) {
        const b = D.Path.endBatch();
        // For flow, batchMs includes field build + extracts; also surface backend
        const flowMs = D.Path.metrics ? D.Path.metrics.lastFlowBuildMs || 0 : 0;
        const wallish = Math.max(b.ms, flowMs);
        game.stats.pathLastIssueMs = wallish;
        game.stats.pathLastIssueCount =
          pointMovers.length || b.finds || 0;
        game.stats.pathLastIssueOk = b.ok || pointMovers.filter((u) => u.path && u.path.length).length;
        game.stats.pathLastBackend =
          (D.Path.metrics && D.Path.metrics.lastBackend) || b.backend || 'astar';
        game.stats.pathLastFlowBuildMs = flowMs;
        if (D.Telemetry && D.Telemetry.orderIssue && pointMovers.length) {
          D.Telemetry.orderIssue(
            game,
            pointMovers.length,
            order.type,
            game.stats.pathLastBackend,
            game.stats.pathLastIssueOk,
            wallish
          );
        }
      } else if (pathBatch) {
        D.Path.endBatch();
      }
    },

    stop(game, unitIds) {
      D.Orders.issue(game, unitIds, { type: 'stop' });
    },

    setRally(game, buildingId, x, y) {
      const b = game.buildings.find((x) => x.id === buildingId);
      if (!b) return;
      b.rallyX = x;
      b.rallyY = y;
    },

    /**
     * Find a valid 2×2 rock pad for MCV → Construction Yard.
     * MCV deploy is never proximity-locked (expansion / rebuild after elim).
     * Searches pads that cover the MCV tile first, then nearby rock.
     * @returns {{ tx:number, ty:number }|null}
     */
    findMcvDeployPad(game, u) {
      if (!u || u.type !== 'mcv' || !game.map) return null;
      const def = D.config.buildings.constructionYard;
      const w = def.tileW;
      const h = def.tileH;
      const mx = Math.floor(u.x);
      const my = Math.floor(u.y);
      const tryPad = (tx, ty) => {
        if (
          D.Map.canPlace(game, 'constructionYard', tx, ty, u.owner, {
            skipProximity: true,
          })
        ) {
          return { tx, ty };
        }
        return null;
      };
      // Prefer pads that include the MCV's tile (classic "deploy under feet")
      for (let oy = 0; oy < h; oy++) {
        for (let ox = 0; ox < w; ox++) {
          const hit = tryPad(mx - ox, my - oy);
          if (hit) return hit;
        }
      }
      // Center-style then spiral out a few tiles for almost-on-rock cases
      const centerTx = mx - Math.floor(w / 2);
      const centerTy = my - Math.floor(h / 2);
      let hit = tryPad(centerTx, centerTy);
      if (hit) return hit;
      for (let r = 1; r <= 3; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            hit = tryPad(centerTx + dx, centerTy + dy);
            if (hit) return hit;
          }
        }
      }
      return null;
    },

    canDeploy(game, unitId) {
      const u = game.units.find((x) => x.id === unitId);
      if (!u || u.type !== 'mcv') return false;
      return !!D.Orders.findMcvDeployPad(game, u);
    },

    tryDeploy(game, u) {
      if (!u || u.type !== 'mcv') return false;
      const pad = D.Orders.findMcvDeployPad(game, u);
      if (!pad) return false;
      D.Entities.createBuilding(game, 'constructionYard', u.owner, pad.tx, pad.ty, {
        complete: true,
      });
      D.Entities.removeUnit(game, u);
      D.Economy.tickPower(game);
      // Message for local/SP; multiplayer server sends cmd_result instead
      if (D.Game && D.Game.pushMessage && !game.multiplayer) {
        D.Game.pushMessage(game, 'Construction Yard deployed.');
      }
      return true;
    },

    /**
     * Saboteur self-destruct: splash damage then remove unit.
     * @returns {boolean}
     */
    tryDetonate(game, u) {
      if (!u || u.type !== 'saboteur' || u.hp <= 0) return false;
      const def = D.config.units.saboteur;
      const det = def && def.detonate;
      if (!det) return false;
      const r = det.radius || 2;
      const baseDmg = det.damage || 50;
      const cx = u.x;
      const cy = u.y;
      const owner = u.owner;
      // Splash hits enemies (and neutrals) in radius; not friendly
      for (const t of [...game.units]) {
        if (t.hp <= 0 || t.id === u.id) continue;
        if (t.owner === owner) continue;
        const d = Math.hypot(t.x - cx, t.y - cy);
        if (d > r) continue;
        const falloff = 1 - (d / r) * 0.5;
        const kind = t.tileW != null ? 'building' : D.config.units[t.type]?.kind || 'vehicle';
        const mult =
          kind === 'infantry' ? det.vsI || 1 : kind === 'vehicle' ? det.vsV || 1 : det.vsB || 1;
        const armor = t.tileW != null ? 0 : D.config.units[t.type]?.armor || 0;
        const dmg = Math.max(1, Math.floor(baseDmg * mult * falloff) - armor);
        t.hp -= dmg;
        if (t.hp <= 0) {
          t.hp = 0;
          if (D.Combat && D.Combat.kill) D.Combat.kill(game, t, owner);
          else if (D.Entities.removeUnit) D.Entities.removeUnit(game, t);
        }
      }
      for (const b of [...game.buildings]) {
        if (b.hp <= 0 || b.owner === owner || b.type === 'concrete') continue;
        const bc = D.Entities.buildingCenter(b);
        const d = Math.hypot(bc.x - cx, bc.y - cy);
        if (d > r + 0.5) continue;
        const falloff = 1 - (d / (r + 0.5)) * 0.45;
        const dmg = Math.max(1, Math.floor(baseDmg * (det.vsB || 1.2) * falloff));
        b.hp -= dmg;
        if (b.hp <= 0) {
          b.hp = 0;
          if (D.Combat && D.Combat.kill) D.Combat.kill(game, b, owner);
          else if (D.Entities.removeBuilding) D.Entities.removeBuilding(game, b);
        }
      }
      game.fx = game.fx || [];
      game.fx.push({ type: 'explode', x: cx, y: cy, life: 0.45, r: r * 0.55 });
      game.fx.push({ type: 'explode', x: cx, y: cy, life: 0.25, r: r * 0.3 });
      if (D.Entities.removeUnit) D.Entities.removeUnit(game, u);
      if (D.Game && D.Game.pushMessage && !game.multiplayer) {
        D.Game.pushMessage(game, 'Saboteur detonated!');
      }
      return true;
    },

    /** Movement + order execution per tick */
    tick(game, dt) {
      let repaths = 0;
      // Scale budget with army size so FFA late-game doesn't stall pathing
      const nUnits = game.units ? game.units.length : 0;
      let maxRepaths;
      if (game.multiplayer || game._serverSim) {
        // Server MP: hard cap — Fly shared-1-CPU logs 60–160ms per path issue
        const mpBase = D.config.path.maxRepathsPerTickMp || 20;
        maxRepaths = Math.max(8, Math.min(mpBase, Math.ceil(nUnits * 0.25) || 8));
      } else {
        // SP / mass armies: scale hard with unit count so large groups unstick
        const base = D.config.path.maxRepathsPerTick || 64;
        maxRepaths = Math.max(base, Math.min(320, Math.ceil(nUnits * 0.5) || base));
      }
      if (D.Path && D.Path.beginBatch) D.Path.beginBatch();

      for (const u of game.units) {
        if (u.hp <= 0) continue;

        // Sitting idle: hunt the nearest hostile in LOS (range+1).
        // A finished attack-move is handled at arrival below.
        if (!u.order) autoAcquire(game, u);

        // Saboteur passive: regenerate HP even when idle
        if (u.type === 'saboteur' && u.hp < u.hpMax) {
          const regen =
            (D.config.units.saboteur && D.config.units.saboteur.hpRegenPerSec) || 0;
          if (regen > 0) u.hp = Math.min(u.hpMax, u.hp + regen * dt);
        }

        // Harvester FSM takes over when harvest order active or internal state active
        if (u.type === 'harvester' && u.harvest && u.order && u.order.type === 'harvest') {
          D.Orders.tickHarvester(game, u, dt, () => {
            if (repaths < maxRepaths) {
              repaths++;
              return true;
            }
            return false;
          });
          continue;
        }
        if (
          u.type === 'harvester' &&
          u.harvest &&
          u.harvest.state !== 'idle' &&
          (!u.order || u.order.type === 'harvest')
        ) {
          D.Orders.tickHarvester(game, u, dt, () => {
            if (repaths < maxRepaths) {
              repaths++;
              return true;
            }
            return false;
          });
          continue;
        }

        const order = u.order;
        if (!order) continue;

        if (order.type === 'deploy') {
          if (u.type !== 'mcv') {
            clearOrder(u);
            continue;
          }
          if (D.Orders.tryDeploy(game, u)) {
            clearStuck(u);
          } else {
            // Stay on deploy order but surface why (was silent — looked "stuck")
            markStuck(game, u, 'deploy', dt);
          }
          continue;
        }

        if (order.type === 'detonate') {
          if (u.type !== 'saboteur') {
            clearOrder(u);
            continue;
          }
          D.Orders.tryDetonate(game, u);
          continue;
        }

        if (
          order.type === 'move' ||
          order.type === 'attack-move' ||
          order.type === 'attack-ground'
        ) {
          const prevX = u.x;
          const prevY = u.y;
          const arrive =
            (D.config.path && D.config.path.arrivalDist) != null
              ? D.config.path.arrivalDist + 0.35
              : 0.5;
          const groupD =
            order.groupX != null
              ? Math.hypot(u.x - order.groupX, u.y - order.groupY)
              : Infinity;
          const d = Math.hypot(u.x - order.x, u.y - order.y);

          // Attack-ground: hold once weapon can fire at the aim point
          if (order.type === 'attack-ground') {
            const udef = D.config.units[u.type];
            const wpn = udef && udef.weapon;
            if (
              wpn &&
              D.Combat &&
              D.Combat.inWeaponRange &&
              D.Combat.inWeaponRange(wpn, d)
            ) {
              u.path = [];
              clearStuck(u);
              continue;
            }
          }

          // Arrive at *personal* formation slot only.
          // (Old "near group click" finish made whole armies stack on one tile.)
          // Only fall back to group click after recovery already abandoned the slot.
          const slotAbandoned = !!(u._groupGoalTried || u._altGoalTried);
          if (
            order.type !== 'attack-ground' &&
            (d < arrive || (slotAbandoned && groupD < arrive + 0.4))
          ) {
            u.path = [];
            clearStuck(u);
            if (order.type === 'move') clearOrder(u);
            // Arrived next to the enemy: pick something in LOS instead of standing.
            if (!u.order || u.order.type === 'attack-move') autoAcquire(game, u);
            continue;
          }

          // Empty path: recover immediately (don't wait — feels frozen in MP)
          const noProg = u._noProgressSec || 0;
          if (!u.path || !u.path.length) {
            recoverPath(game, u, order, () => repaths++ < maxRepaths);
            // Still empty → crawl one step so the army never hard-freezes
            if ((!u.path || !u.path.length) && d > arrive) {
              stepToward(game, u, order.x, order.y, dt);
            }
          } else {
            D.Orders.ensurePath(game, u, order.x, order.y, () => repaths++ < maxRepaths);
          }
          D.Orders.followPath(game, u, dt);

          const moved = Math.hypot(u.x - prevX, u.y - prevY);
          if (moved > 0.002) {
            u._noProgressSec = 0;
            clearStuck(u);
          } else {
            u._noProgressSec = (u._noProgressSec || 0) + dt;
            // No movement this tick with a path: try crawl (path may be wedged)
            if ((!u.path || !u.path.length || noProg > 0.4) && d > arrive) {
              if (stepToward(game, u, order.x, order.y, dt)) {
                u._noProgressSec = 0;
                clearStuck(u);
              }
            }
          }

          if (!u.path.length) {
            const giveUp =
              (D.config.path && D.config.path.stuckGiveUpSec) != null
                ? D.config.path.stuckGiveUpSec
                : 8;
            // Staged recovery: alt personal → group → keep crawling (don't hard-clear early)
            if ((u._noProgressSec || 0) > 1.0 && !(u._altGoalTried)) {
              const alt = alternateGoal(game.map, order.x, order.y, { x: u.x, y: u.y }, 10);
              if (alt) {
                u.order = Object.assign({}, order, { x: alt.x, y: alt.y });
                u.orders = [u.order];
                u._altGoalTried = true;
                u._lastRepathTick = -999;
                u.path = [];
                recoverPath(game, u, u.order, () => repaths++ < maxRepaths);
              } else {
                u._altGoalTried = true;
              }
            } else if (
              (u._noProgressSec || 0) > 2.5 &&
              !(u._groupGoalTried) &&
              order.groupX != null
            ) {
              // Fall back to shared click — better to cluster than freeze red
              u.order = Object.assign({}, order, {
                x: order.groupX,
                y: order.groupY,
              });
              u.orders = [u.order];
              u._groupGoalTried = true;
              u._lastRepathTick = -999;
              u.path = [];
              recoverPath(game, u, u.order, () => repaths++ < maxRepaths);
            } else if ((u._noProgressSec || 0) > giveUp) {
              // Give up formal path but keep attack-move / attack-ground; clear red stuck
              clearStuck(u);
              if (order.type === 'move') clearOrder(u);
              else {
                u.path = [];
              }
              u._noProgressSec = 0;
              u._altGoalTried = false;
              u._groupGoalTried = false;
            } else if (d > arrive && (u._noProgressSec || 0) > 3.5) {
              // Only flash stuck after crawl+recover had time (was too eager)
              markStuck(game, u, 'path', dt);
            }
          }
          continue;
        }

        if (order.type === 'follow') {
          const target = D.Entities.getById(game, order.targetId);
          if (!target || target.hp <= 0 || target.tileW != null) {
            clearStuck(u);
            clearOrder(u);
            continue;
          }
          // Enemy must stay visible — no fog-chasing
          if (!canFollowTarget(game, u.owner, target)) {
            clearStuck(u);
            clearOrder(u);
            continue;
          }
          const standoff = followStandoff();
          const dist = Math.hypot(u.x - target.x, u.y - target.y);
          // Close enough to ring: hold, face target
          if (dist <= standoff + 0.35) {
            u.path = [];
            clearStuck(u);
            const dx = target.x - u.x;
            const dy = target.y - u.y;
            if (dx * dx + dy * dy > 1e-6) {
              u.facing = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
            }
            continue;
          }
          const goal = followGoal(target, u);
          const aimMoved =
            u._followAimX == null ||
            Math.hypot(goal.x - (u._followAimX || 0), goal.y - (u._followAimY || 0)) >
              followRepathDist();
          if (aimMoved || !u.path || !u.path.length) {
            u._followAimX = goal.x;
            u._followAimY = goal.y;
            // Force repath when leader moved
            if (aimMoved) u.path = [];
            D.Orders.ensurePath(game, u, goal.x, goal.y, () => repaths++ < maxRepaths);
          }
          D.Orders.followPath(game, u, dt);
          clearStuck(u);
          continue;
        }

        if (order.type === 'attack') {
          const target = D.Entities.getById(game, order.targetId);
          if (!target || target.hp <= 0) {
            clearStuck(u);
            clearOrder(u);
            continue;
          }
          const tc =
            target.tileW != null
              ? D.Entities.buildingCenter(target)
              : { x: target.x, y: target.y };
          const def = D.config.units[u.type];
          const range = def && def.weapon ? def.weapon.range : 1;
          const dist = Math.hypot(u.x - tc.x, u.y - tc.y);
          if (dist > range) {
            const prevX = u.x;
            const prevY = u.y;
            if ((!u.path || !u.path.length) && (u._noProgressSec || 0) > 0.35) {
              unstickStart(game, u);
              // Aim near target edge, not dead center (often inside building footprint)
              const alt = alternateGoal(game.map, tc.x, tc.y, { x: u.x, y: u.y }, 6);
              const gx = alt ? alt.x : tc.x;
              const gy = alt ? alt.y : tc.y;
              D.Orders.ensurePath(game, u, gx, gy, () => repaths++ < maxRepaths);
            } else {
              D.Orders.ensurePath(game, u, tc.x, tc.y, () => repaths++ < maxRepaths);
            }
            D.Orders.followPath(game, u, dt);
            const moved = Math.hypot(u.x - prevX, u.y - prevY);
            if (moved > 0.002) {
              u._noProgressSec = 0;
              clearStuck(u);
            } else {
              u._noProgressSec = (u._noProgressSec || 0) + dt;
            }
            if (
              (!u.path || !u.path.length) &&
              moved < 0.001 &&
              (u._noProgressSec || 0) > 2.0
            ) {
              markStuck(game, u, 'path', dt);
            }
          } else {
            u.path = [];
            clearStuck(u);
          }
          continue;
        }
      }
      // Many path-stuck units → warn player + re-path a chunk (belt and suspenders)
      helpStuckArmy(game, { count: repaths }, maxRepaths);

      game._repathsThisTick = repaths;
      if (D.Path && D.Path.endBatch && game.stats) {
        const b = D.Path.endBatch();
        game.stats.pathTickMs = b.ms;
        game.stats.pathTickCount = b.finds;
      } else if (D.Path && D.Path.endBatch) {
        D.Path.endBatch();
      }

      // Keep same-owner units from occupying identical cells (visual + combat clarity)
      applySeparation(game, dt);
    },

    ensurePath(game, u, tx, ty, allowRepath) {
      const slop =
        (D.config.path && D.config.path.pathGoalSlop) != null
          ? D.config.path.pathGoalSlop
          : 2.25;
      if (u.path && u.path.length) {
        const last = u.path[u.path.length - 1];
        if (Math.hypot(last.x - tx, last.y - ty) < slop) return;
      }
      // Cooldown stops rapid repath ↔ separation vibration around buildings.
      // Empty path / stuck units skip cooldown so they keep trying to unstick.
      const cool =
        (D.config.path && D.config.path.repathCooldownTicks) != null
          ? D.config.path.repathCooldownTicks
          : 16;
      const empty = !u.path || !u.path.length;
      const recovering = empty || u.stuck || (u._noProgressSec || 0) > 0.5;
      if (
        !recovering &&
        u._lastRepathTick != null &&
        game.tick - u._lastRepathTick < cool
      ) {
        return;
      }
      // Still rate-limit empty-path retries a bit (every ~0.4s) to save budget
      if (
        recovering &&
        empty &&
        u._lastRepathTick != null &&
        game.tick - u._lastRepathTick < 8
      ) {
        return;
      }
      if (allowRepath && !allowRepath()) return;
      unstickStart(game, u);
      const path = D.Path.find(game.map, u.x, u.y, tx, ty);
      // Critical: never wipe an existing path (incl. crawl micro-paths) when
      // A* fails — that caused permanent stuck (empty→crawl→ensurePath clears).
      if (path && path.length) {
        u.path = path;
        u._lastRepathTick = game.tick;
      } else if (empty) {
        u.path = [];
        u._lastRepathTick = game.tick;
      }
      // else keep previous path and do not bump cooldown hard-fail
    },

    followPath(game, u, dt) {
      if (!u.path.length) return;
      const def = D.config.units[u.type];
      const speed = def ? def.speed : 1;
      let remaining = speed * dt;
      while (remaining > 0 && u.path.length) {
        const wp = u.path[0];
        const dx = wp.x - u.x;
        const dy = wp.y - u.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.05) {
          u.path.shift();
          continue;
        }
        // Do NOT hard-stop for friendly units. In a dense 50–100 unit move,
        // almost every unit has a teammate within 0.4 tiles → entire army freezes
        // (looked like "only 1 unit obeyed M/A"). Classic RTS lets friendlies overlap
        // on the march; formation slots + idle separation handle the end point.
        if (dist <= remaining) {
          u.x = wp.x;
          u.y = wp.y;
          remaining -= dist;
          u.path.shift();
        } else {
          u.x += (dx / dist) * remaining;
          u.y += (dy / dist) * remaining;
          remaining = 0;
        }
        if (dist > 0.001) {
          u.facing = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        }
      }
    },

    tickHarvester(game, u, dt, allowRepath) {
      const h = u.harvest;
      const eco = D.config.economy;

      function pathTo(x, y) {
        // Recover from dead paths (stuck harvesters)
        const dist = Math.hypot(u.x - x, u.y - y);
        const prevX = u.x;
        const prevY = u.y;
        if ((!u.path || !u.path.length) && dist > 0.5) {
          h.stuckT = (h.stuckT || 0) + dt;
          // Force a repath every ~1.2s even if repath budget is exhausted
          if (h.stuckT >= 1.2) {
            h.stuckT = 0;
            const path = D.Path.find(game.map, u.x, u.y, x, y);
            u.path = path || [];
            if (!u.path.length) {
              // Nudge goal slightly and try again next cycle
              h.nudge = ((h.nudge || 0) + 1) % 4;
              const off = [
                [0.7, 0],
                [-0.7, 0],
                [0, 0.7],
                [0, -0.7],
              ][h.nudge];
              const path2 = D.Path.find(game.map, u.x, u.y, x + off[0], y + off[1]);
              u.path = path2 || [];
            }
          } else {
            D.Orders.ensurePath(game, u, x, y, allowRepath);
          }
        } else {
          h.stuckT = 0;
          D.Orders.ensurePath(game, u, x, y, allowRepath);
        }
        D.Orders.followPath(game, u, dt);
        const moved = Math.hypot(u.x - prevX, u.y - prevY);
        if (dist > 0.55 && moved < 0.001 && (!u.path || !u.path.length)) {
          markStuck(game, u, 'path', dt);
        } else if (moved > 0.001 || dist < 0.5) {
          clearStuck(u);
        }
      }

      if (h.state === 'idle') {
        // auto-seek spice if empty cargo and no order? only if harvest order
        if (u.order && u.order.type === 'harvest') {
          h.state = 'moveToSpice';
          h.stuckT = 0;
        } else if (u.cargo > 0.5) {
          // Full-ish cargo but idle — go unload
          h.state = 'moveToRefinery';
          h.refineryId = null;
          h.stuckT = 0;
        }
        return;
      }

      if (h.state === 'moveToSpice') {
        let tx = h.tileX;
        let ty = h.tileY;
        if (u.order && u.order.type === 'harvest' && u.order.tileX != null) {
          // Prefer ordered tile while it still has spice
          if (D.Map.spiceAt(game.map, u.order.tileX, u.order.tileY) > 0) {
            tx = u.order.tileX;
            ty = u.order.tileY;
            h.tileX = tx;
            h.tileY = ty;
          }
        }
        if (D.Map.spiceAt(game.map, tx, ty) <= 0) {
          const n = D.Map.findNearestSpice(game.map, u.x, u.y);
          if (!n) {
            if (u.cargo > 0.5) {
              h.state = 'moveToRefinery';
              h.refineryId = null;
            } else {
              h.state = 'idle';
              clearOrder(u);
            }
            return;
          }
          h.tileX = n.tx;
          h.tileY = n.ty;
          tx = n.tx;
          ty = n.ty;
          if (u.order && u.order.type === 'harvest') {
            u.order.tileX = tx;
            u.order.tileY = ty;
          }
        }
        const txc = tx + 0.5;
        const tyc = ty + 0.5;
        if (Math.hypot(u.x - txc, u.y - tyc) < 0.4) {
          h.state = 'harvest';
          h.stuckT = 0;
          u.path = [];
        } else {
          pathTo(txc, tyc);
        }
        return;
      }

      if (h.state === 'harvest') {
        clearStuck(u);
        const amt = D.Map.spiceAt(game.map, h.tileX, h.tileY);
        if (amt <= 0 || u.cargo >= u.cargoMax) {
          h.state = 'moveToRefinery';
          h.refineryId = null;
          h.stuckT = 0;
          return;
        }
        const take = Math.min(eco.harvestRate * dt, amt, u.cargoMax - u.cargo);
        u.cargo += take;
        D.Map.setSpice(game.map, h.tileX, h.tileY, amt - take);
        if (u.cargo >= u.cargoMax) {
          h.state = 'moveToRefinery';
          h.refineryId = null;
          h.stuckT = 0;
        }
        return;
      }

      if (h.state === 'moveToRefinery' || h.state === 'seekRefinery') {
        let ref = h.refineryId
          ? game.buildings.find((b) => b.id === h.refineryId)
          : null;
        if (!ref || ref.hp <= 0 || ref.buildProgress < 1 || ref.type !== 'refinery') {
          ref = D.Orders.findBestRefinery(game, u);
          h.refineryId = ref ? ref.id : null;
          h.wait = 0;
        }
        if (!ref) {
          // No refinery — hold cargo and idle (player may build one)
          h.state = 'idle';
          h.stuckT = 0;
          return;
        }
        let unloader = dockUnloader(game, ref.id, u);
        let busy = !!unloader;

        // After a long queue wait, try another refinery if one exists
        if (busy) {
          h.wait = (h.wait || 0) + dt;
          if (h.wait > 4.5) {
            const alt = D.Orders.findBestRefinery(game, u, ref.id);
            if (alt && alt.id !== ref.id) {
              h.refineryId = alt.id;
              h.wait = 0;
              clearStuck(u);
              ref = alt;
              unloader = dockUnloader(game, ref.id, u);
              busy = !!unloader;
            } else {
              h.wait = 2; // retry again after a bit
            }
          }
        } else {
          h.wait = 0;
        }

        const dock = dockCenter(ref);
        const distDock = Math.hypot(u.x - dock.x, u.y - dock.y);

        if (!busy && distDock < 0.5) {
          // Claim pad (only one unloader — others still busy-check next tick)
          h.state = 'unload';
          h.wait = 0;
          h.stuckT = 0;
          clearStuck(u);
          u.path = [];
          return;
        }

        if (busy) {
          // Hold off the pad so we don't stack on the unloader / freeze path
          const qIdx = dockQueueIndex(game, u, ref.id);
          const hold = dockHoldPoint(ref, qIdx);
          const distHold = Math.hypot(u.x - hold.x, u.y - hold.y);
          if (distDock < 0.85 || distHold > 0.4) {
            pathTo(hold.x, hold.y);
          } else {
            u.path = [];
            // Normal queue — no stuck flash. Only alert if pad blocked a long time.
            if ((h.wait || 0) > 12) markStuck(game, u, 'dock', dt);
            else clearStuck(u);
          }
          return;
        }

        // Pad free — drive in
        clearStuck(u);
        pathTo(dock.x, dock.y);
        return;
      }

      if (h.state === 'unload') {
        const ref = game.buildings.find((b) => b.id === h.refineryId);
        if (!ref || ref.hp <= 0) {
          h.state = 'seekRefinery';
          h.stuckT = 0;
          clearStuck(u);
          return;
        }
        // If somehow two entered unload, yield to lower id
        const other = dockUnloader(game, ref.id, u);
        if (other && other.id < u.id) {
          h.state = 'moveToRefinery';
          h.wait = 0;
          return;
        }
        const owner = u.owner;
        const cap = game.spiceCap[owner];
        const credits = game.credits[owner];
        if (credits >= cap) {
          markStuck(game, u, 'silos', dt);
          return;
        }
        clearStuck(u);
        const room = cap - credits;
        const give = Math.min(eco.unloadRate * dt, u.cargo, room / eco.spiceToCredit);
        u.cargo -= give;
        game.credits[owner] = Math.min(cap, credits + give * eco.spiceToCredit);
        if (u.cargo <= 0.01) {
          u.cargo = 0;
          h.refineryId = null;
          // resume spice
          const n = D.Map.findNearestSpice(game.map, u.x, u.y);
          if (n) {
            h.tileX = n.tx;
            h.tileY = n.ty;
            h.state = 'moveToSpice';
            h.stuckT = 0;
            if (!u.order || u.order.type !== 'harvest') {
              u.order = { type: 'harvest', tileX: n.tx, tileY: n.ty };
              u.orders = [u.order];
            } else {
              u.order.tileX = n.tx;
              u.order.tileY = n.ty;
            }
          } else {
            h.state = 'idle';
            clearOrder(u);
          }
        }
      }
    },

    /**
     * Pick a refinery: prefer free pad, lighter inbound load, closer dock.
     * @param {number|null} excludeId skip this building (re-pick while queued)
     */
    findBestRefinery(game, u, excludeId) {
      let best = null;
      let bestScore = Infinity;
      for (const b of game.buildings) {
        if (b.owner !== u.owner || b.type !== 'refinery' || b.buildProgress < 1 || b.hp <= 0)
          continue;
        if (excludeId != null && b.id === excludeId) continue;
        const c = dockCenter(b);
        const d = Math.hypot(u.x - c.x, u.y - c.y);
        const load = refineryLoad(game, b.id);
        const unloading = dockUnloader(game, b.id) ? 1 : 0;
        // Distance + congestion; mild bias toward primary
        let score = d + load * 5 + unloading * 3;
        if (b.primary) score -= 1.5;
        if (score < bestScore) {
          bestScore = score;
          best = b;
        }
      }
      return best;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
