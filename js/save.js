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
        // FFA / MP: required for correct win/loss + replay re-sim
        winner: game.winner != null ? game.winner : null,
        activeOwners: (game.activeOwners || ['player', 'enemy']).slice(),
        eliminated: game.eliminated ? { ...game.eliminated } : {},
        playerNames: game.playerNames ? { ...game.playerNames } : null,
        // Recent alerts (under attack / elim) for MP clients
        alerts: (game.alerts || []).slice(-8),
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
          stuck: !!u.stuck,
          stuckReason: u.stuckReason || null,
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
        // IMPORTANT: use peek — nextId() increments and burned an ID on every
        // MP snapshot (~every 2 ticks), desyncing recorded entity ids vs replay.
        nextId: D.Entities.peekNextId
          ? D.Entities.peekNextId()
          : D.Entities.nextId(),
        messages: (game.messages || []).slice(0, 10),
        // Combat visuals — required for multiplayer clients (turret shells, tracers)
        projectiles: (game.projectiles || []).map((p) => ({
          id: p.id,
          x: p.x,
          y: p.y,
          tx: p.tx,
          ty: p.ty,
          targetId: p.targetId,
          speed: p.speed,
          weapon: p.weapon,
          owner: p.owner,
          life: p.life,
          kind: p.kind,
          fromTurret: !!p.fromTurret,
        })),
        fx: (game.fx || []).map((f) => ({
          type: f.type,
          x: f.x,
          y: f.y,
          x0: f.x0,
          y0: f.y0,
          x1: f.x1,
          y1: f.y1,
          life: f.life,
          r: f.r,
          color: f.color,
          owner: f.owner,
        })),
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
      const roomId = opts && opts.roomId != null ? opts.roomId : null;
      const roomChanged =
        !!(roomId && game._fogRoomId && game._fogRoomId !== roomId);
      // Rejoin / new room / full map: rebuild world so fog from a prior match
      // does not leave half the map "explored" under FOW.
      const forceReload =
        !!(opts && (opts.resetFog || opts.reconnected || opts.fullMap)) || roomChanged;
      const firstLoad =
        forceReload ||
        !game.map ||
        game.map.width !== data.map.width ||
        game.map.height !== data.map.height ||
        // Lean snapshots omit tiles — only firstLoad when we actually have tiles
        (!game.map && !data.map.tiles);

      // Snapshot stuck flags before replace (for MP toast on client)
      const prevStuck = {};
      if (game.units) {
        for (const u of game.units) {
          if (u.owner === localOwner) {
            prevStuck[u.id] = { stuck: !!u.stuck, reason: u.stuckReason || null };
          }
        }
      }

      // Need tiles for a true reload; otherwise patch entities only
      if (firstLoad && data.map.tiles) {
        if (!D.Save.loadInto(game, data)) return false;
      } else if (!game.map && !data.map.tiles) {
        return false;
      } else {
        D.Save._patchFromNet(game, data);
      }

      game.localOwner = localOwner;
      game.multiplayer = true;
      game._serverSim = false;

      // FFA metadata (may be missing on very old servers)
      if (data.activeOwners && data.activeOwners.length) {
        game.activeOwners = data.activeOwners.slice();
      }
      if (data.winner !== undefined) game.winner = data.winner;
      if (data.eliminated) game.eliminated = { ...data.eliminated };
      if (data.playerNames) game.playerNames = { ...data.playerNames };
      if (data.alerts) game.alerts = data.alerts.slice();

      if (keepCam && !(firstLoad && data.map.tiles)) {
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
      if (keepGroups && !(opts && opts.reconnected)) game.controlGroups = keepGroups;
      game.placement = keepPlacement;
      game.hoverTile = keepHover;

      // Live MP snapshots omit fog arrays. Always rebuild vision from units.
      // Wipe explored when room changes / rejoin so prior match FOW cannot leak.
      if (!game.fog || forceReload || (opts && opts.resetFog)) {
        D.Map.initFog(game);
      }
      if (roomId) game._fogRoomId = roomId;
      const owners =
        D.Seats && D.Seats.active
          ? D.Seats.active(game)
          : ['player', 'enemy'];
      for (const o of owners) {
        D.Map.recomputeFog(game, o);
      }

      // Stuck glow is on the unit; explain why in the message log (server can't toast)
      if (D.Orders && D.Orders.announceStuckFromNet) {
        D.Orders.announceStuckFromNet(game, localOwner, prevStuck);
      }

      return true;
    },

    /** In-place multiplayer patch (map already exists). */
    _patchFromNet(game, data) {
      const map = game.map;
      const n = map.width * map.height;

      // tiles / spice — optional on lean MP snapshots (map already loaded)
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
      } else if (data.map.tiles) {
        // Only rebuild blocked when we received a full tile payload
        D.Map.rebuildBlocked(game);
      }
      if (tilesDirty) map.terrainDirty = true;

      // Accept neutral 'ended' from FFA server; never invent victory from host seat
      if (
        data.phase === 'victory' ||
        data.phase === 'defeat' ||
        data.phase === 'draw' ||
        data.phase === 'ended'
      ) {
        game.phase = data.phase;
      } else {
        game.phase = 'playing';
      }
      game.tick = data.tick || 0;
      if (data.winner !== undefined) game.winner = data.winner;
      if (data.activeOwners && data.activeOwners.length) {
        game.activeOwners = data.activeOwners.slice();
      }
      if (data.eliminated) game.eliminated = { ...data.eliminated };
      if (data.playerNames) game.playerNames = { ...data.playerNames };
      if (data.alerts) game.alerts = data.alerts.slice();
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
          stuck: !!raw.stuck,
          stuckReason: raw.stuckReason || null,
        };
        if (u.weapon && u.weapon.cooldownLeft == null) u.weapon.cooldownLeft = 0;
        game.units.push(u);
      }
      D.Entities.setNextId(Math.max(maxId, data.nextId || 1));

      game.projectiles = (data.projectiles || []).map((p) => ({ ...p }));
      game.fx = (data.fx || []).map((f) => ({ ...f }));
      if (!data.map.blocked) D.Map.rebuildBlocked(game);
      D.Economy.tickPower(game);
      D.Economy.recalcSpiceCap(game);
    },

    /**
     * Apply a mid-match replay keyframe: keep terrain, replace entities/economy.
     * Used so cmd-stream re-sim cannot drift for an entire match.
     */
    applyReplayKeyframe(game, data) {
      if (!game || !game.map || !data) return false;
      const map = game.map;
      const n = map.width * map.height;

      if (data.tick != null) game.tick = data.tick | 0;
      if (data.winner !== undefined) game.winner = data.winner;
      if (data.activeOwners && data.activeOwners.length) {
        game.activeOwners = data.activeOwners.slice();
      }
      if (data.eliminated) game.eliminated = { ...data.eliminated };
      else game.eliminated = {};
      if (data.playerNames) game.playerNames = { ...data.playerNames };
      if (D.Seats && D.Seats.ensureBuckets) {
        D.Seats.ensureBuckets(game, game.activeOwners);
      }
      // After ensureBuckets so seat credit buckets are not wiped
      if (data.credits) {
        for (const k of Object.keys(data.credits)) {
          game.credits[k] = data.credits[k];
        }
      }
      if (data.spiceCap) {
        for (const k of Object.keys(data.spiceCap)) {
          game.spiceCap[k] = data.spiceCap[k];
        }
      }
      if (data.structureBuilder) {
        for (const k of Object.keys(data.structureBuilder)) {
          game.structureBuilder[k] = data.structureBuilder[k];
        }
      }
      if (data.rngState != null) D.rng.setState(data.rngState);

      if (data.map && data.map.spiceAmount && map.spiceAmount) {
        const src = data.map.spiceAmount;
        const len = Math.min(n, src.length);
        for (let i = 0; i < len; i++) map.spiceAmount[i] = +src[i] || 0;
      }

      game.buildings = [];
      game.units = [];
      game.projectiles = [];
      game.fx = [];
      let maxId = 1;

      for (const raw of data.buildings || []) {
        maxId = Math.max(maxId, (raw.id | 0) + 1);
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
        maxId = Math.max(maxId, (raw.id | 0) + 1);
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
          path: [],
          weapon: raw.weapon || (def && def.weapon ? { cooldownLeft: 0 } : null),
          cargo: raw.cargo || 0,
          cargoMax: raw.cargoMax || (def && def.cargoMax) || 0,
          harvest: raw.harvest || null,
          sight: raw.sight || (def && def.sight) || 3,
          selected: false,
          repathQueued: false,
          stuck: !!raw.stuck,
          stuckReason: raw.stuckReason || null,
        };
        if (u.weapon && u.weapon.cooldownLeft == null) u.weapon.cooldownLeft = 0;
        game.units.push(u);
      }

      D.Entities.setNextId(Math.max(maxId, data.nextId || 1));
      D.Map.rebuildBlocked(game);
      D.Economy.tickPower(game);
      // Do not recalcSpiceCap from buildings only — keyframe spiceCap is authoritative
      if (!game.fog) D.Map.initFog(game);
      const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
      for (const o of owners) D.Map.recomputeFog(game, o);
      game._fogDrawDirty = true;
      return true;
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

      if (
        data.phase === 'victory' ||
        data.phase === 'defeat' ||
        data.phase === 'draw' ||
        data.phase === 'ended'
      ) {
        game.phase = data.phase;
      } else {
        game.phase = 'playing';
      }
      game.tick = data.tick || 0;
      game.winner = data.winner != null ? data.winner : null;
      game.activeOwners =
        data.activeOwners && data.activeOwners.length
          ? data.activeOwners.slice()
          : game.activeOwners || ['player', 'enemy'];
      game.eliminated = data.eliminated ? { ...data.eliminated } : {};
      game.playerNames = data.playerNames ? { ...data.playerNames } : game.playerNames || null;
      game.alerts = data.alerts ? data.alerts.slice() : [];
      game.credits = data.credits || { player: 1000, enemy: 1000 };
      game.spiceCap = data.spiceCap || { player: 1000, enemy: 1000 };
      game.structureBuilder = data.structureBuilder || { player: null, enemy: null };
      game.camera = data.camera || { x: 0, y: 0 };
      game.selection = { ids: (data.selection && data.selection.ids) || [], box: null };
      game.controlGroups = data.controlGroups || game.controlGroups;
      game.ai = data.ai || { state: 'Bootstrap', waveAt: 0, lastScoutTick: 0, memory: {} };
      game.projectiles = (data.projectiles || []).map((p) => ({ ...p }));
      game.fx = (data.fx || []).map((f) => ({ ...f }));
      game.worms = [];
      game.placement = null;
      game.messages = data.messages || [];
      if (data.rngState != null) D.rng.setState(data.rngState);
      if (D.Seats && D.Seats.ensureBuckets) {
        D.Seats.ensureBuckets(game, game.activeOwners);
      }
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
          stuck: !!raw.stuck,
          stuckReason: raw.stuckReason || null,
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
