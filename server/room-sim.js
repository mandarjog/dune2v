'use strict';

const { loadGame } = require('./game-loader');
const recordings = require('./recordings');

const BASE_DT = 0.05; // 20 Hz — must match D.config.DT_SEC
const STATE_EVERY = 2;
/** When armies get huge, send snapshots less often to keep WS + JSON cheap. */
const STATE_EVERY_LARGE = 3;
/** 3+ player FFA: leaner net rate (serialize is expensive on shared-1-CPU Fly). */
const STATE_EVERY_FFA = 3;
const STATE_EVERY_FFA_LARGE = 4;
const LARGE_UNIT_THRESHOLD = 80;
const FFA_UNIT_THRESHOLD = 36;
/** Cmd-stream re-sim drifts; keyframes re-sync entities every ~15s of sim time. */
const KEYFRAME_EVERY = 300; // 300 ticks × 0.05s = 15s
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3];
const DEFAULT_SPEED = 2;

/**
 * Server-authoritative skirmish.
 * Recordings = init map/state once + command stream (tiny).
 */
class RoomSim {
  constructor(roomId, meta) {
    this.roomId = roomId;
    this.meta = meta || {};
    this.D = loadGame();
    this.game = null;
    this.timer = null;
    this.running = false;
    this.speed = DEFAULT_SPEED;
    this.onState = null;
    this.onEnd = null;
    this._rec = null;
    /** After first full map blob, omit tiles/spice from live snapshots. */
    this._mapSent = false;
    this.paused = false;
    this._pauseReason = null;
  }

  start() {
    if (this.running) return;
    const D = this.D;
    D.config.features.ai = false;
    D.config.features.debugCheats = false;
    // Worms on for MP (was disabled on shared-1-CPU; performance-1x can handle it).
    // Keep live + cmd-stream replay consistent — both must run the same flag.
    D.config.features.sandworms = true;
    if (D.config.worms) D.config.worms.enabled = true;
    if (D.config.path) {
      // Prefer A* for small squads; bounded flow for 5+ (see pathfinding.js)
      D.config.path.flowMinGroup = Math.max(5, D.config.path.flowMinGroup || 5);
      D.config.path.flowCacheMs = Math.max(3500, D.config.path.flowCacheMs || 3500);
      // Tight flow bounds on server only (shared/small CPU) — SP stays loose
      D.config.path.flowTightBounds = true;
      D.config.path.maxRepathsPerTickMp = Math.min(
        12,
        D.config.path.maxRepathsPerTickMp || 12
      );
    }
    // Random map per match (or fixed seed when replaying / meta.seed set)
    const seed =
      this.meta.seed != null
        ? this.meta.seed >>> 0
        : ((Math.random() * 0x7fffffff) | 0) >>> 0;
    this.seed = seed;
    D.config.seed = seed;

    this.game = D.Game.create();
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.game.localOwner = 'player';
    const owners =
      this.meta.owners && this.meta.owners.length
        ? this.meta.owners
        : ['player', 'enemy'];
    const mapDef =
      D.MAPS.generateSkirmishLarge
        ? D.MAPS.generateSkirmishLarge(seed)
        : D.MAPS.skirmish_large || D.MAPS.skirmish1;
    D.Game.startSkirmish(this.game, mapDef, {
      owners,
      names: this.meta.names || null,
      startMode: this.meta.startMode === 'mcv' ? 'mcv' : 'base',
      seed,
      forceGenerate: false, // already generated above
      generateMap: false,
    });
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.game.rngSeed = seed;
    this.running = true;
    this.speed = DEFAULT_SPEED;
    this.game.netSpeed = DEFAULT_SPEED;

    this._rec = recordings.begin({
      room: this.roomId,
      names: this.meta.names || {},
      owners: owners.slice(),
      baseDt: BASE_DT,
      seed: seed,
      // So Watch replay uses the same worm setting as the live match
      sandworms: !!(D.config.features && D.config.features.sandworms),
    });
    // One full init snapshot (map + starting units) — not per-frame dumps
    const initState = this._serializeInit();
    if (initState) {
      initState.activeOwners = owners.slice();
      initState.playerNames = this.meta.names || null;
    }
    recordings.appendEvent(this._rec, {
      t: 0,
      type: 'init',
      state: initState,
    });
    // Persist meta so list() shows in-progress matches with owners
    if (this._rec) recordings.touchMeta(this._rec);

    this._armTimer();
    this._broadcast(true);
  }

