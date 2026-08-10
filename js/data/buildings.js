/* global Dune2 */
/**
 * BUILDING DATA — source of truth for structure gameplay stats.
 * Edit this file to change building HP, cost, power, weapons (turrets), tech tree, etc.
 * Loaded before config.js; config.buildings points here.
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});
  D.DATA = D.DATA || {};

  /** @type {Record<string, object>} */
  D.DATA.buildings = {
      concrete: {
        name: 'Concrete',
        cost: 5,
        power: 0,
        hp: 20,
        buildTime: 2,
        tileW: 1,
        tileH: 1,
        sight: 0,
        requires: 'constructionYard',
        buildable: true,
        // Classic Dune II: slabs only on rock (prep pad / HP bonus under buildings)
      },
      constructionYard: {
        name: 'Construction Yard',
        cost: 0,
        power: -10,
        hp: 800,
        buildTime: 0,
        tileW: 2,
        tileH: 2,
        sight: 6, // range + 1, same rule as gun turret
        requires: null,
        buildable: false,
        deployOnly: true,
        // Defends itself like a gun turret
        weapon: {
          kind: 'shell',
          damage: 14,
          range: 5.0,
          cooldown: 3.0, // same as gun turret; ~1.5s real at default 2×
          vsI: 0.7,
          vsV: 1.0,
          vsB: 0.5,
          projectile: true,
        },
      },
      windtrap: {
        name: 'Windtrap',
        cost: 300,
        // Was 100; with free starter WT, 70 keeps early power tighter (CY+ref need 40)
        power: 70,
        hp: 200,
        buildTime: 30,
        tileW: 2,
        tileH: 2,
        sight: 2,
        requires: 'constructionYard',
        buildable: true,
      },
      refinery: {
        name: 'Refinery',
        cost: 400,
        power: -30,
        hp: 450,
        buildTime: 40,
        tileW: 3,
        tileH: 2,
        sight: 3,
        requires: 'windtrap',
        buildable: true,
      },
      silo: {
        name: 'Silo',
        cost: 150,
        power: -5,
        hp: 150,
        buildTime: 20,
        tileW: 2,
        tileH: 2,
        sight: 2,
        requires: 'refinery',
        buildable: true,
      },
      barracks: {
        name: 'Barracks',
        cost: 300,
        power: -20,
        hp: 300,
        buildTime: 35,
        tileW: 2,
        tileH: 2,
        sight: 3,
        requires: 'windtrap',
        buildable: true,
        // saboteur filtered by house (Ordos only)
        produces: ['infantry', 'trooper', 'saboteur'],
      },
      lightFactory: {
        name: 'Light Factory',
        cost: 500,
        power: -30,
        hp: 350,
        buildTime: 45,
        tileW: 2,
        tileH: 2,
        sight: 3,
        requires: 'windtrap',
        buildable: true,
        produces: ['trike', 'quad'],
      },
      heavyFactory: {
        name: 'Heavy Factory',
        cost: 600,
        power: -40,
        hp: 400,
        buildTime: 50,
        tileW: 3,
        tileH: 2,
        sight: 3,
        requires: 'refinery',
        buildable: true,
        // siegeTank filtered by house (Harkonnen only)
        produces: ['combatTank', 'siegeTank', 'harvester', 'mcv'],
      },
      gunTurret: {
        name: 'Gun Turret',
        cost: 125,
        power: -20,
        hp: 225,
        buildTime: 25,
        tileW: 1,
        tileH: 1,
        sight: 6, // range + 1 (was 4 < range 5 — FOW blocked the extra tile)
        requires: 'windtrap',
        buildable: true,
        maxCount: 30,
        weapon: {
          kind: 'shell',
          damage: 15,
          range: 5.0,
          cooldown: 3.0, // sim-sec at 1×; ~1.5s real at default 2×
          vsI: 0.7,
          vsV: 1.0,
          vsB: 0.5,
          projectile: true,
          recharge: true,
          magazine: 5,
        },
      },
      /**
       * Atreides special: long-range defense.
       * Base was 2× turret range / 1.1× dmg; tuned down −20% range and −60% fire rate.
       */
      longRangeTower: {
        name: 'Long Range Tower',
        cost: 400,
        power: -40,
        hp: 240,
        buildTime: 30,
        tileW: 1,
        tileH: 1,
        sight: 8,
        requires: 'windtrap',
        buildable: true,
        houses: ['atreides'],
        special: true,
        maxCount: 20,
        weapon: {
          kind: 'shell',
          damage: 30,
          range: 8.0, // was 10; −20%
          // Artillery dead zone — useless in melee / under the barrel
          minRange: 3.5,
          cooldown: 8.25, // ~2.75× gun turret; ~4.1s real at default 2×
          vsI: 0.7,
          vsV: 1.0,
          vsB: 0.55,
          projectile: true,
          recharge: true,
          magazine: 3, // heavy shots, fewer per magazine
        },
      },
      wall: {
        name: 'Wall',
        cost: 50,
        power: 0,
        hp: 80,
        buildTime: 8,
        tileW: 1,
        tileH: 1,
        sight: 0,
        requires: 'windtrap',
        buildable: true,
      },
      radar: {
        name: 'Radar',
        cost: 400,
        power: -30,
        hp: 250,
        buildTime: 40,
        tileW: 2,
        tileH: 2,
        // Wide local vision + unlocks enemy minimap blips in explored fog
        sight: 10,
        requires: 'lightFactory',
        buildable: true,
      },
    };

  /** Defense / armed buildings shown in Unit info. */
  D.DATA.towerOrder = ['gunTurret', 'longRangeTower', 'constructionYard'];
})(typeof window !== 'undefined' ? window : globalThis);
