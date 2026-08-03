'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('combat engagement', () => {
  it('tanks on plain move still fire at enemy in weapon range', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    Dune2.config.features.fog = false;
    // Clear default MCVs noise
    game.units = [];
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40.5, 40.5);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 42.0, 40.5);
    // Plain move order (what players often issue) — previously never fired
    tank.order = { type: 'move', x: 50.5, y: 40.5 };
    tank.orders = [tank.order];
    tank.path = [{ x: 50.5, y: 40.5 }];
    tank.weapon = { cooldownLeft: 0 };
    const hp0 = foe.hp;
    // Tank shells are projectiles — step until impact
    for (let i = 0; i < 40; i++) {
      Dune2.Combat.tick(game, 0.05);
      if (foe.hp < hp0) break;
    }
    assert.ok(foe.hp < hp0, 'enemy took damage while tank was on move order');
    // Move orders keep path so the whole group can still march to a new goal
    assert.ok(tank.path.length > 0, 'tank keeps move path while firing');
  });

  it('new group attack-move is not cancelled by nearby enemies for every unit', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    Dune2.config.features.fog = false;
    game.units = [];
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const t = Dune2.Entities.createUnit(
        game,
        'combatTank',
        'player',
        30 + (i % 4) * 0.9,
        50 + Math.floor(i / 4) * 0.9
      );
      t.weapon = { cooldownLeft: 0 };
      ids.push(t.id);
    }
    // Enemy next to the cluster
    Dune2.Entities.createUnit(game, 'infantry', 'enemy', 31.5, 50.5);
    Dune2.Orders.issue(game, ids, { type: 'attack-move', x: 70.5, y: 30.5 });
    let withPath = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (u && u.path && u.path.length) withPath++;
    }
    assert.ok(withPath >= 10, 'most units got a path on issue, got ' + withPath);
    // One combat tick must not wipe all paths
    Dune2.Combat.tick(game, 0.05);
    withPath = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (u && u.path && u.path.length) withPath++;
    }
    assert.ok(withPath >= 10, 'paths survive combat tick, got ' + withPath);
  });

  it('harvester does not free-fire while harvesting', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    Dune2.config.features.fog = false;
    game.units = [];
    const h = Dune2.Entities.createUnit(game, 'harvester', 'player', 40.5, 40.5);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 41.0, 40.5);
    h.order = { type: 'harvest', tileX: 40, tileY: 40 };
    h.orders = [h.order];
    // harvester has no weapon — still ensure resolve is null-ish
    const t = Dune2.Combat.resolveTarget(game, h);
    assert.equal(t, null);
    void foe;
  });
});