  _armTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.running || this.paused) return;
    const ms = Math.max(10, (BASE_DT * 1000) / this.speed);
    // Skip ticks if previous still running (shared CPU) — better slow than stalled queue
    this.timer = setInterval(() => {
      if (this._ticking) {
        this._skippedTicks = (this._skippedTicks || 0) + 1;
        return;
      }
      this._ticking = true;
      try {
        this._tick();
      } finally {
        this._ticking = false;
      }
    }, ms);
  }

  /**
   * Pause wall-clock ticks (room empty / abandoned). Keeps game state for reconnect.
   * Critical on single-machine hosts: two abandoned sims will starve the live match.
   */
  pause(reason) {
    if (this.paused) return;
    this.paused = true;
    this._pauseReason = reason || 'empty';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Resume ticks after a player reconnects. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._pauseReason = null;
    if (this.running) this._armTimer();
  }

  get isPaused() {
    return !!this.paused;
  }

  setSpeed(mult) {
    const s = Number(mult);
    if (!SPEED_OPTIONS.includes(s)) return false;
    this.speed = s;
    if (this._rec) {
      recordings.appendEvent(this._rec, {
        t: this.game ? this.game.tick : 0,
        type: 'speed',
        speed: s,
      });
    }
    this._armTimer();
    return true;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    let info = null;
    if (this._rec) {
      const endPhase = this.game ? this.game.phase || 'unknown' : 'unknown';
      const endWinner = this.game && this.game.winner != null ? this.game.winner : null;
      if (this.game) {
        // Winner is required for correct replay end UI (phase alone is host-neutral
        // "ended"/"draw" and used to make every Watch look like a draw or flip seats).
        recordings.appendEvent(this._rec, {
          t: this.game.tick,
          type: 'end',
          phase: endPhase,
          winner: endWinner,
        });
      }
      info = recordings.finish(
        this._rec,
        endPhase,
        this.game ? this.game.tick : 0,
        { winner: endWinner }
      );
      this._lastRecordingId = (info && info.id) || this._rec.id;
      this._rec = null;
    }
    this.game = null;
    return info;
  }

  /**
   * @param {{ fullMap?: boolean }} [opts] fullMap forces tiles/spice (reconnect / rejoin)
   */
  snapshot(opts) {
    if (!this.running || !this.game) return null;
    if (opts && opts.fullMap) {
      const was = this._mapSent;
      this._mapSent = false;
      const data = this._serializeLive();
      // Keep lean snapshots for everyone else after this one-off full send
      this._mapSent = true;
      if (!data) this._mapSent = was;
      return data;
    }
    return this._serializeLive();
  }

  get tick() {
    return this.game ? this.game.tick : 0;
  }

  get phase() {
    return this.game ? this.game.phase : null;
  }

  get recordingId() {
    return this._rec ? this._rec.id : this._lastRecordingId || null;
  }

  _tick() {
    if (!this.running || !this.game) return;
    const D = this.D;
    // Match over: victory | defeat | ended (FFA) | draw
    if (this.game.phase !== 'playing') {
      this._broadcast(true);
      const phase = this.game.phase === 'ended' ? 'ended' : this.game.phase;
      // Finish recording first so /api/recordings/:id is ready when clients open Watch
      const winner = this.game.winner || null;
      const info = this.stop();
      const recId = (info && info.id) || this._lastRecordingId || null;
      if (this.onEnd) this.onEnd(phase, { recordingId: recId, winner });
      return;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    D.Game.tick(this.game, BASE_DT);
    const simMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this._lastSimMs = simMs;
    // Budget at 2× is ~25ms/tick; log when we blow it (path + fog + combat)
    if (simMs >= 20 && this.game.tick % 40 === 0) {
      const nU = this.game.units ? this.game.units.length : 0;
      const nB = this.game.buildings ? this.game.buildings.length : 0;
      const owners =
        (this.game.activeOwners && this.game.activeOwners.length) || 2;
      console.log(
        `[perf] room=${this.roomId} tick=${this.game.tick} simMs=${simMs.toFixed(1)} ` +
          `units=${nU} bld=${nB} owners=${owners} speed=${this.speed} ` +
          `pathTick=${(this.game.stats && this.game.stats.pathTickMs) || 0} ` +
          `skipped=${this._skippedTicks || 0}`
      );
      this._skippedTicks = 0;
    }
    // Periodic entity keyframes so Watch/replay does not butterfly-effect for an hour
    // Skip keyframe on already-slow ticks (serialize is heavy)
    if (
      this._rec &&
      this.game.tick > 0 &&
      this.game.tick % KEYFRAME_EVERY === 0 &&
      simMs < 30
    ) {
      const kf = this._serializeKeyframe();
      if (kf) {
        recordings.appendEvent(this._rec, {
          t: this.game.tick,
          type: 'keyframe',
          state: kf,
        });
      }
    }
    this._broadcast(false);
  }

  _broadcast(force) {
    if (!this.game || !this.onState) return;
    const nU = this.game.units ? this.game.units.length : 0;
    const nOwners =
      (this.game.activeOwners && this.game.activeOwners.length) || 2;
    let every = STATE_EVERY;
    if (nOwners >= 3) {
      every = nU >= FFA_UNIT_THRESHOLD ? STATE_EVERY_FFA_LARGE : STATE_EVERY_FFA;
    } else if (nU >= LARGE_UNIT_THRESHOLD) {
      every = STATE_EVERY_LARGE;
    }
    if (!force && this.game.tick % every !== 0) return;
    const payload = this._serializeLive();
    if (payload) this.onState(payload, this.game.tick, { speed: this.speed });
  }

  /** Init blob for recording — map once + entities (no ephemeral VFX). */
  _serializeInit() {
    const D = this.D;
    const data = D.Save.serialize(this.game);
    if (!data) return null;
    delete data.camera;
    delete data.selection;
    delete data.controlGroups;
    delete data.messages;
    delete data.fog;
    if (data.units) {
      for (const u of data.units) {
        delete u.path;
        delete u.orders;
      }
    }
    // Cmd-stream replay re-sims combat; keep init tiny
    data.projectiles = [];
    data.fx = [];
    return data;
  }

  /**
   * Mid-match resync blob for replay — entities/economy/spice, no terrain tiles.
   * Replay keeps init map and snaps units/buildings/credits back to server truth.
   */
  _serializeKeyframe() {
    const D = this.D;
    const data = D.Save.serialize(this.game);
    if (!data) return null;
    delete data.camera;
    delete data.selection;
    delete data.controlGroups;
    delete data.messages;
    delete data.fog;
    delete data.ai;
    if (data.map) {
      // Keep spice (harvest desync is a big visual drift); drop huge static arrays
      delete data.map.tiles;
      delete data.map.blocked;
      delete data.map.spawns;
      delete data.map.wormZones;
    }
    if (data.units) {
      for (const u of data.units) {
        delete u.path;
        // Keep order/harvest so harvesters resume correctly after snap
      }
    }
    data.projectiles = [];
    data.fx = [];
    return data;
  }

  /**
   * Live net snapshot for clients. Includes projectiles/fx so shells are visible
   * in MP (clients do not run combat). Still omits fog/paths for bandwidth.
   * After the first full map, skip tiles/spice arrays (~100KB+) — clients keep local map.
   */
  _serializeLive() {
    const D = this.D;
    const data = D.Save.serialize(this.game);
    if (!data) return null;
    delete data.camera;
    delete data.selection;
    delete data.controlGroups;
    delete data.messages;
    delete data.fog;
    if (data.units) {
      for (const u of data.units) {
        delete u.path;
        delete u.orders;
      }
    }
    // Cap VFX lists so a huge volley cannot bloat the wire
    if (data.projectiles && data.projectiles.length > 80) {
      data.projectiles = data.projectiles.slice(-80);
    }
    if (data.fx && data.fx.length > 40) {
      data.fx = data.fx.slice(-40);
    }
    // Map terrain is huge; only send once (or when explicitly forced via full serialize)
    if (this._mapSent && data.map) {
      // Keep dimensions / spawns; drop bulk arrays. Spice harvest still needs occasional updates.
      const spice = data.map.spiceAmount;
      delete data.map.tiles;
      delete data.map.blocked;
      // Send spice every ~2s so harvest is visible (40 ticks @ 20Hz)
      if (this.game && this.game.tick % 40 !== 0) {
        delete data.map.spiceAmount;
      } else if (spice) {
        data.map.spiceAmount = spice;
      }
    } else {
      this._mapSent = true;
    }
    return data;
  }

  applyCommand(seat, payload) {
    if (!this.running || !this.game || !payload || !payload.op) {
      return { ok: false, reason: 'not_running' };
    }
    if (this.game.phase !== 'playing') return { ok: false, reason: 'ended' };

    const D = this.D;
    const game = this.game;
    const owner =
      D.Seats && D.Seats.isSeat(seat)
        ? seat
        : seat === 'enemy'
          ? 'enemy'
          : 'player';
    // Eliminated FFA seats cannot order (still receive state / chat)
    if (game.eliminated && game.eliminated[owner] != null) {
      return { ok: false, reason: 'eliminated' };
    }
    const tickAt = game.tick;

    function ownedIds(ids) {
      const out = [];
      for (const id of ids || []) {
        const e = D.Entities.getById(game, id);
        if (e && e.owner === owner && e.hp > 0) out.push(id);
      }
      return out;
    }

    let result = { ok: false, reason: 'unknown' };

    switch (payload.op) {
      case 'order': {
        const ids = ownedIds(payload.ids);
        if (!ids.length) {
          result = { ok: false, reason: 'ids' };
          break;
        }
        const order = payload.order || { type: 'stop' };
        D.Orders.issue(game, ids, order);
        if (order.type === 'deploy') {
          let any = false;
          let fail = false;
          for (const id of ids) {
            const u = game.units.find((x) => x.id === id);
            if (!u || u.type !== 'mcv') continue;
            if (D.Orders.tryDeploy(game, u)) any = true;
            else fail = true;
          }
          if (any) {
            this._broadcast(true);
            result = { ok: true, info: 'Construction Yard deployed.' };
            break;
          }
          if (fail) {
            result = {
              ok: false,
              reason: 'deploy',
              message:
                'Cannot deploy — need a clear 2×2 rock pad under/near the MCV (move fully onto rock).',
            };
            break;
          }
        }
        if (order.type === 'detonate') {
          let any = false;
          for (const id of ids) {
            const u = game.units.find((x) => x.id === id);
            if (!u || u.type !== 'saboteur') continue;
            if (D.Orders.tryDetonate(game, u)) any = true;
          }
          if (any) {
            this._broadcast(true);
            result = { ok: true, info: 'Saboteur detonated!' };
          } else {
            result = { ok: false, reason: 'detonate' };
          }
          break;
        }
        result = { ok: true };
        break;
      }
      case 'stop': {
        const ids = ownedIds(payload.ids);
        if (!ids.length) {
          result = { ok: false, reason: 'ids' };
          break;
        }
        D.Orders.stop(game, ids);
        result = { ok: true };
        break;
      }
      case 'build': {
        result = D.Economy.beginStructure(
          game,
          owner,
          payload.type,
          payload.tileX | 0,
          payload.tileY | 0
        );
        break;
      }
      case 'produce': {
        const b = game.buildings.find((x) => x.id === payload.buildingId);
        if (!b || b.owner !== owner) {
          result = { ok: false, reason: 'building' };
          break;
        }
        result = D.Economy.enqueueUnit(game, payload.buildingId, payload.unitType);
        break;
      }
      case 'cancelQueue': {
        const b = game.buildings.find((x) => x.id === payload.buildingId);
        if (!b || b.owner !== owner) {
          result = { ok: false, reason: 'building' };
          break;
        }
        D.Economy.cancelQueue(game, payload.buildingId, payload.index | 0);
        result = { ok: true };
        break;
      }
      case 'rally': {
        const b = game.buildings.find((x) => x.id === payload.buildingId);
        if (!b || b.owner !== owner) {
          result = { ok: false, reason: 'building' };
          break;
        }
        D.Orders.setRally(game, payload.buildingId, payload.x, payload.y);
        result = { ok: true };
        break;
      }
      default:
        result = { ok: false, reason: 'unknown_op' };
    }

    // Log successful cmds (and deploy attempts that applied an order)
    if (this._rec && result && result.ok) {
      // Strip heavy fields; keep op payload only
      const slim = JSON.parse(JSON.stringify(payload));
      recordings.appendEvent(this._rec, {
        t: tickAt,
        type: 'cmd',
        seat,
        payload: slim,
      });
    }

    // Path batch cost from Orders.issue (server-side visibility for big moves)
    if (
      result &&
      result.ok &&
      payload.op === 'order' &&
      game.stats &&
      game.stats.pathLastIssueCount > 0
    ) {
      const ms = game.stats.pathLastIssueMs || 0;
      const n = game.stats.pathLastIssueCount || 0;
      if (ms >= 15 || n >= 40) {
        const via = game.stats.pathLastBackend || '?';
        const flowB = game.stats.pathLastFlowBuildMs || 0;
        console.log(
          `[path] room=${this.roomId} seat=${owner} issue ${n} via=${via} ${ms.toFixed(2)}ms` +
            (via === 'flow' ? ` (field ${flowB.toFixed(2)}ms)` : '') +
            ` ok=${game.stats.pathLastIssueOk || 0}`
        );
      }
    }

    return result;
  }
}

RoomSim.SPEED_OPTIONS = SPEED_OPTIONS;
module.exports = { RoomSim, SPEED_OPTIONS };
