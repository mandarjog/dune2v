'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('pathfinding', () => {
  it('finds a path on open sand', () => {
    const def = Dune2.MAPS.skirmish1;
    const map = Dune2.Map.createFromDef(def);
    const path = Dune2.Path.find(map, 5.5, 5.5, 10.5, 10.5);
    assert.ok(path && path.length > 0);
  });

  it('does not corner-cut through blocked diagonals', () => {
    const w = 8;
    const h = 8;
    const tiles = new Uint8Array(w * h);
    // all sand
    const blocked = new Uint8Array(w * h);
    // wall making diagonal-only corridor blocked
    // layout: start (1,1) goal (3,3); block (2,1) and (1,2) so diagonal (2,2) would corner-cut
    blocked[1 * w + 2] = 1;
    blocked[2 * w + 1] = 1;
    const map = {
      width: w,
      height: h,
      tiles,
      spiceAmount: new Float32Array(w * h),
      blocked,
      terrainDirty: true,
    };
    // Direct diagonal step from (1,1) to (2,2) must be invalid
    assert.equal(Dune2.Path.canStep(map, 1, 1, 2, 2), false);
    // Orthogonal still ok
    assert.equal(Dune2.Path.canStep(map, 1, 1, 1, 0), true);
  });

  it('returns null when goal is sealed behind a wall (no nearby alternate)', () => {
    // 10x10: left room open, right room open, solid wall x=5 with no gap.
    // Start (2,2), goal (8,8). Nearby-goal search (r<=3) stays on right side of wall
    // but path from left cannot cross → null.
    const w = 10;
    const h = 10;
    const tiles = new Uint8Array(w * h);
    const blocked = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) blocked[y * w + 5] = 1;
    const map = {
      width: w,
      height: h,
      tiles,
      spiceAmount: new Float32Array(w * h),
      blocked,
      terrainDirty: true,
    };
    const path = Dune2.Path.find(map, 2.5, 2.5, 8.5, 8.5);
    assert.equal(path, null);
  });
});

describe('economy cap', () => {
  it('starting credits equal base spice cap', () => {
    assert.equal(
      Dune2.config.economy.startingCredits,
      Dune2.config.economy.baseSpiceCap
    );
  });

  it('charge and cap clamp', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish1);
    assert.equal(game.credits.player, 1000);
    assert.equal(game.spiceCap.player, 1000);
    Dune2.Game.giveCredits(game, 5000);
    assert.equal(game.credits.player, 1000);
  });
});

describe('win condition', () => {
  it('defeated only with no CY and no MCV', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish1, { startMode: 'mcv' });
    assert.equal(Dune2.Game.isDefeated(game, 'player'), false);
    // remove MCV
    game.units = game.units.filter((u) => u.owner !== 'player');
    assert.equal(Dune2.Game.isDefeated(game, 'player'), true);
  });

  it('base start is not defeated (has CY)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large || Dune2.MAPS.skirmish1, {
      startMode: 'base',
    });
    assert.equal(Dune2.Game.isDefeated(game, 'player'), false);
    game.units = game.units.filter((u) => u.owner !== 'player');
    assert.equal(Dune2.Game.isDefeated(game, 'player'), false); // still has CY
    game.buildings = game.buildings.filter((b) => b.owner !== 'player');
    assert.equal(Dune2.Game.isDefeated(game, 'player'), true);
  });
});
