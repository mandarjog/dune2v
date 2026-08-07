/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  D.Economy = {
    canAfford(game, owner, cost) {
      return game.credits[owner] >= cost;
    },

    charge(game, owner, cost) {
      if (!D.Economy.canAfford(game, owner, cost)) return false;
      game.credits[owner] -= cost;
      return true;
    },

    tickPower(game) {
      const owners =
        D.Seats && D.Seats.active ? D.Seats.active(game) : ['player', 'enemy'];
      for (const owner of owners) {
        let prod = 0;
        let need = 0;
        for (const b of game.buildings) {
          if (b.owner !== owner || b.buildProgress < 1) continue;
          const def = D.config.buildings[b.type];
          if (!def) continue;
          if (def.power > 0) prod += def.power;
          else need += -def.power;
        }
        const ratio = need > 0 ? Math.min(1, prod / need) : 1;
        if (!game.power) game.power = {};
        game.power[owner] = { prod, need, ratio };
      }
    },

    recalcSpiceCap(game) {
      const owners =
        D.Seats && D.Seats.active ? D.Seats.active(game) : ['player', 'enemy'];
      for (const owner of owners) {
        let cap = D.config.economy.baseSpiceCap;
        for (const b of game.buildings) {
          if (b.owner === owner && b.type === 'silo' && b.buildProgress >= 1) {
            cap += D.config.economy.siloBonus;
          }
        }
        if (!game.spiceCap) game.spiceCap = {};
        game.spiceCap[owner] = cap;
        if (game.credits[owner] > cap) game.credits[owner] = cap;
      }
    },

    hasTech(game, owner, requires) {
      if (!requires) return true;
      return game.buildings.some(
        (b) => b.owner === owner && b.type === requires && b.buildProgress >= 1
      );
    },

    canBuildType(game, owner, type) {
      const def = D.config.buildings[type];
      if (!def || !def.buildable) return false;
      if (D.Seats && D.Seats.allows && !D.Seats.allows(owner, def)) return false;
      if (!D.Economy.hasTech(game, owner, def.requires)) return false;
      return D.Economy.canAfford(game, owner, def.cost);
    },

    /** Units a factory may list for this owner (house specials filtered). */
    produceList(buildingType, owner) {
      const def = D.config.buildings[buildingType];
      if (!def || !def.produces) return [];
      return def.produces.filter((ut) => {
        const udef = D.config.units[ut];
        if (!udef) return false;
        if (D.Seats && D.Seats.allows && !D.Seats.allows(owner, udef)) return false;
        return true;
      });
    },

    /** Incomplete structures for this owner (active construction slots). */
    underConstruction(game, owner) {
      return game.buildings.filter(
        (b) => b.owner === owner && b.buildProgress < 1 && b.hp > 0
      );
    },

    structureQueueMax() {
      const n = D.config.economy && D.config.economy.maxStructureQueue;
      return n != null ? n : 3;
    },

    structureQueueCount(game, owner) {
      return D.Economy.underConstruction(game, owner).length;
    },

    beginStructure(game, owner, type, tileX, tileY) {
      const def = D.config.buildings[type];
      if (!def || !def.buildable) return { ok: false, reason: 'invalid' };
      if (D.Seats && D.Seats.allows && !D.Seats.allows(owner, def)) {
        return { ok: false, reason: 'house' };
      }
      if (!D.Economy.hasTech(game, owner, def.requires)) {
        return { ok: false, reason: 'tech' };
      }
      // Up to N concurrent constructions per side
      const maxQ = D.Economy.structureQueueMax();
      const nBuild = D.Economy.structureQueueCount(game, owner);
      if (nBuild >= maxQ) {
        return { ok: false, reason: 'busy' };
      }
      // Need a completed CY to start new structures (MCV deploy is separate)
      const hasCY = game.buildings.some(
        (b) =>
          b.owner === owner &&
          b.type === 'constructionYard' &&
          b.buildProgress >= 1 &&
          b.hp > 0
      );
      if (!hasCY) return { ok: false, reason: 'no-cy' };
      const skipProx = false;
      if (!D.Map.canPlace(game, type, tileX, tileY, owner, { skipProximity: skipProx })) {
        return { ok: false, reason: 'placement' };
      }
      if (!D.Economy.charge(game, owner, def.cost)) {
        return { ok: false, reason: 'credits' };
      }
      const b = D.Entities.createBuilding(game, type, owner, tileX, tileY, {
        progress: 0,
        costPaid: def.cost,
      });
      // Legacy single-id field: point at newest (UI uses counts now)
      if (game.structureBuilder) game.structureBuilder[owner] = b.id;
      return { ok: true, building: b, queue: nBuild + 1, maxQueue: maxQ };
    },

    enqueueUnit(game, buildingId, unitType, opts) {
      opts = opts || {};
      let b = game.buildings.find((x) => x.id === buildingId);
      const udef = D.config.units[unitType];
      if (!udef) return { ok: false, reason: 'type' };
      // Replay / desynced ids: fall back to an owned factory of the right type
      if ((!b || b.buildProgress < 1 || udef.builtAt !== b.type) && opts.owner) {
        b = game.buildings.find(
          (x) =>
            x.owner === opts.owner &&
            x.type === udef.builtAt &&
            x.buildProgress >= 1 &&
            x.hp > 0 &&
            (x.buildQueue || []).length < 5
        );
      }
      if (!b || b.buildProgress < 1) return { ok: false, reason: 'building' };
      if (udef.builtAt !== b.type) return { ok: false, reason: 'type' };
      if (D.Seats && D.Seats.allows && !D.Seats.allows(b.owner, udef)) {
        return { ok: false, reason: 'house' };
      }
      if (b.buildQueue.length >= 5) return { ok: false, reason: 'queue' };
      if (!D.Economy.charge(game, b.owner, udef.cost)) {
        return { ok: false, reason: 'credits' };
      }
      b.buildQueue.push({
        type: unitType,
        progress: 0,
        costPaid: udef.cost,
      });
      return { ok: true, buildingId: b.id };
    },

    cancelQueue(game, buildingId, index) {
      const b = game.buildings.find((x) => x.id === buildingId);
      if (!b || index < 0 || index >= b.buildQueue.length) return;
      const item = b.buildQueue.splice(index, 1)[0];
      const refund = Math.floor(item.costPaid * D.config.economy.cancelRefund);
      game.credits[b.owner] = Math.min(
        game.spiceCap[b.owner],
        game.credits[b.owner] + refund
      );
    },

    tick(game, dt) {
      D.Economy.tickPower(game);

      // structure build progress
      for (const b of game.buildings) {
        if (b.buildProgress >= 1) continue;
        const def = D.config.buildings[b.type];
        if (!def || !def.buildTime) {
          b.buildProgress = 1;
          continue;
        }
        const power = game.power[b.owner];
        // Bootstrap grace: no windtraps yet → full speed (otherwise first WT is 4× slow)
        const hasPowerPlant = game.buildings.some(
          (x) =>
            x.owner === b.owner &&
            x.type === 'windtrap' &&
            x.buildProgress >= 1
        );
        const mult = !hasPowerPlant
          ? 1
          : power.prod < power.need
            ? Math.max(power.ratio, 0.25)
            : 1;
        b.buildProgress += (dt * mult) / def.buildTime;
        if (b.buildProgress >= 1) {
          b.buildProgress = 1;
          b.hp = b.hpMax;
          if (game.structureBuilder && game.structureBuilder[b.owner] === b.id) {
            game.structureBuilder[b.owner] = null;
          }
          D.Economy.onStructureComplete(game, b);
        }
      }

      // unit queues
      for (const b of game.buildings) {
        if (b.buildProgress < 1 || !b.buildQueue.length) continue;
        const item = b.buildQueue[0];
        const udef = D.config.units[item.type];
        if (!udef) {
          b.buildQueue.shift();
          continue;
        }
        const power = game.power[b.owner];
        const mult =
          power.prod < power.need ? Math.max(power.ratio, 0.25) : 1;
        item.progress += (dt * mult) / udef.buildTime;
        if (item.progress >= 1) {
          b.buildQueue.shift();
          D.Economy.spawnUnit(game, b, item.type);
        }
      }
    },

    onStructureComplete(game, b) {
      D.Economy.tickPower(game);
      D.Economy.recalcSpiceCap(game);
      if (b.type === 'concrete' && game.map) {
        game.map.terrainDirty = true;
      }
      // Teleport units sitting on new blocking footprint
      if (b.type !== 'concrete') {
        D.Economy.teleportUnitsOffFootprint(game, b);
      }
      if (b.type === 'refinery') {
        D.Entities.assignDock(game, b);
        // free harvester
        const spawn = D.Economy.spawnPoint(game, b);
        const h = D.Entities.createUnit(game, 'harvester', b.owner, spawn.x, spawn.y);
        // auto harvest nearest spice
        const spice = D.Map.findNearestSpice(game.map, h.x, h.y);
        if (spice) {
          D.Orders.issue(game, [h.id], {
            type: 'harvest',
            tileX: spice.tx,
            tileY: spice.ty,
          });
        }
        if (b.owner === 'player') {
          D.Game.pushMessage(game, 'Refinery online. Harvester ready.');
        }
      }
      if (b.owner === 'player') {
        const def = D.config.buildings[b.type];
        D.Game.pushMessage(game, (def ? def.name : b.type) + ' complete.');
      }
    },

    spawnPoint(game, b) {
      // toward rally, outside footprint — skip tiles already holding a unit
      const rx = b.rallyX;
      const ry = b.rallyY;
      const candidates = [];
      function push(tx, ty) {
        if (!D.Map.isWalkable(game.map, tx, ty)) return;
        candidates.push({ x: tx + 0.5, y: ty + 0.5, tx, ty });
      }
      for (let r = 0; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            push(Math.floor(rx) + dx, Math.floor(ry) + dy);
          }
        }
      }
      // also edges of building
      for (let dx = 0; dx < b.tileW; dx++) {
        push(b.tileX + dx, b.tileY + b.tileH);
        push(b.tileX + dx, b.tileY - 1);
      }
      for (let dy = 0; dy < b.tileH; dy++) {
        push(b.tileX - 1, b.tileY + dy);
        push(b.tileX + b.tileW, b.tileY + dy);
      }

      function occupied(x, y) {
        for (const u of game.units) {
          if (u.hp <= 0) continue;
          if (Math.hypot(u.x - x, u.y - y) < 0.55) return true;
        }
        return false;
      }

      for (const c of candidates) {
        if (!occupied(c.x, c.y)) return { x: c.x, y: c.y };
      }
      // Soft stack offset if every tile is full
      if (candidates.length) {
        const c = candidates[0];
        const n = game.units.filter(
          (u) => u.hp > 0 && Math.hypot(u.x - c.x, u.y - c.y) < 0.8
        ).length;
        const ang = n * 0.9;
        return { x: c.x + Math.cos(ang) * 0.35, y: c.y + Math.sin(ang) * 0.35 };
      }
      return { x: b.tileX + b.tileW / 2, y: b.tileY + b.tileH + 1.5 };
    },

    spawnUnit(game, b, type) {
      const spawn = D.Economy.spawnPoint(game, b);
      const u = D.Entities.createUnit(game, type, b.owner, spawn.x, spawn.y);
      if (b.rallyX != null) {
        D.Orders.issue(game, [u.id], { type: 'move', x: b.rallyX, y: b.rallyY });
      }
      return u;
    },

    teleportUnitsOffFootprint(game, b) {
      for (const u of game.units) {
        if (u.hp <= 0) continue;
        const tx = Math.floor(u.x);
        const ty = Math.floor(u.y);
        if (
          tx >= b.tileX &&
          tx < b.tileX + b.tileW &&
          ty >= b.tileY &&
          ty < b.tileY + b.tileH
        ) {
          const dest = D.Economy.findEscapeTile(game, b.tileX + b.tileW / 2, b.tileY + b.tileH / 2);
          if (dest) {
            u.x = dest.x;
            u.y = dest.y;
            u.path = [];
          }
        }
      }
    },

    findEscapeTile(game, cx, cy) {
      for (let r = 1; r <= 3; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const tx = Math.floor(cx) + dx;
            const ty = Math.floor(cy) + dy;
            if (D.Map.isWalkable(game.map, tx, ty)) {
              return { x: tx + 0.5, y: ty + 0.5 };
            }
          }
        }
      }
      return null;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
