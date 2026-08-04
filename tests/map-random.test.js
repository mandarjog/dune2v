'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('randomized skirmish_large map', () => {
  it('generateSkirmishLarge is deterministic for a seed', () => {
    assert.equal(typeof Dune2.MAPS.generateSkirmishLarge, 'function');
    const a = Dune2.MAPS.generateSkirmishLarge(12345);
    const b = Dune2.MAPS.generateSkirmishLarge(12345);
    assert.equal(a.width, 96);
    assert.equal(a.height, 96);
    assert.equal(a.seed, 12345);
    assert.equal(a.tiles.length, b.tiles.length);
    for (let i = 0; i < a.tiles.length; i++) {
      assert.equal(a.tiles[i], b.tiles[i], 'tile ' + i);
    }
    assert.deepEqual(a.spawns.player, b.spawns.player);
    assert.deepEqual(a.spawns.enemy, b.spawns.enemy);
  });

  it('different seeds produce different layouts', () => {
    const a = Dune2.MAPS.generateSkirmishLarge(100);
    const b = Dune2.MAPS.generateSkirmishLarge(200);
    let diffs = 0;
    for (let i = 0; i < a.tiles.length; i++) {
      if (a.tiles[i] !== b.tiles[i]) diffs++;
    }
    assert.ok(diffs > 100, 'expected terrain to differ, diffs=' + diffs);
  });

  it('all five seats have deployable spawns on generated maps', () => {
    for (const seed of [1, 42, 999, 0xabcdef]) {
      const def = Dune2.MAPS.generateSkirmishLarge(seed);
      for (const seat of Dune2.Seats.IDS) {
        const sp = def.spawns[seat];
        assert.ok(sp, 'spawn ' + seat + ' seed ' + seed);
        const g = Dune2.Game.create();
        Dune2.Game.startSkirmish(g, def, {
          owners: [seat],
          startMode: 'mcv',
          generateMap: false,
          seed,
        });
        const mcv = g.units.find((u) => u.owner === seat && u.type === 'mcv');
        assert.ok(mcv, 'mcv ' + seat);
        assert.ok(Dune2.Orders.canDeploy(g, mcv.id), 'deploy ' + seat + ' seed ' + seed);
      }
    }
  });

  it('MP-style start uses a non-default seed and embeds map in game', () => {
    const seed = 777001;
    const def = Dune2.MAPS.generateSkirmishLarge(seed);
    const game = Dune2.Game.create();
    game.multiplayer = true;
    Dune2.Game.startSkirmish(game, def, {
      owners: ['player', 'enemy'],
      startMode: 'base',
      seed,
      generateMap: false,
    });
    assert.equal(game.rngSeed, seed);
    assert.ok(game.map);
    assert.equal(game.map.width, 96);
    // Spawns match generated def
    assert.equal(game.map.spawns.player.x, def.spawns.player.x);
    assert.equal(game.map.spawns.player.y, def.spawns.player.y);
  });
});
