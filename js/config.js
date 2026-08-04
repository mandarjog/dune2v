/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  D.config = {
    seed: 42,
    TILE_SIZE: 32,
    SIM_HZ: 20,
    DT_SEC: 0.05,
    // Default skirmish size (map def width/height always wins at runtime)
    MAP_W: 96,
    MAP_H: 96,

    features: {
      fog: true,
      ai: true,
      sandworms: false,
      saveLoad: false,
      debugCheats: false,
    },

    build: {
      proximityTiles: 8,
      concreteHpBonus: 1.2,
    },

    path: {
      /**
       * Path backend for group point-moves (move / attack-move):
       * - hybrid: A* if group < flowMinGroup, else one flow field for all (default)
       * - flow: always flow field for point-moves (still A* for attack-target / harvest)
       * - astar: legacy per-unit A*
       */
      backend: 'hybrid',
      /** hybrid: use flow field when issuing this many units (or more) to one goal. */
      flowMinGroup: 5,
      // Large FFA armies: old budget of 8 made most units sit idle for seconds
      maxRepathsPerTick: 64,
      maxNodes: 2048,
      arrivalDist: 0.15,
      /** Safety cap when walking integration field to a waypoint list. */
      maxFlowPathSteps: 4096,
      /**
       * Group move: unique goal slots around the click so units don't stack
       * (stacking also makes combat look like splash — damage is still per-unit).
       */
      formationSpacing: 1.15,
      /** Soft push only when fully stopped (never while following a path). */
      separationRadius: 0.7,
      separationStrength: 0.45,
      /** Min ticks between A* repaths for one unit (stops vibration near bases). */
      repathCooldownTicks: 16,
      /** How close path end may be to goal before we skip repath. */
      pathGoalSlop: 2.25,
      /** Give up move if stuck this long with no progress (seconds). */
      stuckGiveUpSec: 8,
      /** Follow order: hold this many tiles from the target unit. */
      followStandoff: 1.75,
      /** Follow: repath when target moved this far from last path aim. */
      followRepathDist: 1.25,
    },

    economy: {
      // Lowered with free starter base (CY+WT+Refinery+harvester)
      startingCredits: 500, // === baseSpiceCap
      baseSpiceCap: 500,
      siloBonus: 1000,
      spiceToCredit: 1,
      harvestRate: 40,
      unloadRate: 350,
      cancelRefund: 0.5,
      /** Max structures under construction at once per side (was 1). */
      maxStructureQueue: 3,
    },

    /**
     * Skirmish opener.
     * - base: CY + Windtrap + Refinery + free harvester (default)
     * - mcv: classic MCV-only (must deploy on rock)
     */
    skirmish: {
      startMode: 'base', // 'base' | 'mcv'
      /** Default sim speed for SP and new MP matches. */
      defaultSpeed: 2,
    },

    colors: {
      sand: '#c2a05a',
      dune: '#a8843c',
      rock: '#6b6b6b',
      spice: '#d4780a',
      spiceHeavy: '#b84e00',
      cliff: '#2a2a2a',
      player: '#4a90d9', // Atreides (seat 0)
      enemy: '#c0392b', // Harkonnen (seat 1)
      ordos: '#27ae60', // Ordos (seat 2 / p2)
      harkonnenPink: '#e84393', // additional Harkonnen (seat 3 / p3)
      ordosBlack: '#2c2c2c', // additional Ordos (seat 4 / p4)
      fog: 'rgba(0,0,0,0.72)',
      shroud: '#000000',
      selection: '#ffffff',
      hpOk: '#3ecf4a',
      hpMid: '#e0c040',
      hpLow: '#e04040',
      concrete: '#8a8a8a',
    },

    terrain: {
      SAND: 0,
      DUNE: 1,
      ROCK: 2,
      SPICE: 3,
      SPICE_HEAVY: 4,
      CLIFF: 5,
    },

    buildings: {
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
      },
      constructionYard: {
        name: 'Construction Yard',
        cost: 0,
        power: -10,
        hp: 400,
        buildTime: 0,
        tileW: 2,
        tileH: 2,
        sight: 5,
        requires: null,
        buildable: false,
        deployOnly: true,
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
        produces: ['infantry', 'trooper'],
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
        produces: ['combatTank', 'harvester', 'mcv'],
      },
      gunTurret: {
        name: 'Gun Turret',
        cost: 125,
        power: -20,
        hp: 200,
        buildTime: 25,
        tileW: 1,
        tileH: 1,
        sight: 4,
        requires: 'windtrap',
        buildable: true,
        weapon: {
          kind: 'shell',
          damage: 14,
          range: 5.0,
          cooldown: 1.0,
          vsI: 0.7,
          vsV: 1.0,
          vsB: 0.5,
          projectile: true,
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
    },

    units: {
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
          cooldown: 0.8,
          vsI: 1.0,
          vsV: 0.4,
          vsB: 0.25,
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
          cooldown: 1.4,
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
          cooldown: 0.55,
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
          cooldown: 0.7,
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
        sight: 4,
        buildTime: 40,
        kind: 'vehicle',
        weapon: {
          kind: 'shell',
          damage: 18,
          range: 4.0,
          cooldown: 1.2,
          vsI: 0.6,
          vsV: 1.0,
          vsB: 0.85,
          projectile: true,
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
    },

    ai: {
      omniscient: false,
      tickEvery: 10,
      desirePowerSurplus: 0.2,
      wavePeriodSec: 90,
      waveMinCombatUnits: 5,
      defendRadiusTiles: 12,
      scoutPeriodSec: 45,
      creditsStableThreshold: 400,
      productionWeights: {
        infantry: 2,
        trooper: 2,
        trike: 2,
        quad: 2,
        combatTank: 4,
      },
      buildOrder: [
        'windtrap',
        'refinery',
        'windtrap',
        'barracks',
        'lightFactory',
        'heavyFactory',
        'gunTurret',
        'gunTurret',
        'silo',
        'radar',
        'windtrap',
      ],
      placement: {
        spiralMaxRadius: 12,
        refineryTowardSpiceRange: 20,
      },
    },

    worms: {
      enabled: false,
      maxWorms: 2,
      moveWeight: {
        infantry: 1,
        trooper: 1,
        trike: 3,
        quad: 3,
        combatTank: 3,
        harvester: 4,
        mcv: 3,
      },
      harvestWeightBonus: 2,
      threshold: 100,
      decayPerSec: 5,
      rumbleSec: 2.0,
      swallowRadiusTiles: 1.25,
      emergeRadiusTiles: 2,
      cooldownSec: 90,
      equalOpportunity: true,
    },

    projectileSpeed: 8,
  };
})(typeof window !== 'undefined' ? window : globalThis);
