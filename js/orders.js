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
   * Soft separation ONLY for units that have finished pathing.
   * Never push units that still have a path — that fights followPath and causes
   * vibration / wedge-and-repath loops around bases.
   *
   * Runs in the sim (SP + server MP). Pure client-side separation cannot work for
   * multiplayer: the next server snapshot overwrites positions.
   */
  function applySeparation(game, dt) {
    const units = game.units;
    if (!units || units.length < 2) return;
    if ((game.tick | 0) % 4 !== 0) return;

    const r =
      (D.config.path && D.config.path.separationRadius) != null
        ? D.config.path.separationRadius
        : 0.5;
    const strength =
      (D.config.path && D.config.path.separationStrength) != null
        ? D.config.path.separationStrength
        : 0.25;
    const r2 = r * r;
    const cell = 1;
    const buckets = new Map();

    const list = [];
    for (const u of units) {
      if (u.hp <= 0) continue;
      // Critical: no separation while following a path
      if (u.path && u.path.length > 0) continue;
      // Idle or order complete only
      if (u.order && (u.order.type === 'move' || u.order.type === 'attack-move')) {
        // still walking to goal without path — leave alone (stuck recovery handles)
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
    // Require ~2.5s of continuous stuck before flashing/message (was 1.5 — too noisy)
    if (u._stuckSince < 2.5) return;
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

        // Point-moves: set provisional order; formation rewrites goals below
        if (
          D.Path &&
          game.map &&
          (order.type === 'move' || order.type === 'attack-move') &&
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

        // One shared field / A* batch toward the click, then pin each path's end to its slot
        if (D.Path.assignGroupMove) {
          D.Path.assignGroupMove(game.map, pointMovers, order.x, order.y);
        } else {
          for (const u of pointMovers) {
            u.path = D.Path.find(game.map, u.x, u.y, order.x, order.y) || [];
          }
        }
        for (let i = 0; i < pointMovers.length; i++) {
          const u = pointMovers[i];
          const slot = slots[i] || { x: order.x, y: order.y };
          u.path = finishPathAtSlot(u.path, slot);
          // If trunk path failed entirely, try personal slot / recovery now
          if (!u.path.length) {
            recoverPath(game, u, u.order, null);
          }
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

    canDeploy(game, unitId) {
      const u = game.units.find((x) => x.id === unitId);
      if (!u || u.type !== 'mcv') return false;
      const def = D.config.buildings.constructionYard;
      // center 2x2 on MCV tile
      const tx = Math.floor(u.x) - Math.floor(def.tileW / 2);
      const ty = Math.floor(u.y) - Math.floor(def.tileH / 2);
      const hasCY = game.buildings.some(
        (b) => b.owner === u.owner && b.type === 'constructionYard' && b.buildProgress >= 1
      );
      return D.Map.canPlace(game, 'constructionYard', tx, ty, u.owner, {
        skipProximity: !hasCY,
      });
    },

    tryDeploy(game, u) {
      if (!D.Orders.canDeploy(game, u.id)) return false;
      const def = D.config.buildings.constructionYard;
      const tx = Math.floor(u.x) - Math.floor(def.tileW / 2);
      const ty = Math.floor(u.y) - Math.floor(def.tileH / 2);
      const hasCY = game.buildings.some(
        (b) => b.owner === u.owner && b.type === 'constructionYard' && b.buildProgress >= 1
      );
      if (!D.Map.canPlace(game, 'constructionYard', tx, ty, u.owner, { skipProximity: !hasCY })) {
        return false;
      }
      D.Entities.createBuilding(game, 'constructionYard', u.owner, tx, ty, {
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

    /** Movement + order execution per tick */
    tick(game, dt) {
      let repaths = 0;
      // Scale budget with army size so FFA late-game doesn't stall pathing
      const base = D.config.path.maxRepathsPerTick || 64;
      const nUnits = game.units ? game.units.length : 0;
      const maxRepaths = Math.max(base, Math.min(160, Math.ceil(nUnits * 0.35)));
      if (D.Path && D.Path.beginBatch) D.Path.beginBatch();

      for (const u of game.units) {
        if (u.hp <= 0) continue;

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

        if (order.type === 'move' || order.type === 'attack-move') {
          const prevX = u.x;
          const prevY = u.y;
          const arrive =
            (D.config.path && D.config.path.arrivalDist) != null
              ? D.config.path.arrivalDist + 0.35
              : 0.5;
          // Also accept arriving near original group click (formation slot unreachable)
          const groupD =
            order.groupX != null
              ? Math.hypot(u.x - order.groupX, u.y - order.groupY)
              : Infinity;
          const d = Math.hypot(u.x - order.x, u.y - order.y);

          // Close enough to formation slot OR group click → done
          if (d < arrive || groupD < arrive + 0.55) {
            u.path = [];
            clearStuck(u);
            if (order.type === 'move') clearOrder(u);
            continue;
          }

          // Empty path + no progress: full recovery (group goal / alts), bypass cooldown
          const noProg = u._noProgressSec || 0;
          if ((!u.path || !u.path.length) && noProg > 0.35) {
            recoverPath(game, u, order, () => repaths++ < maxRepaths);
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
          }

          if (!u.path.length) {
            const giveUp =
              (D.config.path && D.config.path.stuckGiveUpSec) != null
                ? D.config.path.stuckGiveUpSec
                : 6;
            // Staged recovery: alt personal → group → give up
            if ((u._noProgressSec || 0) > 0.8 && !(u._altGoalTried)) {
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
              (u._noProgressSec || 0) > 2.0 &&
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
              // Stop fighting the choke — clear move so they hold and can be re-ordered
              clearStuck(u);
              if (order.type === 'move') clearOrder(u);
              else {
                // attack-move: keep order but idle path so combat can still acquire
                u.path = [];
              }
              u._noProgressSec = 0;
              u._altGoalTried = false;
              u._groupGoalTried = false;
            } else if (d > arrive && (u._noProgressSec || 0) > 2.0) {
              markStuck(game, u, 'path', dt);
            }
          }
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
      u.path = path || [];
      u._lastRepathTick = game.tick;
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
