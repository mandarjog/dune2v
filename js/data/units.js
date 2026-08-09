/* global Dune2 */
/**
 * UNIT DATA — source of truth for unit gameplay stats.
 * Edit this file to change HP, range, cost, weapons, recharge magazines, etc.
 * Loaded before config.js; config.units points here.
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});
  D.DATA = D.DATA || {};

  /** @type {Record<string, object>} */
  D.DATA.units = {
      infantry: {
        name: 'Infantry',
        cost: 60,
        builtAt: 'barracks',
        hp: 45,
        speed: 0.7,
        armor: 0,
        sight: 3,
        buildTime: 12,
        kind: 'infantry',
        weapon: {
          kind: 'bullet',
          damage: 4,
          range: 2.5,
          cooldown: 2.4, // sim-sec at 1×; ~1.2s real at default 2×
          vsI: 1.0,
          vsV: 0.4,
          vsB: 0.25,
          projectile: false,
        },
      },
      /**
       * Ordos special: infantry cost, trike HP, 2× infantry damage.
       * Regenerates HP; can self-detonate (D) for splash.
       */
      saboteur: {
        name: 'Saboteur',
        cost: 60,
        builtAt: 'barracks',
        hp: 100,
        speed: 0.85,
        armor: 0,
        sight: 4,
        buildTime: 14,
        kind: 'infantry',
        houses: ['ordos'],
        special: true,
        /** HP restored per second while not at full */
        hpRegenPerSec: 4,
        /** Self-destruct splash (tiles / raw damage before armor) */
        detonate: {
          radius: 2.2,
          damage: 55,
          vsI: 1.2,
          vsV: 1.0,
          vsB: 1.4,
        },
        weapon: {
          kind: 'bullet',
          damage: 8, // 2× infantry
          range: 2.5,
          cooldown: 2.25, // sim-sec at 1×; ~1.1s real at default 2×
          vsI: 1.0,
          vsV: 0.5,
          vsB: 0.45,
          projectile: false,
        },
      },
      trooper: {
        name: 'Trooper',
        cost: 100,
        builtAt: 'barracks',
        hp: 55,
        speed: 0.65,
        armor: 0,
        sight: 3,
        buildTime: 15,
        kind: 'infantry',
        weapon: {
          kind: 'rocket',
          damage: 8,
          range: 3.0,
          cooldown: 4.2, // sim-sec at 1×; ~2.1s real at default 2×
          vsI: 0.5,
          vsV: 1.3,
          vsB: 0.6,
          projectile: false,
        },
      },
      trike: {
        name: 'Trike',
        cost: 300,
        builtAt: 'lightFactory',
        hp: 100,
        speed: 2.2,
        armor: 0,
        sight: 5,
        buildTime: 25,
        kind: 'vehicle',
        weapon: {
          kind: 'bullet',
          damage: 6,
          range: 3.0,
          cooldown: 1.65, // sim-sec at 1×; ~0.8s real at default 2×
          vsI: 1.1,
          vsV: 0.7,
          vsB: 0.3,
          projectile: false,
        },
      },
      quad: {
        name: 'Quad',
        cost: 400,
        builtAt: 'lightFactory',
        hp: 140,
        speed: 1.8,
        armor: 1,
        sight: 4,
        buildTime: 30,
        kind: 'vehicle',
        weapon: {
          kind: 'bullet',
          damage: 9,
          range: 3.2,
          cooldown: 2.1, // sim-sec at 1×; ~1.05s real at default 2×
          vsI: 0.9,
          vsV: 1.0,
          vsB: 0.35,
          projectile: false,
        },
      },
      combatTank: {
        name: 'Combat Tank',
        cost: 600,
        builtAt: 'heavyFactory',
        hp: 220,
        speed: 1.2,
        armor: 2,
        sight: 5, // range + 1 so FOW does not clip max-range shots
        buildTime: 40,
        kind: 'vehicle',
        weapon: {
          kind: 'shell',
          damage: 18,
          range: 4.0,
          cooldown: 3.6, // sim-sec at 1×; ~1.8s real at default 2×
          vsI: 0.6,
          vsV: 1.0,
          vsB: 0.85,
          projectile: true,
          recharge: true,
          magazine: 3, // dump then limp; 5 never emptied at this fire rate
        },
      },
      /** Harkonnen special: slow siege armor (0.5× speed, 2× HP, 1.5× dmg, ½ fire rate, 1.5× range). */
      siegeTank: {
        name: 'Siege Tank',
        cost: 900,
        builtAt: 'heavyFactory',
        hp: 440,
        speed: 0.6,
        armor: 3,
        // Sight = range + 1 so FOW does not clip max-range shots
        sight: 7,
        buildTime: 55,
        kind: 'vehicle',
        houses: ['harkonnen'],
        special: true,
        weapon: {
          kind: 'shell',
          damage: 27, // 1.5× combat tank
          range: 6.0, // 1.5× combat tank (4)
          cooldown: 7.2, // 2× combat tank; ~3.6s real at default 2×
          vsI: 0.5,
          vsV: 1.1,
          vsB: 1.2,
          projectile: true,
          recharge: true,
          magazine: 3,
        },
      },
      harvester: {
        name: 'Harvester',
        cost: 800,
        builtAt: 'heavyFactory',
        hp: 150,
        speed: 1.0,
        armor: 0,
        sight: 3,
        buildTime: 35,
        kind: 'vehicle',
        cargoMax: 700,
        weapon: null,
      },
      mcv: {
        name: 'MCV',
        cost: 2000,
        builtAt: 'heavyFactory',
        hp: 180,
        speed: 0.8,
        armor: 0,
        sight: 3,
        buildTime: 60,
        kind: 'vehicle',
        weapon: null,
        canDeploy: true,
      },
    };

  /** Display order for Unit info table (columns left → right). */
  D.DATA.unitOrder = [
    'infantry',
    'trooper',
    'saboteur',
    'trike',
    'quad',
    'combatTank',
    'siegeTank',
    'harvester',
    'mcv',
  ];
})(typeof window !== 'undefined' ? window : globalThis);
