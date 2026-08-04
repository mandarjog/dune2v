'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { Dune2 } = require('./setup.js');

// Load replay.js into the same global as setup.js
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'replay.js'), 'utf8');
  vm.runInThisContext(code, { filename: 'js/replay.js' });
}

describe('replay winner / view seat', () => {
  it('ended + winner is defeat for the losing seat (not host-relative)', () => {
    const game = Dune2.Game.create();
    game.phase = 'ended';
    game.winner = 'enemy';
    game.localOwner = 'player';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
    game.localOwner = 'enemy';
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
  });

  it('ended without winner used to look like a draw', () => {
    const game = Dune2.Game.create();
    game.phase = 'ended';
    game.winner = null;
    game.localOwner = 'enemy';
    assert.equal(Dune2.Game.localEndPhase(game), 'draw');
  });

  it('Replay._applyEndOutcome sets winner from end event (not draw)', () => {
    const game = Dune2.Game.create();
    game.phase = 'playing';
    game.winner = null;
    game.localOwner = 'enemy';
    Dune2.Replay.recording = { winner: null, phase: 'ended' };
    Dune2.Replay._applyEndOutcome(game, {
      type: 'end',
      phase: 'ended',
      winner: 'p2',
    });
    assert.equal(game.winner, 'p2');
    assert.equal(game.phase, 'ended');
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
    game.localOwner = 'p2';
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
  });

  it('Replay._applyEndOutcome prefers recording meta winner', () => {
    const game = Dune2.Game.create();
    game.phase = 'playing';
    Dune2.Replay.recording = { winner: 'enemy', phase: 'ended' };
    Dune2.Replay._applyEndOutcome(game, { type: 'end', phase: 'ended' });
    assert.equal(game.winner, 'enemy');
    assert.equal(game.phase, 'ended');
  });

  it('legacy victory/defeat end events map to player/enemy winner', () => {
    const game = Dune2.Game.create();
    Dune2.Replay.recording = {};
    Dune2.Replay._applyEndOutcome(game, { type: 'end', phase: 'defeat' });
    assert.equal(game.winner, 'enemy');
    assert.equal(game.phase, 'ended');
  });

  it('resolveViewSeat prefers opts.viewAs then Net.seat (not always player)', () => {
    const game = Dune2.Game.create();
    game.localOwner = 'player';
    game.spectator = false;
    const rec = { owners: ['player', 'enemy', 'p2'] };
    assert.equal(Dune2.Replay._resolveViewSeat(game, rec, { viewAs: 'p2' }), 'p2');
    Dune2.Net = { seat: 'enemy' };
    assert.equal(Dune2.Replay._resolveViewSeat(game, rec, {}), 'enemy');
    Dune2.Net = { seat: null };
    game.localOwner = 'p2';
    assert.equal(Dune2.Replay._resolveViewSeat(game, rec, {}), 'p2');
    game.spectator = true;
    assert.equal(Dune2.Replay._resolveViewSeat(game, rec, {}), null);
    delete Dune2.Net;
  });

  it('checkWinLoss during replay does not set draw/winner (avoids spam + flip)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish1, {
      owners: ['player', 'enemy'],
    });
    game.replay = true;
    game._serverSim = true;
    game.tick = 100;
    game.phase = 'playing';
    // Wipe both sides
    for (const u of [...game.units]) Dune2.Entities.removeUnit(game, u);
    for (const b of [...game.buildings]) Dune2.Entities.removeBuilding(game, b);
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.phase, 'playing', 'replay must not end via re-sim');
    assert.equal(game.winner, null);
  });
});

describe('recordings persist winner', () => {
  let dir;
  let recordings;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune2-win-'));
    process.env.RECORDINGS_DIR = dir;
    delete require.cache[require.resolve('../server/recordings')];
    recordings = require('../server/recordings');
  });

  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.RECORDINGS_DIR;
    delete require.cache[require.resolve('../server/recordings')];
  });

  it('finish writes winner into meta and get() returns it', () => {
    const rec = recordings.begin({
      room: 'TEST',
      names: { player: 'A', enemy: 'B' },
      owners: ['player', 'enemy'],
    });
    for (let i = 0; i < recordings.MIN_CMDS_TO_SAVE; i++) {
      recordings.appendEvent(rec, {
        t: i + 1,
        type: 'cmd',
        seat: 'player',
        payload: { op: 'stop', ids: [] },
      });
    }
    recordings.appendEvent(rec, {
      t: 50,
      type: 'end',
      phase: 'ended',
      winner: 'enemy',
    });
    const info = recordings.finish(rec, 'ended', 50, { winner: 'enemy' });
    assert.ok(info);
    assert.equal(info.winner, 'enemy');
    const loaded = recordings.get(info.id);
    assert.ok(loaded);
    assert.equal(loaded.winner, 'enemy');
    assert.equal(loaded.phase, 'ended');
    const endEv = (loaded.events || []).find((e) => e.type === 'end');
    assert.ok(endEv);
    assert.equal(endEv.winner, 'enemy');
  });
});
