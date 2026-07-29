/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  D.Game = {
    /** Local controlling seat: 'player' (Atreides) or 'enemy' (Harkonnen). */
    me(game) {
      return (game && game.localOwner) || 'player';
    },

    foe(game) {
      return D.Game.me(game) === 'player' ? 'enemy' : 'player';
    },

    /** End-screen phase from the local player's perspective. */
    localEndPhase(game) {
      if (game.phase !== 'victory' && game.phase !== 'defeat') return game.phase;
      if (D.Game.me(game) === 'player') return game.phase;
      // Guest is seat enemy: host "victory" means Atreides won → guest defeat
      return game.phase === 'victory' ? 'defeat' : 'victory';
    },

    create() {
      return {
        phase: 'menu',
        tick: 0,
        credits: { player: 0, enemy: 0 },
        spiceCap: { player: 1000, enemy: 1000 },
        structureBuilder: { player: null, enemy: null },
        power: {
          player: { prod: 0, need: 0, ratio: 1 },
          enemy: { prod: 0, need: 0, ratio: 1 },
        },
        map: null,
        units: [],
        buildings: [],
        projectiles: [],
        worms: [],
        fx: [],
        selection: { ids: [], box: null },
        controlGroups: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [] },
        camera: { x: 0, y: 0 },
        fog: null,
        players: {
          player: { house: 'atreides', color: D.config.colors.player },
          enemy: { house: 'harkonnen', color: D.config.colors.enemy },
        },
        ai: {
          state: 'Bootstrap',
          waveAt: 0,
          lastScoutTick: 0,
          memory: {},
        },
        messages: [],
        placement: null,
        hoverTile: null,
        rngSeed: D.config.seed,
        stats: { fps: 0, simMs: 0 },
        _repathsThisTick: 0,
        // multiplayer
        localOwner: 'player',
        multiplayer: false,
        netRole: null,
        roomCode: null,
      };
    },

    pushMessage(game, text) {
      if (!text) return;
      game.messages.unshift({ text, t: game.tick });
      if (game.messages.length > 30) game.messages.length = 30;
      if (typeof document !== 'undefined') {
        const el = document.getElementById('messages');
        if (el) {
          const div = document.createElement('div');
          div.className = 'msg alert';
          div.textContent = text;
          el.insertBefore(div, el.firstChild);
          while (el.children.length > 20) el.removeChild(el.lastChild);
        }
      }
    },

    startSkirmish(game, mapDef) {
      D.Entities.resetIds();
      D.rng.seed(D.config.seed);
      game.phase = 'playing';
      game.tick = 0;
      game.units = [];
      game.buildings = [];
      game.projectiles = [];
      game.fx = [];
      game.worms = [];
      game.selection = { ids: [], box: null };
      game.controlGroups = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [] };
      game.placement = null;
      game.messages = [];
      game.ai = { state: 'Bootstrap', waveAt: 0, lastScoutTick: 0, memory: {} };
      game.credits.player = D.config.economy.startingCredits;
      game.credits.enemy = D.config.economy.startingCredits;
      game.spiceCap.player = D.config.economy.baseSpiceCap;
      game.spiceCap.enemy = D.config.economy.baseSpiceCap;
      game.structureBuilder = { player: null, enemy: null };
      if (!game.localOwner) game.localOwner = 'player';

      game.map = D.Map.createFromDef(mapDef);
      D.Map.initFog(game);

      const ps = mapDef.spawns.player;
      const es = mapDef.spawns.enemy;
      D.Entities.createUnit(game, 'mcv', 'player', ps.x + 0.5, ps.y + 0.5);
      D.Entities.createUnit(game, 'mcv', 'enemy', es.x + 0.5, es.y + 0.5);

      // camera on local seat spawn
      const me = D.Game.me(game);
      const spawn = me === 'enemy' ? es : ps;
      const ts = D.config.TILE_SIZE;
      game.camera.x = spawn.x * ts - 400;
      game.camera.y = spawn.y * ts - 300;

      D.Economy.tickPower(game);
      D.Map.recomputeFog(game, 'player');
      D.Map.recomputeFog(game, 'enemy');

      D.Game.pushMessage(game, 'Deploy your MCV on rock to begin.');
      if (game.multiplayer) {
        D.Game.pushMessage(
          game,
          me === 'player'
            ? 'You are Atreides (blue). Destroy the enemy CY/MCV.'
            : 'You are Harkonnen (red). Destroy the enemy CY/MCV.'
        );
      } else {
        D.Game.pushMessage(game, 'Atreides vs Harkonnen — harvest the spice.');
      }
    },

    isDefeated(game, owner) {
      const hasCY = game.buildings.some(
        (b) =>
          b.owner === owner &&
          b.type === 'constructionYard' &&
          b.buildProgress >= 1 &&
          b.hp > 0
      );
      const hasMCV = game.units.some((u) => u.owner === owner && u.type === 'mcv' && u.hp > 0);
      return !hasCY && !hasMCV;
    },

    checkWinLoss(game) {
      if (game.phase !== 'playing') return;
      // Grace period first few seconds
      if (game.tick < 40) return;
      if (D.Game.isDefeated(game, 'player')) {
        game.phase = 'defeat';
        const local = D.Game.localEndPhase(game);
        D.Game.pushMessage(
          game,
          local === 'defeat'
            ? 'Defeat. The spice must flow... elsewhere.'
            : 'Victory! Arrakis is yours.'
        );
      } else if (D.Game.isDefeated(game, 'enemy')) {
        game.phase = 'victory';
        const local = D.Game.localEndPhase(game);
        D.Game.pushMessage(
          game,
          local === 'victory'
            ? 'Victory! Arrakis is yours.'
            : 'Defeat. The spice must flow... elsewhere.'
        );
      }
    },

    tick(game, dt) {
      if (game.phase !== 'playing') return;
      // Multiplayer: server runs the sim; browsers only render + send cmds.
      // (Server process sets game._serverSim so it still ticks.)
      if (game.multiplayer && !game._serverSim) return;

      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

      game.tick++;
      D.Orders.tick(game, dt);
      D.Economy.tick(game, dt);
      D.Combat.tick(game, dt);
      if (!game.multiplayer) D.AI.tick(game, dt);
      D.Map.recomputeFog(game, 'player');
      D.Map.recomputeFog(game, 'enemy');
      D.Game.checkWinLoss(game);

      if (typeof performance !== 'undefined') {
        game.stats.simMs = performance.now() - t0;
      }
    },

    /** Debug helpers */
    giveCredits(game, amount) {
      game.credits.player = Math.min(
        game.spiceCap.player,
        game.credits.player + amount
      );
      D.Game.pushMessage(game, '+' + amount + ' credits');
    },

    spawnEnemyArmy(game) {
      const cy = game.buildings.find(
        (b) => b.owner === 'player' && b.type === 'constructionYard'
      );
      const px = cy ? cy.tileX + 8 : 20;
      const py = cy ? cy.tileY - 4 : 40;
      const types = ['infantry', 'infantry', 'trooper', 'trike', 'quad', 'combatTank'];
      for (let i = 0; i < types.length; i++) {
        const u = D.Entities.createUnit(
          game,
          types[i],
          'enemy',
          px + (i % 3),
          py + Math.floor(i / 3)
        );
        D.Orders.issue(game, [u.id], {
          type: 'attack-move',
          x: (cy ? cy.tileX : 10) + 1,
          y: (cy ? cy.tileY : 50) + 1,
        });
      }
      D.Game.pushMessage(game, 'Enemy army spawned!');
    },

    revealMap(game) {
      D.config.features.fog = false;
      D.Map.recomputeFog(game, 'player');
      D.Game.pushMessage(game, 'Map revealed.');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
