/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const OWNER = 'enemy';

  function countBuildings(game, type) {
    return game.buildings.filter(
      (b) => b.owner === OWNER && b.type === type && b.buildProgress >= 1
    ).length;
  }

  function countQueuedOrBuilt(game, type) {
    let n = countBuildings(game, type);
    n += game.buildings.filter(
      (b) => b.owner === OWNER && b.type === type && b.buildProgress < 1
    ).length;
    return n;
  }

  function combatUnits(game) {
    return game.units.filter((u) => {
      if (u.owner !== OWNER || u.hp <= 0) return false;
      if (u.type === 'harvester' || u.type === 'mcv') return false;
      const def = D.config.units[u.type];
      return def && def.weapon;
    });
  }

  function findCY(game, owner) {
    return game.buildings.find(
      (b) => b.owner === owner && b.type === 'constructionYard' && b.buildProgress >= 1
    );
  }

  function spiralPlace(game, type, originX, originY) {
    const maxR = D.config.ai.placement.spiralMaxRadius;
    const def = D.config.buildings[type];
    // try preferred offset for refinery toward spice
    if (type === 'refinery') {
      const spice = D.Map.findNearestSpice(game.map, originX, originY);
      if (spice) {
        const dirX = spice.x - originX;
        const dirY = spice.y - originY;
        const len = Math.hypot(dirX, dirY) || 1;
        for (let dist = 3; dist <= D.config.ai.placement.refineryTowardSpiceRange; dist++) {
          const tx = Math.floor(originX + (dirX / len) * dist) - Math.floor(def.tileW / 2);
          const ty = Math.floor(originY + (dirY / len) * dist) - Math.floor(def.tileH / 2);
          if (D.Map.canPlace(game, type, tx, ty, OWNER)) return { tx, ty };
        }
      }
    }
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r && r > 0) continue;
          const tx = Math.floor(originX) + dx;
          const ty = Math.floor(originY) + dy;
          if (D.Map.canPlace(game, type, tx, ty, OWNER)) return { tx, ty };
        }
      }
    }
    return null;
  }

  function updateMemory(game) {
    // last seen player CY / units
    for (const b of game.buildings) {
      if (b.owner !== 'player' || b.hp <= 0) continue;
      const c = D.Entities.buildingCenter(b);
      if (D.Map.isVisible(game, OWNER, Math.floor(c.x), Math.floor(c.y))) {
        if (b.type === 'constructionYard') {
          game.ai.memory.enemyCY = { x: c.x, y: c.y, t: game.tick };
        }
        game.ai.memory.lastEnemyBuilding = { x: c.x, y: c.y, t: game.tick };
      }
    }
    for (const u of game.units) {
      if (u.owner !== 'player' || u.hp <= 0) continue;
      if (D.Map.isVisible(game, OWNER, Math.floor(u.x), Math.floor(u.y))) {
        game.ai.memory.lastEnemyUnit = { x: u.x, y: u.y, t: game.tick };
      }
    }
  }

  function tryBuild(game, type) {
    const def = D.config.buildings[type];
    if (!def) return false;
    if (!D.Economy.hasTech(game, OWNER, def.requires)) return false;
    if (!D.Economy.canAfford(game, OWNER, def.cost)) return false;
    // already building this?
    if (game.buildings.some((b) => b.owner === OWNER && b.type === type && b.buildProgress < 1)) {
      return false;
    }
    const cy = findCY(game, OWNER);
    if (!cy && type !== 'constructionYard') return false;
    const ox = cy ? cy.tileX + cy.tileW / 2 : 55;
    const oy = cy ? cy.tileY + cy.tileH / 2 : 8;
    const spot = spiralPlace(game, type, ox, oy);
    if (!spot) return false;
    const r = D.Economy.beginStructure(game, OWNER, type, spot.tx, spot.ty);
    return r.ok;
  }

  function ensurePower(game) {
    const p = game.power[OWNER];
    if (p.need === 0) return;
    const surplus = (p.prod - p.need) / Math.max(1, p.need);
    if (surplus < D.config.ai.desirePowerSurplus) {
      tryBuild(game, 'windtrap');
    }
  }

  function followBuildOrder(game) {
    const order = D.config.ai.buildOrder;
    const counts = {};
    for (const t of order) {
      counts[t] = (counts[t] || 0) + 1;
      if (countQueuedOrBuilt(game, t) < counts[t]) {
        if (tryBuild(game, t)) return true;
        return false;
      }
    }
    return false;
  }

  function produce(game) {
    if (game.credits[OWNER] < D.config.ai.creditsStableThreshold) return;
    const p = game.power[OWNER];
    if (p.ratio < 0.6) return;

    const weights = D.config.ai.productionWeights;
    const picks = [];
    for (const [type, w] of Object.entries(weights)) {
      const udef = D.config.units[type];
      if (!udef) continue;
      if (D.Seats && D.Seats.allows && !D.Seats.allows(OWNER, udef)) continue;
      for (let i = 0; i < w; i++) picks.push(type);
    }
    const type = D.rng.pick(picks);
    if (!type) return;
    const udef = D.config.units[type];
    const factory = game.buildings.find(
      (b) =>
        b.owner === OWNER &&
        b.type === udef.builtAt &&
        b.buildProgress >= 1 &&
        b.buildQueue.length < 3
    );
    if (!factory) return;
    D.Economy.enqueueUnit(game, factory.id, type);
  }

  function manageHarvesters(game) {
    const refs = countBuildings(game, 'refinery');
    const harvs = game.units.filter((u) => u.owner === OWNER && u.type === 'harvester').length;
    if (harvs < refs) {
      const hf = game.buildings.find(
        (b) => b.owner === OWNER && b.type === 'heavyFactory' && b.buildProgress >= 1
      );
      if (hf && hf.buildQueue.length < 2) {
        D.Economy.enqueueUnit(game, hf.id, 'harvester');
      }
    }
    // idle harvesters → spice
    for (const u of game.units) {
      if (u.owner !== OWNER || u.type !== 'harvester') continue;
      if (u.harvest && u.harvest.state === 'idle' && (!u.order || u.order.type === 'stop')) {
        const spice = D.Map.findNearestSpice(game.map, u.x, u.y);
        if (spice) {
          D.Orders.issue(game, [u.id], {
            type: 'harvest',
            tileX: spice.tx,
            tileY: spice.ty,
          });
        }
      }
    }
  }

  function scout(game) {
    const cfg = D.config.ai;
    const period = cfg.scoutPeriodSec / D.config.DT_SEC;
    if (game.tick - (game.ai.lastScoutTick || 0) < period) return;
    game.ai.lastScoutTick = game.tick;
    const trike = game.units.find(
      (u) => u.owner === OWNER && u.type === 'trike' && u.hp > 0 && (!u.order || u.order.type === 'move')
    );
    const unit =
      trike ||
      game.units.find(
        (u) =>
          u.owner === OWNER &&
          u.hp > 0 &&
          u.type !== 'harvester' &&
          u.type !== 'mcv' &&
          D.config.units[u.type]?.weapon
      );
    if (!unit) return;
    // frontier unexplored
    const map = game.map;
    const candidates = [];
    for (let i = 0; i < 40; i++) {
      const tx = D.rng.int(0, map.width - 1);
      const ty = D.rng.int(0, map.height - 1);
      if (!D.Map.isExplored(game, OWNER, tx, ty)) {
        candidates.push({ x: tx + 0.5, y: ty + 0.5 });
      }
    }
    const dest =
      candidates[0] ||
      (game.ai.memory.lastEnemyBuilding
        ? { x: game.ai.memory.lastEnemyBuilding.x, y: game.ai.memory.lastEnemyBuilding.y }
        : { x: 8, y: 52 });
    D.Orders.issue(game, [unit.id], { type: 'move', x: dest.x, y: dest.y });
  }

  function attackWave(game) {
    const cfg = D.config.ai;
    const period = cfg.wavePeriodSec / D.config.DT_SEC;
    if (game.tick - (game.ai.waveAt || 0) < period) return;
    const army = combatUnits(game);
    if (army.length < cfg.waveMinCombatUnits) return;
    game.ai.waveAt = game.tick;
    game.ai.state = 'Attack';

    let tx = 8;
    let ty = 52;
    if (game.ai.memory.enemyCY) {
      tx = game.ai.memory.enemyCY.x;
      ty = game.ai.memory.enemyCY.y;
    } else if (game.ai.memory.lastEnemyBuilding) {
      tx = game.ai.memory.lastEnemyBuilding.x;
      ty = game.ai.memory.lastEnemyBuilding.y;
    } else if (game.ai.memory.lastEnemyUnit) {
      tx = game.ai.memory.lastEnemyUnit.x;
      ty = game.ai.memory.lastEnemyUnit.y;
    }

    const ids = army.map((u) => u.id);
    D.Orders.issue(game, ids, { type: 'attack-move', x: tx, y: ty });
  }

  function defend(game) {
    const mem = game.ai.memory.playerAttackedAt;
    if (!mem) return;
    if (game.tick - mem.t > (8 / D.config.DT_SEC)) return;
    game.ai.state = 'Defend';
    const army = combatUnits(game).filter((u) => {
      const cy = findCY(game, OWNER);
      if (!cy) return true;
      const c = D.Entities.buildingCenter(cy);
      return Math.hypot(u.x - c.x, u.y - c.y) < D.config.ai.defendRadiusTiles;
    });
    if (!army.length) return;
    D.Orders.issue(
      game,
      army.map((u) => u.id),
      { type: 'attack-move', x: mem.x, y: mem.y }
    );
  }

  function bootstrapMCV(game) {
    const mcv = game.units.find((u) => u.owner === OWNER && u.type === 'mcv');
    if (!mcv) return;
    if (findCY(game, OWNER)) return;
    // move to rock if needed then deploy
    if (D.Orders.canDeploy(game, mcv.id)) {
      D.Orders.issue(game, [mcv.id], { type: 'deploy' });
    } else {
      // find rock near spawn
      const map = game.map;
      for (let r = 0; r < 15; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const tx = Math.floor(mcv.x) + dx;
            const ty = Math.floor(mcv.y) + dy;
            if (D.Map.tileAt(map, tx, ty) === D.config.terrain.ROCK) {
              D.Orders.issue(game, [mcv.id], { type: 'move', x: tx + 0.5, y: ty + 0.5 });
              // try deploy next ticks
              return;
            }
          }
        }
      }
    }
  }

  D.AI = {
    tick(game, dt) {
      if (!D.config.features.ai) return;
      if (game.phase !== 'playing') return;
      if (game.tick % D.config.ai.tickEvery !== 0) return;

      updateMemory(game);
      bootstrapMCV(game);

      if (!findCY(game, OWNER)) {
        game.ai.state = 'Bootstrap';
        return;
      }

      ensurePower(game);
      manageHarvesters(game);

      const hasRef = countBuildings(game, 'refinery') > 0;
      const hasWT = countBuildings(game, 'windtrap') > 0;
      if (!hasWT || !hasRef) {
        game.ai.state = 'Bootstrap';
        followBuildOrder(game);
        return;
      }

      game.ai.state = game.ai.state === 'Attack' ? 'Military' : game.ai.state || 'Eco';
      followBuildOrder(game);
      produce(game);
      scout(game);
      defend(game);
      attackWave(game);

      if (combatUnits(game).length >= D.config.ai.waveMinCombatUnits) {
        if (game.ai.state !== 'Defend') game.ai.state = 'Military';
      } else {
        game.ai.state = 'Tech';
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
