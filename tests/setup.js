/* Load game modules into a shared global for Node tests. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const globalObj = globalThis;
globalObj.window = undefined;

const files = [
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
  'maps/skirmish1.js',
  'maps/skirmish_large.js',
];

for (const rel of files) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

// Path / combat tests move armies on sand for long stretches — worms would
// swallow them mid-assertion. Individual worm tests re-enable.
if (globalObj.Dune2 && globalObj.Dune2.config) {
  globalObj.Dune2.config.features.sandworms = false;
  if (globalObj.Dune2.config.worms) globalObj.Dune2.config.worms.enabled = false;
}

module.exports = { Dune2: globalObj.Dune2 };
