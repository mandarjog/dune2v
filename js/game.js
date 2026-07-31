/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  D.Game = {
    /** Local controlling seat id. */
    me(game) {
      return (game && game.localOwner) || 'player';
    },

    /** Primary opponent for 1v1 UI; in FFA first other alive owner. */
    foe(game) {
      const me = D.Game.me(game);
      const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
      for (const o of owners) {
        if (o !== me) return o;
      }
      return me === 'player' ? 'enemy' : 'player';
    },

    /** End-screen phase from the local player's perspective. */
    localEndPhase(game) {
      if (game.phase !== 'victory' && game.phase !== 'defeat' && game.phase !== 'draw') {
        return game.phase;
      }
      if (game.phase === 'draw') return 'draw';
      const me = D.Game.me(game);
      if (game.winner != null) {
        return game.winner === me ? 'victory' : 'defeat';
      }
      // Legacy 1v1: phase victory meant player (Atreides) won
      if (me === 'player') return game.phase;
      return game.phase === 'victory' ? 'defeat' : 'victory';
    },

    create() {
      return {
        phase: 'menu',
        tick: 0,
        credits: D.Seats ? D.Seats.emptyCredits() : { player: 0, enemy: 0 },
        spiceCap: D.Seats ? D.Seats.emptySpiceCap() : { player: 1000, enemy: 1000 },
        structureBuilder: { player: null, enemy: null, p2: null, p3: null, p4: null },
        power: D.Seats
          ? D.Seats.emptyPower()
          : {
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
        activeOwners: ['player', 'enemy'],
        winner: null,
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
        spectator: false,
        netRole: null,
        roomCode: null,
        playerNames: null,
        speedMult: 1,
        replay: false,
        netSpeed: 1,
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

    /**
     * @param {object} game
     * @param {object} mapDef
     * @param {object} [opts]
     * @param {string[]} [opts.owners] active seat ids (default player+enemy)
     * @param {object} [opts.names] seat -> display name
     */
    startSkirmish(game, mapDef, opts) {
      opts = opts || {};
      D.Entities.resetIds();
      D.rng.seed(D.config.seed);
      game.phase = 'playing';
      game.tick = 0;
      game.winner = null;
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

      const owners =
        opts.owners && opts.owners.length
          ? opts.owners.filter((o) => D.Seats.isSeat(o))
          : ['player', 'enemy'];
      if (owners.length < 1) owners.push('player');
      game.activeOwners = owners.slice();
      if (opts.names) game.playerNames = opts.names;

      D.Seats.ensureBuckets(game, owners);
      const startC = D.config.economy.startingCredits;
      const baseCap = D.config.economy.baseSpiceCap;
      for (const o of owners) {
        game.credits[o] = startC;
        game.spiceCap[o] = baseCap;
        game.structureBuilder[o] = null;
      }
      if (!game.localOwner || owners.indexOf(game.localOwner) < 0) {
        game.localOwner = owners[0];
      }

      game.map = D.Map.createFromDef(mapDef);
      D.Map.initFog(game);

      // Spawn MCVs
      for (const o of owners) {
        const sp = D.Seats.spawnFor(mapDef, o);
        if (!sp) continue;
        D.Entities.createUnit(game, 'mcv', o, sp.x + 0.5, sp.y + 0.5);
      }

      // camera on local seat spawn
      const me = D.Game.me(game);
      const spawn = D.Seats.spawnFor(mapDef, me) || mapDef.spawns.player;
      const ts = D.config.TILE_SIZE;
      if (spawn) {
        game.camera.x = spawn.x * ts - 400;
        game.camera.y = spawn.y * ts - 300;
      }

      D.Economy.tickPower(game);
      for (const o of owners) {
        D.Map.recomputeFog(game, o);
      }

      D.Game.pushMessage(game, 'Deploy your MCV on rock to begin.');
      if (game.multiplayer) {
        const label = D.Seats.label(me, game.playerNames);
        D.Game.pushMessage(
          game,
          'You are ' +
            label +
            '. Last Construction Yard / MCV standing wins (' +
            owners.length +
            ' players).'
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

      const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
      const alive = owners.filter((o) => !D.Game.isDefeated(game, o));

      if (alive.length >= 2) return;

      if (alive.length === 1) {
        game.winner = alive[0];
        const me = D.Game.me(game);
        game.phase = game.winner === me ? 'victory' : 'defeat';
        const local = D.Game.localEndPhase(game);
        const winLabel = D.Seats
          ? D.Seats.label(game.winner, game.playerNames)
          : game.winner;
        D.Game.pushMessage(
          game,
          local === 'victory'
            ? 'Victory! ' + winLabel + ' controls Arrakis.'
            : 'Defeat. ' + winLabel + ' triumphs. The spice must flow… elsewhere.'
        );
        return;
      }

      // Everyone dead
      game.phase = 'draw';
      game.winner = null;
      D.Game.pushMessage(game, 'Draw — no houses remain.');
    },

    tick(game, dt) {
      if (game.phase !== 'playing') return;
      if (game.multiplayer && !game._serverSim && !game.replay) return;

      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

      game.tick++;
      D.Orders.tick(game, dt);
      D.Economy.tick(game, dt);
      D.Combat.tick(game, dt);
      if (!game.multiplayer && !game.replay) D.AI.tick(game, dt);
      if (!game._replaySeeking) {
        const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
        for (const o of owners) {
          D.Map.recomputeFog(game, o);
        }
      }
      D.Game.checkWinLoss(game);

      if (typeof performance !== 'undefined') {
        game.stats.simMs = performance.now() - t0;
      }
    },

    giveCredits(game, amount) {
      const o = D.Game.me(game);
      game.credits[o] = Math.min(game.spiceCap[o], game.credits[o] + amount);
      D.Game.pushMessage(game, '+' + amount + ' credits');
    },

    spawnEnemyArmy(game) {
      const foe = D.Game.foe(game);
      const cy = game.buildings.find(
        (b) => b.owner === D.Game.me(game) && b.type === 'constructionYard'
      );
      const px = cy ? cy.tileX + 8 : 20;
      const py = cy ? cy.tileY - 4 : 40;
      const types = ['infantry', 'infantry', 'trooper', 'trike', 'quad', 'combatTank'];
      for (let i = 0; i < types.length; i++) {
        D.Entities.createUnit(game, types[i], foe, px + (i % 3), py + Math.floor(i / 3));
      }
      D.Game.pushMessage(game, 'Debug army spawned.');
    },

    revealMap(game) {
      D.config.features.fog = false;
      const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
      for (const o of owners) D.Map.recomputeFog(game, o);
      D.Game.pushMessage(game, 'Fog disabled.');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
