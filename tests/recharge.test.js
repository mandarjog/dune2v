'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('recharge magazines', () => {
  let prev;

  beforeEach(() => {
    prev = Dune2.config.features.recharge;
    Dune2.config.features.recharge = true;
    Dune2.config.features.ai = false;
    Dune2.config.features.fog = false;
    Dune2.config.features.sandworms = false;
    if (Dune2.config.worms) Dune2.config.worms.enabled = false;
  });

  afterEach(() => {
    Dune2.config.features.recharge = prev;
  });

  it('combat tanks start with full magazine', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 30, 50);
    assert.ok(tank.weapon);
    assert.equal(tank.weapon.ammoMax, 5);
    assert.equal(tank.weapon.ammo, 5);
  });

  it('firing consumes ammo and blocks when empty', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.features.fog = false;
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40, 40);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 41.5, 40);
    tank.weapon.cooldownLeft = 0;
    tank.weapon.ammo = 1;
    tank.order = { type: 'attack', targetId: foe.id };
    tank.orders = [tank.order];
    const hp0 = foe.hp;

    // One fire tick — projectile weapons spend ammo on fire (damage may land later)
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.ok(tank.weapon.ammo < 1, 'ammo consumed, got ' + tank.weapon.ammo);
    assert.ok(
      (game.projectiles && game.projectiles.length > 0) || foe.hp < hp0,
      'shot fired (projectile or hit)'
    );

    // Empty magazine: no new projectiles for a few ticks
    tank.weapon.ammo = 0;
    tank.weapon.cooldownLeft = 0;
    game.projectiles = [];
    for (let i = 0; i < 5; i++) {
      tank.weapon.cooldownLeft = 0;
      tank.weapon.ammo = 0; // pin empty (regen would add a bit each tick)
      Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    }
    assert.equal(
      (game.projectiles || []).length,
      0,
      'no fire while magazine empty'
    );
  });

  it('ammo regenerates over time', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 30, 50);
    tank.weapon.ammo = 0;
    // 20s full regen → 4s should restore ~1 shot
    for (let i = 0; i < 80; i++) {
      // 80 * 0.05 = 4s
      Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    }
    assert.ok(
      tank.weapon.ammo >= 0.9 && tank.weapon.ammo <= 1.2,
      '~1 ammo after 4s, got ' + tank.weapon.ammo
    );
  });

  it('feature off: unlimited fire (no ammo field required)', () => {
    Dune2.config.features.recharge = false;
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.features.fog = false;
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40, 40);
    // Still has ammo fields from create, but feature off should still fire
    tank.weapon.ammo = 0;
    tank.weapon.ammoMax = 5;
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 41.5, 40);
    const hp0 = foe.hp;
    tank.order = { type: 'attack', targetId: foe.id };
    tank.orders = [tank.order];
    tank.weapon.cooldownLeft = 0;
    for (let i = 0; i < 30; i++) {
      tank.weapon.cooldownLeft = 0;
      Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    }
    assert.ok(foe.hp < hp0, 'fires with feature off even if ammo 0');
  });

  it('attack-ground spends ammo without a unit target', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.features.fog = false;
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40, 40);
    tank.weapon.ammo = 3;
    tank.weapon.cooldownLeft = 0;
    tank.order = { type: 'attack-ground', x: 42.5, y: 40.5 };
    tank.orders = [tank.order];
    const before = tank.weapon.ammo;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.ok(
      tank.weapon.ammo < before,
      'spent ammo on ground fire, got ' + tank.weapon.ammo
    );
    assert.ok(
      (game.projectiles && game.projectiles.length > 0) ||
        (game.fx && game.fx.some((f) => f.type === 'explode' || f.type === 'tracer')),
      'fired projectile or hitscan fx'
    );
  });

  it('gun turret uses magazine', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    const cy = game.buildings.find(
      (b) => b.owner === 'player' && b.type === 'constructionYard'
    );
    assert.ok(cy);
    const t = Dune2.Entities.createBuilding(
      game,
      'gunTurret',
      'player',
      cy.tileX + 4,
      cy.tileY,
      { complete: true }
    );
    assert.equal(t.weapon.ammoMax, 5);
  });
});
