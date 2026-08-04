'use strict';
/**
 * Regression suite for the move / repath / formation subsystem.
 * These encode the failure modes we hit in play:
 *   open-ground mass move, cliff edges, base edges, stack, spam re-issue,
 *   ensurePath not wiping crawl paths, personal-slot arrival (not group click).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

function openGame(opts) {
  opts = opts || {};
  const game = Dune2.Game.create();
  Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
    owners: ['player', 'enemy'],
    startMode: opts.startMode || 'mcv',
  });
  Dune2.config.features.fog = false;
  Dune2.config.features.ai = false;
  // Park MCVs out of the way
  for (const u of game.units) {
    if (u.type === 'mcv') {
      u.x = 3.5;
      u.y = 3.5;
    }
  }
  return game;
}

function spawnGrid(game, type, owner, n, x0, y0, step) {
  step = step != null ? step : 0.9;
  const ids = [];
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const u = Dune2.Entities.createUnit(
      game,
      type,
      owner,
      x0 + col * step,
      y0 + row * step
    );
    ids.push(u.id);
  }
  return ids;
}

function sim(game, ticks) {
  for (let i = 0; i < ticks; i++) Dune2.Game.tick(game, 0.05);
}

function living(game, ids) {
  return ids
    .map((id) => game.units.find((u) => u.id === id))
    .filter((u) => u && u.hp > 0);
}

function advancedCount(units, before, minDist) {
  minDist = minDist != null ? minDist : 0.4;
  let n = 0;
  for (const u of units) {
    const b = before.get(u.id);
    if (!b) continue;
    if (Math.hypot(u.x - b.x, u.y - b.y) > minDist) n++;
  }
  return n;
}

function uniqueCells(units) {
  const s = new Set();
  for (const u of units) s.add(Math.floor(u.x) + ',' + Math.floor(u.y));
  return s.size;
}

function span(units) {
  let minX = 1e9,
    maxX = -1e9,
    minY = 1e9,
    maxY = -1e9;
  for (const u of units) {
    minX = Math.min(minX, u.x);
    maxX = Math.max(maxX, u.x);
    minY = Math.min(minY, u.y);
    maxY = Math.max(maxY, u.y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

function pathStuckCount(units) {
  return units.filter((u) => u.stuck && u.stuckReason === 'path').length;
}

function withMoveOrder(units) {
  return units.filter(
    (u) => u.order && (u.order.type === 'move' || u.order.type === 'attack-move')
  );
}

function findCliffEdge(map) {
  // Cliffs on skirmish_large are mostly map rim — search full bounds
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (Dune2.Map.tileAt(map, x, y) !== Dune2.config.terrain.CLIFF) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const wx = x + dx;
        const wy = y + dy;
        if (!Dune2.Map.isWalkable(map, wx, wy)) continue;
        // Stage a few tiles inland from the rim
        const sx = wx + dx * 5;
        const sy = wy + dy * 5;
        if (!Dune2.Map.isWalkable(map, sx, sy)) continue;
        return {
          edgeX: wx + 0.5,
          edgeY: wy + 0.5,
          stageX: sx + 0.5,
          stageY: sy + 0.5,
        };
      }
    }
  }
  return null;
}

function initFogFull(game) {
  const n = game.map.width * game.map.height;
  const full = () => ({
    explored: new Uint8Array(n).fill(1),
    visible: new Uint8Array(n).fill(1),
  });
  game.fog = { player: full(), enemy: full() };
  game._fogDrawDirty = true;
}

/** Tiny synthetic map: open sand with a cliff wall and a rock "base" pad. */
function syntheticEdgeMap() {
  const w = 24;
  const h = 24;
  const T = Dune2.config.terrain;
  const tiles = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) tiles[i] = T.SAND;
  // Vertical cliff wall at x=12, gap free at y=0..3 for around-path
  for (let y = 4; y < h; y++) {
    tiles[y * w + 12] = T.CLIFF;
    blocked[y * w + 12] = 1;
  }
  // Rock pad (base) at 18..21, 18..21
  for (let y = 18; y <= 21; y++) {
    for (let x = 18; x <= 21; x++) {
      tiles[y * w + x] = T.ROCK;
    }
  }
  return {
    width: w,
    height: h,
    tiles,
    spiceAmount: new Float32Array(w * h),
    blocked,
    terrainDirty: true,
    spawns: { player: { x: 4, y: 10 }, enemy: { x: 20, y: 10 } },
  };
}

