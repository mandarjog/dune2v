/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const SAVE_KEY = 'dune2_skirmish_v1';
  const SAVE_VERSION = 1;

  function arr(a) {
    if (!a) return null;
    return Array.from(a);
  }

  function u8(a, n) {
    const out = new Uint8Array(n);
    if (a) out.set(a.length === n ? a : a.slice(0, n));
    return out;
  }

  function f32(a, n) {
    const out = new Float32Array(n);
    if (a) out.set(a.length === n ? a : a.slice(0, n));
    return out;
  }

  D.Save = {
    key: SAVE_KEY,

    has() {
      try {
        return !!localStorage.getItem(SAVE_KEY);
      } catch (e) {
        return false;
      }
    },

    clear() {
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch (e) {
        /* ignore */
      }
    },

    serialize(game) {
      if (!game || !game.map || game.phase === 'menu') return null;
      const map = game.map;
      const n = map.width * map.height;
      return {
        v: SAVE_VERSION,
        savedAt: Date.now(),
        phase: game.phase === 'paused' ? 'playing' : game.phase,
        tick: game.tick,
        credits: { ...game.credits },
        spiceCap: { ...game.spiceCap },
        structureBuilder: { ...game.structureBuilder },
        camera: { ...game.camera },
        selection: { ids: game.selection.ids.slice() },
        controlGroups: JSON.parse(JSON.stringify(game.controlGroups)),
        ai: {
          state: game.ai.state,
          waveAt: game.ai.waveAt,
          lastScoutTick: game.ai.lastScoutTick,
          memory: JSON.parse(JSON.stringify(game.ai.memory || {})),
        },
        rngState: D.rng.getState(),
        features: {
          fog: D.config.features.fog,
          ai: D.config.features.ai,
        },
        map: {
          width: map.width,
          height: map.height,
          tiles: arr(map.tiles),
          spiceAmount: arr(map.spiceAmount),
          blocked: arr(map.blocked),
          spawns: map.spawns,
          wormZones: map.wormZones || [],
        },
        fog: game.fog
          ? {
              player: {
                explored: arr(game.fog.player.explored),
                visible: arr(game.fog.player.visible),
              },
              enemy: {
                explored: arr(game.fog.enemy.explored),
                visible: arr(game.fog.enemy.visible),
              },
            }
          : null,
        units: game.units.map((u) => ({
          id: u.id,
          type: u.type,
          owner: u.owner,
          x: u.x,
          y: u.y,
          hp: u.hp,
          hpMax: u.hpMax,
          facing: u.facing,
          order: u.order,
          orders: u.orders,
          path: u.path,
          weapon: u.weapon,
          cargo: u.cargo,
          cargoMax: u.cargoMax,
          harvest: u.harvest,
          sight: u.sight,
        })),
        buildings: game.buildings.map((b) => ({
          id: b.id,
          type: b.type,
          owner: b.owner,
          tileX: b.tileX,
          tileY: b.tileY,
          tileW: b.tileW,
          tileH: b.tileH,
          hp: b.hp,
          hpMax: b.hpMax,
          powered: b.powered,
          buildProgress: b.buildProgress,
          buildQueue: b.buildQueue,
          rallyX: b.rallyX,
          rallyY: b.rallyY,
          dockTileX: b.dockTileX,
          dockTileY: b.dockTileY,
          sight: b.sight,
          weapon: b.weapon,
          costPaid: b.costPaid,
        })),
        nextId: D.Entities.nextId(),
        messages: (game.messages || []).slice(0, 10),
      };
    },

    write(game) {
      const data = D.Save.serialize(game);
      if (!data) return false;
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
        return true;
      } catch (e) {
        console.warn('Save failed', e);
        return false;
      }
    },

    read() {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || data.v !== SAVE_VERSION) {
          D.Save.clear();
          return null;
        }
        return data;
      } catch (e) {
        D.Save.clear();
        return null;
      }
    },

    /** Multiplayer snapshot — same as serialize but no camera/selection. */
    serializeNet(game) {
      const data = D.Save.serialize(game);
      if (!data) return null;
      delete data.camera;
      delete data.selection;
      delete data.controlGroups;
      delete data.messages;
      return data;
    },

    /**
     * Apply server snapshot on a client. Keeps camera, selection, placement.
     * Patches in place when possible so we don't thrash terrain/UI every frame.
     */
    applyNetState(game, data, opts) {
      if (!data || !data.map) return false;
      const localOwner = (opts && opts.localOwner) || game.localOwner || 'player';
      const keepCam = game.camera ? { x: game.camera.x, y: game.camera.y } : null;
      const keepSel = game.selection ? game.selection.ids.slice() : [];
      const keepBox = game.selection ? game.selection.box : null;
      const keepGroups = game.controlGroups;
      const keepPlacement = game.placement;
      const keepHover = game.hoverTile;
      const firstLoad =
        !game.map ||
        game.map.width !== data.map.width ||
        game.map.height !== data.map.height;

      if (firstLoad) {
        if (!D.Save.loadInto(game, data)) return false;
      } else {
        D.Save._patchFromNet(game, data);
      }

      game.localOwner = localOwner;
      game.multiplayer = true;
      game._serverSim = false;

      if (keepCam && !firstLoad) {
        game.camera.x = keepCam.x;
        game.camera.y = keepCam.y;
      }
      // Keep selection across snapshots (ids only; drop dead/foreign)
      game.selection.ids = keepSel.filter((id) => {
        const e = D.Entities.getById(game, id);
        return e && e.hp > 0 && e.owner === localOwner;
      });
      // Preserve in-progress box select
      game.selection.box = keepBox;
      if (keepGroups) game.controlGroups = keepGroups;
      game.placement = keepPlacement;
      game.hoverTile = keepHover;

      return true;
    },

    /** In-place multiplayer patch (map already exists). */
    _patchFromNet(game, data) {
      const map = game.map;
      const n = map.width * map.height;

      // tiles / spice — only mark terrain dirty if tiles changed
      let tilesDirty = false;
      if (data.map.tiles) {
        const src = data.map.tiles;
        for (let i = 0; i < n; i++) {
          const v = src[i] | 0;
          if (map.tiles[i] !== v) {
            map.tiles[i] = v;
            tilesDirty = true;
          }
        }
      }
      if (data.map.spiceAmount) {
        const src = data.map.spiceAmount;
        for (let i = 0; i < n; i++) {
          const v = +src[i] || 0;
          if (map.spiceAmount[i] !== v) {
            map.spiceAmount[i] = v;
            // spice amount alone doesn't need full terrain atlas if tile type unchanged
          }
        }
      }
      if (data.map.blocked) {
        const src = data.map.blocked;
        for (let i = 0; i < n; i++) map.blocked[i] = src[i] | 0;
      } else {
        D.Map.rebuildBlocked(game);
      }
      if (tilesDirty) map.terrainDirty = true;

      game.phase =
        data.phase === 'victory' || data.phase === 'defeat' ? data.phase : 'playing';
      game.tick = data.tick || 0;
      if (data.credits) game.credits = data.credits;
      if (data.spiceCap) game.spiceCap = data.spiceCap;
      if (data.structureBuilder) game.structureBuilder = data.structureBuilder;
      if (data.rngState != null) D.rng.setState(data.rngState);

      if (data.fog) {
        if (!game.fog) D.Map.initFog(game);
        const copyFog = (side) => {
          if (!data.fog[side]) return;
          const exp = data.fog[side].explored;
          const vis = data.fog[side].visible;
          if (exp) {
            for (let i = 0; i < n; i++) game.fog[side].explored[i] = exp[i] | 0;
          }
          if (vis) {
            for (let i = 0; i < n; i++) game.fog[side].visible[i] = vis[i] | 0;
          }
        };
        copyFog('player');
        copyFog('enemy');
      }

      // Rebuild entity lists from snapshot (cheap vs full map recreate)
      game.buildings = [];
      game.units = [];
      let maxId = 1;
      for (const raw of data.buildings || []) {
        maxId = Math.max(maxId, raw.id + 1);
        const b = {
          id: raw.id,
          type: raw.type,
          owner: raw.owner,
          tileX: raw.tileX,
          tileY: raw.tileY,
          tileW: raw.tileW,
          tileH: raw.tileH,
          hp: raw.hp,
          hpMax: raw.hpMax,
          powered: raw.powered !== false,
          buildProgress: raw.buildProgress != null ? raw.buildProgress : 1,
          buildQueue: raw.buildQueue || [],
          rallyX: raw.rallyX,
          rallyY: raw.rallyY,
          dockTileX: raw.dockTileX,
          dockTileY: raw.dockTileY,
          primary: false,
          sight: raw.sight,
          weapon:
            raw.weapon ||
            (D.config.buildings[raw.type]?.weapon ? { cooldownLeft: 0 } : null),
          costPaid: raw.costPaid || 0,
        };
        if (b.weapon && b.weapon.cooldownLeft == null) b.weapon.cooldownLeft = 0;
        game.buildings.push(b);
      }
      for (const raw of data.units || []) {
        maxId = Math.max(maxId, raw.id + 1);
        const def = D.config.units[raw.type];
        const u = {
          id: raw.id,
          type: raw.type,
          owner: raw.owner,
          x: raw.x,
          y: raw.y,
          hp: raw.hp,
          hpMax: raw.hpMax || (def ? def.hp : 100),
          facing: raw.facing || 0,
          orders: raw.orders || (raw.order ? [raw.order] : []),
          order: raw.order || null,
          path: raw.path || [],
          weapon: raw.weapon || (def && def.weapon ? { cooldownLeft: 0 } : null),
          cargo: raw.cargo || 0,
          cargoMax: raw.cargoMax || (def && def.cargoMax) || 0,
          harvest: raw.harvest || null,
          sight: raw.sight || (def && def.sight) || 3,
          selected: false,
          repathQueued: false,
        };
        if (u.weapon && u.weapon.cooldownLeft == null) u.weapon.cooldownLeft = 0;
        game.units.push(u);
      }
      D.Entities.setNextId(Math.max(maxId, data.nextId || 1));

      // projectiles optional
      game.projectiles = (data.projectiles || []).map((p) => ({ ...p }));
      if (!data.map.blocked) D.Map.rebuildBlocked(game);
      D.Economy.tickPower(game);
      D.Economy.recalcSpiceCap(game);
    },

    /** Apply save into an existing game object. Returns true on success. */
    loadInto(game, data) {
      if (!data || !data.map) return false;
      D.Entities.resetIds();
      // restore id counter after entities created — set high water mark
      const mapDef = {
        width: data.map.width,
        height: data.map.height,
        tiles: data.map.tiles,
        spiceAmount: data.map.spiceAmount,
        spawns: data.map.spawns,
        wormZones: data.map.wormZones || [],
      };
      game.map = D.Map.createFromDef(mapDef);
      const n = game.map.width * game.map.height;
      if (data.map.blocked) {
        game.map.blocked = u8(data.map.blocked, n);
      } else {
        D.Map.rebuildBlocked(game);
      }
      game.map.terrainDirty = true;

      game.phase = data.phase === 'victory' || data.phase === 'defeat' ? data.phase : 'playing';
      game.tick = data.tick || 0;
      game.credits = data.credits || { player: 1000, enemy: 1000 };
      game.spiceCap = data.spiceCap || { player: 1000, enemy: 1000 };
      game.structureBuilder = data.structureBuilder || { player: null, enemy: null };
      game.camera = data.camera || { x: 0, y: 0 };
      game.selection = { ids: (data.selection && data.selection.ids) || [], box: null };
      game.controlGroups = data.controlGroups || game.controlGroups;
      game.ai = data.ai || { state: 'Bootstrap', waveAt: 0, lastScoutTick: 0, memory: {} };
      game.projectiles = [];
      game.fx = [];
      game.worms = [];
      game.placement = null;
      game.messages = data.messages || [];
      if (data.rngState != null) D.rng.setState(data.rngState);
      if (data.features) {
        if (data.features.fog != null) D.config.features.fog = data.features.fog;
        if (data.features.ai != null) D.config.features.ai = data.features.ai;
      }

      if (data.fog) {
        game.fog = {
          player: {
            explored: u8(data.fog.player.explored, n),
            visible: u8(data.fog.player.visible, n),
          },
          enemy: {
            explored: u8(data.fog.enemy.explored, n),
            visible: u8(data.fog.enemy.visible, n),
          },
        };
      } else {
        D.Map.initFog(game);
      }

      game.units = [];
      game.buildings = [];
      let maxId = 1;

      for (const raw of data.buildings || []) {
        maxId = Math.max(maxId, raw.id + 1);
        const b = {
          id: raw.id,
          type: raw.type,
          owner: raw.owner,
          tileX: raw.tileX,
          tileY: raw.tileY,
          tileW: raw.tileW,
          tileH: raw.tileH,
          hp: raw.hp,
          hpMax: raw.hpMax,
          powered: raw.powered !== false,
          buildProgress: raw.buildProgress != null ? raw.buildProgress : 1,
          buildQueue: raw.buildQueue || [],
          rallyX: raw.rallyX,
          rallyY: raw.rallyY,
          dockTileX: raw.dockTileX,
          dockTileY: raw.dockTileY,
          primary: false,
          sight: raw.sight,
          weapon: raw.weapon || (D.config.buildings[raw.type]?.weapon ? { cooldownLeft: 0 } : null),
          costPaid: raw.costPaid || 0,
        };
        if (b.weapon && b.weapon.cooldownLeft == null) b.weapon.cooldownLeft = 0;
        game.buildings.push(b);
      }

      for (const raw of data.units || []) {
        maxId = Math.max(maxId, raw.id + 1);
        const def = D.config.units[raw.type];
        const u = {
          id: raw.id,
          type: raw.type,
          owner: raw.owner,
          x: raw.x,
          y: raw.y,
          hp: raw.hp,
          hpMax: raw.hpMax || (def ? def.hp : 100),
          facing: raw.facing || 0,
          orders: raw.orders || (raw.order ? [raw.order] : []),
          order: raw.order || null,
          path: raw.path || [],
          weapon: raw.weapon || (def && def.weapon ? { cooldownLeft: 0 } : null),
          cargo: raw.cargo || 0,
          cargoMax: raw.cargoMax || (def && def.cargoMax) || 0,
          harvest: raw.harvest || null,
          sight: raw.sight || (def && def.sight) || 3,
          selected: false,
          repathQueued: false,
        };
        if (u.weapon && u.weapon.cooldownLeft == null) u.weapon.cooldownLeft = 0;
        game.units.push(u);
      }

      D.Entities.setNextId(Math.max(maxId, data.nextId || 1));

      D.Map.rebuildBlocked(game);
      D.Economy.tickPower(game);
      D.Economy.recalcSpiceCap(game);
      D.Map.recomputeFog(game, 'player');
      D.Map.recomputeFog(game, 'enemy');
      return true;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
