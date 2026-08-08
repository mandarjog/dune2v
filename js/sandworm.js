/* global Dune2 */
/**
 * Sandworms: wormsign rumble → surface → swallow units on soft sand.
 * Safe terrain: rock, concrete pads.
 * Safe units: harvester, saboteur (never swallowed).
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function cfg() {
    return D.config.worms || {};
  }

  function enabled() {
    const w = cfg();
    if (w.enabled === false) return false;
    if (D.config.features && D.config.features.sandworms === false) return false;
    // Either flag on is enough; defaults enable both when shipping worms
    return !!(w.enabled || (D.config.features && D.config.features.sandworms));
  }

  function safeTypes() {
    const list = cfg().safeTypes;
    return list && list.length ? list : ['harvester', 'saboteur'];
  }

  function isSafeUnitType(type) {
    return safeTypes().indexOf(type) >= 0;
  }

  /**
   * Rock tile or finished concrete slab under the tile → worm cannot bite.
   */
  function isSafeTile(game, tx, ty) {
    if (!game || !game.map) return true;
    const T = D.config.terrain;
    const t = D.Map.tileAt(game.map, tx, ty);
    if (t === T.ROCK) return true;
    if (t === T.CLIFF) return true;
    // Concrete pad (1×1 building) makes sand safe
    for (const b of game.buildings) {
      if (b.type !== 'concrete' || b.buildProgress < 1 || b.hp <= 0) continue;
      if (b.tileX === tx && b.tileY === ty) return true;
    }
    return false;
  }

  /** Soft desert where worms hunt (sand / dune / spice). */
  function isDangerTerrain(game, tx, ty) {
    if (!game || !game.map) return false;
    if (isSafeTile(game, tx, ty)) return false;
    const T = D.config.terrain;
    const t = D.Map.tileAt(game.map, tx, ty);
    return (
      t === T.SAND ||
      t === T.DUNE ||
      t === T.SPICE ||
      t === T.SPICE_HEAVY
    );
  }

  /** Unit can be swallowed right now. */
  function isEdible(game, u) {
    if (!u || u.hp <= 0) return false;
    if (isSafeUnitType(u.type)) return false;
    const tx = Math.floor(u.x);
    const ty = Math.floor(u.y);
    if (!isDangerTerrain(game, tx, ty)) return false;
    return true;
  }

  function ensureState(game) {
    if (!game.wormState) {
      game.wormState = {
        heat: 0,
        wx: 0,
        wy: 0,
        wSum: 0,
        cooldownUntil: 0,
        nextId: 1,
      };
    }
    if (!game.worms) game.worms = [];
    return game.wormState;
  }

  function unitWeight(game, u) {
    const w = cfg().moveWeight || {};
    let base = w[u.type];
    if (base == null) {
      // default by class
      if (u.type === 'infantry' || u.type === 'trooper' || u.type === 'saboteur') base = 1;
      else if (u.type === 'harvester') base = 4;
      else base = 3;
    }
    if (
      u.type === 'harvester' &&
      u.harvest &&
      (u.harvest.state === 'harvest' || u.harvest.state === 'harvesting')
    ) {
      base += cfg().harvestWeightBonus || 0;
    }
    return base;
  }

  function accumulateHeat(game, dt) {
    const st = ensureState(game);
    const map = game.map;
    if (!map) return;

    let add = 0;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const u of game.units) {
      if (!u || u.hp <= 0) continue;
      const tx = Math.floor(u.x);
      const ty = Math.floor(u.y);
      if (!isDangerTerrain(game, tx, ty)) continue;
      const wt = unitWeight(game, u) * dt;
      if (wt <= 0) continue;
      add += wt;
      sx += u.x * wt;
      sy += u.y * wt;
      sw += wt;
    }

    if (add > 0 && sw > 0) {
      st.heat += add;
      // Blend emerge focus toward activity
      const nx = sx / sw;
      const ny = sy / sw;
      if (st.wSum <= 0) {
        st.wx = nx;
        st.wy = ny;
        st.wSum = sw;
      } else {
        const a = 0.15;
        st.wx = st.wx * (1 - a) + nx * a;
        st.wy = st.wy * (1 - a) + ny * a;
        st.wSum = Math.min(1e6, st.wSum + sw);
      }
    }

    const decay = (cfg().decayPerSec != null ? cfg().decayPerSec : 5) * dt;
    st.heat = Math.max(0, st.heat - decay);
  }

  function findEmergeSpot(game) {
    const st = ensureState(game);
    const map = game.map;
    let cx = Math.floor(st.wx || map.width / 2);
    let cy = Math.floor(st.wy || map.height / 2);
    // Prefer a danger tile near focus; spiral out
    for (let r = 0; r < 24; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r && r > 0) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (isDangerTerrain(game, tx, ty)) {
            return { x: tx + 0.5, y: ty + 0.5 };
          }
        }
      }
    }
    // Fallback: any edible unit position
    for (const u of game.units) {
      if (isEdible(game, u)) return { x: u.x, y: u.y };
    }
    return { x: cx + 0.5, y: cy + 0.5 };
  }

  function alertWormsign(game, worm) {
    const owners =
      D.Seats && D.Seats.active ? D.Seats.active(game) : ['player', 'enemy'];
    const tx = Math.floor(worm.x);
    const ty = Math.floor(worm.y);
    let any = false;
    for (const o of owners) {
      const vis =
        !D.Map.fogVisible ||
        !D.Map.fogVisible(game) ||
        D.Map.isVisible(game, o, tx, ty) ||
        D.Map.isExplored(game, o, tx, ty);
      if (!vis) continue;
      any = true;
      D.Game.pushAlert(game, {
        seat: o,
        kind: 'wormsign',
        text: 'Wormsign! The sand trembles…',
        x: worm.x,
        y: worm.y,
      });
    }
    if (any || !D.config.features.fog) {
      D.Game.pushMessage(game, 'Wormsign!');
    }
  }

  function spawnWorm(game) {
    const st = ensureState(game);
    const max = cfg().maxWorms != null ? cfg().maxWorms : 2;
    if (game.worms.length >= max) return null;
    const spot = findEmergeSpot(game);
    const worm = {
      id: st.nextId++,
      x: spot.x,
      y: spot.y,
      phase: 'rumble',
      phaseT: 0,
      warned: false,
      swallows: 0,
    };
    game.worms.push(worm);
    st.heat = 0;
    st.wSum = 0;
    return worm;
  }

  function nearestEdible(game, worm) {
    let best = null;
    let bestD = Infinity;
    for (const u of game.units) {
      if (!isEdible(game, u)) continue;
      const d = (u.x - worm.x) * (u.x - worm.x) + (u.y - worm.y) * (u.y - worm.y);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  function swallowNear(game, worm) {
    const r = cfg().swallowRadiusTiles != null ? cfg().swallowRadiusTiles : 1.25;
    const r2 = r * r;
    const victims = [];
    for (const u of game.units) {
      if (!isEdible(game, u)) continue;
      const d2 = (u.x - worm.x) * (u.x - worm.x) + (u.y - worm.y) * (u.y - worm.y);
      if (d2 <= r2) victims.push(u);
    }
    for (const u of victims) {
      const owner = u.owner;
      const type = u.type;
      D.Entities.removeUnit(game, u);
      worm.swallows++;
      // FX
      if (!game.fx) game.fx = [];
      game.fx.push({
        type: 'explode',
        x: u.x,
        y: u.y,
        r: 0.9,
        life: 0.45,
        color: '#c2a05a',
      });
      game.fx.push({
        type: 'worm_gulp',
        x: worm.x,
        y: worm.y,
        r: 1.2,
        life: 0.5,
      });
      D.Game.pushAlert(game, {
        seat: owner,
        kind: 'worm_eat',
        text: 'A sandworm swallowed your ' + type + '!',
        x: worm.x,
        y: worm.y,
      });
      if (owner === (game.localOwner || 'player')) {
        D.Game.pushMessage(game, 'Sandworm! Your ' + type + ' was swallowed.');
      }
    }
    return victims.length;
  }

  function updateWorm(game, worm, dt) {
    const rumbleSec = cfg().rumbleSec != null ? cfg().rumbleSec : 2;
    const surfaceSec = cfg().surfaceSec != null ? cfg().surfaceSec : 5;
    const speed = cfg().moveSpeed != null ? cfg().moveSpeed : 2.2;

    worm.phaseT += dt;

    if (worm.phase === 'rumble') {
      if (!worm.warned) {
        worm.warned = true;
        alertWormsign(game, worm);
      }
      // Rumble FX periodically
      if (!game.fx) game.fx = [];
      if ((game.tick | 0) % 4 === 0) {
        game.fx.push({
          type: 'wormsign',
          x: worm.x,
          y: worm.y,
          r: 1.5 + Math.sin(worm.phaseT * 8) * 0.3,
          life: 0.2,
        });
      }
      if (worm.phaseT >= rumbleSec) {
        worm.phase = 'surface';
        worm.phaseT = 0;
        D.Game.pushMessage(game, 'A sandworm breaches!');
      }
      return;
    }

    if (worm.phase === 'surface') {
      const prey = nearestEdible(game, worm);
      if (prey) {
        const dx = prey.x - worm.x;
        const dy = prey.y - worm.y;
        const len = Math.hypot(dx, dy) || 1;
        // Stay on danger terrain when possible
        const nx = worm.x + (dx / len) * speed * dt;
        const ny = worm.y + (dy / len) * speed * dt;
        const ntx = Math.floor(nx);
        const nty = Math.floor(ny);
        if (isDangerTerrain(game, ntx, nty) || isDangerTerrain(game, Math.floor(worm.x), Math.floor(worm.y))) {
          // Allow short rock hops only if prey is close
          if (isDangerTerrain(game, ntx, nty) || len < 2) {
            worm.x = nx;
            worm.y = ny;
          }
        }
      }
      swallowNear(game, worm);
      if (!game.fx) game.fx = [];
      if ((game.tick | 0) % 3 === 0) {
        game.fx.push({
          type: 'worm_body',
          x: worm.x,
          y: worm.y,
          r: 1.1,
          life: 0.15,
        });
      }
      if (worm.phaseT >= surfaceSec) {
        worm.phase = 'dive';
        worm.phaseT = 0;
      }
      return;
    }

    if (worm.phase === 'dive') {
      if (!game.fx) game.fx = [];
      game.fx.push({
        type: 'wormsign',
        x: worm.x,
        y: worm.y,
        r: 1.2 * (1 - worm.phaseT),
        life: 0.15,
      });
      if (worm.phaseT >= 0.8) {
        const st = ensureState(game);
        const cd = cfg().cooldownSec != null ? cfg().cooldownSec : 90;
        st.cooldownUntil = game.tick + Math.floor(cd / D.config.DT_SEC);
        const i = game.worms.indexOf(worm);
        if (i >= 0) game.worms.splice(i, 1);
      }
    }
  }

  D.Worms = {
    enabled,
    isSafeTile,
    isDangerTerrain,
    isEdible,
    isSafeUnitType,
    ensureState,

    /** Test / debug: force a rumble at world position. */
    forceEmerge(game, x, y) {
      if (!game) return null;
      ensureState(game);
      const worm = {
        id: game.wormState.nextId++,
        x: x != null ? x : game.map.width / 2,
        y: y != null ? y : game.map.height / 2,
        phase: 'rumble',
        phaseT: 0,
        warned: false,
        swallows: 0,
      };
      game.worms.push(worm);
      return worm;
    },

    tick(game, dt) {
      if (!game || game.phase !== 'playing') return;
      if (!enabled()) return;
      if (game.replay && !game._serverSim) return;

      const st = ensureState(game);
      accumulateHeat(game, dt);

      // Spawn if ready
      const threshold = cfg().threshold != null ? cfg().threshold : 100;
      const max = cfg().maxWorms != null ? cfg().maxWorms : 2;
      if (
        game.worms.length < max &&
        game.tick >= (st.cooldownUntil || 0) &&
        st.heat >= threshold
      ) {
        spawnWorm(game);
      }

      // Copy list — updateWorm may splice
      const list = game.worms.slice();
      for (const w of list) {
        if (game.worms.indexOf(w) < 0) continue;
        updateWorm(game, w, dt);
      }
    },

    /** Serialize for net/save. */
    serialize(game) {
      const st = game.wormState || null;
      return {
        worms: (game.worms || []).map((w) => ({
          id: w.id,
          x: w.x,
          y: w.y,
          phase: w.phase,
          phaseT: w.phaseT,
          warned: !!w.warned,
          swallows: w.swallows | 0,
        })),
        wormState: st
          ? {
              heat: st.heat,
              wx: st.wx,
              wy: st.wy,
              wSum: st.wSum,
              cooldownUntil: st.cooldownUntil,
              nextId: st.nextId,
            }
          : null,
      };
    },

    apply(game, data) {
      if (!game) return;
      if (data && data.worms) {
        game.worms = data.worms.map((w) => ({
          id: w.id,
          x: w.x,
          y: w.y,
          phase: w.phase || 'rumble',
          phaseT: w.phaseT || 0,
          warned: !!w.warned,
          swallows: w.swallows | 0,
        }));
      } else if (data && Array.isArray(data)) {
        // raw worms array
        game.worms = data.map((w) => ({ ...w }));
      } else {
        game.worms = game.worms || [];
      }
      if (data && data.wormState) {
        game.wormState = { ...data.wormState };
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
