/* global Dune2 */
/**
 * Pre-built skirmish setups for testing (pathing, FOW, late-game feel).
 * Once started, behaviour is identical to a normal SP game (AI, save, etc.).
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const ARMY_MIX = [
    'infantry',
    'infantry',
    'trooper',
    'trike',
    'quad',
    'combatTank',
    'combatTank',
  ];

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n | 0));
  }

  /** Walkable spawn near (ax, ay), scanning outward. Avoids already-used tiles. */
  function findWalkableNear(map, ax, ay, maxR, occupied) {
    maxR = maxR != null ? maxR : 24;
    ax = Math.floor(ax);
    ay = Math.floor(ay);
    const free = (tx, ty) => {
      if (!D.Map.isWalkable(map, tx, ty)) return false;
      if (occupied && occupied.has(tx + ',' + ty)) return false;
      return true;
    };
    if (free(ax, ay)) return { x: ax + 0.5, y: ay + 0.5, tx: ax, ty: ay };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = ax + dx;
          const ty = ay + dy;
          if (free(tx, ty)) return { x: tx + 0.5, y: ty + 0.5, tx, ty };
        }
      }
    }
    return null;
  }

  /**
   * Grid of units near base spawn, slightly toward map center so they can move.
   * @returns {number} count actually placed
   */
  function spawnArmy(game, owner, count, opts) {
    opts = opts || {};
    const map = game.map;
    const sp = (map.spawns && map.spawns[owner]) || map.spawns.player;
    const towardCenterX = map.width / 2 - sp.x;
    const towardCenterY = map.height / 2 - sp.y;
    const len = Math.hypot(towardCenterX, towardCenterY) || 1;
    // Anchor: a few tiles toward mid so not stacked on the CY
    const ax = sp.x + (towardCenterX / len) * 10;
    const ay = sp.y + (towardCenterY / len) * 10;

    let placed = 0;
    const occupied = new Set();
    // Mark building footprints as occupied so army spawns off the base pad
    for (const b of game.buildings || []) {
      if (b.owner !== owner || b.type === 'concrete') continue;
      for (let dy = 0; dy < b.tileH; dy++) {
        for (let dx = 0; dx < b.tileW; dx++) {
          occupied.add(b.tileX + dx + ',' + (b.tileY + dy));
        }
      }
    }
    // Wider spacing for large armies so pathfinding isn't a traffic jam on one tile
    const spacing = count > 40 ? 1.45 : 1.2;
    const cols = Math.ceil(Math.sqrt(count * 1.35));
    for (let i = 0; i < count * 4 && placed < count; i++) {
      const col = placed % cols;
      const row = Math.floor(placed / cols);
      const ox = (col - cols / 2) * spacing;
      const oy = row * spacing;
      // Mirror formation so player expands NE-ish, enemy SW-ish
      const sign = owner === 'enemy' ? -1 : 1;
      const px = ax + ox * sign;
      const py = ay + oy * sign;
      const pos = findWalkableNear(map, px, py, 10, occupied);
      if (!pos) continue;
      occupied.add(pos.tx + ',' + pos.ty);
      const type = ARMY_MIX[placed % ARMY_MIX.length];
      try {
        D.Entities.createUnit(game, type, owner, pos.x, pos.y);
        placed++;
      } catch (e) {
        /* skip unknown types */
      }
    }
    return placed;
  }

  /** Place building near spawn; spiral if exact tile fails (rock / occupied). */
  function placeExtra(game, owner, type, dx, dy) {
    const map = game.map;
    const sp = map.spawns[owner] || map.spawns.player;
    const tx0 = Math.floor(sp.x + dx);
    const ty0 = Math.floor(sp.y + dy);
    if (D.Map.canPlace(game, type, tx0, ty0, owner, { skipProximity: true })) {
      D.Entities.createBuilding(game, type, owner, tx0, ty0, { complete: true });
      return true;
    }
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx2 = -r; dx2 <= r; dx2++) {
          if (Math.abs(dx2) !== r && Math.abs(dy) !== r) continue;
          const tx = tx0 + dx2;
          const ty = ty0 + dy;
          if (
            D.Map.canPlace(game, type, tx, ty, owner, { skipProximity: true })
          ) {
            D.Entities.createBuilding(game, type, owner, tx, ty, {
              complete: true,
            });
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Extra silos / factory so late-game eco isn't empty. */
  function boostBase(game, owner) {
    const extras = [
      { type: 'silo', dx: 4, dy: 0 },
      { type: 'silo', dx: 5, dy: 0 },
      { type: 'barracks', dx: 3, dy: -3 },
      { type: 'lightFactory', dx: 6, dy: -2 },
      { type: 'heavyFactory', dx: -2, dy: 3 },
    ];
    for (const e of extras) placeExtra(game, owner, e.type, e.dx, e.dy);
    D.Map.rebuildBlocked(game);
    D.Economy.tickPower(game);
    D.Economy.recalcSpiceCap(game);
    // Top up credits to silo capacity
    if (game.spiceCap[owner] != null) {
      game.credits[owner] = game.spiceCap[owner];
    }
  }

  /**
   * Scan a filled disk of rock around anchor; score by approach direction.
   * @returns {Array<{tx:number,ty:number}>}
   */
  function placeNearAnchor(game, owner, type, ax, ay, count, opts) {
    opts = opts || {};
    const preferDir = opts.preferDir || null;
    const minR = opts.minR != null ? opts.minR : 1;
    const maxR = opts.maxR != null ? opts.maxR : 14;
    const minSep = opts.minSep != null ? opts.minSep : 1; // tile gap between same type
    const placed = [];
    const candidates = [];
    const ax0 = Math.floor(ax);
    const ay0 = Math.floor(ay);
    for (let dy = -maxR; dy <= maxR; dy++) {
      for (let dx = -maxR; dx <= maxR; dx++) {
        const r = Math.hypot(dx, dy);
        if (r < minR || r > maxR) continue;
        const tx = ax0 + dx;
        const ty = ay0 + dy;
        if (!D.Map.canPlace(game, type, tx, ty, owner, { skipProximity: true })) {
          continue;
        }
        let score = -r;
        if (preferDir) {
          const len = r || 1;
          score += ((dx / len) * preferDir.x + (dy / len) * preferDir.y) * 12;
        }
        candidates.push({ tx, ty, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (placed.length >= count) break;
      if (!D.Map.canPlace(game, type, c.tx, c.ty, owner, { skipProximity: true })) {
        continue;
      }
      // keep a little spacing so the ring is readable
      let near = false;
      for (const p of placed) {
        if (Math.hypot(p.x - c.tx, p.y - c.ty) < minSep) {
          near = true;
          break;
        }
      }
      if (near) continue;
      D.Entities.createBuilding(game, type, owner, c.tx, c.ty, { complete: true });
      placed.push({ x: c.tx, y: c.ty });
    }
    return placed;
  }

  /**
   * Enemy-only defense for mass-army stress (player stays open).
   * Runs *before* boostBase factories so rock next to the CY is free.
   * Turrets on the approach side + windtraps for power.
   */
  function boostEnemyDefense(game) {
    const owner = 'enemy';
    const map = game.map;
    const cy = game.buildings.find(
      (b) => b.owner === owner && b.type === 'constructionYard' && b.hp > 0
    );
    const sp = (map.spawns && map.spawns[owner]) || map.spawns.player;
    const ax = cy ? cy.tileX + cy.tileW / 2 : sp.x + 0.5;
    const ay = cy ? cy.tileY + cy.tileH / 2 : sp.y + 0.5;
    // Face player spawn (SW on skirmish_large)
    const pSp = map.spawns.player || { x: map.width / 2, y: map.height / 2 };
    let dx = pSp.x - ax;
    let dy = pSp.y - ay;
    const len = Math.hypot(dx, dy) || 1;
    const preferDir = { x: dx / len, y: dy / len };

    // Power first (behind base), then a clear turret screen on the approach
    placeNearAnchor(game, owner, 'windtrap', ax, ay, 3, {
      preferDir: { x: -preferDir.x, y: -preferDir.y },
      minR: 2,
      maxR: 12,
      minSep: 2,
    });
    const turrets = placeNearAnchor(game, owner, 'gunTurret', ax, ay, 8, {
      preferDir,
      minR: 2,
      maxR: 12,
      minSep: 1.4,
    });

    D.Map.rebuildBlocked(game);
    D.Economy.tickPower(game);
    D.Economy.recalcSpiceCap(game);
    if (game.spiceCap[owner] != null) {
      game.credits[owner] = game.spiceCap[owner];
    }
    return turrets;
  }

  D.Scenario = {
    /**
     * 1v1 SP stress: full bases + large armies, AI on enemy.
     * @param {object} game
     * @param {object} [opts]
     * @param {number} [opts.perSide=80] combat units per house (10–250)
     * @param {boolean} [opts.boostBase=true] extra factories/silos
     * @param {boolean} [opts.ai=true]
     */
    startMassArmies(game, opts) {
      opts = opts || {};
      const perSide = clamp(opts.perSide != null ? opts.perSide : 80, 10, 250);
      const mapDef = D.MAPS.skirmish_large || D.MAPS.skirmish1;

      game.multiplayer = false;
      game.spectator = false;
      game.replay = false;
      game._serverSim = false;
      game.localOwner = 'player';
      game.netRole = null;

      D.config.features.ai = opts.ai !== false;
      // Mass stress default: FOW off so you can see enemy turrets/base.
      // Override with ?fog=1 to play with fog.
      if (opts.fog === true) D.config.features.fog = true;
      else D.config.features.fog = false;
      // Worms: menu / opts.sandworms (default off for mass path stress unless checked)
      const wormsOn =
        opts.sandworms != null
          ? !!opts.sandworms
          : !!(D.config.features && D.config.features.sandworms);
      D.config.features.sandworms = wormsOn;
      if (D.config.worms) D.config.worms.enabled = wormsOn;
      // Cap must fit pre-spawned armies (default 35 would only block *new* trains,
      // but UI/telemetry looked like "stuck at 35" — lift for this scenario)
      if (!D.config.build) D.config.build = {};
      D.config.build.maxArmySize = Math.max(
        D.config.build.maxArmySize || 35,
        perSide + 40
      );
      // Give large SP groups more recovery A* budget
      if (D.config.path) {
        D.config.path.maxRepathsPerTick = Math.max(
          D.config.path.maxRepathsPerTick || 64,
          128
        );
      }

      D.Game.startSkirmish(game, mapDef, {
        owners: ['player', 'enemy'],
        startMode: 'base',
        names: { player: 'Commander', enemy: 'AI Harkonnen' },
      });

      /** @type {Array<{x:number,y:number}>} */
      let turretSpots = [];
      if (opts.boostBase !== false) {
        // Defenses first (while rock around CY is free), then eco buildings
        turretSpots = boostEnemyDefense(game);
        boostBase(game, 'player');
        boostBase(game, 'enemy');
      }

      const pN = spawnArmy(game, 'player', perSide);
      const eN = spawnArmy(game, 'enemy', perSide);

      // Fog maps still init (for toggling mid-game); vision full when fog off
      if (D.Map.initFog) D.Map.initFog(game);
      // Force flag again right before recompute (defends against anything that flipped it)
      if (opts.fog === true) D.config.features.fog = true;
      else D.config.features.fog = false;
      D.Map.recomputeFog(game, 'player');
      D.Map.recomputeFog(game, 'enemy');
      game._fogDrawDirty = true;

      const nTur = turretSpots.length;
      const posHint =
        nTur > 0
          ? ' at ' +
            turretSpots
              .slice(0, 3)
              .map((p) => p.x + ',' + p.y)
              .join(' · ') +
            (nTur > 3 ? '…' : '')
          : '';
      D.Game.pushMessage(
        game,
        'Mass armies: ' +
          pN +
          ' vs ' +
          eN +
          '. Enemy gun turrets: ' +
          nTur +
          posHint +
          '. FOW ' +
          (D.config.features.fog ? 'ON' : 'OFF') +
          ' · army cap ' +
          (D.config.build && D.config.build.maxArmySize) +
          ' · worms ' +
          (D.config.features.sandworms ? 'ON' : 'OFF') +
          '. You = Atreides.'
      );
      if (game.stats) {
        game.stats.scenario = 'mass';
        game.stats.scenarioPerSide = perSide;
        game.stats.enemyTurrets = nTur;
      }
      return {
        player: pN,
        enemy: eN,
        perSide,
        enemyTurrets: nTur,
        turretSpots,
      };
    },

    /** Parse URL / menu options. */
    parseOpts(params) {
      params = params || new URLSearchParams(location.search);
      let perSide = 80;
      if (params.get('armies')) perSide = parseInt(params.get('armies'), 10) || 80;
      if (params.get('units')) perSide = parseInt(params.get('units'), 10) || perSide;
      // fog: default off for mass; ?fog=1 forces on; ?fog=0 forces off
      let fog;
      if (params.get('fog') === '1' || params.get('fog') === 'true') fog = true;
      else if (params.get('fog') === '0' || params.get('fog') === 'false') fog = false;
      else fog = false; // mass default
      let sandworms;
      const w = params.get('worms') || params.get('sandworms');
      if (w === '1' || w === 'true') sandworms = true;
      else if (w === '0' || w === 'false') sandworms = false;
      // else undefined → menu / config default
      return {
        perSide: clamp(perSide, 10, 250),
        fog,
        ai: params.get('ai') === '0' ? false : true,
        sandworms,
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
