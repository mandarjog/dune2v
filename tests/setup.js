/* Load game modules into a shared global for Node tests. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const globalObj = globalThis;
globalObj.window = undefined;

const files = [
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
  'js/game.js',
  'js/scenario.js',
  'maps/skirmish1.js',
  'maps/skirmish_large.js',
];

for (const rel of files) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

module.exports = { Dune2: globalObj.Dune2 };
