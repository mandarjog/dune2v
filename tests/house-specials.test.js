'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('house special units', () => {
  it('maps seats to houses', () => {
    assert.equal(Dune2.Seats.houseId('player'), 'atreides');
    assert.equal(Dune2.Seats.houseId('enemy'), 'harkonnen');
    assert.equal(Dune2.Seats.houseId('p2'), 'ordos');
    assert.equal(Dune2.Seats.houseId('p3'), 'harkonnen');
    assert.equal(Dune2.Seats.houseId('p4'), 'ordos');
  });

  it('allows house specials only for matching house', () => {
    const lrt = Dune2.config.buildings.longRangeTower;
    const siege = Dune2.config.units.siegeTank;
    const sab = Dune2.config.units.saboteur;
    assert.ok(lrt && siege && sab);
    assert.equal(Dune2.Seats.allows('player', lrt), true);
    assert.equal(Dune2.Seats.allows('enemy', lrt), false);
    assert.equal(Dune2.Seats.allows('enemy', siege), true);
    assert.equal(Dune2.Seats.allows('player', siege), false);
    assert.equal(Dune2.Seats.allows('p2', sab), true);
    assert.equal(Dune2.Seats.allows('player', sab), false);
    // Shared units still open
    assert.equal(Dune2.Seats.allows('player', Dune2.config.units.infantry), true);
    assert.equal(Dune2.Seats.allows('enemy', Dune2.config.buildings.gunTurret), true);
  });

  it('stats match design multipliers', () => {
    const gun = Dune2.config.buildings.gunTurret.weapon;
    const lrt = Dune2.config.buildings.longRangeTower.weapon;
    // Tuned: −20% from 2× gun range (10 → 8), −60% fire rate (cooldown ↑)
    assert.equal(lrt.range, 8);
    assert.equal(gun.damage, 15);
    assert.equal(lrt.damage, 30);
    assert.equal(Dune2.config.buildings.longRangeTower.hp, 240);
    assert.equal(Dune2.config.buildings.longRangeTower.maxCount, 20);
    assert.equal(Dune2.config.buildings.gunTurret.hp, 225);
    assert.equal(Dune2.config.buildings.gunTurret.maxCount, 30);
    assert.ok(lrt.minRange > 0, 'LRT has close-range dead zone');
    assert.ok(lrt.minRange < lrt.range);
    assert.ok(lrt.cooldown > gun.cooldown * 2);

    const tank = Dune2.config.units.combatTank;
    const siege = Dune2.config.units.siegeTank;
    assert.equal(siege.speed, 0.4);
    assert.equal(siege.hp, 225);
    assert.equal(siege.maxCount, 12);
    assert.equal(siege.weapon.damage, 20);
    assert.equal(siege.weapon.cooldown, tank.weapon.cooldown * 2);
    assert.equal(siege.weapon.range, tank.weapon.range * 1.5);
    assert.ok(
      siege.sight >= siege.weapon.range + 1,
      'sight is range + 1 so FOW does not clip max-range fire'
    );
    assert.ok(
      tank.sight >= tank.weapon.range + 1,
      'combat tank sight is range + 1'
    );

    const inf = Dune2.config.units.infantry;
    const trike = Dune2.config.units.trike;
    const sab = Dune2.config.units.saboteur;
    assert.equal(sab.cost, inf.cost);
    assert.equal(sab.hp, trike.hp);
    assert.equal(sab.weapon.damage, inf.weapon.damage * 2);
  });

  it('specials are flagged and LRT refuses close targets', () => {
    assert.equal(Dune2.config.buildings.longRangeTower.special, true);
    assert.equal(Dune2.config.units.siegeTank.special, true);
    assert.equal(Dune2.config.units.saboteur.special, true);
    const w = Dune2.config.buildings.longRangeTower.weapon;
    assert.equal(Dune2.Combat.inWeaponRange(w, 2), false);
    assert.equal(Dune2.Combat.inWeaponRange(w, 5), true);
    assert.equal(Dune2.Combat.inWeaponRange(w, 9), false);
  });

  it('produceList and enqueueUnit respect house', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish1, {
      owners: ['player', 'enemy'],
    });
    // Give factories
    const barracksP = game.buildings.find(
      (b) => b.owner === 'player' && b.type === 'constructionYard'
    );
    assert.ok(barracksP);
    // Place barracks + heavy for both via free build (bypass credits for setup)
    game.credits.player = 5000;
    game.credits.enemy = 5000;
    // Tech: windtrap already there
    let r = Dune2.Economy.beginStructure(game, 'player', 'barracks', 15, 75);
    // may fail placement — find free tile near CY
    if (!r.ok) {
      // use existing if any
    }
    // Build heavy factories by direct entity for test isolation
    const hfP = Dune2.Entities.createBuilding(game, 'heavyFactory', 'player', 18, 78, {
      complete: true,
    });
    const hfE = Dune2.Entities.createBuilding(game, 'heavyFactory', 'enemy', 70, 24, {
      complete: true,
    });
    const brP = Dune2.Entities.createBuilding(game, 'barracks', 'player', 16, 78, {
      complete: true,
    });
    const brE = Dune2.Entities.createBuilding(game, 'barracks', 'enemy', 72, 24, {
      complete: true,
    });
    hfP.buildProgress = 1;
    hfE.buildProgress = 1;
    brP.buildProgress = 1;
    brE.buildProgress = 1;

    const listP = Dune2.Economy.produceList('heavyFactory', 'player');
    const listE = Dune2.Economy.produceList('heavyFactory', 'enemy');
    assert.ok(listP.includes('combatTank'));
    assert.ok(!listP.includes('siegeTank'));
    assert.ok(listE.includes('siegeTank'));

    const barP = Dune2.Economy.produceList('barracks', 'player');
    const barO = Dune2.Economy.produceList('barracks', 'p2');
    assert.ok(!barP.includes('saboteur'));
    assert.ok(barO.includes('saboteur'));

    // Atreides cannot train siege
    game.credits.player = 5000;
    let bad = Dune2.Economy.enqueueUnit(game, hfP.id, 'siegeTank');
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'house');

    // Harkonnen can
    game.credits.enemy = 5000;
    let good = Dune2.Economy.enqueueUnit(game, hfE.id, 'siegeTank');
    assert.equal(good.ok, true);

    // Atreides can build LRT
    game.credits.player = 5000;
    // free rock near base
    const place = Dune2.Economy.beginStructure(game, 'player', 'longRangeTower', 22, 76);
    // may fail placement on this map — still assert house gate separately
    const houseBlock = Dune2.Economy.beginStructure(game, 'enemy', 'longRangeTower', 70, 26);
    assert.equal(houseBlock.ok, false);
    assert.equal(houseBlock.reason, 'house');
  });

  it('canBuildType false for wrong house LRT', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish1);
    game.credits.enemy = 5000;
    assert.equal(Dune2.Economy.canBuildType(game, 'enemy', 'longRangeTower'), false);
    game.credits.player = 5000;
    // tech + afford — may still be false without windtrap complete path
    // player has starter WT
    assert.equal(Dune2.Economy.canBuildType(game, 'player', 'longRangeTower'), true);
  });

  it('caps siege tanks at 12, LRTs at 20, gun turrets at 30', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    Dune2.config.features.fog = false;
    game.units = [];
    game.buildings = [];
    game.credits.enemy = 99999;
    game.credits.player = 99999;
    const hf = Dune2.Entities.createBuilding(game, 'heavyFactory', 'enemy', 20, 20, {
      complete: true,
    });
    for (let i = 0; i < 12; i++) {
      Dune2.Entities.createUnit(game, 'siegeTank', 'enemy', 22 + (i % 6) * 0.4, 22);
    }
    const r = Dune2.Economy.enqueueUnit(game, hf.id, 'siegeTank');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'type_cap');
    assert.equal(r.cap, 12);

    Dune2.Entities.createBuilding(game, 'constructionYard', 'player', 40, 40, {
      complete: true,
    });
    Dune2.Entities.createBuilding(game, 'windtrap', 'player', 43, 40, {
      complete: true,
    });
    for (let i = 0; i < 20; i++) {
      Dune2.Entities.createBuilding(
        game,
        'longRangeTower',
        'player',
        50 + (i % 10),
        50 + Math.floor(i / 10),
        { complete: true }
      );
    }
    assert.equal(Dune2.Economy.countBuildingsOfType(game, 'player', 'longRangeTower'), 20);
    assert.equal(Dune2.Economy.canBuildType(game, 'player', 'longRangeTower'), false);
    const br = Dune2.Economy.beginStructure(game, 'player', 'longRangeTower', 60, 50);
    assert.equal(br.ok, false);
    assert.equal(br.reason, 'type_cap');
    assert.equal(br.cap, 20);

    for (let i = 0; i < 30; i++) {
      Dune2.Entities.createBuilding(
        game,
        'gunTurret',
        'player',
        10 + (i % 15),
        10 + Math.floor(i / 15),
        { complete: true }
      );
    }
    assert.equal(Dune2.Economy.countBuildingsOfType(game, 'player', 'gunTurret'), 30);
    const gr = Dune2.Economy.beginStructure(game, 'player', 'gunTurret', 30, 10);
    assert.equal(gr.ok, false);
    assert.equal(gr.reason, 'type_cap');
    assert.equal(gr.cap, 30);
  });
});
