'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGame } = require('../server/game-loader');

const REC_PATH = path.join(
  __dirname,
  '..',
  'data',
  'recordings',
  'MS74HH9K-MULXSH.json'
);

describe('replay entity ids', () => {
  it('serialize uses peekNextId and does not burn ids', () => {
    const D = loadGame();
    D.Entities.resetIds();
    const g = D.Game.create();
    D.Game.startSkirmish(g, D.MAPS.skirmish1);
    const before = D.Entities.peekNextId();
    const a = D.Save.serialize(g);
    const mid = D.Entities.peekNextId();
    const b = D.Save.serialize(g);
    const after = D.Entities.peekNextId();
    assert.equal(mid, before, 'first serialize must not burn id');
    assert.equal(after, before, 'second serialize must not burn id');
    assert.equal(a.nextId, before);
    assert.equal(b.nextId, before);
  });

  it(
    're-sim of MS74HH9K-MULXSH spawns combat units (id-burn compat)',
    { timeout: 120000 },
    () => {
      if (!fs.existsSync(REC_PATH)) {
        // Recording is local/gitignored — skip in CI without the file
        return;
      }
      const raw = JSON.parse(fs.readFileSync(REC_PATH, 'utf8'));
      const rec = raw.recording || raw;
      const events = rec.events || [];
      assert.ok(events.length > 10, 'recording has events');

      const D = loadGame();
      D.config.features.ai = false;
      D.config.features.fog = true;

      // Minimal Replay harness (Node has no UI/renderer)
      const BASE_DT = 0.05;
      const STATE_EVERY = 2;
      const idBurnCompat = rec.idStable !== true;

      const game = D.Game.create();
      const init = events.find((e) => e.type === 'init');
      assert.ok(init && init.state, 'has init');
      assert.ok(D.Save.loadInto(game, init.state));
      game.replay = true;
      game._serverSim = true;
      game.multiplayer = false;
      game.phase = 'playing';
      if (idBurnCompat) {
        D.Entities.setNextId(D.Entities.peekNextId() + 1);
      }

      let eventIndex = 0;
      while (eventIndex < events.length && events[eventIndex].type === 'init') {
        eventIndex++;
      }

      function applyCmd(seat, payload) {
        if (!payload || !payload.op) return;
        const owner = seat === 'enemy' ? 'enemy' : 'player';
        if (payload.op === 'order') {
          const ids = (payload.ids || []).filter((id) => {
            const e = D.Entities.getById(game, id);
            return e && e.owner === owner && e.hp > 0;
          });
          if (!ids.length) return;
          const order = payload.order || { type: 'stop' };
          D.Orders.issue(game, ids, order);
          if (order.type === 'deploy') {
            let any = false;
            for (const id of ids) {
              const u = game.units.find((x) => x.id === id);
              if (u && u.type === 'mcv' && D.Orders.tryDeploy(game, u)) any = true;
            }
            if (any && idBurnCompat) D.Entities.nextId();
          }
        } else if (payload.op === 'build') {
          D.Economy.beginStructure(
            game,
            owner,
            payload.type,
            payload.tileX | 0,
            payload.tileY | 0
          );
        } else if (payload.op === 'produce') {
          D.Economy.enqueueUnit(game, payload.buildingId, payload.unitType, {
            owner,
          });
        } else if (payload.op === 'stop') {
          const ids = (payload.ids || []).filter((id) => {
            const e = D.Entities.getById(game, id);
            return e && e.owner === owner;
          });
          D.Orders.stop(game, ids);
        } else if (payload.op === 'rally') {
          D.Orders.setRally(game, payload.buildingId, payload.x, payload.y);
        } else if (payload.op === 'cancelQueue') {
          D.Economy.cancelQueue(game, payload.buildingId, payload.index | 0);
        }
      }

      const duration = rec.durationTicks || 27337;
      let produceOk = 0;
      let produceFail = 0;
      // Sample mid-game after produces (first produce ~16000)
      const sampleAt = 18000;
      let sampleUnits = null;

      while (game.tick < duration + 5 && game.phase === 'playing') {
        const t = game.tick;
        while (eventIndex < events.length) {
          const ev = events[eventIndex];
          if (ev.t > t) break;
          eventIndex++;
          if (ev.type === 'cmd' && ev.payload) {
            if (ev.payload.op === 'produce') {
              const r = D.Economy.enqueueUnit(
                game,
                ev.payload.buildingId,
                ev.payload.unitType,
                { owner: ev.seat === 'enemy' ? 'enemy' : 'player' }
              );
              if (r && r.ok) produceOk++;
              else produceFail++;
            } else {
              applyCmd(ev.seat, ev.payload);
            }
          } else if (ev.type === 'end') {
            game.phase = ev.phase || game.phase;
          }
        }
        if (game.phase !== 'playing') break;
        game.replay = true;
        game._serverSim = true;
        D.Game.tick(game, BASE_DT);
        if (idBurnCompat && game.tick % STATE_EVERY === 0) D.Entities.nextId();
        if (game.tick === sampleAt) {
          sampleUnits = game.units
            .filter((u) => u.owner === 'player' && u.hp > 0)
            .map((u) => u.type);
        }
      }

      const byType = {};
      for (const u of game.units) {
        if (u.hp <= 0) continue;
        const k = u.owner + ':' + u.type;
        byType[k] = (byType[k] || 0) + 1;
      }

      assert.ok(
        produceOk >= 4,
        'most produce cmds should succeed, got ok=' + produceOk + ' fail=' + produceFail
      );
      assert.ok(
        (byType['player:combatTank'] || 0) +
          (byType['player:trooper'] || 0) +
          (byType['player:quad'] || 0) >
          0 ||
          (sampleUnits &&
            sampleUnits.some((t) => t === 'combatTank' || t === 'trooper' || t === 'quad')),
        'expected trained units in re-sim, end=' +
          JSON.stringify(byType) +
          ' sample@' +
          sampleAt +
          '=' +
          JSON.stringify(sampleUnits)
      );
    }
  );
});
