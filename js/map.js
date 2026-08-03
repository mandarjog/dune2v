/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});
  const T = () => D.config.terrain;

  function idx(map, tx, ty) {
    return ty * map.width + tx;
  }

  function inBounds(map, tx, ty) {
    return tx >= 0 && ty >= 0 && tx < map.width && ty < map.height;
  }

  D.Map = {
    createFromDef(def) {
      const w = def.width;
      const h = def.height;
      const n = w * h;
      const tiles = new Uint8Array(def.tiles);
      const spiceAmount = new Float32Array(def.spiceAmount || n);
      const blocked = new Uint8Array(n); // buildings / cliffs
      // cliff tiles blocked
      const cliff = T().CLIFF;
      for (let i = 0; i < n; i++) {
        if (tiles[i] === cliff) blocked[i] = 1;
      }
      return {
        width: w,
        height: h,
        tiles,
        spiceAmount,
        blocked,
        spawns: def.spawns,
        wormZones: def.wormZones || [],
        terrainDirty: true,
      };
    },

    tileAt(map, tx, ty) {
      if (!inBounds(map, tx, ty)) return T().CLIFF;
      return map.tiles[idx(map, tx, ty)];
    },

    setTile(map, tx, ty, id) {
      if (!inBounds(map, tx, ty)) return;
      map.tiles[idx(map, tx, ty)] = id;
      map.terrainDirty = true;
    },

    spiceAt(map, tx, ty) {
      if (!inBounds(map, tx, ty)) return 0;
      return map.spiceAmount[idx(map, tx, ty)];
    },

    setSpice(map, tx, ty, amount) {
      if (!inBounds(map, tx, ty)) return;
      const i = idx(map, tx, ty);
      map.spiceAmount[i] = Math.max(0, amount);
      if (map.spiceAmount[i] <= 0) {
        const t = map.tiles[i];
        if (t === T().SPICE || t === T().SPICE_HEAVY) {
          map.tiles[i] = T().SAND;
          map.terrainDirty = true;
        }
      }
    },

    isBuildableTerrain(map, tx, ty) {
      const t = D.Map.tileAt(map, tx, ty);
      return t === T().ROCK; // concrete overlays handled separately via buildings
    },

    isWalkable(map, tx, ty) {
      if (!inBounds(map, tx, ty)) return false;
      const i = idx(map, tx, ty);
      if (map.blocked[i]) return false;
      return map.tiles[i] !== T().CLIFF;
    },

    setBlocked(map, tx, ty, blocked) {
      if (!inBounds(map, tx, ty)) return;
      map.blocked[idx(map, tx, ty)] = blocked ? 1 : 0;
    },

    markBuildingBlocked(map, b, blocked) {
      for (let dy = 0; dy < b.tileH; dy++) {
        for (let dx = 0; dx < b.tileW; dx++) {
          D.Map.setBlocked(map, b.tileX + dx, b.tileY + dy, blocked);
        }
      }
    },

    rebuildBlocked(game) {
      const map = game.map;
      const n = map.width * map.height;
      map.blocked.fill(0);
      const cliff = T().CLIFF;
      for (let i = 0; i < n; i++) {
        if (map.tiles[i] === cliff) map.blocked[i] = 1;
      }
      for (const b of game.buildings) {
        if (b.type === 'concrete') continue; // concrete does not block
        D.Map.markBuildingBlocked(map, b, true);
      }
    },

    initFog(game) {
      const n = game.map.width * game.map.height;
      const owners =
        D.Seats && D.Seats.active
          ? D.Seats.active(game)
          : ['player', 'enemy'];
      game.fog = game.fog || {};
      for (const o of owners) {
        game.fog[o] = {
          explored: new Uint8Array(n),
          visible: new Uint8Array(n),
        };
      }
      // Always keep classic buckets for older code paths
      if (!game.fog.player) {
        game.fog.player = { explored: new Uint8Array(n), visible: new Uint8Array(n) };
      }
      if (!game.fog.enemy) {
        game.fog.enemy = { explored: new Uint8Array(n), visible: new Uint8Array(n) };
      }
    },

    stampSight(game, owner, cx, cy, radius) {
      if (radius <= 0) return;
      const fog = game.fog[owner];
      if (!fog) return;
      const map = game.map;
      const r = Math.ceil(radius);
      const r2 = radius * radius;
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const tx = x0 + dx;
          const ty = y0 + dy;
          if (!inBounds(map, tx, ty)) continue;
          const i = idx(map, tx, ty);
          fog.visible[i] = 1;
          fog.explored[i] = 1;
        }
      }
    },

    /** Sim FOW (combat/AI). Replay keeps this on for accurate re-sim. */
    fogEnabled(game) {
      return !!D.config.features.fog;
    },

    /**
     * View FOW (renderer/minimap). Off during replay / live spectate so both houses are visible.
     */
    fogVisible(game) {
      if (game && (game.replay || game.spectator)) return false;
      return !!D.config.features.fog;
    },

    recomputeFog(game, owner) {
      const fog = game.fog[owner];
      if (!fog) return;
      fog.visible.fill(0);

      if (!D.Map.fogEnabled(game)) {
        fog.visible.fill(1);
        fog.explored.fill(1);
        game._fogDrawDirty = true;
        return;
      }

      for (const u of game.units) {
        if (u.owner !== owner || u.hp <= 0) continue;
        const def = D.config.units[u.type];
        D.Map.stampSight(game, owner, u.x, u.y, def ? def.sight : 3);
      }
      for (const b of game.buildings) {
        if (b.owner !== owner || b.buildProgress < 1 || b.hp <= 0) continue;
        const def = D.config.buildings[b.type];
        // Always keep the footprint itself explored/visible for the owner
        // (so a lone gun turret is never lost under shroud).
        for (let dy = 0; dy < b.tileH; dy++) {
          for (let dx = 0; dx < b.tileW; dx++) {
            const tx = b.tileX + dx;
            const ty = b.tileY + dy;
            if (!inBounds(game.map, tx, ty)) continue;
            const i = idx(game.map, tx, ty);
            fog.visible[i] = 1;
            fog.explored[i] = 1;
          }
        }
        if (!def || def.sight <= 0) continue;
        const cx = b.tileX + b.tileW / 2;
        const cy = b.tileY + b.tileH / 2;
        D.Map.stampSight(game, owner, cx, cy, def.sight);
      }
      game._fogDrawDirty = true;
    },

    isVisible(game, owner, tx, ty) {
      // Callers that need spectator/full view should use fogVisible / shouldDraw*
      if (!D.Map.fogEnabled(game)) return true;
      const map = game.map;
      if (!inBounds(map, tx, ty)) return false;
      return !!(game.fog[owner] && game.fog[owner].visible[idx(map, tx, ty)] === 1);
    },

    isExplored(game, owner, tx, ty) {
      if (!D.Map.fogEnabled(game)) return true;
      const map = game.map;
      if (!inBounds(map, tx, ty)) return false;
      return !!(game.fog[owner] && game.fog[owner].explored[idx(map, tx, ty)] === 1);
    },

    /** Building footprint entirely on rock (or concrete tiles). */
    canPlace(game, type, tileX, tileY, owner, opts) {
      opts = opts || {};
      const def = D.config.buildings[type];
      if (!def) return false;
      const map = game.map;
      const w = def.tileW;
      const h = def.tileH;

      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const tx = tileX + dx;
          const ty = tileY + dy;
          if (!inBounds(map, tx, ty)) return false;
          const t = D.Map.tileAt(map, tx, ty);
          if (t !== T().ROCK) return false;
          // occupied by non-concrete building?
          if (D.Map.isTileOccupiedByBuilding(game, tx, ty, type === 'concrete')) {
            return false;
          }
        }
      }

      // proximity (first CY exempt)
      if (!opts.skipProximity) {
        const hasAny = game.buildings.some(
          (b) => b.owner === owner && b.buildProgress >= 1 && b.type !== 'concrete'
        );
        if (hasAny) {
          const prox = D.config.build.proximityTiles;
          const cx = tileX + w / 2;
          const cy = tileY + h / 2;
          let ok = false;
          for (const b of game.buildings) {
            if (b.owner !== owner || b.buildProgress < 1) continue;
            if (b.type === 'concrete') continue;
            const bx = b.tileX + b.tileW / 2;
            const by = b.tileY + b.tileH / 2;
            const d = Math.hypot(cx - bx, cy - by);
            if (d <= prox + Math.max(b.tileW, b.tileH)) {
              ok = true;
              break;
            }
          }
          if (!ok) return false;
        }
      }
      return true;
    },

    isTileOccupiedByBuilding(game, tx, ty, allowConcreteStack) {
      for (const b of game.buildings) {
        if (tx < b.tileX || ty < b.tileY) continue;
        if (tx >= b.tileX + b.tileW || ty >= b.tileY + b.tileH) continue;
        if (allowConcreteStack && b.type === 'concrete') continue;
        if (b.type === 'concrete' && allowConcreteStack) continue;
        // concrete under buildings: allow placing non-concrete on concrete
        if (b.type === 'concrete') {
          // another concrete? no
          return !allowConcreteStack;
        }
        return true;
      }
      return false;
    },

    hasConcreteUnder(game, tileX, tileY, tileW, tileH) {
      for (let dy = 0; dy < tileH; dy++) {
        for (let dx = 0; dx < tileW; dx++) {
          const tx = tileX + dx;
          const ty = tileY + dy;
          let found = false;
          for (const b of game.buildings) {
            if (b.type !== 'concrete' || b.buildProgress < 1) continue;
            if (b.tileX === tx && b.tileY === ty) {
              found = true;
              break;
            }
          }
          if (!found) return false;
        }
      }
      return true;
    },

    findNearestSpice(map, x, y) {
      let best = null;
      let bestD = Infinity;
      for (let ty = 0; ty < map.height; ty++) {
        for (let tx = 0; tx < map.width; tx++) {
          if (map.spiceAmount[idx(map, tx, ty)] > 0) {
            const d = (tx + 0.5 - x) * (tx + 0.5 - x) + (ty + 0.5 - y) * (ty + 0.5 - y);
            if (d < bestD) {
              bestD = d;
              best = { x: tx + 0.5, y: ty + 0.5, tx, ty };
            }
          }
        }
      }
      return best;
    },

    inBounds,
    idx,
  };
})(typeof window !== 'undefined' ? window : globalThis);
