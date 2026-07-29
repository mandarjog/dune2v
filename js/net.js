/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function roomLink(code) {
    const u = new URL(location.href);
    u.searchParams.set('room', code);
    return u.pathname + u.search + u.hash;
  }

  D.Net = {
    ws: null,
    game: null,
    status: 'idle', // idle | connecting | lobby | playing | error
    room: null,
    seat: null, // 'player' | 'enemy'
    role: null, // 'host' | 'guest' (lobby label only; sim is server)
    playerId: null,
    peers: 0,
    seats: {},
    lastError: null,
    _wantRoom: null,
    _createOnOpen: false,
    _handlers: [],
    _lastStateTick: -1,
    _focusedOnce: false,

    isMultiplayer(game) {
      return !!(game && game.multiplayer);
    },

    isHost(game) {
      return D.Net.isMultiplayer(game) && D.Net.role === 'host';
    },

    isGuest(game) {
      return D.Net.isMultiplayer(game) && D.Net.role === 'guest';
    },

    on(fn) {
      D.Net._handlers.push(fn);
      return () => {
        D.Net._handlers = D.Net._handlers.filter((h) => h !== fn);
      };
    },

    _emit(ev, data) {
      for (const h of D.Net._handlers) {
        try {
          h(ev, data);
        } catch (e) {
          console.warn('[net] handler', e);
        }
      }
    },

    init(game) {
      D.Net.game = game;
    },

    /** Connect and create a fresh room. */
    host() {
      D.Net._createOnOpen = true;
      D.Net._wantRoom = null;
      D.Net._connect();
    },

    /** Connect and join/create room code (shareable URL). */
    join(roomCode) {
      const code = String(roomCode || '')
        .trim()
        .toUpperCase();
      if (!code) {
        D.Net.lastError = 'Enter a room code';
        D.Net._emit('error', { error: 'bad_room' });
        return;
      }
      D.Net._createOnOpen = false;
      D.Net._wantRoom = code;
      D.Net._connect();
    },

    leave() {
      if (D.Net.ws && D.Net.ws.readyState === 1) {
        try {
          D.Net.ws.send(JSON.stringify({ type: 'leave' }));
        } catch (e) {
          /* ignore */
        }
        D.Net.ws.close();
      }
      D.Net.ws = null;
      D.Net.status = 'idle';
      D.Net.room = null;
      D.Net.seat = null;
      D.Net.role = null;
      D.Net.peers = 0;
      D.Net.seats = {};
      D.Net._lastStateTick = -1;
      D.Net._focusedOnce = false;
      if (D.Net.game) {
        D.Net.game.multiplayer = false;
        D.Net.game.netRole = null;
        D.Net.game.localOwner = 'player';
        D.Net.game._serverSim = false;
      }
      D.Net._emit('left');
    },

    _connect() {
      if (typeof WebSocket === 'undefined') {
        D.Net.lastError = 'WebSocket unavailable';
        D.Net.status = 'error';
        D.Net._emit('error', { error: 'no_ws' });
        return;
      }
      if (!location.host || location.protocol === 'file:') {
        D.Net.lastError = 'Multiplayer needs the game server (npm start / Fly)';
        D.Net.status = 'error';
        D.Net._emit('error', { error: 'no_host' });
        return;
      }

      if (D.Net.ws) {
        try {
          D.Net.ws.onclose = null;
          D.Net.ws.close();
        } catch (e) {
          /* ignore */
        }
        D.Net.ws = null;
      }

      D.Net.status = 'connecting';
      D.Net.lastError = null;
      D.Net._emit('status', { status: 'connecting' });

      let ws;
      try {
        ws = new WebSocket(wsUrl());
      } catch (e) {
        D.Net.lastError = String(e.message || e);
        D.Net.status = 'error';
        D.Net._emit('error', { error: 'connect_failed' });
        return;
      }
      D.Net.ws = ws;

      ws.onopen = () => {
        if (D.Net._createOnOpen) {
          ws.send(JSON.stringify({ type: 'create', playerId: D.Net.playerId }));
        } else if (D.Net._wantRoom) {
          ws.send(
            JSON.stringify({
              type: 'join',
              room: D.Net._wantRoom,
              playerId: D.Net.playerId,
            })
          );
        }
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        D.Net._onMessage(msg);
      };

      ws.onerror = () => {
        D.Net.lastError = 'Connection error';
      };

      ws.onclose = () => {
        const wasPlaying = D.Net.game && D.Net.game.multiplayer && D.Net.game.phase === 'playing';
        D.Net.ws = null;
        if (D.Net.status === 'idle') return;
        D.Net.status = wasPlaying ? 'error' : 'idle';
        if (wasPlaying) {
          D.Net.lastError = 'Disconnected from room';
          D.Game.pushMessage(D.Net.game, 'Disconnected from multiplayer room.');
          D.Net._emit('disconnect');
        }
      };
    },

    _onMessage(msg) {
      if (msg.type === 'hello') return;

      if (msg.type === 'error') {
        D.Net.lastError = msg.error || 'error';
        D.Net._emit('error', msg);
        if (msg.error === 'room_full') {
          D.Game.pushMessage(D.Net.game, 'Room is full (2 players max).');
        }
        return;
      }

      if (msg.type === 'joined') {
        D.Net.room = msg.room;
        D.Net.seat = msg.seat;
        D.Net.role = msg.role;
        D.Net.playerId = msg.playerId;
        D.Net.peers = msg.peers || 1;
        D.Net.seats = msg.seats || {};
        D.Net.status = 'lobby';
        const game = D.Net.game;
        if (game) {
          game.multiplayer = true;
          game.netRole = D.Net.role;
          game.localOwner = D.Net.seat || 'player';
          game.roomCode = D.Net.room;
        }
        try {
          const u = new URL(location.href);
          u.searchParams.set('room', D.Net.room);
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        } catch (e) {
          /* ignore */
        }
        D.Net._emit('joined', msg);
        return;
      }

      if (msg.type === 'peer_joined') {
        D.Net.peers = msg.peers || D.Net.peers;
        D.Net.seats = msg.seats || D.Net.seats;
        D.Net._emit('peer_joined', msg);
        return;
      }

      if (msg.type === 'peer_left') {
        D.Net.peers = msg.peers || 0;
        D.Net.seats = msg.seats || {};
        D.Net._emit('peer_left', msg);
        if (D.Net.game && D.Net.game.phase === 'playing') {
          D.Game.pushMessage(D.Net.game, 'Opponent disconnected — match paused on server.');
        }
        return;
      }

      if (msg.type === 'start') {
        D.Net._handleStart(msg);
        return;
      }

      if (msg.type === 'state') {
        D.Net._handleState(msg);
        return;
      }

      if (msg.type === 'match_end') {
        // phase arrives via state snapshots too
        return;
      }

      if (msg.type === 'cmd_result') {
        D.Net._handleCmdResult(msg);
        return;
      }

      // legacy: ignore client cmd relay
      if (msg.type === 'cmd') return;
    },

    _handleStart(msg) {
      const game = D.Net.game;
      if (!game) return;

      D.config.features.ai = false;
      if (D.Save) D.Save.clear();

      game.multiplayer = true;
      game.netRole = D.Net.role;
      game.localOwner = D.Net.seat || 'player';
      game.roomCode = D.Net.room;
      // Allow input immediately; first state fills the world
      if (game.phase === 'menu' || game.phase === 'lobby') game.phase = 'playing';
      D.Net.status = 'playing';
      D.Net._lastStateTick = -1;
      D.Net._focusedOnce = false;

      if (D.UI) {
        D.UI.hideMenu();
        D.UI.hideLobby && D.UI.hideLobby();
      }
      D.Game.pushMessage(
        game,
        game.localOwner === 'enemy'
          ? 'Match live — you are Harkonnen (red). Select your MCV and press E to deploy.'
          : 'Match live — you are Atreides (blue). Select your MCV and press E to deploy.'
      );
      D.Net._emit('match_started', { role: D.Net.role });
    },

    _handleState(msg) {
      const game = D.Net.game;
      if (!game || !game.multiplayer) return;
      if (!msg.payload) return;
      if (msg.tick != null && msg.tick < D.Net._lastStateTick) return;
      D.Net._lastStateTick = msg.tick != null ? msg.tick : D.Net._lastStateTick;

      const hadMap = !!game.map;
      const ok = D.Save.applyNetState(game, msg.payload, {
        localOwner: D.Net.seat || game.localOwner || 'player',
      });
      if (!ok) {
        console.warn('[net] applyNetState failed', msg.tick);
        return;
      }

      game.multiplayer = true;
      game.netRole = D.Net.role;
      game.localOwner = D.Net.seat || game.localOwner || 'player';
      game._serverSim = false;
      if (game.phase === 'menu') game.phase = 'playing';

      if (!hadMap && D.Renderer) {
        D.Renderer.rebuildTerrain(game);
        D.Net._focusSpawn(game);
      } else if (!D.Net._focusedOnce && game.map) {
        D.Net._focusSpawn(game);
      }
      // Do NOT invalidateSelection every snapshot — that destroys Deploy/produce buttons
      // mid-click. UI.refresh uses a signature and updates HUD cheaply.
      if (D.UI) {
        D.UI.hideMenu();
        D.UI.hideLobby && D.UI.hideLobby();
      }
    },

    _handleCmdResult(msg) {
      const game = D.Net.game;
      if (!game || !msg) return;
      if (msg.ok) {
        if (msg.info) D.Game.pushMessage(game, msg.info);
        return;
      }
      const reasons = {
        ids: 'No valid units for that order.',
        placement: 'Cannot deploy here — need rock (move MCV onto rock first).',
        rock: 'Cannot deploy here — need rock (move MCV onto rock first).',
        deploy: 'Deploy failed — MCV must sit on open rock.',
        building: 'Factory not ready.',
        credits: 'Not enough credits.',
        tech: 'Missing required building.',
        busy: 'Already constructing.',
        not_started: 'Match not started yet.',
        not_running: 'Server sim not running.',
      };
      const text = msg.message || reasons[msg.reason] || 'Order failed: ' + (msg.reason || '?');
      D.Game.pushMessage(game, text);
    },

    _focusSpawn(game) {
      if (!game.map) return;
      const owner = game.localOwner || 'player';
      const sp = game.map.spawns && game.map.spawns[owner];
      if (!sp) return;
      const t = D.config.TILE_SIZE;
      game.camera.x = sp.x * t - 400;
      game.camera.y = sp.y * t - 300;
      if (D.Renderer) D.Renderer.clampCamera(game);
      D.Net._focusedOnce = true;
    },

    _send(obj) {
      if (D.Net.ws && D.Net.ws.readyState === 1) {
        D.Net.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    },

    /**
     * Issue a gameplay command.
     * Multiplayer: always send to server (both seats).
     * Single-player: apply locally.
     */
    command(game, payload) {
      if (!payload || !payload.op) return { ok: false, reason: 'bad' };
      const owner = game.localOwner || 'player';

      if (game.multiplayer) {
        if (!D.Net._send({ type: 'cmd', payload })) {
          D.Game.pushMessage(game, 'Not connected to server.');
          return { ok: false, reason: 'disconnected' };
        }
        return { ok: true, deferred: true };
      }

      return D.Net.applyCommand(game, owner, payload);
    },

    applyCommand(game, seat, payload) {
      if (!game || !payload || !payload.op) return { ok: false, reason: 'bad' };
      const owner = seat === 'enemy' ? 'enemy' : 'player';

      function ownedIds(ids) {
        const out = [];
        for (const id of ids || []) {
          const e = D.Entities.getById(game, id);
          if (e && e.owner === owner && e.hp > 0) out.push(id);
        }
        return out;
      }

      switch (payload.op) {
        case 'order': {
          const ids = ownedIds(payload.ids);
          if (!ids.length) return { ok: false, reason: 'ids' };
          D.Orders.issue(game, ids, payload.order || { type: 'stop' });
          return { ok: true };
        }
        case 'stop': {
          const ids = ownedIds(payload.ids);
          if (!ids.length) return { ok: false, reason: 'ids' };
          D.Orders.stop(game, ids);
          return { ok: true };
        }
        case 'build': {
          return D.Economy.beginStructure(
            game,
            owner,
            payload.type,
            payload.tileX | 0,
            payload.tileY | 0
          );
        }
        case 'produce': {
          const b = game.buildings.find((x) => x.id === payload.buildingId);
          if (!b || b.owner !== owner) return { ok: false, reason: 'building' };
          return D.Economy.enqueueUnit(game, payload.buildingId, payload.unitType);
        }
        case 'cancelQueue': {
          const b = game.buildings.find((x) => x.id === payload.buildingId);
          if (!b || b.owner !== owner) return { ok: false, reason: 'building' };
          D.Economy.cancelQueue(game, payload.buildingId, payload.index | 0);
          return { ok: true };
        }
        case 'rally': {
          const b = game.buildings.find((x) => x.id === payload.buildingId);
          if (!b || b.owner !== owner) return { ok: false, reason: 'building' };
          D.Orders.setRally(game, payload.buildingId, payload.x, payload.y);
          return { ok: true };
        }
        default:
          return { ok: false, reason: 'unknown_op' };
      }
    },

    roomUrl() {
      if (!D.Net.room) return '';
      try {
        return location.origin + roomLink(D.Net.room);
      } catch {
        return roomLink(D.Net.room);
      }
    },

    sharePath() {
      return D.Net.room ? roomLink(D.Net.room) : '';
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
