'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('Scenario.mass armies', () => {
  it('starts a normal playing skirmish with large armies both sides', () => {
    const game = Dune2.Game.create();
    const r = Dune2.Scenario.startMassArmies(game, { perSide: 40, ai: true });
    assert.equal(game.phase, 'playing');
    assert.equal(game.multiplayer, false);
    assert.equal(game.localOwner, 'player');
    assert.ok(r.player >= 35, 'player army ' + r.player);
    assert.ok(r.enemy >= 35, 'enemy army ' + r.enemy);
    assert.ok(
      game.buildings.some((b) => b.owner === 'player' && b.type === 'constructionYard')
    );
    assert.ok(
      game.buildings.some((b) => b.owner === 'enemy' && b.type === 'constructionYard')
    );
    assert.equal(Dune2.config.features.ai, true);
    // Select-all path: issue move should path (hybrid flow for large group)
    const ids = game.units.filter((u) => u.owner === 'player' && u.type !== 'harvester').map((u) => u.id);
    assert.ok(ids.length >= 30);
    Dune2.Orders.issue(game, ids.slice(0, 40), { type: 'move', x: 48.5, y: 48.5 });
    assert.equal(game.stats.pathLastBackend, 'flow');
    let withPath = 0;
    for (const id of ids.slice(0, 40)) {
      const u = game.units.find((x) => x.id === id);
      if (u && u.path && u.path.length) withPath++;
    }
    assert.ok(withPath >= 30, 'mass move paths ' + withPath);
  });
});
