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
    assert.equal(tank.weapon.ammoMax, 3);
    assert.equal(tank.weapon.ammo, 3);
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
    tank.weapon.ammo = 2;
    tank.order = { type: 'attack', targetId: foe.id };
    tank.orders = [tank.order];
    const hp0 = foe.hp;

    // One fire tick — projectile weapons spend ammo on fire (damage may land later)
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.ok(tank.weapon.ammo < 2, 'ammo consumed, got ' + tank.weapon.ammo);
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
    // 20s empty→full, mag 3 → 4s restores 3*(4/20) = 0.6
    for (let i = 0; i < 80; i++) {
      // 80 * 0.05 = 4s
      Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    }
    assert.ok(
      tank.weapon.ammo >= 0.55 && tank.weapon.ammo <= 0.7,
      '~0.6 ammo after 4s, got ' + tank.weapon.ammo
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

  it('does not fire on the same tick regen crosses 1.0 while UI still shows 0', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.features.fog = false;
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40, 40);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 42, 40);
    tank.order = { type: 'attack', targetId: foe.id };
    tank.orders = [tank.order];
    // Just under one whole shot — sidebar shows 0/3
    tank.weapon.ammo = 0.99;
    tank.weapon.volleyLeft = 0;
    tank.weapon.cooldownLeft = 0;
    const n0 = (game.projectiles || []).length;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.equal(
      (game.projectiles || []).length,
      n0,
      'must not fire until a full shot is banked (was 0.99→regen→fire bug)'
    );
    assert.ok(tank.weapon.ammo > 0.99, 'regen still applied after fire check');
    // One banked shot is not enough to start a 2-shot volley
    tank.weapon.ammo = 1.0;
    tank.weapon.volleyLeft = 0;
    tank.weapon.cooldownLeft = 0;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.equal(
      (game.projectiles || []).length,
      n0,
      'tanks do not open a volley on a single shot'
    );
    // Two banked shots start the pair
    tank.weapon.ammo = 2.0;
    tank.weapon.volleyLeft = 0;
    tank.weapon.cooldownLeft = 0;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.ok(
      (game.projectiles || []).length > n0,
      'fires when a volley (2) is banked'
    );
    assert.ok(tank.weapon.ammo < 2, 'spent the first shot of the pair');
    assert.equal(tank.weapon.volleyLeft, 1, 'one shot left in the volley');
  });

  it('tank volley fires a second shot at 1 ammo then waits for 2', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.features.fog = false;
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40, 40);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 42, 40);
    tank.order = { type: 'attack', targetId: foe.id };
    tank.orders = [tank.order];
    tank.weapon.ammo = 1.4;
    tank.weapon.volleyLeft = 1;
    tank.weapon.cooldownLeft = 0;
    const n0 = (game.projectiles || []).length;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.ok(
      (game.projectiles || []).length > n0,
      'second volley shot fires with 1 ammo'
    );
    assert.equal(tank.weapon.volleyLeft, 0);
    assert.ok(tank.weapon.ammo < 1);

    game.projectiles = [];
    tank.weapon.ammo = 1.0;
    tank.weapon.volleyLeft = 0;
    tank.weapon.cooldownLeft = 0;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.equal(
      (game.projectiles || []).length,
      0,
      'does not start a new volley until 2 are banked'
    );
  });

  it('gun turret still fires on a single ammo (no volley)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.features.fog = false;
    const cy = game.buildings.find(
      (b) => b.owner === 'player' && b.type === 'constructionYard'
    );
    const turret = Dune2.Entities.createBuilding(
      game,
      'gunTurret',
      'player',
      cy.tileX + 4,
      cy.tileY,
      { complete: true }
    );
    const foe = Dune2.Entities.createUnit(
      game,
      'infantry',
      'enemy',
      turret.tileX + 1.5,
      turret.tileY + 0.5
    );
    turret.weapon.ammo = 1.0;
    turret.weapon.cooldownLeft = 0;
    const n0 = (game.projectiles || []).length;
    Dune2.Combat.tick(game, Dune2.config.DT_SEC);
    assert.ok(
      (game.projectiles || []).length > n0,
      'turret fires at 1/5, got ammo ' + turret.weapon.ammo
    );
    void foe;
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
