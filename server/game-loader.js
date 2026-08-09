'use strict';

/**
 * Load browser IIFE game modules into a Node global for server-side sim.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SCRIPTS = [
  // Gameplay roster (source of truth) — must load before config.js
  'js/data/units.js',
  'js/data/buildings.js',
  'js/config.js',
  'js/seats.js',
  'js/rng.js',
  'js/map.js',
  'js/pathfinding.js',
  'js/entities.js',
  'js/orders.js',
  'js/economy.js',
  'js/combat.js',
  'js/ai.js',
  'js/sandworm.js',
  'js/game.js',
  'js/version.js',
  'js/scenario.js',
  'js/save.js',
  'maps/skirmish1.js',
  'maps/skirmish_large.js',
];

let loaded = false;

function installStubs() {
  if (global.window === global) return;
  global.window = global;
  global.globalThis = global;
  global.performance = require('perf_hooks').performance;
  global.document = {
    getElementById() {
      return null;
    },
    createElement() {
      return {
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {},
        setAttribute() {},
        addEventListener() {},
      };
    },
  };
}

function loadGame() {
  if (loaded && global.Dune2) return global.Dune2;
  installStubs();
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    const code = fs.readFileSync(file, 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(code);
  }
  loaded = true;
  return global.Dune2;
}

module.exports = { loadGame, ROOT };
