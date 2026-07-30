'use strict';

/**
 * Fly-friendly game host:
 *  - Serves the static browser client (index.html, js/, css/, …)
 *  - WebSocket /ws — 2-seat multiplayer rooms (host-authoritative)
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

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(__dirname, '..');

const PROTOCOL = 5; // speed + recordings
const MAX_SEATS = 2;
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

/** @type {{ at: number, text: string, contact: string, ua: string, ip: string }[]} */
const feedbackLog = [];
const FEEDBACK_MAX = 200;

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
        feedback: feedbackLog.length,
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
        };
        feedbackLog.push(entry);
        if (feedbackLog.length > FEEDBACK_MAX) feedbackLog.shift();
        console.log(
          `[feedback] ${new Date(entry.at).toISOString()} contact=${contact || '-'} ${text.slice(0, 120)}`
        );
        return send(
          res,
          200,
          JSON.stringify({ ok: true }),
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
 *   id: string,
 *   slots: Map<string, SeatSlot>,
 *   started: boolean,
 *   touched: number,
 *   sim: import('./room-sim').RoomSim | null,
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
  return {
    room: room.id,
    peers: connected,
    seats,
    started: room.started,
    open: room.slots.size < MAX_SEATS || reclaimable,
    authority: 'server',
    reconnectGraceMs: RECONNECT_GRACE_MS,
  };
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
  for (const slot of room.slots.values()) {
    if (slot.ws && slot.ws !== exceptWs && slot.ws.readyState === 1) {
      slot.ws.send(payload);
    }
  }
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
 * Detach a websocket from its seat.
 * @param intentional if true, free the seat; if false (drop), reserve for reconnect
 */
function detachWs(ws, intentional) {
  const room = ws.roomRef;
  if (!room) return null;
  const seat = ws.seat;
  const playerId = ws.playerId;
  const name = ws.displayName;
  const slot = seat ? room.slots.get(seat) : null;

  if (slot && slot.ws === ws) {
    slot.ws = null;
    slot.connected = false;
    slot.disconnectedAt = Date.now();
  }

  ws.roomRef = null;
  ws.seat = null;
  ws.role = null;

  if (intentional && seat) {
    room.slots.delete(seat);
  }

  // No seats left at all → destroy
  if (room.slots.size === 0) {
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

  ws.roomRef = room;
  ws.seat = seat;
  ws.role = slot.role;
  ws.playerId = playerId;
  ws.displayName = name;
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
  for (const seat of ['player', 'enemy']) {
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

function sendMatchSync(ws, room, { reconnected }) {
  const snap = roomSnapshot(room);
  const names = {
    player: (snap.seats.player && snap.seats.player.name) || 'Atreides',
    enemy: (snap.seats.enemy && snap.seats.enemy.name) || 'Harkonnen',
  };
  sendJson(ws, {
    type: 'start',
    seed: 42,
    map: 'skirmish1',
    authority: 'server',
    reconnected: !!reconnected,
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
        ts: Date.now(),
        reconnected: !!reconnected,
      });
    }
  }
}

/** Start server sim when both seats are claimed (connected). */
function maybeStartMatch(room) {
  if (!room || room.started) return;
  if (room.slots.size < MAX_SEATS) return;
  // Prefer both connected to start
  if (connectedCount(room) < MAX_SEATS) return;

  room.started = true;
  touch(room);

  const snap = roomSnapshot(room);
  const names = {
    player: (snap.seats.player && snap.seats.player.name) || 'Atreides',
    enemy: (snap.seats.enemy && snap.seats.enemy.name) || 'Harkonnen',
  };
  const startMsg = {
    type: 'start',
    seed: 42,
    map: 'skirmish1',
    authority: 'server',
    speed: 1,
    speedOptions: SPEED_OPTIONS,
    ...snap,
    names,
  };
  broadcastRoom(room, startMsg, null);

  room.speedPending = null;
  const sim = new RoomSim(room.id, { names });
  room.sim = sim;
  sim.onState = (payload, tick, extra) => {
    const wire = JSON.stringify({
      type: 'state',
      tick,
      payload,
      speed: (extra && extra.speed) || sim.speed,
      ts: Date.now(),
    });
    for (const slot of room.slots.values()) {
      if (slot.ws && slot.ws.readyState === 1) slot.ws.send(wire);
    }
  };
  sim.onEnd = (phase, info) => {
    broadcastRoom(
      room,
      {
        type: 'match_end',
        phase,
        recordingId: (info && info.recordingId) || sim.recordingId || null,
      },
      null
    );
  };
  try {
    sim.start();
    console.log(`[room ${room.id}] server sim started`);
  } catch (err) {
    console.error(`[room ${room.id}] sim failed`, err);
    room.started = false;
    room.sim = null;
    broadcastRoom(
      room,
      { type: 'error', error: 'sim_failed', message: String(err.message || err) },
      null
    );
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
    room = {
      id,
      slots: new Map(),
      started: false,
      touched: Date.now(),
      sim: null,
    };
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
  const room = {
    id,
    slots: new Map(),
    started: false,
    touched: Date.now(),
    sim: null,
  };
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

function setupWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.roomRef = null;
    ws.seat = null;
    ws.role = null;
    ws.playerId = null;
    ws.displayName = 'Commander';
    const remote = req.socket.remoteAddress || '?';
    console.log(`[ws] connect ${remote} (clients=${wss.clients.size})`);

    sendJson(ws, {
      type: 'hello',
      service: 'dune2v',
      protocol: PROTOCOL,
      message: 'Server-authoritative MP. create | join | cmd | set_name',
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
        joinExisting(ws, msg.room, msg.playerId, msg.name);
        return;
      }

      if (msg.type === 'set_name') {
        ws.displayName = sanitizeName(msg.name);
        const room = ws.roomRef;
        if (room && ws.seat && room.slots.has(ws.seat)) {
          room.slots.get(ws.seat).name = ws.displayName;
          touch(room);
          broadcastRoom(room, { type: 'roster', ...roomSnapshot(room) }, null);
        }
        sendJson(ws, {
          type: 'name_ok',
          name: ws.displayName,
          ...(room ? roomSnapshot(room) : {}),
        });
        return;
      }

      // Intentional leave — free seat (no reconnect reservation)
      if (msg.type === 'leave') {
        const left = detachWs(ws, true);
        if (left && !left.empty && left.room) {
          broadcastRoom(left.room, {
            type: 'peer_left',
            playerId: left.playerId,
            seat: left.seat,
            name: left.name || null,
            intentional: true,
            ...roomSnapshot(left.room),
          });
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

      if (msg.type === 'start') {
        maybeStartMatch(room);
        return;
      }

      if (msg.type === 'cmd') {
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

      // Speed change: one player requests, other must accept
      if (msg.type === 'speed_request') {
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
        broadcastRoom(
          room,
          {
            type: 'chat',
            from: ws.playerId,
            seat: ws.seat,
            name: (slot && slot.name) || ws.displayName || 'Commander',
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
      if (left && !left.empty && left.room) {
        broadcastRoom(left.room, {
          type: 'peer_disconnected',
          playerId: left.playerId,
          seat: left.seat,
          name: left.name || null,
          reconnectGraceMs: RECONNECT_GRACE_MS,
          ...roomSnapshot(left.room),
        });
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

      if (empty || (noOneHome && stale) || (noOneHome && !room.started)) {
        stopSim(room);
        for (const slot of room.slots.values()) {
          try {
            if (slot.ws) slot.ws.close();
          } catch {
            /* ignore */
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

server.listen(PORT, HOST, () => {
  console.log(`[dune2v] http://${HOST}:${PORT}  static=${ROOT}  ws=/ws  protocol=${PROTOCOL}`);
});

function shutdown(sig) {
  console.log(`[dune2v] ${sig}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
