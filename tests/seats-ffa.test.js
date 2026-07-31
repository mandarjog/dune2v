'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('seats / FFA', () => {
  it('cycles houses Atreides → Harkonnen → Ordos', () => {
    assert.equal(Dune2.Seats.house('player').id, 'atreides');
    assert.equal(Dune2.Seats.house('enemy').id, 'harkonnen');
    assert.equal(Dune2.Seats.house('p2').id, 'ordos');
    assert.equal(Dune2.Seats.house('p3').id, 'atreides');
    assert.equal(Dune2.Seats.house('p4').id, 'harkonnen');
    assert.equal(Dune2.Seats.label('p2', { p2: 'Alex' }), 'Ordos-Alex');
  });

  it('startSkirmish supports 3 owners with MCVs and fog', () => {
    const game = Dune2.Game.create();
    const map = Dune2.MAPS.skirmish_large;
    Dune2.Game.startSkirmish(game, map, {
      owners: ['player', 'enemy', 'p2'],
      names: { player: 'A', enemy: 'B', p2: 'C' },
    });
    assert.deepEqual(game.activeOwners, ['player', 'enemy', 'p2']);
    assert.equal(game.units.filter((u) => u.type === 'mcv').length, 3);
    assert.ok(game.fog.player && game.fog.enemy && game.fog.p2);
    assert.ok(Dune2.Orders.canDeploy(
      game,
      game.units.find((u) => u.owner === 'p2').id
    ));
  });

  it('FFA win when only one owner remains', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
    });
    game.localOwner = 'player';
    game.tick = 100;
    // Wipe enemy + p2
    for (const u of [...game.units]) {
      if (u.owner !== 'player') Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner !== 'player') Dune2.Entities.removeBuilding(game, b);
    }
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.winner, 'player');
    assert.equal(game.phase, 'victory');
  });

  it('large map has 5 deployable spawns', () => {
    const def = Dune2.MAPS.skirmish_large;
    for (const seat of Dune2.Seats.IDS) {
      assert.ok(def.spawns[seat], 'spawn ' + seat);
      const g = Dune2.Game.create();
      Dune2.Game.startSkirmish(g, def, { owners: [seat] });
      const mcv = g.units.find((u) => u.owner === seat && u.type === 'mcv');
      assert.ok(mcv, 'mcv for ' + seat);
      assert.ok(Dune2.Orders.canDeploy(g, mcv.id), 'deploy ' + seat);
    }
  });
});
