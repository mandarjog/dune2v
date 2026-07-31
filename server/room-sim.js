'use strict';

const { loadGame } = require('./game-loader');
const recordings = require('./recordings');

const BASE_DT = 0.05; // 20 Hz — must match D.config.DT_SEC
const STATE_EVERY = 2;
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3];

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
    this.speed = 1;
    this.onState = null;
    this.onEnd = null;
    this._rec = null;
  }

  start() {
    if (this.running) return;
    const D = this.D;
    D.config.features.ai = false;
    D.config.features.debugCheats = false;
    // Fixed seed for deterministic re-sim replay
    if (D.config.seed == null) D.config.seed = 42;

    this.game = D.Game.create();
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.game.localOwner = 'player';
    D.Game.startSkirmish(this.game, D.MAPS.skirmish1);
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.running = true;
    this.speed = 1;

    this._rec = recordings.begin({
      room: this.roomId,
      names: this.meta.names || {},
      baseDt: BASE_DT,
      seed: D.config.seed,
    });
    // One full init snapshot (map + starting units) — not per-frame dumps
    recordings.appendEvent(this._rec, {
      t: 0,
      type: 'init',
      state: this._serializeInit(),
    });

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
      if (this.game) {
        recordings.appendEvent(this._rec, {
          t: this.game.tick,
          type: 'end',
          phase: this.game.phase || 'unknown',
        });
      }
      info = recordings.finish(
        this._rec,
        this.game ? this.game.phase : 'unknown',
        this.game ? this.game.tick : 0
      );
      this._lastRecordingId = (info && info.id) || this._rec.id;
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
    return this._rec ? this._rec.id : this._lastRecordingId || null;
  }

  _tick() {
    if (!this.running || !this.game) return;
    const D = this.D;
    if (this.game.phase !== 'playing') {
      this._broadcast(true);
      const phase = this.game.phase;
      // Finish recording first so /api/recordings/:id is ready when clients open Watch
      const info = this.stop();
      const recId = (info && info.id) || this._lastRecordingId || null;
      if (this.onEnd) this.onEnd(phase, { recordingId: recId });
      return;
    }
    D.Game.tick(this.game, BASE_DT);
    this._broadcast(false);
  }

  _broadcast(force) {
    if (!this.game || !this.onState) return;
    if (!force && this.game.tick % STATE_EVERY !== 0) return;
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
   * Live net snapshot for clients. Includes projectiles/fx so shells are visible
   * in MP (clients do not run combat). Still omits fog/paths for bandwidth.
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
            result = { ok: false, reason: 'deploy' };
            break;
          }
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

    return result;
  }
}

RoomSim.SPEED_OPTIONS = SPEED_OPTIONS;
module.exports = { RoomSim, SPEED_OPTIONS };
