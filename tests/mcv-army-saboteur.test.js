'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadGame } = require('../server/game-loader');

describe('MCV deploy, army cap, saboteur', () => {
  it('MCV deploys on rock without proximity when CY already exists', () => {
    const D = loadGame();
    D.config.features.fog = false;
    const game = D.Game.create();
    D.Game.startSkirmish(game, D.MAPS.skirmish1, { owners: ['player', 'enemy'] });
    // Existing CY means old code required proximity — MCV far on rock should still deploy
    const rock = [];
    for (let y = 0; y < game.map.height; y++) {
      for (let x = 0; x < game.map.width; x++) {
        if (D.Map.tileAt(game.map, x, y) === D.config.terrain.ROCK) rock.push({ x, y });
      }
    }
    assert.ok(rock.length > 20);
    // pick rock tiles far from base
    const far = rock.find((t) => t.x > 40 && t.y > 20 && t.x < 55);
    assert.ok(far, 'need far rock');
    const mcv = D.Entities.createUnit(game, 'mcv', 'player', far.x + 0.5, far.y + 0.5);
    assert.equal(D.Orders.canDeploy(game, mcv.id), true);
    assert.equal(D.Orders.tryDeploy(game, mcv), true);
    assert.ok(
      game.buildings.some((b) => b.type === 'constructionYard' && b.owner === 'player')
    );
    assert.ok(!game.units.find((u) => u.id === mcv.id));
  });

  it('army cap blocks produce at 35 units', () => {
    const D = loadGame();
    const game = D.Game.create();
    D.Game.startSkirmish(game, D.MAPS.skirmish1);
    game.credits.player = 99999;
    const hf = D.Entities.createBuilding(game, 'heavyFactory', 'player', 12, 50, {
      complete: true,
    });
    hf.buildProgress = 1;
    // spawn 35 tanks
    for (let i = 0; i < 35; i++) {
      D.Entities.createUnit(game, 'combatTank', 'player', 14 + (i % 10) * 0.4, 52);
    }
    // starter units also count — may already be over. Cap living + queue
    while (D.Economy.armyCount(game, 'player') > 35) {
      const u = game.units.find((x) => x.owner === 'player' && x.type === 'combatTank');
      if (u) D.Entities.removeUnit(game, u);
      else break;
    }
    while (D.Economy.armyCount(game, 'player') < 35) {
      D.Entities.createUnit(game, 'combatTank', 'player', 15, 52);
    }
    assert.equal(D.Economy.armyCount(game, 'player'), 35);
    const r = D.Economy.enqueueUnit(game, hf.id, 'combatTank');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'army_cap');
  });

  it('LRT nerf: range 8 and slower fire', () => {
    const D = loadGame();
    const w = D.config.buildings.longRangeTower.weapon;
    assert.equal(w.range, 8);
    assert.ok(w.cooldown >= 2.5);
  });

  it('saboteur regenerates HP and detonates for splash', () => {
    const D = loadGame();
    D.config.features.fog = false;
    const game = D.Game.create();
    D.Game.startSkirmish(game, D.MAPS.skirmish1);
    const sab = D.Entities.createUnit(game, 'saboteur', 'player', 20, 50);
    sab.hp = 40;
    for (let i = 0; i < 40; i++) D.Orders.tick(game, 0.05);
    assert.ok(sab.hp > 40, 'regen applied');
    assert.ok(sab.hp <= sab.hpMax);

    const foe = D.Entities.createUnit(game, 'combatTank', 'enemy', 20.5, 50.2);
    const hp0 = foe.hp;
    assert.equal(D.Orders.tryDetonate(game, sab), true);
    assert.ok(!game.units.find((u) => u.id === sab.id), 'saboteur removed');
    assert.ok(foe.hp < hp0, 'splash damaged enemy');
  });
});
