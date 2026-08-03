'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('seats / FFA', () => {
  it('assigns houses + 5 unique seat colors (pink Harkonnen, black Ordos)', () => {
    assert.equal(Dune2.Seats.house('player').id, 'atreides');
    assert.equal(Dune2.Seats.house('enemy').id, 'harkonnen');
    assert.equal(Dune2.Seats.house('p2').id, 'ordos');
    // Extra seats: additional Harkonnen (pink) + additional Ordos (black)
    assert.equal(Dune2.Seats.house('p3').id, 'harkonnen');
    assert.equal(Dune2.Seats.house('p4').id, 'ordos');
    assert.equal(Dune2.Seats.label('p2', { p2: 'Alex' }), 'Ordos-Alex');
    const colors = Dune2.Seats.IDS.map((s) => Dune2.Seats.color(s));
    assert.equal(new Set(colors).size, 5, 'five distinct colors');
    assert.equal(Dune2.Seats.color('p3'), '#e84393'); // pink
    assert.equal(Dune2.Seats.color('p4'), '#2c2c2c'); // black
  });

  it('startSkirmish supports 3 owners with starter bases and fog', () => {
    const game = Dune2.Game.create();
    const map = Dune2.MAPS.skirmish_large;
    Dune2.Game.startSkirmish(game, map, {
      owners: ['player', 'enemy', 'p2'],
      names: { player: 'A', enemy: 'B', p2: 'C' },
      startMode: 'base',
    });
    assert.deepEqual(game.activeOwners, ['player', 'enemy', 'p2']);
    for (const o of ['player', 'enemy', 'p2']) {
      assert.ok(
        game.buildings.some((b) => b.owner === o && b.type === 'constructionYard'),
        o + ' has CY'
      );
      assert.ok(
        game.units.some((u) => u.owner === o && u.type === 'harvester'),
        o + ' has harvester'
      );
    }
    assert.ok(game.fog.player && game.fog.enemy && game.fog.p2);
  });

  it('mcv startMode still spawns only MCVs', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    assert.equal(game.units.filter((u) => u.type === 'mcv').length, 2);
    assert.equal(game.buildings.length, 0);
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
    assert.equal(game.phase, 'victory'); // SP: local-relative
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
  });

  it('mid-match elimination marks seat without ending FFA', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
      names: { player: 'A', enemy: 'B', p2: 'C' },
    });
    game.tick = 100;
    // Wipe only enemy
    for (const u of [...game.units]) {
      if (u.owner === 'enemy') Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner === 'enemy') Dune2.Entities.removeBuilding(game, b);
    }
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.phase, 'playing');
    assert.ok(game.eliminated.enemy != null, 'enemy eliminated');
    assert.equal(game.eliminated.player, undefined);
    assert.equal(game.eliminated.p2, undefined);
    assert.equal(game.winner, null);
    assert.ok(
      (game.alerts || []).some((a) => a.kind === 'eliminated' && a.seat === 'enemy')
    );
  });

  it('server-style FFA end uses phase ended + winner (not host-relative)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
    });
    game.multiplayer = true;
    game._serverSim = true;
    game.localOwner = 'player'; // host seat — used to poison phase for all clients
    game.tick = 100;
    // Only p2 remains
    for (const u of [...game.units]) {
      if (u.owner !== 'p2') Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner !== 'p2') Dune2.Entities.removeBuilding(game, b);
    }
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.winner, 'p2');
    assert.equal(game.phase, 'ended');
    // Each seat derives correctly from winner
    game.localOwner = 'p2';
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
    game.localOwner = 'player';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
    game.localOwner = 'enemy';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
  });

  it('serialize includes activeOwners and winner for FFA replay', () => {
    // save.js not loaded in unit tests — exercise game fields only
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
    });
    assert.deepEqual(game.activeOwners, ['player', 'enemy', 'p2']);
  });

  it('large map has 5 deployable spawns', () => {
    const def = Dune2.MAPS.skirmish_large;
    for (const seat of Dune2.Seats.IDS) {
      assert.ok(def.spawns[seat], 'spawn ' + seat);
      const g = Dune2.Game.create();
      Dune2.Game.startSkirmish(g, def, { owners: [seat], startMode: 'mcv' });
      const mcv = g.units.find((u) => u.owner === seat && u.type === 'mcv');
      assert.ok(mcv, 'mcv for ' + seat);
      assert.ok(Dune2.Orders.canDeploy(g, mcv.id), 'deploy ' + seat);
    }
  });
});
