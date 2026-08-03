'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('group move formation', () => {
  it('assigns distinct goals so units do not all share one tile', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    const ids = [];
    for (let i = 0; i < 25; i++) {
      const u = Dune2.Entities.createUnit(
        game,
        'infantry',
        'player',
        22 + (i % 5) * 0.9,
        68 - Math.floor(i / 5) * 0.9
      );
      ids.push(u.id);
    }
    Dune2.Orders.issue(game, ids, { type: 'move', x: 48.5, y: 48.5 });

    const goals = new Set();
    let withPath = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      assert.ok(u && u.order, 'has order');
      const key =
        Math.round(u.order.x * 4) + ',' + Math.round(u.order.y * 4);
      goals.add(key);
      if (u.path && u.path.length) withPath++;
      // Personal goal should differ from raw click for most of the group
    }
    // At least ~20 distinct slot keys out of 25 (spacing ~0.85 tile)
    assert.ok(goals.size >= 18, 'distinct goals got ' + goals.size);
    assert.ok(withPath >= 20, 'paths ' + withPath);

    // Last waypoint should match unit's personal order goal (approx)
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (!u.path || !u.path.length) continue;
      const last = u.path[u.path.length - 1];
      assert.ok(
        Math.hypot(last.x - u.order.x, last.y - u.order.y) < 0.35,
        'path ends at formation slot'
      );
    }
  });

  it('combat damages only the targeted unit id (not all stacked)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    // Stack three player infantry on one cell
    const a = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    const b = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    const c = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 40.2, 40.5);
    foe.order = { type: 'attack', targetId: a.id };
    foe.weapon = { cooldownLeft: 0 };
    Dune2.config.features.fog = false;
    const hpB = b.hp;
    const hpC = c.hp;
    for (let i = 0; i < 3; i++) {
      game.tick++;
      foe.weapon.cooldownLeft = 0;
      Dune2.Combat.tick(game, 0.05);
    }
    assert.ok(a.hp < a.hpMax || a.hp === 0, 'target took damage');
    assert.equal(b.hp, hpB, 'stacked non-target B unchanged');
    assert.equal(c.hp, hpC, 'stacked non-target C unchanged');
  });
});
