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

describe('flow field / hybrid', () => {
  it('buildFlowField + pathFromField reaches goal on large map', () => {
    const map = Dune2.Map.createFromDef(Dune2.MAPS.skirmish_large);
    const sp = map.spawns.player;
    // Prefer sand just off the home rock plateau
    let sx = sp.x + 8;
    let sy = sp.y - 6;
    if (!Dune2.Map.isWalkable(map, sx, sy)) {
      sx = sp.x;
      sy = sp.y;
    }
    assert.ok(Dune2.Map.isWalkable(map, sx, sy), 'start walkable');
    const field = Dune2.Path.buildFlowField(map, 48.5, 48.5);
    assert.ok(field);
    assert.ok(field.reached > 100);
    const path = Dune2.Path.pathFromField(field, sx + 0.5, sy + 0.5);
    assert.ok(path && path.length > 0, 'flow path from near player spawn');
    const last = path[path.length - 1];
    assert.ok(Math.abs(last.x - (field.gx + 0.5)) < 0.01);
    assert.ok(Math.abs(last.y - (field.gy + 0.5)) < 0.01);
  });

  it('hybrid uses flow for large groups and A* for small', () => {
    const map = Dune2.Map.createFromDef(Dune2.MAPS.skirmish_large);
    const prev = Dune2.config.path.backend;
    const prevMin = Dune2.config.path.flowMinGroup;
    Dune2.config.path.backend = 'hybrid';
    Dune2.config.path.flowMinGroup = 5;

    const small = [];
    for (let i = 0; i < 3; i++) {
      small.push({ x: 20 + i, y: 70, path: [] });
    }
    const viaSmall = Dune2.Path.assignGroupMove(map, small, 40.5, 50.5);
    assert.equal(viaSmall, 'astar');
    assert.ok(small.every((u) => u.path && u.path.length));

    const big = [];
    for (let i = 0; i < 12; i++) {
      big.push({ x: 18 + (i % 4), y: 72 - Math.floor(i / 4), path: [] });
    }
    const viaBig = Dune2.Path.assignGroupMove(map, big, 40.5, 50.5);
    assert.equal(viaBig, 'flow');
    assert.ok(big.filter((u) => u.path && u.path.length).length >= 10);

    Dune2.config.path.backend = prev;
    Dune2.config.path.flowMinGroup = prevMin;
  });

  it('fieldCoversUnits rejects cache when starts are outside field', () => {
    const map = Dune2.Map.createFromDef(Dune2.MAPS.skirmish_large);
    const near = [{ x: 20, y: 70, path: [] }];
    Dune2.Path.assignGroupFlow(map, near, 40.5, 50.5);
    const field = Dune2.Path._flowCache && Dune2.Path._flowCache.field;
    assert.ok(field);
    assert.equal(Dune2.Path.fieldCoversUnits(field, near), true);
    // Far units should not be covered by a tightly-bounded field from a short move
    const far = [{ x: 90, y: 10, path: [] }];
    // After a short field build, far corner may be Infinity
    // Rebuild with only near units so field is limited
    Dune2.Path._flowCache = null;
    Dune2.config.path.flowTightBounds = true;
    Dune2.config.path.flowMaxCost = 40;
    Dune2.Path.assignGroupFlow(map, near, 22.5, 70.5, { tightBounds: true });
    const f2 = Dune2.Path._flowCache.field;
    assert.ok(f2);
    // Far side of map almost certainly uncovered under maxCost 40
    const coversFar = Dune2.Path.fieldCoversUnits(f2, far);
    assert.equal(coversFar, false);
    Dune2.config.path.flowTightBounds = false;
    Dune2.config.path.flowMaxCost = 160;
    Dune2.Path._flowCache = null;
  });

  it('Orders.issue move uses flow for 20 infantry', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'base',
    });
    Dune2.config.path.backend = 'hybrid';
    Dune2.config.path.flowMinGroup = 5;
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const u = Dune2.Entities.createUnit(
        game,
        'infantry',
        'player',
        22 + (i % 5) * 0.8,
        68 - Math.floor(i / 5) * 0.8
      );
      ids.push(u.id);
    }
    Dune2.Orders.issue(game, ids, { type: 'move', x: 50.5, y: 50.5 });
    assert.equal(game.stats.pathLastBackend, 'flow');
    let withPath = 0;
    for (const id of ids) {
      const u = game.units.find((x) => x.id === id);
      if (u && u.path && u.path.length) withPath++;
    }
    assert.ok(withPath >= 18, 'most units path via flow, got ' + withPath);
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
    const cap = Dune2.config.economy.baseSpiceCap;
    assert.equal(cap, 500);
    assert.equal(game.credits.player, cap);
    assert.equal(game.spiceCap.player, cap);
    Dune2.Game.giveCredits(game, 5000);
    assert.equal(game.credits.player, cap);
  });

  it('starter base power is positive but tight', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large || Dune2.MAPS.skirmish1, {
      startMode: 'base',
    });
    const p = game.power.player;
    // Windtrap 70 − CY 10 − Refinery 30 = 30 surplus
    assert.equal(p.prod, 70);
    assert.equal(p.need, 40);
    assert.ok(p.ratio >= 1);
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
