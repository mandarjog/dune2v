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

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(__dirname, '..');

const PROTOCOL = 2;
const MAX_SEATS = 2;
const ROOM_CODE_LEN = 6;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 60 * 60 * 1000;

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

function serveStatic(req, res) {
  let urlPath = req.url || '/';
  if (urlPath === '/health' || urlPath === '/healthz') {
    return send(
      res,
      200,
      JSON.stringify({
        ok: true,
        service: 'dune2v',
        protocol: PROTOCOL,
        rooms: rooms.size,
      }),
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }
    );
  }

  if (urlPath.startsWith('/ws')) {
    return send(res, 426, 'Upgrade Required', { 'Content-Type': 'text/plain' });
  }

  if (urlPath === '/') urlPath = '/index.html';

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

// ─── Rooms ─────────────────────────────────────────────────
/** @typedef {{ id: string, seats: Map<string, import('ws').WebSocket>, started: boolean, touched: number }} Room */

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

function roomSnapshot(room) {
  const seats = {};
  for (const [seat, ws] of room.seats) {
    seats[seat] = { playerId: ws.playerId, role: ws.role };
  }
  return {
    room: room.id,
    peers: room.seats.size,
    seats,
    started: room.started,
    open: room.seats.size < MAX_SEATS,
  };
}

function getRoom(id) {
  return rooms.get(String(id || '').toUpperCase()) || null;
}

function touch(room) {
  if (room) room.touched = Date.now();
}

function destroyRoom(room) {
  if (!room) return;
  rooms.delete(room.id);
}

function leaveRoom(ws) {
  const room = ws.roomRef;
  if (!room) return null;
  const seat = ws.seat;
  const playerId = ws.playerId;
  room.seats.delete(seat);
  ws.roomRef = null;
  ws.seat = null;
  ws.role = null;

  if (room.seats.size === 0) {
    destroyRoom(room);
    return { roomId: room.id, empty: true, seat, playerId };
  }

  // If host left, promote remaining player to host (still same seat labels)
  if (ws.role === 'host') {
    for (const peer of room.seats.values()) {
      peer.role = 'host';
      break;
    }
  }
  touch(room);
  return { roomId: room.id, empty: false, seat, playerId, room };
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, except) {
  const payload = JSON.stringify(obj);
  for (const peer of room.seats.values()) {
    if (peer !== except && peer.readyState === 1) peer.send(payload);
  }
}

function hostOf(room) {
  for (const ws of room.seats.values()) {
    if (ws.role === 'host') return ws;
  }
  return room.seats.values().next().value || null;
}

function assignSeat(room) {
  if (!room.seats.has('player')) return 'player';
  if (!room.seats.has('enemy')) return 'enemy';
  return null;
}

function joinExisting(ws, roomId, playerId) {
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
    // First arrival with a chosen code creates the room (shareable URL before host open)
    room = { id, seats: new Map(), started: false, touched: Date.now() };
    rooms.set(id, room);
  }
  if (room.seats.size >= MAX_SEATS) {
    sendJson(ws, { type: 'error', error: 'room_full', room: id });
    return;
  }
  const seat = assignSeat(room);
  if (!seat) {
    sendJson(ws, { type: 'error', error: 'room_full', room: id });
    return;
  }

  leaveRoom(ws);
  ws.playerId = playerId || `p_${Math.random().toString(36).slice(2, 8)}`;
  ws.seat = seat;
  // First client in the room is host (runs sim); second is guest
  ws.role = room.seats.size === 0 ? 'host' : 'guest';
  ws.roomRef = room;
  room.seats.set(seat, ws);
  touch(room);

  sendJson(ws, {
    type: 'joined',
    protocol: PROTOCOL,
    playerId: ws.playerId,
    seat: ws.seat,
    role: ws.role,
    ...roomSnapshot(room),
  });
  broadcastRoom(
    room,
    {
      type: 'peer_joined',
      playerId: ws.playerId,
      seat: ws.seat,
      ...roomSnapshot(room),
    },
    ws
  );
}

