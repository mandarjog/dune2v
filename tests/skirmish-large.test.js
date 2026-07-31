'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

const SAND = 0;
const DUNE = 1;
const ROCK = 2;
const SPICE = 3;
const SPICE_HEAVY = 4;
const CLIFF = 5;

function nearRock(map, sx, sy, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      if (map.tiles[y * map.width + x] === ROCK) return true;
    }
  }
  return false;
}

describe('skirmish_large map', () => {
  it('is 96×96 with both MAPS entries', () => {
    const def = Dune2.MAPS.skirmish_large;
    assert.ok(def, 'skirmish_large registered');
    assert.equal(def.id, 'skirmish_large');
    assert.equal(def.width, 96);
    assert.equal(def.height, 96);
    assert.equal(def.tiles.length, 96 * 96);
    assert.equal(def.spiceAmount.length, 96 * 96);
    assert.ok(Dune2.MAPS.skirmish1, 'classic skirmish1 kept');
    assert.equal(Dune2.MAPS.skirmish1.width, 64);
    assert.equal(Dune2.MAPS.skirmish_classic, Dune2.MAPS.skirmish1);
  });

  it('has walkable rock spawns where MCV can deploy immediately', () => {
    const def = Dune2.MAPS.skirmish_large;
    const map = Dune2.Map.createFromDef(def);
    const ps = def.spawns.player;
    const es = def.spawns.enemy;

    assert.ok(Dune2.Map.isWalkable(map, ps.x, ps.y), 'player spawn walkable');
    assert.ok(Dune2.Map.isWalkable(map, es.x, es.y), 'enemy spawn walkable');

    // Spawns must be ROCK — CY deploy is 2×2 rock only (sand pads broke E-deploy)
    assert.equal(Dune2.Map.tileAt(map, ps.x, ps.y), ROCK, 'player spawn on rock');
    assert.equal(Dune2.Map.tileAt(map, es.x, es.y), ROCK, 'enemy spawn on rock');

    // MCV mode: spawn must allow immediate deploy
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, def, { startMode: 'mcv' });
    const pMcv = game.units.find((u) => u.owner === 'player' && u.type === 'mcv');
    const eMcv = game.units.find((u) => u.owner === 'enemy' && u.type === 'mcv');
    assert.ok(pMcv && eMcv, 'both MCVs spawned');
    assert.ok(
      Dune2.Orders.canDeploy(game, pMcv.id),
      'player MCV can deploy at spawn'
    );
    assert.ok(
      Dune2.Orders.canDeploy(game, eMcv.id),
      'enemy MCV can deploy at spawn'
    );
    assert.ok(Dune2.Orders.tryDeploy(game, pMcv), 'player deploy succeeds');
    assert.ok(
      game.buildings.some((b) => b.owner === 'player' && b.type === 'constructionYard'),
      'player CY exists after deploy'
    );

    // Default base mode: CY + WT + refinery + harvester
    const g2 = Dune2.Game.create();
    Dune2.Game.startSkirmish(g2, def, { startMode: 'base' });
    assert.ok(g2.buildings.some((b) => b.owner === 'player' && b.type === 'constructionYard'));
    assert.ok(g2.buildings.some((b) => b.owner === 'player' && b.type === 'windtrap'));
    assert.ok(g2.buildings.some((b) => b.owner === 'player' && b.type === 'refinery'));
    assert.ok(g2.units.some((u) => u.owner === 'player' && u.type === 'harvester'));

    let spiceTotal = 0;
    let spiceTiles = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i];
      if (t === SPICE || t === SPICE_HEAVY) {
        spiceTiles++;
        spiceTotal += map.spiceAmount[i];
      }
    }
    assert.ok(spiceTiles > 0, 'has spice tiles');
    assert.ok(spiceTotal > 0, 'spice amount > 0');

    // Spawns farther apart than classic 64 map (~distance 56)
    const dx = ps.x - es.x;
    const dy = ps.y - es.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    assert.ok(dist > 70, `spawn distance ${dist.toFixed(1)} should exceed classic`);
  });

  it('pathfinding reaches across the map with raised maxNodes', () => {
    assert.ok(Dune2.config.path.maxNodes >= 2048);
    const map = Dune2.Map.createFromDef(Dune2.MAPS.skirmish_large);
    const ps = Dune2.MAPS.skirmish_large.spawns.player;
    const es = Dune2.MAPS.skirmish_large.spawns.enemy;
    const path = Dune2.Path.find(map, ps.x + 0.5, ps.y + 0.5, es.x + 0.5, es.y + 0.5);
    assert.ok(path && path.length > 0, 'path from player spawn to enemy spawn');
  });

  it('startSkirmish accepts skirmish_large', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, { startMode: 'base' });
    assert.equal(game.map.width, 96);
    assert.equal(game.map.height, 96);
    assert.equal(game.fog.player.explored.length, 96 * 96);
    assert.ok(
      game.buildings.some((b) => b.owner === 'player' && b.type === 'constructionYard')
    );
    assert.ok(game.units.some((u) => u.owner === 'player' && u.type === 'harvester'));
  });
});
