'use strict';

const { loadGame } = require('./game-loader');
const recordings = require('./recordings');

const BASE_DT = 0.05; // 20 Hz — must match D.config.DT_SEC
const STATE_EVERY = 2;
/** Record a keyframe every N sim ticks (~0.5s at 1x). */
const RECORD_EVERY = 10;
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3];

/**
 * Server-authoritative skirmish for one room.
 * Both browser clients only send commands and render snapshots.
 */
class RoomSim {
  constructor(roomId, meta) {
    this.roomId = roomId;
    this.meta = meta || {};
    this.D = loadGame();
    this.game = null;
    this.timer = null;
    this.running = false;
    this.speed = 1;
    this.onState = null; // (payload, tick, extra) => void
    this.onEnd = null; // (phase, recordingMeta) => void
    this._recording = null;
    this._lastRecordTick = -999;
  }

  start() {
    if (this.running) return;
    const D = this.D;
    D.config.features.ai = false;
    D.config.features.debugCheats = false;

    this.game = D.Game.create();
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.game.localOwner = 'player';
    D.Game.startSkirmish(this.game, D.MAPS.skirmish1);
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.running = true;
    this.speed = 1;

    this._recording = {
      id: recordings.newId(),
      room: this.roomId,
      names: this.meta.names || {},
      startedAt: Date.now(),
      endedAt: 0,
      durationTicks: 0,
      phase: 'playing',
      baseDt: BASE_DT,
      frames: [],
    };
    this._lastRecordTick = -999;
    this._recordFrame(true);

    this._armTimer();
    this._broadcast(true);
  }

  _armTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const ms = Math.max(8, (BASE_DT * 1000) / this.speed);
    this.timer = setInterval(() => this._tick(), ms);
  }

  /**
   * @param {number} mult 0.5 | 1 | 1.5 | 2 | 3
   */
  setSpeed(mult) {
    const s = Number(mult);
    if (!SPEED_OPTIONS.includes(s)) return false;
    this.speed = s;
    this._armTimer();
    return true;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Finalize recording before dropping game
    if (this._recording && this.game) {
      this._recordFrame(true);
      this._recording.endedAt = Date.now();
      this._recording.durationTicks = this.game.tick;
      this._recording.phase = this.game.phase || 'unknown';
      try {
        recordings.save(this._recording);
      } catch (e) {
        console.warn('[room-sim] record save failed', e.message);
      }
    }
    this.game = null;
  }

  /** Current snapshot for reconnecting clients (null if not running). */
  snapshot() {
    if (!this.running || !this.game) return null;
    return this._serialize(false);
  }

  get tick() {
    return this.game ? this.game.tick : 0;
  }

  get phase() {
    return this.game ? this.game.phase : null;
  }

  get recordingId() {
    return this._recording ? this._recording.id : null;
  }

  _tick() {
    if (!this.running || !this.game) return;
    const D = this.D;
    if (this.game.phase !== 'playing') {
      this._broadcast(true);
      this._recordFrame(true);
      const phase = this.game.phase;
      const recId = this._recording && this._recording.id;
      if (this.onEnd) this.onEnd(phase, { recordingId: recId });
      this.stop();
      return;
    }
    // Always advance one fixed sim step; wall-clock rate comes from timer
    D.Game.tick(this.game, BASE_DT);
    this._recordFrame(false);
    this._broadcast(false);
  }

  _recordFrame(force) {
    if (!this._recording || !this.game) return;
    const t = this.game.tick;
    if (!force && t - this._lastRecordTick < RECORD_EVERY) return;
    this._lastRecordTick = t;
    const full = force || t === 0 || this._recording.frames.length === 0;
    const payload = this._serialize(!full);
    if (!payload) return;
    this._recording.frames.push({ tick: t, full: !!full, state: payload });
    // Cap runaway size (~30 min at 2 frames/s)
    if (this._recording.frames.length > 4000) {
      this._recording.frames.splice(1, 200); // drop early middles, keep start
    }
  }

  _broadcast(force) {
    if (!this.game || !this.onState) return;
    if (!force && this.game.tick % STATE_EVERY !== 0) return;
    const payload = this._serialize(false);
    if (payload) {
      this.onState(payload, this.game.tick, { speed: this.speed });
    }
  }

  /**
   * @param {boolean} thin - omit static map tiles (keep spice/blocked)
   */
  _serialize(thin) {
    const D = this.D;
    const data = D.Save.serialize(this.game);
    if (!data) return null;
    delete data.camera;
    delete data.selection;
    delete data.controlGroups;
    delete data.messages;
    if (thin && data.map) {
      // Replay keeps tiles from last full frame
      delete data.map.tiles;
    }
    // Fog is large; recompute on client from units
    if (data.fog) {
      // keep explored sticky only on full frames
      if (thin) delete data.fog;
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
    const owner = seat === 'enemy' ? 'enemy' : 'player';

    function ownedIds(ids) {
      const out = [];
      for (const id of ids || []) {
        const e = D.Entities.getById(game, id);
        if (e && e.owner === owner && e.hp > 0) out.push(id);
      }
      return out;
    }

    switch (payload.op) {
      case 'order': {
        const ids = ownedIds(payload.ids);
        if (!ids.length) return { ok: false, reason: 'ids' };
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
            return { ok: true, info: 'Construction Yard deployed.' };
          }
          if (fail) return { ok: false, reason: 'deploy' };
        }
        return { ok: true };
      }
      case 'stop': {
        const ids = ownedIds(payload.ids);
        if (!ids.length) return { ok: false, reason: 'ids' };
        D.Orders.stop(game, ids);
        return { ok: true };
      }
      case 'build': {
        return D.Economy.beginStructure(
          game,
          owner,
          payload.type,
          payload.tileX | 0,
          payload.tileY | 0
        );
      }
      case 'produce': {
        const b = game.buildings.find((x) => x.id === payload.buildingId);
        if (!b || b.owner !== owner) return { ok: false, reason: 'building' };
        return D.Economy.enqueueUnit(game, payload.buildingId, payload.unitType);
      }
      case 'cancelQueue': {
        const b = game.buildings.find((x) => x.id === payload.buildingId);
        if (!b || b.owner !== owner) return { ok: false, reason: 'building' };
        D.Economy.cancelQueue(game, payload.buildingId, payload.index | 0);
        return { ok: true };
      }
      case 'rally': {
        const b = game.buildings.find((x) => x.id === payload.buildingId);
        if (!b || b.owner !== owner) return { ok: false, reason: 'building' };
        D.Orders.setRally(game, payload.buildingId, payload.x, payload.y);
        return { ok: true };
      }
      default:
        return { ok: false, reason: 'unknown_op' };
    }
  }
}

RoomSim.SPEED_OPTIONS = SPEED_OPTIONS;
module.exports = { RoomSim, SPEED_OPTIONS };
