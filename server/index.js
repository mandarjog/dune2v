'use strict';

/**
 * Fly-friendly game host:
 *  - Serves the static browser client (index.html, js/, css/, …)
 *  - WebSocket /ws — multiplayer rooms (2–5 FFA seats + spectators)
 *
 * Env:
 *   PORT          listen port (Fly sets this; default 8080)
 *   HOST          bind address (default 0.0.0.0)
 *   STATIC_ROOT   override static directory (default repo root)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomSim, SPEED_OPTIONS } = require('./room-sim');
const recordings = require('./recordings');
const feedbackStore = require('./feedback-store');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(__dirname, '..');

const PROTOCOL = 7; // 2–5 player FFA seats
const MAX_SEATS = 5;
const MIN_START = 2;
const MAX_SPECTATORS = 8;
/** Seat order: first two keep legacy ids for save/replay compat. */
const SEAT_ORDER = ['player', 'enemy', 'p2', 'p3', 'p4'];
const HOUSE_CYCLE = ['Atreides', 'Harkonnen', 'Ordos'];
const ROOM_CODE_LEN = 6;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 60 * 60 * 1000;
/** Keep a disconnected seat reserved so the same playerId can reclaim it. */
const RECONNECT_GRACE_MS = 15 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function readJsonBody(req, limit = 8000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  // Strip query string first — shareable MP links are /?room=CODE
  let urlPath = (req.url || '/').split('?')[0] || '/';
  if (urlPath === '/health' || urlPath === '/healthz') {
    return send(
      res,
      200,
      JSON.stringify({
        ok: true,
        service: 'dune2v',
        protocol: PROTOCOL,
        rooms: rooms.size,
        feedback: feedbackStore.count(),
      }),
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }
    );
  }

  if (urlPath === '/api/recordings' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ ok: true, recordings: recordings.list() }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  // Ops: force prune 0-cmd / orphan recordings
  if (urlPath === '/api/recordings/prune' && (req.method === 'POST' || req.method === 'GET')) {
    const r = runRecordingCleanup('api');
    return send(
      res,
      200,
      JSON.stringify({
        ok: true,
        removed: (r && r.removed) || [],
        kept: r ? r.kept : 0,
      }),
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }
    );
  }

  // Live in-progress (or lobby) matches for spectate list
  if (urlPath === '/api/live' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ ok: true, matches: listLiveMatches() }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  // Optional: dump recent feedback (not linked in UI; for ops)
  if (urlPath === '/api/feedback' && req.method === 'GET') {
    return send(
      res,
      200,
      JSON.stringify({ ok: true, count: feedbackStore.count(), path: feedbackStore.feedbackPath() }),
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    );
  }

  if (urlPath.startsWith('/api/recordings/') && req.method === 'GET') {
    const id = decodeURIComponent(urlPath.slice('/api/recordings/'.length)).replace(
      /[^a-zA-Z0-9_-]/g,
      ''
    );
    const rec = recordings.get(id);
    if (!rec) {
      return send(res, 404, JSON.stringify({ ok: false, error: 'not_found' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    return send(res, 200, JSON.stringify({ ok: true, recording: rec }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  if (urlPath === '/api/feedback' && req.method === 'POST') {
    return readJsonBody(req)
      .then((body) => {
        const text = String(body.text || body.message || '')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
          .trim()
          .slice(0, 2000);
        const contact = String(body.contact || '')
          .replace(/[\u0000-\u001f]/g, '')
          .trim()
          .slice(0, 120);
        if (text.length < 3) {
          return send(
            res,
            400,
            JSON.stringify({ ok: false, error: 'empty' }),
            { 'Content-Type': 'application/json; charset=utf-8' }
          );
        }
        const entry = {
          at: Date.now(),
          text,
          contact,
          ua: String(req.headers['user-agent'] || '').slice(0, 200),
          ip: String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '').slice(0, 80),
          room: body.room ? String(body.room).slice(0, 32) : null,
          href: body.href ? String(body.href).slice(0, 300) : null,
        };
        const saved = feedbackStore.append(entry);
        console.log(
          `[feedback] ${new Date(entry.at).toISOString()} disk=${saved} contact=${contact || '-'} ${text.slice(0, 120)}`
        );
        return send(
          res,
          200,
          JSON.stringify({ ok: true, saved }),
          {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          }
        );
      })
      .catch((err) => {
        const code = err && err.message === 'too_large' ? 413 : 400;
        return send(
          res,
          code,
          JSON.stringify({ ok: false, error: String(err.message || err) }),
          { 'Content-Type': 'application/json; charset=utf-8' }
        );
      });
  }

  if (urlPath.startsWith('/ws')) {
    return send(res, 426, 'Upgrade Required', { 'Content-Type': 'text/plain' });
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) send(res, 500, 'Read error');
      else res.destroy();
    });
  });
}

// ─── Rooms (server-authoritative sim + reconnect) ──────────
/**
 * @typedef {{
 *   playerId: string,
 *   name: string,
 *   role: string,
 *   ws: import('ws').WebSocket | null,
 *   connected: boolean,
 *   disconnectedAt: number | null,
 * }} SeatSlot
 * @typedef {{
 *   playerId: string,
 *   name: string,
 *   ws: import('ws').WebSocket | null,
 *   connected: boolean,
 * }} SpecSlot
 * @typedef {{
 *   id: string,
 *   slots: Map<string, SeatSlot>,
 *   spectators: Map<string, SpecSlot>,
 *   started: boolean,
 *   touched: number,
 *   createdAt: number,
 *   sim: import('./room-sim').RoomSim | null,
 *   allowSpectate: 'open' | 'off',
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

function genRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_ALPHABET[(Math.random() * ROOM_ALPHABET.length) | 0];
  }
  return code;
}

function uniqueRoomCode() {
  for (let i = 0; i < 40; i++) {
    const c = genRoomCode();
    if (!rooms.has(c)) return c;
  }
  return genRoomCode() + Date.now().toString(36).slice(-3).toUpperCase();
}

const NAME_MAX = 20;

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  s = s.replace(/[<>]/g, '');
  return s || 'Commander';
}

function sanitizePlayerId(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40);
  return s || `p_${Math.random().toString(36).slice(2, 10)}`;
}

function spectatorCount(room) {
  if (!room || !room.spectators) return 0;
  let n = 0;
  for (const s of room.spectators.values()) if (s.connected && s.ws) n++;
  return n;
}

function houseForSeat(seat) {
  const i = SEAT_ORDER.indexOf(seat);
  return HOUSE_CYCLE[((i % 3) + 3) % 3];
}

function roomNames(room) {
  const names = {};
  for (const seat of SEAT_ORDER) {
    const slot = room.slots.get(seat);
    // Store raw player names; client prefixes house (Ordos-Alex)
    names[seat] = (slot && slot.name) || houseForSeat(seat);
  }
  return names;
}

function orderedConnectedOwners(room) {
  return SEAT_ORDER.filter((seat) => {
    const slot = room.slots.get(seat);
    return slot && slot.connected;
  });
}

function roomSnapshot(room) {
  const seats = {};
  let connected = 0;
  for (const [seat, slot] of room.slots) {
    seats[seat] = {
      playerId: slot.playerId,
      role: slot.role,
      name: slot.name || 'Commander',
      connected: !!slot.connected,
    };
    if (slot.connected) connected++;
  }
  const reclaimable = [...room.slots.values()].some(
    (s) => !s.connected && s.disconnectedAt && Date.now() - s.disconnectedAt < RECONNECT_GRACE_MS
  );
  const specs = spectatorCount(room);
  const names = roomNames(room);
  let phase = null;
  let tick = null;
  if (room.sim) {
    phase = room.sim.phase || null;
    tick = room.sim.tick;
  } else if (room.started) {
    phase = 'ended';
  }
  const spectateOpen =
    (room.allowSpectate || 'open') !== 'off' && specs < MAX_SPECTATORS;
  return {
    room: room.id,
    peers: connected,
    players: connected,
    seats,
    names,
    started: room.started,
    open: room.slots.size < MAX_SEATS || reclaimable,
    spectateOpen,
    spectators: specs,
    phase,
    tick,
    authority: 'server',
    reconnectGraceMs: RECONNECT_GRACE_MS,
  };
}

/** Public list for GET /api/live — non-empty rooms (lobby or in-progress). */
function listLiveMatches() {
  const matches = [];
  const now = Date.now();
  for (const room of rooms.values()) {
    const players = connectedCount(room);
    const specs = spectatorCount(room);
    // Show rooms with at least one connected client or a running match
    if (players < 1 && specs < 1 && !room.started) continue;
    const snap = roomSnapshot(room);
    matches.push({
      room: snap.room,
      names: snap.names,
      started: snap.started,
      phase: snap.phase,
      players: snap.players,
      spectators: snap.spectators,
      open: snap.spectateOpen,
      tick: snap.tick,
      ageMs: Math.max(0, now - (room.createdAt || room.touched || now)),
    });
  }
  // Started matches first, then by most recent activity
  matches.sort((a, b) => {
    if (a.started !== b.started) return a.started ? -1 : 1;
    return (b.tick || 0) - (a.tick || 0);
  });
  return matches;
}

function makeRoom(id) {
  const now = Date.now();
  return {
    id,
    slots: new Map(),
    spectators: new Map(),
    started: false,
    touched: now,
    createdAt: now,
    sim: null,
    allowSpectate: 'open',
  };
}

function isSpectatorWs(ws) {
  return !!(ws && (ws.role === 'spectator' || ws.isSpectator));
}

/** Send JSON wire to every connected player seat and spectator. */
function forEachClient(room, fn) {
  if (!room) return;
  for (const slot of room.slots.values()) {
    if (slot.ws && slot.ws.readyState === 1) fn(slot.ws);
  }
  if (room.spectators) {
    for (const spec of room.spectators.values()) {
      if (spec.ws && spec.ws.readyState === 1) fn(spec.ws);
    }
  }
}

function getRoom(id) {
  return rooms.get(String(id || '').toUpperCase()) || null;
}

function touch(room) {
  if (room) room.touched = Date.now();
}

function stopSim(room) {
  if (room && room.sim) {
    room.sim.stop();
    room.sim = null;
  }
}

function destroyRoom(room) {
  if (!room) return;
  stopSim(room);
  rooms.delete(room.id);
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, exceptWs) {
  const payload = JSON.stringify(obj);
  forEachClient(room, (ws) => {
    if (ws !== exceptWs) ws.send(payload);
  });
}

function connectedCount(room) {
  let n = 0;
  for (const s of room.slots.values()) if (s.connected) n++;
  return n;
}

function ensureHostRole(room) {
  let hasHost = false;
  for (const s of room.slots.values()) {
    if (s.role === 'host' && s.connected) hasHost = true;
  }
  if (!hasHost) {
    for (const s of room.slots.values()) {
      if (s.connected) {
        s.role = 'host';
        if (s.ws) s.ws.role = 'host';
        break;
      }
    }
  }
}

/**
 * Detach a websocket from its seat or spectator slot.
 * @param intentional if true, free the seat; if false (drop), reserve for reconnect (players only)
 */
function detachWs(ws, intentional) {
  const room = ws.roomRef;
  if (!room) return null;
  const seat = ws.seat;
  const playerId = ws.playerId;
  const name = ws.displayName;
  const wasSpectator = isSpectatorWs(ws);

  if (wasSpectator) {
    if (room.spectators && playerId) {
      const spec = room.spectators.get(playerId);
      if (spec && spec.ws === ws) {
        room.spectators.delete(playerId);
      }
    }
    ws.roomRef = null;
    ws.seat = null;
    ws.role = null;
    ws.isSpectator = false;

    // Spectators never keep a room alive alone
    if (room.slots.size === 0) {
      destroyRoom(room);
      return {
        roomId: room.id,
        empty: true,
        seat: null,
        playerId,
        name,
        intentional: !!intentional,
        spectator: true,
      };
    }
    if (!room.started && connectedCount(room) === 0) {
      destroyRoom(room);
      return {
        roomId: room.id,
        empty: true,
        seat: null,
        playerId,
        name,
        intentional: !!intentional,
        spectator: true,
      };
    }
    touch(room);
    return {
      roomId: room.id,
      empty: false,
      seat: null,
      playerId,
      name,
      intentional: !!intentional,
      spectator: true,
      room,
    };
  }

  const slot = seat ? room.slots.get(seat) : null;

  if (slot && slot.ws === ws) {
    slot.ws = null;
    slot.connected = false;
    slot.disconnectedAt = Date.now();
  }

  ws.roomRef = null;
  ws.seat = null;
  ws.role = null;
  ws.isSpectator = false;

  if (intentional && seat) {
    room.slots.delete(seat);
  }

  // No player seats left → destroy (spectators dropped with room)
  if (room.slots.size === 0) {
    if (room.spectators) {
      for (const spec of room.spectators.values()) {
        try {
          if (spec.ws) {
            sendJson(spec.ws, { type: 'left', reason: 'room_closed' });
            spec.ws.roomRef = null;
            spec.ws.close();
          }
        } catch {
          /* ignore */
        }
      }
      room.spectators.clear();
    }
    destroyRoom(room);
    return { roomId: room.id, empty: true, seat, playerId, name, intentional: !!intentional };
  }

  // Lobby with nobody connected → destroy
  if (!room.started && connectedCount(room) === 0) {
    destroyRoom(room);
    return { roomId: room.id, empty: true, seat, playerId, name, intentional: !!intentional };
  }

  ensureHostRole(room);
  touch(room);
  return {
    roomId: room.id,
    empty: false,
    seat,
    playerId,
    name,
    intentional: !!intentional,
    room,
  };
}

function bindSeat(ws, room, seat, playerId, name, role) {
  // Drop any previous room association without freeing (shouldn't happen)
  if (ws.roomRef && ws.roomRef !== room) {
    detachWs(ws, true);
  }
  // Leave spectator slot if switching to a player seat in same room
  if (ws.roomRef === room && isSpectatorWs(ws)) {
    detachWs(ws, true);
  }

  const existing = room.slots.get(seat);
  if (existing && existing.ws && existing.ws !== ws && existing.ws.readyState === 1) {
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
  }

  const slot = {
    playerId,
    name,
    role: role || (seat === 'player' ? 'host' : 'guest'),
    ws,
    connected: true,
    disconnectedAt: null,
  };
  room.slots.set(seat, slot);
  // Player seat takes priority — drop any spectator entry for this id
  if (room.spectators && room.spectators.has(playerId)) {
    const prev = room.spectators.get(playerId);
    if (prev && prev.ws && prev.ws !== ws) {
      try {
        prev.ws.roomRef = null;
        prev.ws.close();
      } catch {
        /* ignore */
      }
    }
    room.spectators.delete(playerId);
  }

  ws.roomRef = room;
  ws.seat = seat;
  ws.role = slot.role;
  ws.playerId = playerId;
  ws.displayName = name;
  ws.isSpectator = false;
  touch(room);
  return slot;
}

function bindSpectator(ws, room, playerId, name) {
  if (ws.roomRef && ws.roomRef !== room) {
    detachWs(ws, true);
  } else if (ws.roomRef === room && !isSpectatorWs(ws) && ws.seat) {
    // Leaving a player seat to spectate (unusual) — free seat
    detachWs(ws, true);
  }

  if (!room.spectators) room.spectators = new Map();

  const existing = room.spectators.get(playerId);
  if (existing && existing.ws && existing.ws !== ws && existing.ws.readyState === 1) {
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
  }

  const slot = {
    playerId,
    name,
    ws,
    connected: true,
  };
  room.spectators.set(playerId, slot);

  ws.roomRef = room;
  ws.seat = null;
  ws.role = 'spectator';
  ws.playerId = playerId;
  ws.displayName = name;
  ws.isSpectator = true;
  touch(room);
  return slot;
}

function findReclaimSeat(room, playerId) {
  if (!playerId) return null;
  for (const [seat, slot] of room.slots) {
    if (slot.playerId === playerId) return seat;
  }
  return null;
}

function findOpenSeat(room) {
  for (const seat of SEAT_ORDER) {
    if (!room.slots.has(seat)) return seat;
    const slot = room.slots.get(seat);
    // Expired reservation — free for a new player
    if (
      !slot.connected &&
      slot.disconnectedAt &&
      Date.now() - slot.disconnectedAt >= RECONNECT_GRACE_MS
    ) {
      room.slots.delete(seat);
      return seat;
    }
  }
  return null;
}

function sendMatchSync(ws, room, { reconnected, spectator }) {
  const snap = roomSnapshot(room);
  const names = snap.names || roomNames(room);
  sendJson(ws, {
    type: 'start',
    seed: 42,
    map: 'skirmish_large',
    authority: 'server',
    reconnected: !!reconnected,
    spectator: !!spectator || isSpectatorWs(ws),
    ...snap,
    names,
  });
  if (room.sim) {
    const payload = room.sim.snapshot();
    if (payload) {
      sendJson(ws, {
        type: 'state',
        tick: room.sim.tick,
        payload,
        speed: room.sim.speed,
        ts: Date.now(),
        reconnected: !!reconnected,
      });
    }
  }
}

/**
 * Start when forced by host (2+ players) or room is full (5 connected).
 * Does not auto-start at 2 so a third–fifth player can join the lobby first.
 */
function maybeStartMatch(room, opts) {
  opts = opts || {};
  if (!room || room.started) return false;
  const n = connectedCount(room);
  if (n < MIN_START) return false;
  if (!opts.force && n < MAX_SEATS) return false;
  return startMatchNow(room, opts);
}

function startMatchNow(room, opts) {
  opts = opts || {};
  if (!room || room.started) return false;
  const owners = orderedConnectedOwners(room);
  if (owners.length < MIN_START) return false;

  const startMode =
    opts.startMode === 'mcv' || room.startMode === 'mcv' ? 'mcv' : 'base';
  room.startMode = startMode;

  room.started = true;
  touch(room);

  const snap = roomSnapshot(room);
  const names = snap.names || roomNames(room);
  const startMsg = {
    type: 'start',
    seed: 42,
    map: 'skirmish_large',
    authority: 'server',
    speed: 1,
    speedOptions: SPEED_OPTIONS,
    owners,
    maxSeats: MAX_SEATS,
    startMode,
    ...snap,
    names,
  };
  forEachClient(room, (ws) => {
    sendJson(ws, {
      ...startMsg,
      spectator: isSpectatorWs(ws),
      seat: ws.seat,
      role: ws.role,
    });
  });

  room.speedPending = null;
  const sim = new RoomSim(room.id, { names, owners, startMode });
  room.sim = sim;
  sim.onState = (payload, tick, extra) => {
    const wire = JSON.stringify({
      type: 'state',
      tick,
      payload,
      speed: (extra && extra.speed) || sim.speed,
      ts: Date.now(),
    });
    forEachClient(room, (ws) => {
      ws.send(wire);
    });
  };
  sim.onEnd = (phase, info) => {
    broadcastRoom(
      room,
      {
        type: 'match_end',
        phase,
        winner: (info && info.winner) || (room.sim && room.sim.game && room.sim.game.winner) || null,
        recordingId: (info && info.recordingId) || sim.recordingId || null,
      },
      null
    );
  };
  try {
    sim.start();
    console.log(
      `[room ${room.id}] server sim started owners=${owners.join(',')} n=${owners.length}`
    );
    return true;
  } catch (err) {
    console.error(`[room ${room.id}] sim failed`, err);
    room.started = false;
    room.sim = null;
    broadcastRoom(
      room,
      { type: 'error', error: 'sim_failed', message: String(err.message || err) },
      null
    );
    return false;
  }
}

function joinExisting(ws, roomId, playerId, name) {
  const id = String(roomId || '')
    .trim()
    .toUpperCase()
    .slice(0, 16);
  if (!id) {
    sendJson(ws, { type: 'error', error: 'bad_room' });
    return;
  }
  let room = getRoom(id);
  if (!room) {
    room = makeRoom(id);
    rooms.set(id, room);
  }

  const pid = sanitizePlayerId(playerId);
  const displayName = sanitizeName(name);

  // Leave any other room intentionally
  if (ws.roomRef && ws.roomRef !== room) {
    detachWs(ws, true);
  }

  let seat = findReclaimSeat(room, pid);
  let reconnected = false;

  if (seat) {
    reconnected = room.started || !!(room.slots.get(seat) && !room.slots.get(seat).connected);
    const prev = room.slots.get(seat);
    bindSeat(ws, room, seat, pid, displayName, prev ? prev.role : undefined);
  } else {
    seat = findOpenSeat(room);
    if (!seat) {
      sendJson(ws, { type: 'error', error: 'room_full', room: id });
      return;
    }
    // First seat in empty room is host
    const isFirst = room.slots.size === 0;
    bindSeat(ws, room, seat, pid, displayName, isFirst ? 'host' : 'guest');
  }

  const snap = roomSnapshot(room);
  sendJson(ws, {
    type: 'joined',
    protocol: PROTOCOL,
    playerId: ws.playerId,
    name: ws.displayName,
    seat: ws.seat,
    role: ws.role,
    reconnected,
    ...snap,
  });
  broadcastRoom(
    room,
    {
      type: reconnected ? 'peer_reconnected' : 'peer_joined',
      playerId: ws.playerId,
      name: ws.displayName,
      seat: ws.seat,
      ...roomSnapshot(room),
    },
    ws
  );

  if (room.started && room.sim) {
    // Resume into live match
    sendMatchSync(ws, room, { reconnected: true });
  } else {
    maybeStartMatch(room);
  }
}

function createRoom(ws, playerId, name) {
  if (ws.roomRef) detachWs(ws, true);
  const id = uniqueRoomCode();
  const room = makeRoom(id);
  rooms.set(id, room);
  const pid = sanitizePlayerId(playerId);
  const displayName = sanitizeName(name);
  bindSeat(ws, room, 'player', pid, displayName, 'host');
  sendJson(ws, {
    type: 'joined',
    protocol: PROTOCOL,
    playerId: ws.playerId,
    name: ws.displayName,
    seat: ws.seat,
    role: ws.role,
    created: true,
    ...roomSnapshot(room),
  });
}

/**
 * Join a room as spectator (no seat, no commands, receives state broadcasts).
 * Default allowSpectate = open. Does not count toward MAX_SEATS.
 */
function joinSpectate(ws, roomId, playerId, name) {
  const id = String(roomId || '')
    .trim()
    .toUpperCase()
    .slice(0, 16);
  if (!id) {
    sendJson(ws, { type: 'error', error: 'bad_room' });
    return;
  }
  const room = getRoom(id);
  if (!room) {
    sendJson(ws, { type: 'error', error: 'no_room', room: id });
    return;
  }
  if ((room.allowSpectate || 'open') === 'off') {
    sendJson(ws, { type: 'error', error: 'spectate_off', room: id });
    return;
  }

  const pid = sanitizePlayerId(playerId);
  const displayName = sanitizeName(name);

  // Already a player in this room — reject (don't steal seat into spectator)
  if (ws.roomRef === room && ws.seat && !isSpectatorWs(ws)) {
    sendJson(ws, { type: 'error', error: 'already_playing', room: id });
    return;
  }

  // Leave other rooms
  if (ws.roomRef && ws.roomRef !== room) {
    detachWs(ws, true);
  }

  // Reclaim existing spectator slot for same playerId, else enforce cap
  const already = room.spectators && room.spectators.get(pid);
  if (!already || already.ws !== ws) {
    const others = spectatorCount(room) - (already && already.connected ? 1 : 0);
    if (others >= MAX_SPECTATORS) {
      sendJson(ws, { type: 'error', error: 'spectators_full', room: id });
      return;
    }
  }

  bindSpectator(ws, room, pid, displayName);

  const snap = roomSnapshot(room);
  sendJson(ws, {
    type: 'joined',
    protocol: PROTOCOL,
    playerId: ws.playerId,
    name: ws.displayName,
    seat: null,
    role: 'spectator',
    spectator: true,
    reconnected: false,
    ...snap,
  });
  // Notify others of spectator count change (roster only)
  broadcastRoom(
    room,
    {
      type: 'roster',
      ...roomSnapshot(room),
    },
    ws
  );

  if (room.started && room.sim) {
    sendMatchSync(ws, room, { reconnected: false, spectator: true });
  } else {
    // Lobby: wait for start broadcast
    sendJson(ws, {
      type: 'lobby_wait',
      message: 'Waiting for match to start…',
      ...snap,
    });
  }
}

function setupWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.roomRef = null;
    ws.seat = null;
    ws.role = null;
    ws.playerId = null;
    ws.displayName = 'Commander';
    ws.isSpectator = false;
    const remote = req.socket.remoteAddress || '?';
    console.log(`[ws] connect ${remote} (clients=${wss.clients.size})`);

    sendJson(ws, {
      type: 'hello',
      service: 'dune2v',
      protocol: PROTOCOL,
      message: 'Server-authoritative MP. create | join | spectate | cmd | set_name',
    });

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch {
        sendJson(ws, { type: 'error', error: 'invalid_json' });
        return;
      }

      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong', t: msg.t || Date.now() });
        return;
      }

      if (msg.type === 'create') {
        createRoom(ws, msg.playerId, msg.name);
        return;
      }

      if (msg.type === 'join') {
        // Optional role: 'spectator' reuses join shape
        if (msg.role === 'spectator') {
          joinSpectate(ws, msg.room, msg.playerId, msg.name);
          return;
        }
        joinExisting(ws, msg.room, msg.playerId, msg.name);
        return;
      }

      if (msg.type === 'spectate') {
        joinSpectate(ws, msg.room, msg.playerId, msg.name);
        return;
      }

      if (msg.type === 'set_name') {
        ws.displayName = sanitizeName(msg.name);
        const room = ws.roomRef;
        if (room && ws.seat && room.slots.has(ws.seat)) {
          room.slots.get(ws.seat).name = ws.displayName;
          touch(room);
          broadcastRoom(room, { type: 'roster', ...roomSnapshot(room) }, null);
        } else if (room && isSpectatorWs(ws) && room.spectators && ws.playerId) {
          const spec = room.spectators.get(ws.playerId);
          if (spec) spec.name = ws.displayName;
          touch(room);
        }
        sendJson(ws, {
          type: 'name_ok',
          name: ws.displayName,
          ...(room ? roomSnapshot(room) : {}),
        });
        return;
      }

      // Intentional leave — free seat (no reconnect reservation); spectators just drop
      if (msg.type === 'leave') {
        const left = detachWs(ws, true);
        if (left && !left.empty && left.room && !left.spectator) {
          broadcastRoom(left.room, {
            type: 'peer_left',
            playerId: left.playerId,
            seat: left.seat,
            name: left.name || null,
            intentional: true,
            ...roomSnapshot(left.room),
          });
        } else if (left && !left.empty && left.room && left.spectator) {
          broadcastRoom(left.room, { type: 'roster', ...roomSnapshot(left.room) }, null);
        }
        sendJson(ws, { type: 'left' });
        return;
      }

      const room = ws.roomRef;
      if (!room) {
        sendJson(ws, { type: 'error', error: 'not_in_room' });
        return;
      }
      touch(room);

      if (msg.type === 'start' || msg.type === 'start_match') {
        if (isSpectatorWs(ws)) {
          sendJson(ws, { type: 'error', error: 'spectator' });
          return;
        }
        // Only host (or any player if host gone) may force-start with 2–5 players
        const slot = ws.seat && room.slots.get(ws.seat);
        const isHost = slot && slot.role === 'host';
        if (!isHost && ws.role !== 'host') {
          sendJson(ws, { type: 'error', error: 'not_host' });
          return;
        }
        if (room.started) {
          sendJson(ws, { type: 'error', error: 'already_started' });
          return;
        }
        if (connectedCount(room) < MIN_START) {
          sendJson(ws, {
            type: 'error',
            error: 'need_players',
            message: 'Need at least ' + MIN_START + ' players to start.',
          });
          return;
        }
        const mode = msg.startMode === 'mcv' ? 'mcv' : 'base';
        room.startMode = mode;
        const ok = maybeStartMatch(room, { force: true, startMode: mode });
        if (!ok) {
          sendJson(ws, { type: 'error', error: 'start_failed' });
        }
        return;
      }

      if (msg.type === 'cmd') {
        if (isSpectatorWs(ws) || !ws.seat) {
          sendJson(ws, {
            type: 'cmd_result',
            ok: false,
            reason: 'spectator',
          });
          return;
        }
        if (!room.sim || !room.started) {
          sendJson(ws, {
            type: 'cmd_result',
            ok: false,
            reason: 'not_started',
          });
          return;
        }
        const payload = msg.payload != null ? msg.payload : msg;
        const result = room.sim.applyCommand(ws.seat, payload) || {
          ok: false,
          reason: 'unknown',
        };
        sendJson(ws, {
          type: 'cmd_result',
          ok: !!result.ok,
          reason: result.reason || null,
          info: result.info || null,
          op: payload.op || null,
        });
        return;
      }

      // Speed change: one player requests, other must accept (spectators cannot)
      if (msg.type === 'speed_request') {
        if (isSpectatorWs(ws) || !ws.seat) {
          sendJson(ws, { type: 'error', error: 'spectator' });
          return;
        }
        if (!room.sim || !room.started) {
          sendJson(ws, { type: 'error', error: 'not_started' });
          return;
        }
        const speed = Number(msg.speed);
        if (!SPEED_OPTIONS.includes(speed)) {
          sendJson(ws, { type: 'error', error: 'bad_speed' });
          return;
        }
        if (speed === room.sim.speed) {
          sendJson(ws, { type: 'speed', speed, note: 'already' });
          return;
        }
        room.speedPending = {
          speed,
          fromSeat: ws.seat,
          fromName: ws.displayName,
          at: Date.now(),
        };
        broadcastRoom(
          room,
          {
            type: 'speed_request',
            speed,
            fromSeat: ws.seat,
            fromName: ws.displayName,
            from: ws.playerId,
          },
          null
        );
        return;
      }

      if (msg.type === 'speed_response') {
        if (isSpectatorWs(ws) || !ws.seat) {
          sendJson(ws, { type: 'error', error: 'spectator' });
          return;
        }
        if (!room.sim || !room.started || !room.speedPending) {
          sendJson(ws, { type: 'error', error: 'no_pending_speed' });
          return;
        }
        const pend = room.speedPending;
        if (ws.seat === pend.fromSeat) {
          sendJson(ws, { type: 'error', error: 'cannot_answer_own' });
          return;
        }
        const accept = msg.accept !== false && msg.accept !== 'false';
        if (!accept) {
          room.speedPending = null;
          broadcastRoom(
            room,
            {
              type: 'speed_rejected',
              speed: pend.speed,
              bySeat: ws.seat,
              byName: ws.displayName,
            },
            null
          );
          return;
        }
        const ok = room.sim.setSpeed(pend.speed);
        room.speedPending = null;
        if (!ok) {
          sendJson(ws, { type: 'error', error: 'bad_speed' });
          return;
        }
        broadcastRoom(
          room,
          {
            type: 'speed',
            speed: room.sim.speed,
            bySeat: ws.seat,
            byName: ws.displayName,
          },
          null
        );
        return;
      }

      if (msg.type === 'state') {
        return;
      }

      if (msg.type === 'chat') {
        const text = String(msg.text || '')
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        if (!text) return;
        const slot = ws.seat && room.slots.get(ws.seat);
        const spec =
          isSpectatorWs(ws) && room.spectators && ws.playerId
            ? room.spectators.get(ws.playerId)
            : null;
        broadcastRoom(
          room,
          {
            type: 'chat',
            from: ws.playerId,
            seat: ws.seat,
            role: ws.role,
            name:
              (slot && slot.name) ||
              (spec && spec.name) ||
              ws.displayName ||
              'Commander',
            text,
            ts: Date.now(),
          },
          null
        );
        return;
      }

      sendJson(ws, {
        type: 'error',
        error: 'unknown_type',
        got: msg.type || null,
      });
    });

    // Drop = soft disconnect: keep seat reserved for reconnect grace period
    ws.on('close', () => {
      const left = detachWs(ws, false);
      if (left && !left.empty && left.room && !left.spectator) {
        broadcastRoom(left.room, {
          type: 'peer_disconnected',
          playerId: left.playerId,
          seat: left.seat,
          name: left.name || null,
          reconnectGraceMs: RECONNECT_GRACE_MS,
          ...roomSnapshot(left.room),
        });
      } else if (left && !left.empty && left.room && left.spectator) {
        broadcastRoom(left.room, { type: 'roster', ...roomSnapshot(left.room) }, null);
      }
      console.log(`[ws] disconnect (clients=${wss.clients.size} rooms=${rooms.size})`);
    });
  });

  // Sweep idle rooms + expired reconnect reservations
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      // Drop expired reservations
      for (const [seat, slot] of [...room.slots.entries()]) {
        if (
          !slot.connected &&
          slot.disconnectedAt &&
          now - slot.disconnectedAt >= RECONNECT_GRACE_MS
        ) {
          room.slots.delete(seat);
        }
      }

      const noOneHome = connectedCount(room) === 0;
      const stale = now - room.touched > ROOM_IDLE_MS;
      const empty = room.slots.size === 0;
      // Spectators alone never keep a room
      const onlySpectators = empty || (noOneHome && spectatorCount(room) >= 0 && room.slots.size === 0);

      if (
        empty ||
        onlySpectators ||
        (noOneHome && stale) ||
        (noOneHome && !room.started)
      ) {
        stopSim(room);
        for (const slot of room.slots.values()) {
          try {
            if (slot.ws) slot.ws.close();
          } catch {
            /* ignore */
          }
        }
        if (room.spectators) {
          for (const spec of room.spectators.values()) {
            try {
              if (spec.ws) spec.ws.close();
            } catch {
              /* ignore */
            }
          }
        }
        rooms.delete(id);
      }
    }
  }, 60_000).unref();

  return wss;
}