describe('path-movement requirements', () => {
  let prevFog;
  let prevAi;
  let prevBackend;

  beforeEach(() => {
    prevFog = Dune2.config.features.fog;
    prevAi = Dune2.config.features.ai;
    prevBackend = Dune2.config.path.backend;
    Dune2.config.features.fog = false;
    Dune2.config.features.ai = false;
  });

  afterEach(() => {
    Dune2.config.features.fog = prevFog;
    Dune2.config.features.ai = prevAi;
    Dune2.config.path.backend = prevBackend;
  });

  // ─── R1: open-ground mass move ─────────────────────────────────
  describe('R1 open ground', () => {
    it('most of a 20-tank group advances on open sand', () => {
      const game = openGame();
      const ids = spawnGrid(game, 'combatTank', 'player', 20, 40.5, 50.5);
      const units0 = living(game, ids);
      const before = new Map(units0.map((u) => [u.id, { x: u.x, y: u.y }]));

      Dune2.Orders.issue(game, ids, { type: 'move', x: 55.5, y: 50.5 });
      const withPath = living(game, ids).filter((u) => u.path && u.path.length).length;
      assert.ok(withPath >= 18, 'paths at issue ' + withPath);

      sim(game, 60); // 3s
      const advanced = advancedCount(living(game, ids), before, 0.5);
      assert.ok(advanced >= 16, 'advanced ' + advanced + '/20');
      assert.ok(pathStuckCount(living(game, ids)) <= 2, 'path-stuck too high');
    });

    it('flow backend assigns paths for large groups', () => {
      const game = openGame();
      const ids = spawnGrid(game, 'combatTank', 'player', 12, 42.5, 48.5);
      Dune2.Orders.issue(game, ids, { type: 'move', x: 52.5, y: 48.5 });
      assert.ok(
        game.stats &&
          (game.stats.pathLastBackend === 'flow' ||
            game.stats.pathLastBackend === 'flow-cache'),
        'backend ' + (game.stats && game.stats.pathLastBackend)
      );
      assert.ok(game.stats.pathLastIssueOk >= 10, 'ok ' + game.stats.pathLastIssueOk);
    });
  });

  // ─── R2: formation / no stack ──────────────────────────────────
  describe('R2 formation (no stack on one tile)', () => {
    it('assigns distinct personal goals for 20 units', () => {
      const game = openGame();
      const ids = spawnGrid(game, 'combatTank', 'player', 20, 40.5, 50.5);
      Dune2.Orders.issue(game, ids, { type: 'move', x: 55.5, y: 50.5 });
      const goals = new Set();
      for (const u of living(game, ids)) {
        assert.ok(u.order && u.order.type === 'move');
        assert.ok(u.order.groupX != null, 'has groupX');
        goals.add(Math.round(u.order.x * 4) + ',' + Math.round(u.order.y * 4));
        if (u.path && u.path.length) {
          const last = u.path[u.path.length - 1];
          assert.ok(
            Math.hypot(last.x - u.order.x, last.y - u.order.y) < 0.4,
            'path ends at personal slot'
          );
        }
      }
      assert.ok(goals.size >= 16, 'distinct goals ' + goals.size);
    });

    it('does not finish move only because unit is near group click', () => {
      // Unit near click but far from its personal slot must keep moving
      const game = openGame();
      const u = Dune2.Entities.createUnit(game, 'combatTank', 'player', 50.5, 50.5);
      // Fake a formation order: personal slot far, group click under feet
      u.order = {
        type: 'move',
        x: 54.5,
        y: 50.5,
        groupX: 50.5,
        groupY: 50.5,
      };
      u.orders = [u.order];
      u.path = [{ x: 54.5, y: 50.5 }];
      u._altGoalTried = false;
      u._groupGoalTried = false;

      for (let i = 0; i < 5; i++) Dune2.Orders.tick(game, 0.05);

      const still = game.units.find((x) => x.id === u.id);
      // Must still have move order (not cleared by "near group" shortcut)
      assert.ok(
        still.order && still.order.type === 'move',
        'order cleared early — stacking bug regression'
      );
      assert.ok(
        Math.hypot(still.x - 50.5, still.y - 50.5) > 0.15 ||
          Math.hypot(still.x - 54.5, still.y - 50.5) < 4,
        'should be walking toward personal slot'
      );
    });

    it('20 tanks spread after arrival (not one pile)', () => {
      const game = openGame();
      const ids = spawnGrid(game, 'combatTank', 'player', 20, 40.5, 50.5);
      Dune2.Orders.issue(game, ids, { type: 'move', x: 55.5, y: 50.5 });
      sim(game, 280);
      sim(game, 40); // idle separation
      const units = living(game, ids);
      assert.ok(uniqueCells(units) >= 10, 'cells ' + uniqueCells(units));
      assert.ok(span(units) >= 2.5, 'span ' + span(units).toFixed(2));
    });
  });

  // ─── R3: cliff edge ────────────────────────────────────────────
  describe('R3 cliff edge', () => {
    it('group advances when ordered past a cliff wall (synthetic map)', () => {
      const game = Dune2.Game.create();
      game.map = syntheticEdgeMap();
      game.units = [];
      game.buildings = [];
      game.projectiles = [];
      game.fx = [];
      game.tick = 1;
      game.phase = 'playing';
      game.multiplayer = false;
      game.activeOwners = ['player', 'enemy'];
      Dune2.Map.rebuildBlocked(game);
      if (Dune2.Seats) Dune2.Seats.ensureBuckets(game, ['player', 'enemy']);
      initFogFull(game);
      Dune2.config.features.fog = false;

      // Left of cliff wall (x=12). Goal on right via open gap at top (y<4).
      const ids = spawnGrid(game, 'combatTank', 'player', 8, 6.5, 12.5, 0.85);
      const before = new Map(living(game, ids).map((u) => [u.id, { x: u.x, y: u.y }]));

      Dune2.Orders.issue(game, ids, { type: 'move', x: 16.5, y: 2.5 });
      sim(game, 250);

      const units = living(game, ids);
      const advanced = advancedCount(units, before, 0.5);
      // Must not freeze as a red blob; most should move (around gap or crawl)
      assert.ok(advanced >= 5, 'advanced past cliff approach ' + advanced + '/8');
      // After a long march, not all should still be path-stuck
      assert.ok(
        pathStuckCount(units) <= 4,
        'too many path-stuck at cliff: ' + pathStuckCount(units)
      );
    });

    it('large-map cliff rim: army near map-edge cliff still gets paths and moves', () => {
      const game = openGame();
      const edge = findCliffEdge(game.map);
      assert.ok(edge, 'need a cliff edge fixture on skirmish_large');
      const ids = spawnGrid(
        game,
        'trike',
        'player',
        10,
        edge.stageX - 1,
        edge.stageY - 1,
        0.8
      );
      // Keep spawn on-map walkable
      for (const u of living(game, ids)) {
        if (!Dune2.Map.isWalkable(game.map, Math.floor(u.x), Math.floor(u.y))) {
          u.x = edge.stageX;
          u.y = edge.stageY;
        }
      }
      const before = new Map(living(game, ids).map((u) => [u.id, { x: u.x, y: u.y }]));
      // Order onto the walkable rim cell next to cliff
      Dune2.Orders.issue(game, ids, {
        type: 'move',
        x: edge.edgeX,
        y: edge.edgeY,
      });
      const withPath = living(game, ids).filter((u) => u.path && u.path.length).length;
      assert.ok(withPath >= 7, 'paths near cliff ' + withPath);
      sim(game, 100);
      const advanced = advancedCount(living(game, ids), before, 0.3);
      assert.ok(advanced >= 6, 'advanced near cliff ' + advanced);
    });
  });

  // ─── R4: base / building edge ──────────────────────────────────
  describe('R4 base edge', () => {
    it('army can move away from starter base without freezing', () => {
      const game = openGame({ startMode: 'base' });
      // Use real player army near spawn + extras
      const sp = game.map.spawns.player;
      const ids = spawnGrid(game, 'combatTank', 'player', 15, sp.x + 2, sp.y - 3, 0.85);
      const before = new Map(living(game, ids).map((u) => [u.id, { x: u.x, y: u.y }]));

      // Move into open sand away from CY / buildings
      Dune2.Orders.issue(game, ids, {
        type: 'move',
        x: sp.x + 14.5,
        y: sp.y - 8.5,
      });
      sim(game, 100);
      const advanced = advancedCount(living(game, ids), before, 0.5);
      assert.ok(advanced >= 10, 'advanced from base ' + advanced + '/15');
      assert.ok(pathStuckCount(living(game, ids)) <= 3, 'stuck near base');
    });

    it('army ordered onto rock near buildings still mostly moves', () => {
      const game = openGame({ startMode: 'base' });
      const sp = game.map.spawns.player;
      const ids = spawnGrid(game, 'combatTank', 'player', 12, sp.x + 6, sp.y - 6, 0.85);
      // Goal: back toward base rock (buildings occupy some tiles)
      Dune2.Orders.issue(game, ids, {
        type: 'move',
        x: sp.x + 1.5,
        y: sp.y + 0.5,
      });
      const withPath = living(game, ids).filter((u) => u.path && u.path.length).length;
      assert.ok(withPath >= 8, 'paths toward base rock ' + withPath);
      const before = new Map(living(game, ids).map((u) => [u.id, { x: u.x, y: u.y }]));
      sim(game, 120);
      const advanced = advancedCount(living(game, ids), before, 0.3);
      assert.ok(advanced >= 7, 'advanced toward base ' + advanced);
    });
  });

  // ─── R5: spam re-issue ─────────────────────────────────────────
  describe('R5 spam re-issue', () => {
    it('rapid re-orders still leave most of the group advancing', () => {
      const game = openGame();
      const ids = spawnGrid(game, 'combatTank', 'player', 16, 40.5, 48.5);
      const before = new Map(living(game, ids).map((u) => [u.id, { x: u.x, y: u.y }]));

      // Spam 8 move orders while sim runs (frustration click pattern)
      for (let k = 0; k < 8; k++) {
        Dune2.Orders.issue(game, ids, {
          type: 'move',
          x: 52.5 + (k % 3) * 0.5,
          y: 48.5 + (k % 2) * 0.5,
        });
        sim(game, 5);
      }
      sim(game, 40);

      const advanced = advancedCount(living(game, ids), before, 0.5);
      assert.ok(advanced >= 10, 'after spam advanced ' + advanced + '/16');
      assert.ok(
        pathStuckCount(living(game, ids)) <= 4,
        'after spam stuck ' + pathStuckCount(living(game, ids))
      );
    });

    it('ensurePath does not wipe an existing path when A* fails', () => {
      const game = openGame();
      const u = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40.5, 40.5);
      // Micro crawl path (not near far goal)
      u.path = [{ x: 41.0, y: 40.5 }];
      u.order = { type: 'move', x: 80.5, y: 80.5 };
      u.orders = [u.order];
      // Goal sealed: use synthetic wall? On open map A* may succeed.
      // Force failure by pointing at a sealed synthetic map goal.
      game.map = syntheticEdgeMap();
      // Put unit left of wall; goal inside a 1-tile pocket? Use goal deep in blocked
      // Actually cliff wall has gap — use find to impossible by surrounding unit
      // Simpler: mock by calling ensurePath with allowRepath and a goal that's
      // the cliff cell itself (resolveGoal may snap). Use max-distance sealed.
      // Place unit at 6.5,10 and set path; call ensurePath to goal behind solid wall
      // at 14,20 (cliff blocks 12, y>=4). Path may still go around.
      // Direct test of contract: if Path.find returns null, path preserved.
      const orig = u.path.slice();
      // Monkey-patch find temporarily
      const realFind = Dune2.Path.find;
      Dune2.Path.find = () => null;
      try {
        Dune2.Orders.ensurePath(game, u, 20.5, 20.5, () => true);
      } finally {
        Dune2.Path.find = realFind;
      }
      assert.ok(u.path && u.path.length, 'path wiped on failed repath');
      assert.equal(u.path[0].x, orig[0].x);
      assert.equal(u.path[0].y, orig[0].y);
    });
  });

  // ─── R6: recovery / crawl ──────────────────────────────────────
  describe('R6 recovery', () => {
    it('empty-path unit with move order is not permanently path-stuck', () => {
      const game = openGame();
      const u = Dune2.Entities.createUnit(game, 'combatTank', 'player', 40.5, 50.5);
      u.order = { type: 'move', x: 48.5, y: 50.5, groupX: 48.5, groupY: 50.5 };
      u.orders = [u.order];
      u.path = [];
      u._noProgressSec = 0;
      u._altGoalTried = false;
      u._groupGoalTried = false;

      const x0 = u.x;
      sim(game, 40);
      const still = game.units.find((x) => x.id === u.id);
      // Either has a path, moved, or completed order — not frozen with stuck forever
      const moved = Math.hypot(still.x - x0, still.y - 50.5) > 0.2;
      const hasPath = still.path && still.path.length > 0;
      const done = !still.order || still.order.type !== 'move';
      assert.ok(moved || hasPath || done, 'unit remained frozen with empty path');
    });
  });

  // ─── R7: attack-move keeps path while shooting ─────────────────
  describe('R7 attack-move', () => {
    it('attack-move does not clear path for every unit in weapon range', () => {
      const game = openGame();
      Dune2.config.features.fog = false;
      const ids = spawnGrid(game, 'combatTank', 'player', 8, 40.5, 50.5, 0.9);
      // Enemy pack ahead
      for (let i = 0; i < 4; i++) {
        Dune2.Entities.createUnit(game, 'infantry', 'enemy', 46.5 + i * 0.4, 50.5);
      }
      Dune2.Orders.issue(game, ids, { type: 'attack-move', x: 52.5, y: 50.5 });
      const before = new Map(living(game, ids).map((u) => [u.id, { x: u.x, y: u.y }]));
      sim(game, 80);
      const advanced = advancedCount(living(game, ids), before, 0.4);
      // Not "only 1 unit obeyed" — most of the group should advance through the skirmish
      assert.ok(advanced >= 4, 'attack-move advanced ' + advanced + '/8');
    });
  });
});
