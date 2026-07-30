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

  const NAME_KEY = 'dune2_player_name';
  const PLAYER_ID_KEY = 'dune2_player_id';
  const NAME_MAX = 20;

  function sanitizeName(raw) {
    let s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NAME_MAX)
      .replace(/[<>]/g, '');
    return s || 'Commander';
  }

  function genPlayerId() {
    return (
      'p_' +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6)
    );
  }

  D.Net = {
    ws: null,
    game: null,
    status: 'idle', // idle | connecting | lobby | playing | error | reconnecting
    room: null,
    seat: null, // 'player' | 'enemy'
    role: null, // 'host' | 'guest' (lobby label only; sim is server)
    playerId: null,
    name: 'Commander',
    peers: 0,
    seats: {},
    names: { player: null, enemy: null },
    lastError: null,
    _wantRoom: null,
    _createOnOpen: false,
    _handlers: [],
    _lastStateTick: -1,
    _focusedOnce: false,
    _intentionalLeave: false,
    _reconnectAttempts: 0,
    _reconnectTimer: 0,

    loadStoredName() {
      try {
        const n = localStorage.getItem(NAME_KEY);
        if (n) D.Net.name = sanitizeName(n);
      } catch (e) {
        /* ignore */
      }
      return D.Net.name;
    },

    saveName(raw) {
      D.Net.name = sanitizeName(raw);
      try {
        localStorage.setItem(NAME_KEY, D.Net.name);
      } catch (e) {
        /* ignore */
      }
      return D.Net.name;
    },

    /** Stable id across refreshes so the server can reclaim your seat. */
    loadPlayerId() {
      try {
        let id = localStorage.getItem(PLAYER_ID_KEY);
        if (!id || id.length < 4) {
          id = genPlayerId();
          localStorage.setItem(PLAYER_ID_KEY, id);
        }
        D.Net.playerId = id;
        return id;
      } catch (e) {
        if (!D.Net.playerId) D.Net.playerId = genPlayerId();
        return D.Net.playerId;
      }
    },

    /** Display name for a seat from last roster/start. */
    nameFor(seat) {
      if (D.Net.names && D.Net.names[seat]) return D.Net.names[seat];
      const s = D.Net.seats && D.Net.seats[seat];
      if (s && s.name) return s.name;
      return seat === 'enemy' ? 'Harkonnen' : 'Atreides';
    },

    _applyRoster(msg) {
      if (msg.seats) D.Net.seats = msg.seats;
      if (msg.peers != null) D.Net.peers = msg.peers;
      const names = { player: null, enemy: null };
      if (msg.seats) {
        if (msg.seats.player && msg.seats.player.name) names.player = msg.seats.player.name;
        if (msg.seats.enemy && msg.seats.enemy.name) names.enemy = msg.seats.enemy.name;
      }
      if (msg.names) {
        if (msg.names.player) names.player = msg.names.player;
        if (msg.names.enemy) names.enemy = msg.names.enemy;
      }
      D.Net.names = names;
      if (D.Net.game) {
        D.Net.game.playerNames = {
          player: names.player || 'Atreides',
          enemy: names.enemy || 'Harkonnen',
        };
      }
    },

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
      D.Net.loadStoredName();
      D.Net.loadPlayerId();
    },

    /** Connect and create a fresh room. */
    host(name) {
      if (name != null) D.Net.saveName(name);
      else D.Net.loadStoredName();
      D.Net.loadPlayerId();
      D.Net._intentionalLeave = false;
      D.Net._createOnOpen = true;
      D.Net._wantRoom = null;
      D.Net._connect();
    },

    /** Connect and join/create room code (shareable URL). Same playerId reclaims seat. */
    join(roomCode, name) {
      const code = String(roomCode || '')
        .trim()
        .toUpperCase();
      if (!code) {
        D.Net.lastError = 'Enter a room code';
        D.Net._emit('error', { error: 'bad_room' });
        return;
      }
      if (name != null) D.Net.saveName(name);
      else D.Net.loadStoredName();
      D.Net.loadPlayerId();
      D.Net._intentionalLeave = false;
      D.Net._createOnOpen = false;
      D.Net._wantRoom = code;
      D.Net._connect();
    },

    leave() {
      D.Net._intentionalLeave = true;
      D.Net._clearReconnectTimer();
      if (D.Net.ws && D.Net.ws.readyState === 1) {
        try {
          D.Net.ws.send(JSON.stringify({ type: 'leave' }));
        } catch (e) {
          /* ignore */
        }
        try {
          D.Net.ws.onclose = null;
          D.Net.ws.close();
        } catch (e) {
          /* ignore */
        }
      }
      D.Net.ws = null;
      D.Net.status = 'idle';
      D.Net.room = null;
      D.Net.seat = null;
      D.Net.role = null;
      D.Net.peers = 0;
      D.Net.seats = {};
      D.Net.names = { player: null, enemy: null };
      D.Net._lastStateTick = -1;
      D.Net._focusedOnce = false;
      D.Net._reconnectAttempts = 0;
      D.Net._wantRoom = null;
      D.Net._createOnOpen = false;
      if (D.Net.game) {
        D.Net.game.multiplayer = false;
        D.Net.game.netRole = null;
        D.Net.game.localOwner = 'player';
        D.Net.game._serverSim = false;
        D.Net.game.playerNames = null;
      }
      D.Net._emit('left');
    },

    _clearReconnectTimer() {
      if (D.Net._reconnectTimer) {
        clearTimeout(D.Net._reconnectTimer);
        D.Net._reconnectTimer = 0;
      }
    },

    /** After an unexpected drop mid-match, rejoin same room with same playerId. */
    _scheduleReconnect() {
      D.Net._clearReconnectTimer();
      if (D.Net._intentionalLeave) return;
      const room = D.Net.room || D.Net._wantRoom;
      if (!room) return;
      if (D.Net._reconnectAttempts >= 8) {
        D.Net.status = 'error';
        D.Net.lastError = 'Could not reconnect';
        D.Game.pushMessage(D.Net.game, 'Reconnect failed. Re-open the room link to try again.');
        D.Net._emit('disconnect');
        return;
      }
      D.Net._reconnectAttempts++;
      D.Net.status = 'reconnecting';
      D.Net._wantRoom = room;
      D.Net._createOnOpen = false;
      const delay = Math.min(1000 * D.Net._reconnectAttempts, 5000);
      D.Game.pushMessage(
        D.Net.game,
        'Connection lost — reconnecting to room ' + room + '… (' + D.Net._reconnectAttempts + ')'
      );
      D.Net._emit('status', { status: 'reconnecting' });
      D.Net._reconnectTimer = setTimeout(() => {
        D.Net._reconnectTimer = 0;
        D.Net._connect();
      }, delay);
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
        const name = D.Net.name || D.Net.loadStoredName();
        const playerId = D.Net.loadPlayerId();
        if (D.Net._createOnOpen) {
          ws.send(
            JSON.stringify({
              type: 'create',
              playerId,
              name,
            })
          );
        } else if (D.Net._wantRoom) {
          ws.send(
            JSON.stringify({
              type: 'join',
              room: D.Net._wantRoom,
              playerId,
              name,
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
        D.Net.ws = null;
        if (D.Net.status === 'idle' || D.Net._intentionalLeave) return;
        const inMatch =
          D.Net.game &&
          D.Net.game.multiplayer &&
          (D.Net.game.phase === 'playing' ||
            D.Net.status === 'playing' ||
            D.Net.status === 'lobby' ||
            D.Net.status === 'reconnecting');
        if (inMatch && (D.Net.room || D.Net._wantRoom)) {
          D.Net._scheduleReconnect();
        } else {
          D.Net.status = 'error';
          D.Net.lastError = 'Disconnected from room';
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
        if (msg.playerId) {
          D.Net.playerId = msg.playerId;
          try {
            localStorage.setItem(PLAYER_ID_KEY, msg.playerId);
          } catch (e) {
            /* ignore */
          }
        }
        if (msg.name) D.Net.name = msg.name;
        D.Net.peers = msg.peers || 1;
        D.Net._applyRoster(msg);
        D.Net._reconnectAttempts = 0;
        if (msg.reconnected || msg.started) {
          D.Net.status = 'playing';
          D.Net._lastStateTick = -1; // accept full resync
        } else {
          D.Net.status = 'lobby';
        }
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
        if (msg.reconnected) {
          D.Game.pushMessage(game, 'Reconnected to room ' + D.Net.room + '.');
        }
        D.Net._emit('joined', msg);
        return;
      }

      if (
        msg.type === 'peer_joined' ||
        msg.type === 'peer_reconnected' ||
        msg.type === 'roster' ||
        msg.type === 'name_ok'
      ) {
        if (msg.name && msg.type === 'name_ok') D.Net.name = msg.name;
        D.Net._applyRoster(msg);
        if (msg.type === 'peer_reconnected' && D.Net.game) {
          D.Game.pushMessage(
            D.Net.game,
            (msg.name || 'Opponent') + ' reconnected.'
          );
        }
        D.Net._emit(
          msg.type === 'peer_joined' || msg.type === 'peer_reconnected'
            ? msg.type
            : 'roster',
          msg
        );
        return;
      }

      if (msg.type === 'peer_left' || msg.type === 'peer_disconnected') {
        D.Net.peers = msg.peers || 0;
        D.Net._applyRoster(msg);
        D.Net._emit(msg.type, msg);
        if (D.Net.game && D.Net.game.phase === 'playing') {
          const who = msg.name || 'Opponent';
          if (msg.type === 'peer_disconnected') {
            D.Game.pushMessage(
              D.Net.game,
              who + ' disconnected — they can rejoin with the same room link.'
            );
          } else {
            D.Game.pushMessage(D.Net.game, who + ' left the room.');
          }
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

      if (msg.type === 'chat') {
        D.Net._emit('chat', msg);
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
      D.Net._applyRoster(msg);
      D.Net.status = 'playing';
      D.Net._reconnectAttempts = 0;
      const meName = D.Net.nameFor(game.localOwner);
      const foeSeat = game.localOwner === 'player' ? 'enemy' : 'player';
      const foeName = D.Net.nameFor(foeSeat);
      const house = game.localOwner === 'enemy' ? 'Harkonnen (red)' : 'Atreides (blue)';
      if (msg.reconnected) {
        D.Game.pushMessage(
          game,
          'Back in the match as ' + meName + ' (' + house + ').'
        );
      } else {
        D.Game.pushMessage(
          game,
          meName + ' vs ' + foeName + ' — you are ' + house + '. Select MCV, press E to deploy.'
        );
      }
      D.Net._emit('match_started', { role: D.Net.role, reconnected: !!msg.reconnected });
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

    /** Send a chat line to the room (both seats receive, including sender). */
    sendChat(text) {
      const t = String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      if (!t) return false;
      if (!D.Net.game || !D.Net.game.multiplayer) return false;
      return D.Net._send({ type: 'chat', text: t });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