function createRoom(ws, playerId) {
  leaveRoom(ws);
  const id = uniqueRoomCode();
  const room = { id, seats: new Map(), started: false, touched: Date.now() };
  rooms.set(id, room);
  ws.playerId = playerId || `p_${Math.random().toString(36).slice(2, 8)}`;
  ws.seat = 'player';
  ws.role = 'host';
  ws.roomRef = room;
  room.seats.set('player', ws);
  touch(room);
  sendJson(ws, {
    type: 'joined',
    protocol: PROTOCOL,
    playerId: ws.playerId,
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
    const remote = req.socket.remoteAddress || '?';
    console.log(`[ws] connect ${remote} (clients=${wss.clients.size})`);

    sendJson(ws, {
      type: 'hello',
      service: 'dune2v',
      protocol: PROTOCOL,
      message: 'Send {type:"create"} or {type:"join",room:"ABC123"}',
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
        createRoom(ws, msg.playerId);
        return;
      }

      if (msg.type === 'join') {
        joinExisting(ws, msg.room, msg.playerId);
        return;
      }

      if (msg.type === 'leave') {
        const left = leaveRoom(ws);
        if (left && !left.empty && left.room) {
          broadcastRoom(left.room, {
            type: 'peer_left',
            playerId: left.playerId,
            seat: left.seat,
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

      // Host marks match started and fans out to peers
      if (msg.type === 'start') {
        if (ws.role !== 'host') {
          sendJson(ws, { type: 'error', error: 'host_only' });
          return;
        }
        room.started = true;
        const payload = {
          type: 'start',
          from: ws.playerId,
          seed: msg.seed != null ? msg.seed : 42,
          map: msg.map || 'skirmish1',
          ...roomSnapshot(room),
        };
        broadcastRoom(room, payload); // include host? host already started locally
        // Guests need it; host can ignore
        sendJson(ws, payload);
        return;
      }

      // Host → guests: authoritative snapshot
      if (msg.type === 'state') {
        if (ws.role !== 'host') {
          sendJson(ws, { type: 'error', error: 'host_only' });
          return;
        }
        const payload = JSON.stringify({
          type: 'state',
          from: ws.playerId,
          tick: msg.tick,
          payload: msg.payload,
          ts: Date.now(),
        });
        for (const peer of room.seats.values()) {
          if (peer !== ws && peer.readyState === 1) peer.send(payload);
        }
        return;
      }

      // Guest (or host echo) commands → host applies
      if (msg.type === 'cmd') {
        const host = hostOf(room);
        if (!host) return;
        const envelope = {
          type: 'cmd',
          from: ws.playerId,
          seat: ws.seat,
          payload: msg.payload != null ? msg.payload : msg,
          ts: Date.now(),
        };
        if (ws === host) {
          // Host cmds stay local; optional echo to guests not needed (state carries)
          return;
        }
        sendJson(host, envelope);
        return;
      }

      // Lightweight chat / lobby note
      if (msg.type === 'chat') {
        broadcastRoom(
          room,
          {
            type: 'chat',
            from: ws.playerId,
            seat: ws.seat,
            text: String(msg.text || '').slice(0, 200),
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

    ws.on('close', () => {
      const left = leaveRoom(ws);
      if (left && !left.empty && left.room) {
        broadcastRoom(left.room, {
          type: 'peer_left',
          playerId: left.playerId,
          seat: left.seat,
          ...roomSnapshot(left.room),
        });
      }
      console.log(`[ws] disconnect (clients=${wss.clients.size} rooms=${rooms.size})`);
    });
  });

  // Sweep idle empty-ish rooms
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (room.seats.size === 0 || now - room.touched > ROOM_IDLE_MS) {
        for (const peer of room.seats.values()) {
          try {
            peer.close();
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