const server = http.createServer(serveStatic);
setupWs(server);

/** Drop short recordings (cmds < MIN_CMDS_TO_SAVE). */
const PRUNE_SHORT_MS = 15 * 60 * 1000;

function runRecordingCleanup(reason) {
  try {
    const r = recordings.pruneShort ? recordings.pruneShort() : recordings.pruneZeroCmd();
    if (r && r.removed && r.removed.length) {
      console.log(
        `[recordings] cleanup (${reason}): removed ${r.removed.length}, kept ${r.kept} (minCmds=${r.minCmds || 10})`
      );
    } else if (reason === 'boot') {
      console.log(
        `[recordings] cleanup (boot): nothing to remove, kept ${r ? r.kept : 0} (minCmds=${(r && r.minCmds) || 10})`
      );
    }
    return r;
  } catch (e) {
    console.warn('[recordings] cleanup failed', e.message);
    return null;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[dune2v] http://${HOST}:${PORT}  static=${ROOT}  ws=/ws  protocol=${PROTOCOL}`);
  // Immediate sweep of leftover 0-cmd stubs on volume
  runRecordingCleanup('boot');
  setInterval(() => runRecordingCleanup('interval'), PRUNE_SHORT_MS).unref();
});

function shutdown(sig) {
  console.log(`[dune2v] ${sig}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
