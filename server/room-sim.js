'use strict';

const { loadGame } = require('./game-loader');
const recordings = require('./recordings');

const BASE_DT = 0.05; // 20 Hz — must match D.config.DT_SEC
const STATE_EVERY = 2;
/** Record keyframe every N sim ticks (~1s at 1×). */
const RECORD_EVERY = 20;
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3];
/** Hard cap frames per match to protect disk/load. */
const MAX_FRAMES = 900;

/**
 * Server-authoritative skirmish for one room.
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
    this.onState = null;
    this.onEnd = null;
    this._rec = null;
    this._lastRecordTick = -999;
    this._frameCount = 0;
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
    this._frameCount = 0;

    this._rec = recordings.begin({
      room: this.roomId,
      names: this.meta.names || {},
      baseDt: BASE_DT,
    });
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
    const ms = Math.max(10, (BASE_DT * 1000) / this.speed);
    this.timer = setInterval(() => this._tick(), ms);
  }

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
    let info = null;
    if (this._rec) {
      info = recordings.finish(
        this._rec,
        this.game ? this.game.phase : 'unknown',
        this.game ? this.game.tick : 0
      );
      this._rec = null;
    }
    this.game = null;
    return info;
  }

  snapshot() {
    if (!this.running || !this.game) return null;
    return this._serializeLive();
  }

  get tick() {
    return this.game ? this.game.tick : 0;
  }

  get phase() {
    return this.game ? this.game.phase : null;
  }

  get recordingId() {
    return this._rec ? this._rec.id : null;
  }

  _tick() {
    if (!this.running || !this.game) return;
    const D = this.D;
    if (this.game.phase !== 'playing') {
      this._broadcast(true);
      this._recordFrame(true);
      const phase = this.game.phase;
      const recId = this.recordingId;
      if (this.onEnd) this.onEnd(phase, { recordingId: recId });
      this.stop();
      return;
    }
    D.Game.tick(this.game, BASE_DT);
    this._recordFrame(false);
    this._broadcast(false);
  }

  _recordFrame(force) {
    if (!this._rec || !this.game) return;
    if (this._frameCount >= MAX_FRAMES && !force) return;
    const t = this.game.tick;
    if (!force && t - this._lastRecordTick < RECORD_EVERY) return;
    this._lastRecordTick = t;
    const full = force || this._frameCount === 0;
    const payload = this._serializeRecord(full);
    if (!payload) return;
    recordings.appendFrame(this._rec, { tick: t, full: !!full, state: payload });
    this._frameCount++;
  }

  _broadcast(force) {
    if (!this.game || !this.onState) return;
    if (!force && this.game.tick % STATE_EVERY !== 0) return;
    const payload = this._serializeLive();
    if (payload) this.onState(payload, this.game.tick, { speed: this.speed });
  }

  /** Live net snapshot — keep lean (no fog; client recomputes). */
  _serializeLive() {
    const D = this.D;
    const data = D.Save.serialize(this.game);
    if (!data) return null;
    delete data.camera;
    delete data.selection;
    delete data.controlGroups;
    delete data.messages;
    delete data.fog;
    // Paths bloat JSON; clients don't need them for rendering
    if (data.units) {
      for (const u of data.units) {
        delete u.path;
        delete u.orders;
      }
    }
    return data;
  }

  /**
   * Recording snapshot — even leaner on thin frames.
   * @param {boolean} full include map tiles
   */
  _serializeRecord(full) {
    const data = this._serializeLive();
    if (!data) return null;
    if (!full && data.map) {
      delete data.map.tiles;
      // spice still useful for visual
    }
    // Drop projectiles/fx on thin frames to save space (optional keep)
    if (!full) {
      data.projectiles = [];
      data.fx = [];
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
