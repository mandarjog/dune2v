/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  let nextId = 1;
  /** Projectiles/fx use a separate counter so they cannot desync unit/building ids. */
  let nextFxId = 1;

  D.Entities = {
    resetIds() {
      nextId = 1;
      nextFxId = 1;
    },

    setNextId(n) {
      nextId = Math.max(1, n | 0);
    },

    peekNextId() {
      return nextId;
    },

    nextId() {
      return nextId++;
    },

    /** Ids for projectiles / transient effects (not used in cmd payloads). */
    nextFxId() {
      return nextFxId++;
    },

    /** Runtime weapon state (cooldown + optional magazine when recharge is used). */
    makeWeaponState(wdef) {
      if (!wdef) return null;
      const st = { cooldownLeft: 0 };
      if (wdef.recharge) {
        const max =
          wdef.magazine != null
            ? wdef.magazine
            : (D.config.recharge && D.config.recharge.magazine) || 5;
        st.ammo = max;
        st.ammoMax = max;
        if (wdef.volley) st.volleyLeft = 0;
      }
      return st;
    },

    createUnit(game, type, owner, x, y) {
      const def = D.config.units[type];
      if (!def) throw new Error('Unknown unit ' + type);
      const u = {
        id: nextId++,
        type,
        owner,
        x,
        y,
        hp: def.hp,
        hpMax: def.hp,
        facing: 0,
        orders: [],
        order: null,
        path: [],
        weapon: D.Entities.makeWeaponState(def.weapon),
        cargo: 0,
        cargoMax: def.cargoMax || 0,
        harvest: type === 'harvester'
          ? { state: 'idle', tileX: 0, tileY: 0, refineryId: null, unloadLeft: 0, wait: 0 }
          : null,
        sight: def.sight,
        selected: false,
        repathQueued: false,
      };
      game.units.push(u);
      return u;
    },

    createBuilding(game, type, owner, tileX, tileY, opts) {
      opts = opts || {};
      const def = D.config.buildings[type];
      if (!def) throw new Error('Unknown building ' + type);
      let hpMax = def.hp;
      if (
        type !== 'concrete' &&
        D.Map.hasConcreteUnder(game, tileX, tileY, def.tileW, def.tileH)
      ) {
        hpMax = Math.floor(def.hp * D.config.build.concreteHpBonus);
      }
      const complete = opts.complete !== false && opts.progress == null;
      const progress = opts.progress != null ? opts.progress : complete ? 1 : 0;
      const b = {
        id: nextId++,
        type,
        owner,
        tileX,
        tileY,
        tileW: def.tileW,
        tileH: def.tileH,
        hp: opts.hp != null ? opts.hp : progress >= 1 ? hpMax : Math.max(1, Math.floor(hpMax * 0.15)),
        hpMax,
        powered: true,
        buildProgress: progress,
        buildQueue: [],
        rallyX: tileX + def.tileW / 2,
        rallyY: tileY + def.tileH + 1.5,
        dockTileX: null,
        dockTileY: null,
        primary: false,
        sight: def.sight,
        weapon: D.Entities.makeWeaponState(def.weapon),
        costPaid: opts.costPaid || 0,
      };

      if (type === 'refinery') {
        D.Entities.assignDock(game, b);
      }

      game.buildings.push(b);
      if (type !== 'concrete') {
        D.Map.markBuildingBlocked(game.map, b, true);
      }
      return b;
    },

    assignDock(game, b) {
      // bottom-center outside footprint
      const candidates = [];
      const midX = b.tileX + Math.floor(b.tileW / 2);
      const below = b.tileY + b.tileH;
      candidates.push([midX, below], [midX - 1, below], [midX + 1, below]);
      candidates.push([b.tileX - 1, b.tileY + 1], [b.tileX + b.tileW, b.tileY + 1]);
      for (const [tx, ty] of candidates) {
        if (D.Map.isWalkable(game.map, tx, ty) || !game.map.blocked[D.Map.idx(game.map, tx, ty)]) {
          // may be blocked by self footprint — prefer outside
          if (
            tx >= b.tileX &&
            tx < b.tileX + b.tileW &&
            ty >= b.tileY &&
            ty < b.tileY + b.tileH
          ) {
            continue;
          }
          if (D.Map.inBounds(game.map, tx, ty) && D.Map.tileAt(game.map, tx, ty) !== D.config.terrain.CLIFF) {
            b.dockTileX = tx;
            b.dockTileY = ty;
            return;
          }
        }
      }
      b.dockTileX = midX;
      b.dockTileY = below;
    },

    getById(game, id) {
      let e = game.units.find((u) => u.id === id);
      if (e) return e;
      return game.buildings.find((b) => b.id === id) || null;
    },

    removeUnit(game, u) {
      const i = game.units.indexOf(u);
      if (i >= 0) game.units.splice(i, 1);
      const si = game.selection.ids.indexOf(u.id);
      if (si >= 0) game.selection.ids.splice(si, 1);
    },

    removeBuilding(game, b) {
      if (b.type !== 'concrete') {
        D.Map.markBuildingBlocked(game.map, b, false);
      }
      const i = game.buildings.indexOf(b);
      if (i >= 0) game.buildings.splice(i, 1);
      // free dock waiters etc. handled by harvest FSM
    },

    unitCenter(u) {
      return { x: u.x, y: u.y };
    },

    buildingCenter(b) {
      return { x: b.tileX + b.tileW / 2, y: b.tileY + b.tileH / 2 };
    },

    dist(ax, ay, bx, by) {
      return Math.hypot(ax - bx, ay - by);
    },

    targetKind(entity) {
      if (entity.tileW != null) return 'building';
      const def = D.config.units[entity.type];
      return def && def.kind === 'infantry' ? 'infantry' : 'vehicle';
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
