'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Dune2 } = require('./setup.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load save.js + replay helpers already partially in setup; setup has game/save?
// setup.js does not load save.js — use game-loader
const { loadGame } = require('../server/game-loader');

describe('replay keyframe resync', () => {
  it('applyReplayKeyframe restores units without changing map tiles', () => {
    const D = loadGame();
    const game = D.Game.create();
    D.Game.startSkirmish(game, D.MAPS.skirmish1, { owners: ['player', 'enemy'] });
    const tile0 = game.map.tiles[0];
    const nUnits0 = game.units.length;

    // Wipe and apply a fake keyframe with one tank
    const tank = {
      id: 99,
      type: 'combatTank',
      owner: 'player',
      x: 10.5,
      y: 10.5,
      hp: 100,
      hpMax: 200,
      facing: 0,
      order: null,
      orders: [],
      weapon: { cooldownLeft: 0 },
      cargo: 0,
      cargoMax: 0,
      harvest: null,
      sight: 4,
    };
    const ok = D.Save.applyReplayKeyframe(game, {
      tick: 500,
      credits: { player: 999, enemy: 100 },
      spiceCap: { player: 1000, enemy: 1000 },
      units: [tank],
      buildings: [],
      nextId: 100,
      rngState: 1,
      activeOwners: ['player', 'enemy'],
    });
    assert.equal(ok, true);
    assert.equal(game.tick, 500);
    assert.equal(game.map.tiles[0], tile0, 'map unchanged');
    assert.equal(game.units.length, 1);
    assert.equal(game.units[0].id, 99);
    assert.equal(game.credits.player, 999);
    assert.equal(D.Entities.peekNextId(), 100);
    assert.notEqual(game.units.length, nUnits0);
  });
});
