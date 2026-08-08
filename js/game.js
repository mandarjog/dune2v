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

    /** True when this seat has lost CY+MCV (mid-match FFA or final). */
    isEliminated(game, owner) {
      if (!game || !owner) return false;
      if (game.eliminated && game.eliminated[owner] != null) return true;
      return false;
    },

    /**
     * End-screen outcome from the local player's perspective.
     * Always prefer `game.winner` — never trust a host-relative phase alone
     * (server used to set phase from localOwner='player', which made every
     * non-player seat flip to "victory" in FFA).
     */
    localEndPhase(game) {
      if (
        game.phase !== 'victory' &&
        game.phase !== 'defeat' &&
        game.phase !== 'draw' &&
        game.phase !== 'ended'
      ) {
        return game.phase;
      }
      if (game.phase === 'draw') return 'draw';
      const me = D.Game.me(game);
      if (game.winner != null) {
        return game.winner === me ? 'victory' : 'defeat';
      }
      if (game.phase === 'ended') return 'draw';
      // Legacy 1v1 saves: phase victory meant Atreides (player seat) won
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
        wormState: null,
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
        /** seat -> tick when eliminated (no CY/MCV). Match may continue in FFA. */
        eliminated: {},
        /** Recent combat/system alerts for MP clients (under attack, elim). */
        alerts: [],
        ai: {
          state: 'Bootstrap',
          waveAt: 0,
          lastScoutTick: 0,
          memory: {},
        },
        messages: [],
        placement: null,
        /** Last train click: { buildingId, unitType } for sticky re-queue (Q / re-click). */
        stickyProduce: null,
        hoverTile: null,
        rngSeed: D.config.seed,
        stats: {
          fps: 0,
          simMs: 0,
          /** Last Orders.issue path batch (ms / count) */
          pathLastIssueMs: 0,
          pathLastIssueCount: 0,
          pathLastIssueOk: 0,
          pathLastBackend: 'astar',
          pathLastFlowBuildMs: 0,
          /** Repaths inside last Orders.tick */
          pathTickMs: 0,
          pathTickCount: 0,
        },
        _repathsThisTick: 0,
        // multiplayer
        localOwner: 'player',
        multiplayer: false,
        spectator: false,
        netRole: null,
        roomCode: null,
        playerNames: null,
        speedMult: (D.config.skirmish && D.config.skirmish.defaultSpeed) || 2,
        replay: false,
        netSpeed: (D.config.skirmish && D.config.skirmish.defaultSpeed) || 2,
      };
    },

    /**
     * Queue a short-lived alert for clients (chat HUD / flash).
     * @param {object} game
     * @param {{seat?:string, kind:string, text:string, x?:number, y?:number}} alert
     */
    pushAlert(game, alert) {
      if (!game || !alert || !alert.text) return;
      if (!game.alerts) game.alerts = [];
      game._alertSeq = (game._alertSeq || 0) + 1;
      game.alerts.push({
        id: game._alertSeq,
        seat: alert.seat || null,
        kind: alert.kind || 'info',
        text: String(alert.text).slice(0, 120),
        x: alert.x,
        y: alert.y,
        t: game.tick | 0,
      });
      // Keep a small rolling window for net snapshots
      if (game.alerts.length > 12) game.alerts = game.alerts.slice(-12);
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
     * @param {string} [opts.startMode] 'base' | 'mcv' (default from config.skirmish)
     */
    startSkirmish(game, mapDef, opts) {
      opts = opts || {};
      D.Entities.resetIds();
      // Match seed: opts.seed > config.seed (MP randomizes; SP keeps config default)
      const seed =
        opts.seed != null
          ? opts.seed >>> 0
          : D.config.seed != null
            ? D.config.seed >>> 0
            : 42;
      D.config.seed = seed;
      D.rng.seed(seed);
      game.rngSeed = seed;
      game.phase = 'playing';
      game.tick = 0;
      game.winner = null;
      game.eliminated = {};
      game.alerts = [];
      game._alertSeq = 0;
      game._underAttackAt = {};
      game.units = [];
      game.buildings = [];
      game.projectiles = [];
      game.fx = [];
      game.worms = [];
      game.wormState = null;
      if (D.Worms && D.Worms.ensureState) D.Worms.ensureState(game);
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

      // Default match speed (SP); MP server overrides via RoomSim
      if (!game.multiplayer) {
        const defSp =
          (D.config.skirmish && D.config.skirmish.defaultSpeed) || 2;
        game.speedMult = defSp;
      }

      const startMode =
        opts.startMode === 'mcv' || opts.startMode === 'base'
          ? opts.startMode
          : (D.config.skirmish && D.config.skirmish.startMode) || 'base';
      game.startMode = startMode;

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

      // Prefer a fresh procedural map when a generator is available and seed set
      let def = mapDef;
      if (
        (!def || def.id === 'skirmish_large') &&
        D.MAPS &&
        typeof D.MAPS.generateSkirmishLarge === 'function' &&
        opts.generateMap !== false
      ) {
        // MP always regenerates; SP regenerates when opts.seed provided
        if (opts.forceGenerate || opts.seed != null) {
          def = D.MAPS.generateSkirmishLarge(seed);
        } else if (!def) {
          def = D.MAPS.skirmish_large || D.MAPS.skirmish1;
        }
      }
      if (!def) def = D.MAPS.skirmish_large || D.MAPS.skirmish1;
      game.mapDefId = def.id || 'skirmish_large';
      game.map = D.Map.createFromDef(def);
      // Keep spawns from the def used (generator may jitter)
      mapDef = def;
      D.Map.initFog(game);

      if (startMode === 'mcv') {
        for (const o of owners) {
          const sp = D.Seats.spawnFor(mapDef, o);
          if (!sp) continue;
          D.Entities.createUnit(game, 'mcv', o, sp.x + 0.5, sp.y + 0.5);
        }
      } else {
        for (const o of owners) {
          D.Game.placeStarterBase(game, mapDef, o);
        }
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
      D.Economy.recalcSpiceCap(game);
      for (const o of owners) {
        D.Map.recomputeFog(game, o);
      }

      if (startMode === 'mcv') {
        D.Game.pushMessage(game, 'Deploy your MCV on rock to begin (E).');
      } else {
        D.Game.pushMessage(
          game,
          'Base online — CY, Windtrap, Refinery + harvester. Expand and harvest.'
        );
      }
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
        const meH = D.Seats.houseName(me);
        const foe = owners.find((o) => o !== me);
        const foeH = foe ? D.Seats.houseName(foe) : 'AI';
        D.Game.pushMessage(game, meH + ' vs ' + foeH + ' — harvest the spice.');
      }
    },

    /**
     * Find rock footprint near (nearX, nearY) for a building type.
     * @returns {{tx:number,ty:number}|null}
     */
    findStarterFootprint(game, type, owner, nearX, nearY, maxR) {
      maxR = maxR != null ? maxR : 12;
      const prefer = [];
      // Prefer tiles around the spawn first
      for (let r = 0; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const tx = nearX + dx;
            const ty = nearY + dy;
            if (
              D.Map.canPlace(game, type, tx, ty, owner, { skipProximity: true })
            ) {
              prefer.push({ tx, ty, d: dx * dx + dy * dy });
            }
          }
        }
        if (prefer.length) break;
      }
      if (!prefer.length) return null;
      prefer.sort((a, b) => a.d - b.d);
      return { tx: prefer[0].tx, ty: prefer[0].ty };
    },

    /**
     * CY + Windtrap + Refinery + free harvester on rock near seat spawn.
     */
    placeStarterBase(game, mapDef, owner) {
      const sp = D.Seats.spawnFor(mapDef, owner);
      if (!sp) return false;
      const cx = sp.x;
      const cy = sp.y;

      // CY: same 2×2 math as MCV deploy (centered on spawn tile)
      let cyPos = null;
      const tryCy = [
        { tx: cx - 1, ty: cy - 1 },
        { tx: cx, ty: cy - 1 },
        { tx: cx - 1, ty: cy },
        { tx: cx, ty: cy },
      ];
      for (const p of tryCy) {
        if (D.Map.canPlace(game, 'constructionYard', p.tx, p.ty, owner, { skipProximity: true })) {
          cyPos = p;
          break;
        }
      }
      if (!cyPos) {
        cyPos = D.Game.findStarterFootprint(game, 'constructionYard', owner, cx, cy, 14);
      }
      if (!cyPos) {
        // Last resort: MCV so the player is not soft-locked
        D.Entities.createUnit(game, 'mcv', owner, cx + 0.5, cy + 0.5);
        return false;
      }

      const yard = D.Entities.createBuilding(
        game,
        'constructionYard',
        owner,
        cyPos.tx,
        cyPos.ty,
        { complete: true }
      );
      if (game.structureBuilder) game.structureBuilder[owner] = yard.id;

      const anchorX = cyPos.tx + 1;
      const anchorY = cyPos.ty + 1;

      let wtPos = D.Game.findStarterFootprint(
        game,
        'windtrap',
        owner,
        anchorX + 2,
        anchorY,
        10
      );
      if (!wtPos) {
        wtPos = D.Game.findStarterFootprint(game, 'windtrap', owner, anchorX, anchorY, 14);
      }
      if (wtPos) {
        D.Entities.createBuilding(game, 'windtrap', owner, wtPos.tx, wtPos.ty, {
          complete: true,
        });
      }

      let refPos = D.Game.findStarterFootprint(
        game,
        'refinery',
        owner,
        anchorX,
        anchorY + 3,
        12
      );
      if (!refPos) {
        refPos = D.Game.findStarterFootprint(game, 'refinery', owner, anchorX, anchorY, 16);
      }
      let ref = null;
      if (refPos) {
        ref = D.Entities.createBuilding(game, 'refinery', owner, refPos.tx, refPos.ty, {
          complete: true,
        });
      }

      // Free harvester (refinery complete normally grants one)
      if (ref) {
        const spawn =
          D.Economy.spawnPoint && D.Economy.spawnPoint(game, ref)
            ? D.Economy.spawnPoint(game, ref)
            : {
                x: (ref.dockTileX != null ? ref.dockTileX : ref.tileX) + 0.5,
                y: (ref.dockTileY != null ? ref.dockTileY : ref.tileY + ref.tileH) + 0.5,
              };
        const h = D.Entities.createUnit(game, 'harvester', owner, spawn.x, spawn.y);
        const spice = D.Map.findNearestSpice(game.map, h.x, h.y);
        if (spice && D.Orders) {
          D.Orders.issue(game, [h.id], {
            type: 'harvest',
            tileX: spice.tx,
            tileY: spice.ty,
          });
        }
      }

      return true;
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
      if (!game.eliminated) game.eliminated = {};

      // Mid-match FFA elimination: mark seats that lost CY+MCV while others remain.
      for (const o of owners) {
        if (game.eliminated[o] != null) continue;
        if (!D.Game.isDefeated(game, o)) continue;
        game.eliminated[o] = game.tick;
        const label = D.Seats ? D.Seats.label(o, game.playerNames) : o;
        D.Game.pushMessage(game, label + ' has been eliminated!');
        D.Game.pushAlert(game, {
          seat: o,
          kind: 'eliminated',
          text: 'Your base has fallen — you are eliminated.',
        });
        // Inform everyone else once via global-ish alert (no seat = all clients)
        D.Game.pushAlert(game, {
          seat: null,
          kind: 'elim_notice',
          text: label + ' has been eliminated!',
        });
      }

      const alive = owners.filter((o) => !D.Game.isDefeated(game, o));

      if (alive.length >= 2) return;

      // Replay re-sim can desync (missing cmds / id drift). Recorded end+winner
      // is authoritative — do not flip to draw/ended mid-stream or spam Victory.
      if (game.replay) return;

      if (alive.length === 1) {
        game.winner = alive[0];
        // Neutral end phase for MP/server: clients derive victory/defeat from winner.
        // SP keeps classic victory/defeat so old UI paths and saves still work.
        const me = D.Game.me(game);
        if (game.multiplayer || game._serverSim) {
          game.phase = 'ended';
        } else {
          game.phase = game.winner === me ? 'victory' : 'defeat';
        }
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
        D.Game.pushAlert(game, {
          seat: null,
          kind: 'match_end',
          text:
            local === 'victory'
              ? 'Victory! ' + winLabel + ' controls Arrakis.'
              : winLabel + ' wins the match.',
        });
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
      if (D.Worms) D.Worms.tick(game, dt);
      if (!game.multiplayer && !game.replay) D.AI.tick(game, dt);
      // FOW: full recompute is O(units × sight²). Always update local view;
      // stagger other owners when unit count is high OR FFA (3+ seats) on server.
      if (!game._replaySeeking) {
        const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
        const nUnits = game.units ? game.units.length : 0;
        const local = game.localOwner || 'player';
        D.Map.recomputeFog(game, local);
        const others = owners.filter((o) => o !== local);
        const stagger =
          others.length > 0 &&
          (nUnits > 40 ||
            owners.length >= 3 ||
            (game.multiplayer && game._serverSim && nUnits > 20));
        if (stagger) {
          D.Map.recomputeFog(game, others[game.tick % others.length]);
        } else {
          for (const o of others) D.Map.recomputeFog(game, o);
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
