'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('follow order', () => {
  function openMap() {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    Dune2.config.features.fog = false;
    Dune2.config.features.ai = false;
    // Park MCVs out of the way
    for (const u of game.units) {
      if (u.type === 'mcv') {
        u.x = 5.5;
        u.y = 5.5;
      }
    }
    return game;
  }

  it('friendly unit follows a moving leader', () => {
    const game = openMap();
    // Same speed so follower can keep up
    const leader = Dune2.Entities.createUnit(game, 'trike', 'player', 40.5, 40.5);
    const follower = Dune2.Entities.createUnit(game, 'trike', 'player', 36.5, 40.5);
    const startX = follower.x;

    Dune2.Orders.issue(game, [follower.id], {
      type: 'follow',
      targetId: leader.id,
    });
    assert.equal(follower.order && follower.order.type, 'follow');
    assert.equal(follower.order.targetId, leader.id);

    // Leader walks east; follower should keep up within standoff + slack
    Dune2.Orders.issue(game, [leader.id], { type: 'move', x: 55.5, y: 40.5 });
    for (let i = 0; i < 160; i++) Dune2.Game.tick(game, 0.05);

    const still = game.units.find((u) => u.id === follower.id);
    const lead = game.units.find((u) => u.id === leader.id);
    assert.ok(still && lead, 'both alive');
    assert.ok(lead.x > 48, 'leader advanced, x=' + lead.x);
    assert.ok(still.x > startX + 4, 'follower advanced, x=' + still.x);
    const d = Math.hypot(still.x - lead.x, still.y - lead.y);
    const standoff = Dune2.config.path.followStandoff || 1.75;
    assert.ok(
      d < standoff + 5,
      'follower near leader dist=' + d.toFixed(2) + ' (standoff ' + standoff + ')'
    );
    assert.equal(still.order && still.order.type, 'follow');
  });

  it('does not assign follow to the target itself', () => {
    const game = openMap();
    const a = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    Dune2.Orders.issue(game, [a.id], { type: 'follow', targetId: a.id });
    assert.ok(!a.order || a.order.type !== 'follow', 'self not following self');
  });

  it('rejects enemy follow when not visible (FOW)', () => {
    const game = openMap();
    Dune2.config.features.fog = true;
    Dune2.Map.initFog(game);
    // Full shroud for player
    const fog = game.fog.player;
    fog.visible.fill(0);
    fog.explored.fill(0);

    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 60.5, 60.5);
    const me = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);

    Dune2.Orders.issue(game, [me.id], { type: 'follow', targetId: foe.id });
    assert.ok(!me.order || me.order.type !== 'follow', 'no follow into fog');
  });

  it('clears follow when enemy target leaves vision', () => {
    const game = openMap();
    Dune2.config.features.fog = true;
    Dune2.Map.initFog(game);
    const me = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    const foe = Dune2.Entities.createUnit(game, 'infantry', 'enemy', 41.5, 40.5);

    // Reveal both tiles
    const fog = game.fog.player;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tx = Math.floor(me.x) + dx;
        const ty = Math.floor(me.y) + dy;
        if (tx >= 0 && ty >= 0 && tx < game.map.width && ty < game.map.height) {
          const i = ty * game.map.width + tx;
          fog.visible[i] = 1;
          fog.explored[i] = 1;
        }
      }
    }

    Dune2.Orders.issue(game, [me.id], { type: 'follow', targetId: foe.id });
    assert.equal(me.order && me.order.type, 'follow');

    // Hide enemy
    fog.visible.fill(0);
    for (let i = 0; i < 5; i++) Dune2.Game.tick(game, 0.05);

    const still = game.units.find((u) => u.id === me.id);
    assert.ok(!still.order || still.order.type !== 'follow', 'cleared after fog');
  });

  it('clears follow when target dies', () => {
    const game = openMap();
    const leader = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    const follower = Dune2.Entities.createUnit(game, 'infantry', 'player', 38.5, 40.5);
    Dune2.Orders.issue(game, [follower.id], {
      type: 'follow',
      targetId: leader.id,
    });
    assert.equal(follower.order.type, 'follow');
    Dune2.Entities.removeUnit(game, leader);
    for (let i = 0; i < 3; i++) Dune2.Game.tick(game, 0.05);
    const still = game.units.find((u) => u.id === follower.id);
    assert.ok(!still.order || still.order.type !== 'follow');
  });

  it('allows follow of visible enemy', () => {
    const game = openMap();
    Dune2.config.features.fog = false;
    const foe = Dune2.Entities.createUnit(game, 'trike', 'enemy', 50.5, 40.5);
    const me = Dune2.Entities.createUnit(game, 'infantry', 'player', 40.5, 40.5);
    Dune2.Orders.issue(game, [me.id], { type: 'follow', targetId: foe.id });
    assert.equal(me.order && me.order.type, 'follow');
    assert.equal(me.order.targetId, foe.id);
  });
});
