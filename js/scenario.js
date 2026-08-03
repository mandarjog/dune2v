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

  /** Walkable spawn near (ax, ay), scanning outward. */
  function findWalkableNear(map, ax, ay, maxR) {
    maxR = maxR != null ? maxR : 24;
    ax = Math.floor(ax);
    ay = Math.floor(ay);
    if (D.Map.isWalkable(map, ax, ay)) return { x: ax + 0.5, y: ay + 0.5 };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = ax + dx;
          const ty = ay + dy;
          if (D.Map.isWalkable(map, tx, ty)) return { x: tx + 0.5, y: ty + 0.5 };
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
    const ax = sp.x + (towardCenterX / len) * 8;
    const ay = sp.y + (towardCenterY / len) * 8;

    let placed = 0;
    const cols = Math.ceil(Math.sqrt(count * 1.2));
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const col = placed % cols;
      const row = Math.floor(placed / cols);
      const ox = (col - cols / 2) * 1.15;
      const oy = row * 1.15;
      // Mirror formation so player expands NE-ish, enemy SW-ish
      const sign = owner === 'enemy' ? -1 : 1;
      const px = ax + ox * sign;
      const py = ay + oy * sign;
      const pos = findWalkableNear(map, px, py, 6);
      if (!pos) continue;
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

  /** Extra silos / factory so late-game eco isn't empty. */
  function boostBase(game, owner) {
    const map = game.map;
    const sp = map.spawns[owner] || map.spawns.player;
    const extras = [
      { type: 'silo', dx: 4, dy: 0 },
      { type: 'silo', dx: 5, dy: 0 },
      { type: 'barracks', dx: 3, dy: -3 },
      { type: 'lightFactory', dx: 6, dy: -2 },
      { type: 'heavyFactory', dx: -2, dy: 3 },
      { type: 'gunTurret', dx: 8, dy: 1 },
    ];
    for (const e of extras) {
      const tx = Math.floor(sp.x + e.dx);
      const ty = Math.floor(sp.y + e.dy);
      if (!D.Map.canPlace(game, e.type, tx, ty, owner, { skipProximity: true })) {
        // loose search
        let ok = false;
        for (let r = 1; r <= 5 && !ok; r++) {
          for (let dy = -r; dy <= r && !ok; dy++) {
            for (let dx = -r; dx <= r && !ok; dx++) {
              if (
                D.Map.canPlace(game, e.type, tx + dx, ty + dy, owner, {
                  skipProximity: true,
                })
              ) {
                D.Entities.createBuilding(game, e.type, owner, tx + dx, ty + dy, {
                  complete: true,
                });
                ok = true;
              }
            }
          }
        }
        continue;
      }
      D.Entities.createBuilding(game, e.type, owner, tx, ty, { complete: true });
    }
    D.Map.rebuildBlocked(game);
    D.Economy.tickPower(game);
    D.Economy.recalcSpiceCap(game);
    // Top up credits to silo capacity
    if (game.spiceCap[owner] != null) {
      game.credits[owner] = game.spiceCap[owner];
    }
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
      if (opts.fog === false) D.config.features.fog = false;
      if (opts.fog === true) D.config.features.fog = true;

      D.Game.startSkirmish(game, mapDef, {
        owners: ['player', 'enemy'],
        startMode: 'base',
        names: { player: 'Commander', enemy: 'AI Harkonnen' },
      });

      if (opts.boostBase !== false) {
        boostBase(game, 'player');
        boostBase(game, 'enemy');
      }

      const pN = spawnArmy(game, 'player', perSide);
      const eN = spawnArmy(game, 'enemy', perSide);

      // Fog for both so vision is consistent
      if (D.Map.initFog) D.Map.initFog(game);
      D.Map.recomputeFog(game, 'player');
      D.Map.recomputeFog(game, 'enemy');

      D.Game.pushMessage(
        game,
        'Mass armies: ' +
          pN +
          ' vs ' +
          eN +
          ' + bases. You = Atreides, AI = Harkonnen. Play as a normal skirmish.'
      );
      if (game.stats) {
        game.stats.scenario = 'mass';
        game.stats.scenarioPerSide = perSide;
      }
      return { player: pN, enemy: eN, perSide };
    },

    /** Parse URL / menu options. */
    parseOpts(params) {
      params = params || new URLSearchParams(location.search);
      let perSide = 80;
      if (params.get('armies')) perSide = parseInt(params.get('armies'), 10) || 80;
      if (params.get('units')) perSide = parseInt(params.get('units'), 10) || perSide;
      return {
        perSide: clamp(perSide, 10, 250),
        fog: params.get('fog') === '0' ? false : undefined,
        ai: params.get('ai') === '0' ? false : true,
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
