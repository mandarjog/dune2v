'use strict';

/**
 * Fly-friendly game host:
 *  - Serves the static browser client (index.html, js/, css/, …)
 *  - WebSocket endpoint at /ws for multiplayer rooms (stub → real net later)
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
    return send(res, 200, JSON.stringify({ ok: true, service: 'dune2v' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  if (urlPath.startsWith('/ws')) {
    return send(res, 426, 'Upgrade Required', { 'Content-Type': 'text/plain' });
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA-ish fallback only for bare paths — keep 404 for missing assets
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control':
        ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) send(res, 500, 'Read error');
      else res.destroy();
    });
  });
}

// ─── Multiplayer room stub ─────────────────────────────────
/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();

function roomOf(ws) {
  return ws.roomId || null;
}

function joinRoom(ws, roomId) {
  const id = String(roomId || 'lobby').slice(0, 64);
  leaveRoom(ws);
  if (!rooms.has(id)) rooms.set(id, new Set());
  rooms.get(id).add(ws);
  ws.roomId = id;
  return id;
}

function leaveRoom(ws) {
  const id = ws.roomId;
  if (!id) return;
  const set = rooms.get(id);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(id);
  }
  ws.roomId = null;
}

function broadcast(roomId, data, except) {
  const set = rooms.get(roomId);
  if (!set) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const peer of set) {
    if (peer !== except && peer.readyState === 1) peer.send(payload);
  }
}

function setupWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.roomId = null;
    ws.playerId = null;
    const remote = req.socket.remoteAddress || '?';
    console.log(`[ws] connect ${remote} (clients=${wss.clients.size})`);

    ws.send(
      JSON.stringify({
        type: 'hello',
        service: 'dune2v',
        protocol: 1,
        message:
          'Multiplayer protocol stub. Send {type:"join",room:"demo"} to join a room.',
      })
    );

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t || Date.now() }));
        return;
      }

      if (msg.type === 'join') {
        const roomId = joinRoom(ws, msg.room || 'lobby');
        ws.playerId = msg.playerId || `p_${Math.random().toString(36).slice(2, 8)}`;
        const peers = rooms.get(roomId)?.size || 1;
        ws.send(
          JSON.stringify({
            type: 'joined',
            room: roomId,
            playerId: ws.playerId,
            peers,
          })
        );
        broadcast(
          roomId,
          { type: 'peer_joined', playerId: ws.playerId, peers },
          ws
        );
        return;
      }

      if (msg.type === 'leave') {
        const roomId = roomOf(ws);
        leaveRoom(ws);
        if (roomId) {
          broadcast(roomId, {
            type: 'peer_left',
            playerId: ws.playerId,
            peers: rooms.get(roomId)?.size || 0,
          });
        }
        ws.send(JSON.stringify({ type: 'left' }));
        return;
      }

      // Relay opaque game commands to room peers (host-authoritative later)
      if (msg.type === 'cmd' || msg.type === 'relay') {
        const roomId = roomOf(ws);
        if (!roomId) {
          ws.send(JSON.stringify({ type: 'error', error: 'not_in_room' }));
          return;
        }
        broadcast(
          roomId,
          {
            type: 'cmd',
            from: ws.playerId,
            room: roomId,
            payload: msg.payload != null ? msg.payload : msg,
            ts: Date.now(),
          },
          ws
        );
        return;
      }

      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'unknown_type',
          got: msg.type || null,
        })
      );
    });

    ws.on('close', () => {
      const roomId = roomOf(ws);
      const pid = ws.playerId;
      leaveRoom(ws);
      if (roomId) {
        broadcast(roomId, {
          type: 'peer_left',
          playerId: pid,
          peers: rooms.get(roomId)?.size || 0,
        });
      }
      console.log(`[ws] disconnect (clients=${wss.clients.size})`);
    });
  });

  return wss;
}

const server = http.createServer(serveStatic);
setupWs(server);

server.listen(PORT, HOST, () => {
  console.log(`[dune2v] http://${HOST}:${PORT}  static=${ROOT}  ws=/ws`);
});

function shutdown(sig) {
  console.log(`[dune2v] ${sig}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
