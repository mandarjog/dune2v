'use strict';

const { loadGame } = require('./game-loader');

const DT = 0.05; // 20 Hz — must match D.config.DT_SEC
const STATE_EVERY = 2;

/**
 * Server-authoritative skirmish for one room.
 * Both browser clients only send commands and render snapshots.
 */
class RoomSim {
  constructor(roomId) {
    this.roomId = roomId;
    this.D = loadGame();
    this.game = null;
    this.timer = null;
    this.running = false;
    this.onState = null; // (payload, tick) => void
    this.onEnd = null; // (phase) => void
  }

  start() {
    if (this.running) return;
    const D = this.D;
    D.config.features.ai = false;
    D.config.features.debugCheats = false;

    this.game = D.Game.create();
    this.game.multiplayer = true;
    this.game._serverSim = true; // allow Game.tick under multiplayer
    this.game.localOwner = 'player'; // irrelevant on server
    D.Game.startSkirmish(this.game, D.MAPS.skirmish1);
    this.game.multiplayer = true;
    this.game._serverSim = true;
    this.running = true;

    this.timer = setInterval(() => this._tick(), DT * 1000);
    // Immediate snapshot so clients can paint
    this._broadcast(true);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.game = null;
  }

  /** Current snapshot for reconnecting clients (null if not running). */
  snapshot() {
    if (!this.running || !this.game) return null;
    return this._serialize();
  }

  get tick() {
    return this.game ? this.game.tick : 0;
  }

  get phase() {
    return this.game ? this.game.phase : null;
  }

  _tick() {
    if (!this.running || !this.game) return;
    const D = this.D;
    if (this.game.phase !== 'playing') {
      // still broadcast terminal state a few times then stop ticking orders
      this._broadcast(true);
      if (this.onEnd) this.onEnd(this.game.phase);
      this.stop();
      return;
    }
    D.Game.tick(this.game, DT);
    // Game.tick skips MP guest; server game has multiplayer true and netRole null
    // — ensure tick actually runs (see game.js). We set netRole undefined.
    this._broadcast(false);
  }

  _broadcast(force) {
    if (!this.game || !this.onState) return;
    if (!force && this.game.tick % STATE_EVERY !== 0) return;
    const payload = this._serialize();
    if (payload) this.onState(payload, this.game.tick);
  }

  _serialize() {
    const D = this.D;
    const data = D.Save.serialize(this.game);
    if (!data) return null;
    delete data.camera;
    delete data.selection;
    delete data.controlGroups;
    delete data.messages;
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
        // Immediate deploy attempt so clients get fast feedback
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

module.exports = { RoomSim };
