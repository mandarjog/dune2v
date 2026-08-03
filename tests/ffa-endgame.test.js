'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('FFA endgame / under-attack alerts', () => {
  function wipeOwner(game, owner) {
    for (const u of [...game.units]) {
      if (u.owner === owner) Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner === owner) Dune2.Entities.removeBuilding(game, b);
    }
  }

  it('legacy host-relative phase no longer fools non-player seats', () => {
    // Reproduce the Friday bug: phase=defeat (host lost), winner=enemy.
    // Old localEndPhase without winner flipped every non-player to victory.
    const game = Dune2.Game.create();
    game.phase = 'ended';
    game.winner = 'enemy';
    game.localOwner = 'enemy';
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
    game.localOwner = 'p2';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
    game.localOwner = 'player';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
  });

  it('sequential elims then final win', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2', 'p3'],
    });
    game.multiplayer = true;
    game._serverSim = true;
    game.tick = 100;

    wipeOwner(game, 'p3');
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.phase, 'playing');
    assert.ok(game.eliminated.p3 != null);

    wipeOwner(game, 'enemy');
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.phase, 'playing');
    assert.ok(game.eliminated.enemy != null);

    wipeOwner(game, 'player');
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.winner, 'p2');
    assert.equal(game.phase, 'ended');
    game.localOwner = 'p2';
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
    game.localOwner = 'player';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
  });

  it('damage to player unit queues under_attack alert (throttled)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
    });
    game.multiplayer = true;
    game._serverSim = true;
    game.tick = 100;
    Dune2.config.features.fog = false;
    const target = game.units.find((u) => u.owner === 'player' && u.type === 'harvester');
    assert.ok(target);
    // Place infantry on top of harvester with attack order + ready weapon
    const foe = Dune2.Entities.createUnit(
      game,
      'infantry',
      'enemy',
      target.x,
      target.y
    );
    foe.order = { type: 'attack', targetId: target.id };
    foe.weapon = { cooldownLeft: 0 };
    for (let i = 0; i < 8; i++) {
      game.tick++;
      Dune2.Combat.tick(game, 0.05);
      foe.weapon.cooldownLeft = 0; // force re-fire every tick
    }
    const attacks = (game.alerts || []).filter((a) => a.kind === 'under_attack');
    assert.ok(attacks.length >= 1, 'expected under_attack alert, got ' + JSON.stringify(game.alerts));
    assert.equal(attacks[0].seat, 'player');
    // Throttle: more damage within 60 ticks should not spam extra alerts
    const n1 = game.alerts.filter((a) => a.kind === 'under_attack').length;
    for (let i = 0; i < 10; i++) {
      game.tick++;
      foe.weapon.cooldownLeft = 0;
      Dune2.Combat.tick(game, 0.05);
    }
    const n2 = game.alerts.filter((a) => a.kind === 'under_attack').length;
    assert.equal(n2, n1, 'under_attack throttled within ~3s');
    Dune2.config.features.fog = true;
  });

  it('immediate path on order for large selection', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const u = Dune2.Entities.createUnit(game, 'infantry', 'player', 20 + (i % 5), 70 + Math.floor(i / 5));
      ids.push(u.id);
    }
    Dune2.Orders.issue(game, ids, { type: 'move', x: 40.5, y: 50.5 });
    let withPath = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (u && u.path && u.path.length) withPath++;
    }
    assert.ok(withPath >= 15, 'most units get a path on issue, got ' + withPath);
  });
});
