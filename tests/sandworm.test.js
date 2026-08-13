'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

function sandMap() {
  // 16×16 mostly sand with a rock strip
  const w = 16;
  const h = 16;
  const n = w * h;
  const tiles = new Uint8Array(n);
  const spice = new Float32Array(n);
  const T = Dune2.config.terrain;
  for (let i = 0; i < n; i++) tiles[i] = T.SAND;
  // rock column
  for (let y = 0; y < h; y++) {
    tiles[y * w + 0] = T.ROCK;
    tiles[y * w + 1] = T.ROCK;
  }
  return {
    id: 'test_worm',
    width: w,
    height: h,
    tiles,
    spiceAmount: spice,
    spawns: {
      player: { x: 2, y: 2 },
      enemy: { x: 12, y: 12 },
    },
    wormZones: [],
  };
}

describe('sandworms', () => {
  let prevEnabled;
  let prevFeat;

  beforeEach(() => {
    prevEnabled = Dune2.config.worms.enabled;
    prevFeat = Dune2.config.features.sandworms;
    Dune2.config.worms.enabled = true;
    Dune2.config.features.sandworms = true;
    Dune2.config.features.fog = false;
    Dune2.config.features.ai = false;
  });

  afterEach(() => {
    Dune2.config.worms.enabled = prevEnabled;
    Dune2.config.features.sandworms = prevFeat;
  });

  it('exports worm helpers and enables by default', () => {
    assert.ok(Dune2.Worms);
    assert.equal(Dune2.Worms.isSafeUnitType('harvester'), true);
    assert.equal(Dune2.Worms.isSafeUnitType('saboteur'), true);
    assert.equal(Dune2.Worms.isSafeUnitType('combatTank'), false);
  });

  it('rock and concrete are safe; open sand is not', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, sandMap(), {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
      generateMap: false,
    });
    // Clear free MCV clutter for tile tests
    game.units = [];
    assert.equal(Dune2.Worms.isSafeTile(game, 0, 5), true); // rock
    assert.equal(Dune2.Worms.isDangerTerrain(game, 5, 5), true); // sand
    // Place concrete on sand
    Dune2.Entities.createBuilding(game, 'concrete', 'player', 5, 5, {
      instant: true,
    });
    // ensure completed concrete
    const slab = game.buildings.find((b) => b.type === 'concrete');
    if (slab) {
      slab.buildProgress = 1;
      slab.hp = slab.hpMax || 100;
    }
    assert.equal(Dune2.Worms.isSafeTile(game, 5, 5), true);
    assert.equal(Dune2.Worms.isDangerTerrain(game, 5, 5), false);
  });

  it('swallows tank on sand after surface; harvester and saboteur safe', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, sandMap(), {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
      generateMap: false,
    });
    game.units = [];
    game.buildings = [];
    Dune2.Map.rebuildBlocked(game);

    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 8.5, 8.5);
    const harv = Dune2.Entities.createUnit(game, 'harvester', 'player', 9.5, 8.5);
    const sab = Dune2.Entities.createUnit(game, 'saboteur', 'player', 8.5, 9.5);
    assert.ok(tank && harv && sab);

    assert.equal(Dune2.Worms.isEdible(game, tank), true);
    assert.equal(Dune2.Worms.isEdible(game, harv), false);
    assert.equal(Dune2.Worms.isEdible(game, sab), false);

    const worm = Dune2.Worms.forceEmerge(game, 8.5, 8.5);
    assert.equal(worm.phase, 'rumble');

    // Skip rumble
    worm.phase = 'surface';
    worm.phaseT = 0;
    worm.warned = true;

    const dt = Dune2.config.DT_SEC;
    for (let i = 0; i < 5; i++) {
      Dune2.Worms.tick(game, dt);
    }

    assert.ok(
      !game.units.find((u) => u.id === tank.id),
      'tank swallowed on sand'
    );
    assert.ok(game.units.find((u) => u.id === harv.id), 'harvester safe');
    assert.ok(game.units.find((u) => u.id === sab.id), 'saboteur safe');
    assert.ok(worm.swallows >= 1);
  });

  it('gulps edible units on the rumble→surface breach, not only after chase', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, sandMap(), {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
      generateMap: false,
    });
    game.units = [];
    game.buildings = [];
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 8.5, 8.5);
    const tankId = tank.id;
    const worm = Dune2.Worms.forceEmerge(game, 8.5, 8.5);
    worm.warned = true;
    // One frame before breach
    worm.phase = 'rumble';
    worm.phaseT = (Dune2.config.worms.rumbleSec || 2) - 0.001;
    Dune2.Worms.tick(game, Dune2.config.DT_SEC);
    assert.equal(worm.phase, 'surface');
    assert.ok(
      !game.units.find((u) => u.id === tankId),
      'tank swallowed on breach gulp'
    );
    assert.ok(worm.swallows >= 1);
  });

  it('does not eat units on rock', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, sandMap(), {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
      generateMap: false,
    });
    game.units = [];
    game.buildings = [];
    const tank = Dune2.Entities.createUnit(game, 'combatTank', 'player', 0.5, 5.5);
    assert.equal(Dune2.Worms.isEdible(game, tank), false);

    const worm = Dune2.Worms.forceEmerge(game, 0.5, 5.5);
    worm.phase = 'surface';
    worm.phaseT = 0;
    worm.warned = true;
    for (let i = 0; i < 10; i++) Dune2.Worms.tick(game, Dune2.config.DT_SEC);
    assert.ok(game.units.find((u) => u.id === tank.id), 'rock is safe');
  });

  it('wormsign alert fires on rumble', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, sandMap(), {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
      generateMap: false,
    });
    game.units = [];
    Dune2.Worms.forceEmerge(game, 6, 6);
    Dune2.Worms.tick(game, Dune2.config.DT_SEC);
    const signs = (game.alerts || []).filter((a) => a.kind === 'wormsign');
    assert.ok(signs.length >= 1, 'wormsign alert');
  });

  it('heat from sand traffic eventually spawns a worm', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, sandMap(), {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
      generateMap: false,
    });
    game.units = [];
    game.buildings = [];
    // Many tanks milling on sand
    for (let i = 0; i < 8; i++) {
      Dune2.Entities.createUnit(game, 'combatTank', 'player', 6 + (i % 3), 6 + Math.floor(i / 3));
    }
    Dune2.config.worms.threshold = 20;
    Dune2.config.worms.cooldownSec = 0;
    game.wormState.cooldownUntil = 0;
    game.wormState.heat = 0;

    let spawned = false;
    for (let i = 0; i < 400; i++) {
      game.tick++;
      Dune2.Worms.tick(game, Dune2.config.DT_SEC);
      if (game.worms.length) {
        spawned = true;
        break;
      }
    }
    assert.ok(spawned, 'worm should spawn from heat');
    assert.ok(
      game.worms[0].phase === 'rumble' || game.worms[0].phase === 'surface'
    );
  });
});
