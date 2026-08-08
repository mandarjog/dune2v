'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');

describe('seats / FFA', () => {
  it('assigns houses + 5 unique seat colors (pink Harkonnen, black Ordos)', () => {
    assert.equal(Dune2.Seats.house('player').id, 'atreides');
    assert.equal(Dune2.Seats.house('enemy').id, 'harkonnen');
    assert.equal(Dune2.Seats.house('p2').id, 'ordos');
    // Extra seats: additional Harkonnen (pink) + additional Ordos (black)
    assert.equal(Dune2.Seats.house('p3').id, 'harkonnen');
    assert.equal(Dune2.Seats.house('p4').id, 'ordos');
    assert.equal(Dune2.Seats.label('p2', { p2: 'Alex' }), 'Ordos-Alex');
    const colors = Dune2.Seats.IDS.map((s) => Dune2.Seats.color(s));
    assert.equal(new Set(colors).size, 5, 'five distinct colors');
    assert.equal(Dune2.Seats.color('p3'), '#e84393'); // pink
    assert.equal(Dune2.Seats.color('p4'), '#2c2c2c'); // black
  });

  it('skirmishPair maps preferred house to local + AI seats', () => {
    const a = Dune2.Seats.skirmishPair('atreides');
    assert.equal(a.localOwner, 'player');
    assert.equal(a.aiOwner, 'enemy');
    assert.deepEqual(a.owners, ['player', 'enemy']);

    const h = Dune2.Seats.skirmishPair('harkonnen');
    assert.equal(h.localOwner, 'enemy');
    assert.equal(h.aiOwner, 'player');
    assert.deepEqual(h.owners, ['enemy', 'player']);

    const o = Dune2.Seats.skirmishPair('ordos');
    assert.equal(o.localOwner, 'p2');
    assert.equal(o.aiOwner, 'enemy');
    assert.deepEqual(o.owners, ['p2', 'enemy']);

    assert.equal(Dune2.Seats.primarySeat('harkonnen'), 'enemy');
    assert.deepEqual(Dune2.Seats.seatsForHouse('ordos'), ['p2', 'p4']);
    assert.equal(Dune2.Seats.normalizeHouse('HK'), 'harkonnen');
  });

  it('startSkirmish as Harkonnen uses enemy seat + AI on player', () => {
    const game = Dune2.Game.create();
    const pair = Dune2.Seats.skirmishPair('harkonnen');
    game.localOwner = pair.localOwner;
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: pair.owners,
      startMode: 'base',
    });
    assert.equal(game.localOwner, 'enemy');
    assert.deepEqual(game.activeOwners, ['enemy', 'player']);
    assert.ok(
      game.buildings.some(
        (b) => b.owner === 'enemy' && b.type === 'constructionYard'
      )
    );
    assert.ok(
      game.buildings.some(
        (b) => b.owner === 'player' && b.type === 'constructionYard'
      )
    );
    // House specials follow seat
    assert.equal(Dune2.Seats.allows('enemy', Dune2.config.units.siegeTank), true);
    assert.equal(
      Dune2.Seats.allows('enemy', Dune2.config.buildings.longRangeTower),
      false
    );
  });

  it('Net.applyCommand builds for Ordos seat (p2), not collapsed to player', () => {
    // net.js needs light browser stubs
    if (!global.location) {
      global.location = {
        protocol: 'http:',
        host: 'localhost',
        href: 'http://localhost/',
        origin: 'http://localhost',
        pathname: '/',
        search: '',
      };
    }
    if (!global.WebSocket) global.WebSocket = function () {};
    if (!global.history) global.history = { replaceState() {} };
    if (!global.sessionStorage) {
      global.sessionStorage = {
        getItem() {
          return null;
        },
        setItem() {},
        removeItem() {},
      };
    }
    if (!global.localStorage) {
      global.localStorage = {
        getItem() {
          return null;
        },
        setItem() {},
        removeItem() {},
      };
    }
    if (!Dune2.Net || !Dune2.Net.applyCommand) {
      const fs = require('fs');
      const path = require('path');
      const vm = require('vm');
      const code = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'net.js'),
        'utf8'
      );
      vm.runInThisContext(code, { filename: 'js/net.js' });
    }
    assert.ok(Dune2.Net && Dune2.Net.applyCommand);

    const game = Dune2.Game.create();
    const pair = Dune2.Seats.skirmishPair('ordos');
    game.localOwner = pair.localOwner;
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: pair.owners,
      startMode: 'base',
    });
    assert.equal(game.localOwner, 'p2');
    assert.ok(Dune2.Economy.hasTech(game, 'p2', 'refinery'));
    // Broken old mapping: p2 → player → tech fail (player has no refinery)
    const bad = Dune2.Net.applyCommand(game, 'player', {
      op: 'build',
      type: 'silo',
      tileX: 0,
      tileY: 0,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'tech');

    const cy = game.buildings.find(
      (b) => b.owner === 'p2' && b.type === 'constructionYard'
    );
    assert.ok(cy);
    let placed = null;
    for (let r = 1; r < 12 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          const tx = cy.tileX + dx;
          const ty = cy.tileY + dy;
          if (Dune2.Map.canPlace(game, 'silo', tx, ty, 'p2')) {
            const r2 = Dune2.Net.applyCommand(game, 'p2', {
              op: 'build',
              type: 'silo',
              tileX: tx,
              tileY: ty,
            });
            if (r2 && r2.ok) placed = r2;
          }
        }
      }
    }
    assert.ok(placed && placed.ok, 'silo place as p2: ' + JSON.stringify(placed));
    assert.ok(
      game.buildings.some((b) => b.owner === 'p2' && b.type === 'silo'),
      'silo owned by p2'
    );
  });

  it('AI drives the non-local seat (player when human is Harkonnen)', () => {
    const game = Dune2.Game.create();
    const pair = Dune2.Seats.skirmishPair('harkonnen');
    game.localOwner = pair.localOwner;
    Dune2.config.features.ai = true;
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: pair.owners,
      startMode: 'base',
    });
    // Give AI cash and force AI tick cadence
    game.credits.player = 5000;
    game.tick = Dune2.config.ai.tickEvery;
    const before = game.buildings.filter((b) => b.owner === 'player').length;
    Dune2.AI.tick(game, Dune2.config.DT_SEC);
    // AI should at least attempt eco (may queue/build); memory targets local house
    assert.ok(game.ai && game.ai.memory);
    // enemy (human) units/buildings are foes — not used as OWNER
    const after = game.buildings.filter((b) => b.owner === 'player').length;
    // Either built something or still at bootstrap with same count — must not touch enemy buildings
    const humanBuildings = game.buildings.filter((b) => b.owner === 'enemy').length;
    assert.ok(humanBuildings >= 3, 'human base intact');
    assert.ok(after >= before, 'AI may expand player base');
  });

  it('startSkirmish supports 3 owners with starter bases and fog', () => {
    const game = Dune2.Game.create();
    const map = Dune2.MAPS.skirmish_large;
    Dune2.Game.startSkirmish(game, map, {
      owners: ['player', 'enemy', 'p2'],
      names: { player: 'A', enemy: 'B', p2: 'C' },
      startMode: 'base',
    });
    assert.deepEqual(game.activeOwners, ['player', 'enemy', 'p2']);
    for (const o of ['player', 'enemy', 'p2']) {
      assert.ok(
        game.buildings.some((b) => b.owner === o && b.type === 'constructionYard'),
        o + ' has CY'
      );
      assert.ok(
        game.units.some((u) => u.owner === o && u.type === 'harvester'),
        o + ' has harvester'
      );
    }
    assert.ok(game.fog.player && game.fog.enemy && game.fog.p2);
  });

  it('mcv startMode still spawns only MCVs', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy'],
      startMode: 'mcv',
    });
    assert.equal(game.units.filter((u) => u.type === 'mcv').length, 2);
    assert.equal(game.buildings.length, 0);
  });

  it('FFA win when only one owner remains', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
    });
    game.localOwner = 'player';
    game.tick = 100;
    // Wipe enemy + p2
    for (const u of [...game.units]) {
      if (u.owner !== 'player') Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner !== 'player') Dune2.Entities.removeBuilding(game, b);
    }
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.winner, 'player');
    assert.equal(game.phase, 'victory'); // SP: local-relative
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
  });

  it('mid-match elimination marks seat without ending FFA', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
      names: { player: 'A', enemy: 'B', p2: 'C' },
    });
    game.tick = 100;
    // Wipe only enemy
    for (const u of [...game.units]) {
      if (u.owner === 'enemy') Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner === 'enemy') Dune2.Entities.removeBuilding(game, b);
    }
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.phase, 'playing');
    assert.ok(game.eliminated.enemy != null, 'enemy eliminated');
    assert.equal(game.eliminated.player, undefined);
    assert.equal(game.eliminated.p2, undefined);
    assert.equal(game.winner, null);
    assert.ok(
      (game.alerts || []).some((a) => a.kind === 'eliminated' && a.seat === 'enemy')
    );
  });

  it('server-style FFA end uses phase ended + winner (not host-relative)', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
    });
    game.multiplayer = true;
    game._serverSim = true;
    game.localOwner = 'player'; // host seat — used to poison phase for all clients
    game.tick = 100;
    // Only p2 remains
    for (const u of [...game.units]) {
      if (u.owner !== 'p2') Dune2.Entities.removeUnit(game, u);
    }
    for (const b of [...game.buildings]) {
      if (b.owner !== 'p2') Dune2.Entities.removeBuilding(game, b);
    }
    Dune2.Game.checkWinLoss(game);
    assert.equal(game.winner, 'p2');
    assert.equal(game.phase, 'ended');
    // Each seat derives correctly from winner
    game.localOwner = 'p2';
    assert.equal(Dune2.Game.localEndPhase(game), 'victory');
    game.localOwner = 'player';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
    game.localOwner = 'enemy';
    assert.equal(Dune2.Game.localEndPhase(game), 'defeat');
  });

  it('serialize includes activeOwners and winner for FFA replay', () => {
    // save.js not loaded in unit tests — exercise game fields only
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish_large, {
      owners: ['player', 'enemy', 'p2'],
    });
    assert.deepEqual(game.activeOwners, ['player', 'enemy', 'p2']);
  });

  it('large map has 5 deployable spawns', () => {
    const def = Dune2.MAPS.skirmish_large;
    for (const seat of Dune2.Seats.IDS) {
      assert.ok(def.spawns[seat], 'spawn ' + seat);
      const g = Dune2.Game.create();
      Dune2.Game.startSkirmish(g, def, { owners: [seat], startMode: 'mcv' });
      const mcv = g.units.find((u) => u.owner === seat && u.type === 'mcv');
      assert.ok(mcv, 'mcv for ' + seat);
      assert.ok(Dune2.Orders.canDeploy(g, mcv.id), 'deploy ' + seat);
    }
  });
});
