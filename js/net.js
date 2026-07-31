/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function roomLink(code) {
    const c = String(code || '')
      .trim()
      .toUpperCase();
    if (!c) return '';
    try {
      // Clean absolute URL — drop spectate/replay/live params
      const u = new URL(location.href);
      u.search = '';
      u.hash = '';
      u.searchParams.set('room', c);
      return u.toString();
    } catch (e) {
      return (
        (location.origin || '') +
        (location.pathname || '/') +
        '?room=' +
        encodeURIComponent(c)
      );
    }
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
    seat: null, // 'player' | 'enemy' | null (spectator)
    role: null, // 'host' | 'guest' | 'spectator'
    playerId: null,
    name: 'Commander',
    peers: 0,
    seats: {},
    names: { player: null, enemy: null },
    spectators: 0,
    lastError: null,
    lastRecordingId: null,
    _wantRoom: null,
    _wantSpectate: false,
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

    /** Display name for a seat from last roster/start (raw name, no house prefix). */
    nameFor(seat) {
      if (D.Net.names && D.Net.names[seat]) return D.Net.names[seat];
      const s = D.Net.seats && D.Net.seats[seat];
      if (s && s.name) return s.name;
      if (D.Seats && D.Seats.houseName) return D.Seats.houseName(seat);
      return seat === 'enemy' ? 'Harkonnen' : 'Atreides';
    },

    /** House-Name label e.g. Ordos-Alex */
    labelFor(seat) {
      if (D.Seats && D.Seats.label) {
        return D.Seats.label(seat, D.Net.names || null);
      }
      return D.Net.nameFor(seat);
    },

    _applyRoster(msg) {
      if (msg.seats) D.Net.seats = msg.seats;
      if (msg.peers != null) D.Net.peers = msg.peers;
      if (msg.spectators != null) D.Net.spectators = msg.spectators;
      if (msg.owners) D.Net.owners = msg.owners;
      const names = {};
      if (D.Seats && D.Seats.IDS) {
        for (const id of D.Seats.IDS) names[id] = null;
      } else {
        names.player = null;
        names.enemy = null;
      }
      if (msg.seats) {
        for (const seat of Object.keys(msg.seats)) {
          if (msg.seats[seat] && msg.seats[seat].name) names[seat] = msg.seats[seat].name;
        }
      }
      if (msg.names) {
        for (const seat of Object.keys(msg.names)) {
          if (msg.names[seat]) names[seat] = msg.names[seat];
        }
      }
      D.Net.names = names;
      if (D.Net.game) {
        D.Net.game.playerNames = Object.assign({}, names);
        if (msg.owners && msg.owners.length) {
          D.Net.game.activeOwners = msg.owners.slice();
        }
      }
    },

    /** Host: start match with current lobby (2–5 players). */
    startMatch() {
      if (!D.Net.ws || D.Net.ws.readyState !== 1) return false;
      try {
        D.Net.ws.send(JSON.stringify({ type: 'start_match' }));
        return true;
      } catch (e) {
        return false;
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
      D.Net._wantSpectate = false;
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
      D.Net._wantSpectate = false;
      D.Net._wantRoom = code;
      D.Net._connect();
    },

    /**
     * Join a room as spectator (no seat, FOW off, no orders).
     * Receives the same state broadcasts as players.
     */
    spectate(roomCode, name) {
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
      D.Net._wantSpectate = true;
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
      D.Net.spectators = 0;
      D.Net._lastStateTick = -1;
      D.Net._focusedOnce = false;
      D.Net._reconnectAttempts = 0;
      D.Net._wantRoom = null;
      D.Net._wantSpectate = false;
      D.Net._createOnOpen = false;
      if (D.Net.game) {
        D.Net.game.multiplayer = false;
        D.Net.game.spectator = false;
        D.Net.game.netRole = null;
        D.Net.game.localOwner = 'player';
        D.Net.game._serverSim = false;
        D.Net.game.playerNames = null;
        D.Net.game.roomCode = null;
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
      // Keep spectator role across reconnect
      if (D.Net.role === 'spectator' || (D.Net.game && D.Net.game.spectator)) {
        D.Net._wantSpectate = true;
      }
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
        } else if (D.Net._wantRoom && D.Net._wantSpectate) {
          ws.send(
            JSON.stringify({
              type: 'spectate',
              room: D.Net._wantRoom,
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
          D.Game.pushMessage(
            D.Net.game,
            'Room is full (5 players max). Open Live matches to spectate.'
          );
        }
        if (msg.error === 'need_players') {
          D.Game.pushMessage(D.Net.game, 'Need at least 2 players to start.');
        } else if (msg.error === 'spectators_full') {
          D.Game.pushMessage(D.Net.game, 'Too many spectators in that room.');
        } else if (msg.error === 'no_room') {
          D.Game.pushMessage(D.Net.game, 'Room not found.');
        } else if (msg.error === 'spectate_off') {
          D.Game.pushMessage(D.Net.game, 'Spectating is disabled for that room.');
        }
        return;
      }

      if (msg.type === 'joined') {
        D.Net.room = msg.room;
        D.Net.seat = msg.seat != null ? msg.seat : null;
        D.Net.role = msg.role;
        const isSpec = msg.role === 'spectator' || msg.spectator === true;
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
        if (msg.spectators != null) D.Net.spectators = msg.spectators;
        D.Net._applyRoster(msg);
        D.Net._reconnectAttempts = 0;
        if (msg.reconnected || msg.started || isSpec) {
          D.Net.status = msg.started || isSpec ? 'playing' : 'lobby';
          if (msg.started || msg.reconnected) D.Net._lastStateTick = -1;
          if (isSpec && !msg.started) D.Net.status = 'lobby';
        } else {
          D.Net.status = 'lobby';
        }
        const game = D.Net.game;
        if (game) {
          game.multiplayer = true;
          game.spectator = isSpec;
          game.netRole = D.Net.role;
          // Spectators use 'player' for UI labels; FOW off via game.spectator
          game.localOwner = isSpec ? 'player' : D.Net.seat || 'player';
          game.roomCode = D.Net.room;
        }
        try {
          const u = new URL(location.href);
          if (isSpec) {
            u.searchParams.delete('room');
            u.searchParams.set('spectate', D.Net.room);
          } else {
            u.searchParams.delete('spectate');
            u.searchParams.set('room', D.Net.room);
          }
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        } catch (e) {
          /* ignore */
        }
        if (msg.reconnected) {
          D.Game.pushMessage(game, 'Reconnected to room ' + D.Net.room + '.');
        } else if (isSpec) {
          D.Game.pushMessage(
            game,
            'Spectating room ' + D.Net.room + (msg.started ? '' : ' (waiting for start)…')
          );
        }
        D.Net._emit('joined', msg);
        return;
      }

      if (msg.type === 'lobby_wait') {
        D.Net._applyRoster(msg);
        D.Net.status = 'lobby';
        D.Net._emit('lobby_wait', msg);
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
        if (msg.speed != null && D.Net.game) D.Net.game.netSpeed = msg.speed;
        D.Net._handleState(msg);
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

      if (msg.type === 'speed_request') {
        D.Net._emit('speed_request', msg);
        return;
      }
      if (msg.type === 'speed' || msg.type === 'speed_rejected') {
        if (msg.type === 'speed' && D.Net.game && msg.speed != null) {
          D.Net.game.netSpeed = msg.speed;
        }
        D.Net._emit(msg.type, msg);
        return;
      }

      if (msg.type === 'match_end') {
        if (msg.recordingId) {
          D.Net.lastRecordingId = msg.recordingId;
        }
        D.Net._emit('match_end', msg);
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

      const isSpec =
        D.Net.role === 'spectator' ||
        msg.role === 'spectator' ||
        msg.spectator === true ||
        !!game.spectator;

      game.multiplayer = true;
      game.spectator = isSpec;
      game.netRole = isSpec ? 'spectator' : D.Net.role;
      game.localOwner = isSpec ? 'player' : D.Net.seat || 'player';
      game.roomCode = D.Net.room;
      // Allow input immediately; first state fills the world
      if (game.phase === 'menu' || game.phase === 'lobby') game.phase = 'playing';
      D.Net.status = 'playing';
      D.Net._lastStateTick = -1;
      D.Net._focusedOnce = false;

      if (D.UI) {
        D.UI.hideMenu();
        D.UI.hideLobby && D.UI.hideLobby();
        D.UI.hideLiveMatches && D.UI.hideLiveMatches();
      }
      D.Net._applyRoster(msg);
      D.Net.status = 'playing';
      D.Net._reconnectAttempts = 0;
      if (msg.owners && msg.owners.length) {
        game.activeOwners = msg.owners.slice();
      }
      const roster = (msg.owners || Object.keys(D.Net.seats || {})).filter(Boolean);
      const rosterLabels = roster.map((s) => D.Net.labelFor(s)).join(' · ');
      if (isSpec) {
        D.Game.pushMessage(
          game,
          'SPECTATING · ' +
            (rosterLabels || 'match') +
            ' · room ' +
            (D.Net.room || '') +
            ' — FOW off, view only.'
        );
      } else {
        const meLabel = D.Net.labelFor(game.localOwner);
        if (msg.reconnected) {
          D.Game.pushMessage(game, 'Back in the match as ' + meLabel + '.');
        } else {
          D.Game.pushMessage(
            game,
            'You are ' +
              meLabel +
              (roster.length > 2 ? ' · FFA ' + roster.length + 'p' : '') +
              '. Select MCV, press E to deploy.'
          );
        }
      }
      D.Net._emit('match_started', {
        role: D.Net.role,
        reconnected: !!msg.reconnected,
        spectator: isSpec,
      });
    },

    _handleState(msg) {
      const game = D.Net.game;
      if (!game || !game.multiplayer || game.replay) return;
      if (!msg.payload) return;
      if (msg.tick != null && msg.tick < D.Net._lastStateTick) return;
      D.Net._lastStateTick = msg.tick != null ? msg.tick : D.Net._lastStateTick;

      const isSpec = !!(game.spectator || D.Net.role === 'spectator');
      const hadMap = !!game.map;
      const ok = D.Save.applyNetState(game, msg.payload, {
        localOwner: isSpec ? 'player' : D.Net.seat || game.localOwner || 'player',
      });
      if (!ok) {
        console.warn('[net] applyNetState failed', msg.tick);
        return;
      }

      game.multiplayer = true;
      game.spectator = isSpec;
      game.netRole = isSpec ? 'spectator' : D.Net.role;
      game.localOwner = isSpec ? 'player' : D.Net.seat || game.localOwner || 'player';
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
        D.UI.hideLiveMatches && D.UI.hideLiveMatches();
      }
    },

    _handleCmdResult(msg) {
      const game = D.Net.game;
      if (!game || !msg) return;
      if (msg.ok) {
        if (msg.info) D.Game.pushMessage(game, msg.info);
        return;
      }
      if (msg.reason === 'spectator') return; // silent for spectators
      const reasons = {
        ids: 'No valid units for that order.',
        placement: 'Cannot deploy here — need rock (move MCV onto rock first).',
        rock: 'Cannot deploy here — need rock (move MCV onto rock first).',
        deploy: 'Deploy failed — MCV must sit on open rock.',
        building: 'Factory not ready.',
        credits: 'Not enough credits.',
        tech: 'Missing required building.',
        busy: 'Construction queue full (3 max).',
        not_started: 'Match not started yet.',
        not_running: 'Server sim not running.',
        spectator: 'Spectators cannot issue orders.',
      };
      const text = msg.message || reasons[msg.reason] || 'Order failed: ' + (msg.reason || '?');
      D.Game.pushMessage(game, text);
    },

    _focusSpawn(game) {
      if (!game.map) return;
      // Spectators start at mid-map so both bases are closer to view
      if (game.spectator) {
        const t = D.config.TILE_SIZE;
        game.camera.x = (game.map.width * t) / 2 - 400;
        game.camera.y = (game.map.height * t) / 2 - 300;
        if (D.Renderer) D.Renderer.clampCamera(game);
        D.Net._focusedOnce = true;
        return;
      }
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
      if (game && (game.spectator || game.replay)) {
        return { ok: false, reason: game.spectator ? 'spectator' : 'replay' };
      }
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
      // roomLink already returns absolute URL
      return roomLink(D.Net.room);
    },

    sharePath() {
      if (!D.Net.room) return '';
      try {
        const u = new URL(D.Net.roomUrl());
        return u.pathname + u.search + u.hash;
      } catch (e) {
        return '/?room=' + encodeURIComponent(D.Net.room);
      }
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

    requestSpeed(speed) {
      if (!D.Net.game || !D.Net.game.multiplayer || D.Net.game.spectator) return false;
      return D.Net._send({ type: 'speed_request', speed: Number(speed) });
    },

    respondSpeed(accept) {
      return D.Net._send({ type: 'speed_response', accept: !!accept });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
