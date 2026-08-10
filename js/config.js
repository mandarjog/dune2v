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
      sandworms: true,
      /**
       * Magazine / capacitor for tanks & defense towers.
       * Toggle via menu “Recharge” or ?recharge=0.
       */
      recharge: true,
      saveLoad: false,
      debugCheats: false,
    },

    /**
     * When features.recharge is on, weapons with `recharge: true` use a magazine.
     * ammo regens continuously; full empty→full takes regenSec seconds.
     */
    recharge: {
      magazine: 5,
      regenSec: 20,
    },

    build: {
      proximityTiles: 8,
      concreteHpBonus: 1.2,
      /** Max living units per owner (all types). Blocks produce when at cap. */
      maxArmySize: 35,
    },

    path: {
      /**
       * Path backend for group point-moves (move / attack-move):
       * - hybrid: A* if group < flowMinGroup, else one flow field for all (default)
       * - flow: always flow field for point-moves (still A* for attack-target / harvest)
       * - astar: legacy per-unit A*
       */
      backend: 'hybrid',
      /**
       * hybrid: use flow field when issuing this many units (or more) to one goal.
       * Small groups use A* (cheap). Large groups use one flow field.
       */
      flowMinGroup: 5,
      /** Reuse flow field for spam-clicks near same goal (ms). */
      flowCacheMs: 3500,
      /** Cache key snap in tiles (nearby clicks share field). */
      flowCacheSnap: 3,
      /**
       * Tight maxCost + early-exit (server MP on shared/small CPU).
       * SP keeps looser bounds so mass armies don't freeze on long desert paths.
       */
      flowTightBounds: false,
      /** Cap when flowTightBounds (tile cost from goal). */
      flowMaxCost: 160,
      /** Soft cap when not tight (SP / large armies). */
      flowMaxCostSp: 280,
      /**
       * Issue paths in waves of this many units (0 = never chunk).
       * Prevents one huge flow/A* batch from leaving most of a mass army empty-path.
       */
      massPathChunk: 24,
      /**
       * When a batch leaves units without paths, retry failed units in cascading
       * subset sizes: chunk → half → … → 1 (individual A*). Always eventually
       * tries singles so a frozen blob cannot stay frozen forever.
       */
      pathCascade: [16, 8, 4, 1],
      /** Path-stuck / frozen units before we warn + cascade re-path. */
      stuckArmyWarn: 6,
      /** How often (ticks) to run frozen-army cascade (~0.75s at 20Hz). */
      stuckArmyCheckTicks: 15,
      /** Auto re-path max units per cascade pulse. */
      stuckArmyRepathChunk: 32,
      // Large FFA armies: old budget of 8 made most units sit idle for seconds
      maxRepathsPerTick: 64,
      /** Cap recovery A* on server MP so one tick cannot eat 100ms+ */
      maxRepathsPerTickMp: 20,
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

    /**
     * Gameplay roster — defined in js/data/buildings.js and js/data/units.js.
     * Edit those files to change balance; this only wires them into config.
     */
    buildings: (D.DATA && D.DATA.buildings) || {},
    units: (D.DATA && D.DATA.units) || {},

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
        saboteur: 2,
        trike: 2,
        quad: 2,
        combatTank: 3,
        siegeTank: 2,
      },
      buildOrder: [
        'windtrap',
        'refinery',
        'windtrap',
        'barracks',
        'lightFactory',
        'heavyFactory',
        'repairYard',
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
      enabled: true,
      maxWorms: 2,
      /** Units that attract worms (weight/sec while on soft sand). */
      moveWeight: {
        infantry: 1,
        trooper: 1,
        saboteur: 0.5,
        trike: 3,
        quad: 3,
        combatTank: 3,
        siegeTank: 3,
        harvester: 4,
        mcv: 3,
      },
      harvestWeightBonus: 2,
      /** Never swallowed — safe even on open sand. */
      safeTypes: ['harvester', 'saboteur'],
      threshold: 80,
      decayPerSec: 4,
      rumbleSec: 2.0,
      surfaceSec: 5,
      moveSpeed: 2.4,
      swallowRadiusTiles: 1.35,
      emergeRadiusTiles: 2,
      cooldownSec: 75,
      equalOpportunity: true,
    },

    projectileSpeed: 8,
  };
})(typeof window !== 'undefined' ? window : globalThis);
