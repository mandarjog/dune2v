'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('mass group move', () => {
  it('most of a dense player army advances after M-order (no friendly freeze)', () => {
    const game = Dune2.Game.create();
    Dune2.Scenario.startMassArmies(game, { perSide: 60, ai: false });
    const players = game.units.filter((u) => u.owner === 'player' && u.type !== 'harvester');
    assert.ok(players.length >= 50);
    const ids = players.map((u) => u.id);
    const before = new Map(players.map((u) => [u.id, { x: u.x, y: u.y }]));

    Dune2.Orders.issue(game, ids, { type: 'move', x: 48.5, y: 18.5 });

    let withPath = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (u && u.path && u.path.length) withPath++;
    }
    assert.ok(withPath >= ids.length * 0.9, 'paths assigned ' + withPath + '/' + ids.length);

    // ~2 seconds of sim
    for (let i = 0; i < 40; i++) Dune2.Game.tick(game, 0.05);

    let advanced = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (!u || u.hp <= 0) continue;
      const b = before.get(id);
      const d = Math.hypot(u.x - b.x, u.y - b.y);
      if (d > 0.4) advanced++;
    }
    // Must not be ~1 unit; dense blob should mostly be marching
    assert.ok(
      advanced >= ids.length * 0.6,
      'units that advanced >0.4 tiles: ' + advanced + '/' + ids.length
    );
  });
});
