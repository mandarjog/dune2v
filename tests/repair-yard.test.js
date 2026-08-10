'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

function freshGame() {
  const game = Dune2.Game.create();
  Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
    owners: ['player', 'enemy'],
    startMode: 'mcv',
  });
  Dune2.config.features.fog = false;
  Dune2.config.features.ai = false;
  game.units = [];
  game.buildings = [];
  game.credits.player = 99999;
  return game;
}

describe('Repair Yard', () => {
  it('is in building data with expected cost/hp/power', () => {
    const d = Dune2.config.buildings.repairYard;
    assert.ok(d);
    assert.equal(d.name, 'Repair Yard');
    assert.equal(d.cost, 1000);
    assert.equal(d.hp, 400);
    assert.equal(d.power, -40);
    assert.equal(d.requires, 'heavyFactory');
    assert.equal(d.repair.range, 2);
    assert.equal(d.repair.slots, 4);
  });

  it('heals a damaged vehicle at 3× build speed within 2 tiles', () => {
    const game = freshGame();
    Dune2.Entities.createBuilding(game, 'windtrap', 'player', 10, 10, {
      complete: true,
    });
    const yard = Dune2.Entities.createBuilding(game, 'repairYard', 'player', 20, 20, {
      complete: true,
    });
    Dune2.Economy.tickPower(game);
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 23.5, 21);
    // 3×2 yard at (20,20): right edge is x=23. Unit at 23.5 is 0.5 outside → in range 2
    assert.ok(Dune2.Economy.distToFootprint(tank.x, tank.y, yard) <= 2);
    tank.hp = 1;
    const udef = Dune2.config.units.combatTank;
    const fullHeal = udef.buildTime / 3;
    // Simulate full-heal duration + a tick
    const dt = Dune2.config.DT_SEC;
    const ticks = Math.ceil(fullHeal / dt) + 2;
    for (let i = 0; i < ticks; i++) Dune2.Economy.tick(game, dt);
    assert.ok(tank.hp >= tank.hpMax - 0.01, 'full heal in buildTime/3, hp=' + tank.hp);
    assert.equal(tank._repairing, false, 'done repairing when full');
  });

  it('does not heal infantry or units more than 2 tiles away', () => {
    const game = freshGame();
    Dune2.Entities.createBuilding(game, 'windtrap', 'player', 10, 10, {
      complete: true,
    });
    Dune2.Entities.createBuilding(game, 'repairYard', 'player', 20, 20, {
      complete: true,
    });
    Dune2.Economy.tickPower(game);
    const inf = Dune2.Entities.createUnit(game, 'infantry', 'player', 21, 21);
    inf.hp = 10;
    const far = Dune2.Entities.createUnit(game, 'combatTank', 'player', 30, 30);
    far.hp = 10;
    for (let i = 0; i < 20; i++) Dune2.Economy.tick(game, 0.05);
    assert.equal(inf.hp, 10, 'infantry not repaired');
    assert.equal(far.hp, 10, 'out of range not repaired');
  });

  it('repairs at most 4 vehicles at once (most damaged first)', () => {
    const game = freshGame();
    Dune2.Entities.createBuilding(game, 'windtrap', 'player', 10, 10, {
      complete: true,
    });
    Dune2.Entities.createBuilding(game, 'repairYard', 'player', 20, 20, {
      complete: true,
    });
    Dune2.Economy.tickPower(game);
    const tanks = [];
    for (let i = 0; i < 6; i++) {
      const t = Dune2.Entities.createUnit(
        game,
        'combatTank',
        'player',
        20.5 + (i % 3) * 0.4,
        22.4
      );
      t.hp = 20 + i * 10; // more damaged = lower index
      tanks.push(t);
    }
    Dune2.Economy.tick(game, 0.05);
    const healing = tanks.filter((t) => t._repairing);
    assert.equal(healing.length, 4);
    // Four most damaged: hp 20,30,40,50
    assert.ok(tanks[0]._repairing && tanks[1]._repairing && tanks[2]._repairing && tanks[3]._repairing);
    assert.equal(tanks[4]._repairing, false);
    assert.equal(tanks[5]._repairing, false);
  });

  it('is offline when power ratio is under 0.5', () => {
    const game = freshGame();
    // Yard costs 40, no windtrap → ratio 0
    Dune2.Entities.createBuilding(game, 'repairYard', 'player', 20, 20, {
      complete: true,
    });
    Dune2.Economy.tickPower(game);
    assert.ok(game.power.player.ratio < 0.5);
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 21, 22.4);
    tank.hp = 50;
    Dune2.Economy.tick(game, 0.05);
    assert.equal(tank.hp, 50);
    assert.equal(tank._repairing, false);
  });
});
