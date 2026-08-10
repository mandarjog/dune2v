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

/** Git short SHA (or env from Fly/CI). Shown in /health, /js/version.js, WS hello. */
function resolveGitRev() {
  const env =
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    process.env.FLY_IMAGE_REF ||
    process.env.SOURCE_VERSION ||
    '';
  if (env) {
    // FLY_IMAGE_REF is often registry.fly.io/app:deployment-01H… — keep tail
    const m = String(env).match(/([0-9a-f]{7,40})/i);
    if (m) return m[1].slice(0, 12);
    return String(env).slice(0, 24);
  }
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    return 'unknown';
  }
}
const BUILD_REV = resolveGitRev();
const BUILD_TIME = new Date().toISOString();

const PROTOCOL = 8; // mid-match rejoin + consent
const MAX_SEATS = 5;
const MIN_START = 2;
const MAX_SPECTATORS = 8;
/** Seat order: first two keep legacy ids for save/replay compat. */
const SEAT_ORDER = ['player', 'enemy', 'p2', 'p3', 'p4'];
/** Match client Seats: Atreides, Harkonnen, Ordos, Harkonnen (pink), Ordos (black). */
const HOUSE_FOR_SEAT = {
  player: 'Atreides',
  enemy: 'Harkonnen',
  p2: 'Ordos',
  p3: 'Harkonnen',
  p4: 'Ordos',
};
const HOUSE_ID_FOR_SEAT = {
  player: 'atreides',
  enemy: 'harkonnen',
  p2: 'ordos',
  p3: 'harkonnen',
  p4: 'ordos',
};

function normalizeHouseId(id) {
  if (id == null || id === '') return null;
  const s = String(id).toLowerCase().trim();
  if (s === 'atreides' || s === 'a' || s === 'at') return 'atreides';
  if (s === 'harkonnen' || s === 'h' || s === 'hk' || s === 'hark') return 'harkonnen';
  if (s === 'ordos' || s === 'o' || s === 'or') return 'ordos';
  return null;
}

function houseIdForSeat(seat) {
  return HOUSE_ID_FOR_SEAT[seat] || null;
}

function seatsForHouse(houseId) {
  const h = normalizeHouseId(houseId);
  if (!h) return [];
  return SEAT_ORDER.filter((s) => HOUSE_ID_FOR_SEAT[s] === h);
}
const ROOM_CODE_LEN = 6;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 60 * 60 * 1000;
/** Keep a disconnected seat reserved so the same playerId can reclaim it. */
const RECONNECT_GRACE_MS = 15 * 60 * 1000;
/** Pending rejoin requests expire if nobody accepts. */
const REJOIN_REQUEST_MS = 90 * 1000;
/** Started match with 0 connected players this long → destroy (sim is paused immediately). */
const EMPTY_MATCH_MS = 3 * 60 * 1000;
/** Admin UI + kill API. Set ADMIN_TOKEN env in production. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dune2-admin';

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
        rev: BUILD_REV,
        buildTime: BUILD_TIME,
        rooms: rooms.size,
        feedback: feedbackStore.count(),
      }),
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }
    );
  }

  // Client revision stamp — always fresh (no cache)
  if (urlPath === '/js/version.js' || urlPath === '/api/version') {
    if (urlPath === '/api/version') {
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          service: 'dune2v',
          rev: BUILD_REV,
          buildTime: BUILD_TIME,
          protocol: PROTOCOL,
        }),
        {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        }
      );
    }
    const body =
      '/* dune2v build */\n' +
      '(function(g){var D=g.Dune2=g.Dune2||{};D.BUILD={rev:' +
      JSON.stringify(BUILD_REV) +
      ',time:' +
      JSON.stringify(BUILD_TIME) +
      ',protocol:' +
      PROTOCOL +
      ',source:"server"};})(typeof window!=="undefined"?window:globalThis);\n';
    return send(res, 200, body, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
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

  // ── Admin: list / kill rooms ─────────────────────────────────
  // GET  /admin-dune2?token=…          → simple HTML console
  // GET  /admin-dune2/api?token=…      → JSON rooms
  // POST /admin-dune2/kill?token=…     body { room } or ?room=
  // POST /admin-dune2/kill-all?token=…
  if (urlPath === '/admin-dune2' || urlPath === '/admin-dune2/') {
    if (!adminAuthorized(req)) {
      return send(res, 401, 'Unauthorized — pass ?token=', {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
    const rows = [];
    for (const room of rooms.values()) {
      const snap = roomSnapshot(room);
      rows.push(
        `<tr>
          <td><b>${snap.room}</b></td>
          <td>${snap.title ? String(snap.title).replace(/</g, '') : '—'}</td>
          <td>${snap.started ? snap.phase || 'playing' : 'lobby'}</td>
          <td>${snap.players}</td>
          <td>${snap.spectators}</td>
          <td>${snap.tick != null ? snap.tick : '—'}</td>
          <td>${room.sim && room.sim.isPaused ? 'paused' : room.sim ? 'running' : '—'}</td>
          <td>
            <a href="/admin-dune2/kill?token=${encodeURIComponent(ADMIN_TOKEN)}&room=${encodeURIComponent(snap.room)}"
               onclick="return confirm('Kill room ${snap.room}?')">Kill</a>
          </td>
        </tr>`
      );
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>dune2v admin</title>
<style>
body{font-family:system-ui,sans-serif;background:#111;color:#ddd;padding:20px}
table{border-collapse:collapse;width:100%;max-width:960px}
th,td{border:1px solid #444;padding:6px 10px;text-align:left}
th{background:#222}
button,a.btn{background:#c0392b;color:#fff;border:0;padding:4px 10px;cursor:pointer;border-radius:3px;text-decoration:none;font-size:13px}
a{color:#6af}
.meta{color:#888;font-size:12px;margin-bottom:12px}
</style></head><body>
<h1>dune2v admin</h1>
<p class="meta">rev=${BUILD_REV} · rooms=${rooms.size} ·
<a class="btn" href="/admin-dune2/kill-all?token=${encodeURIComponent(ADMIN_TOKEN)}"
  onclick="return confirm('Kill ALL rooms?')">Kill all rooms</a>
 · <a href="/admin-dune2?token=${encodeURIComponent(ADMIN_TOKEN)}">Refresh</a>
</p>
<table>
<thead><tr><th>Room</th><th>Title</th><th>Phase</th><th>Players</th><th>Specs</th><th>Tick</th><th>Sim</th><th></th></tr></thead>
<tbody>
${rows.length ? rows.join('\n') : '<tr><td colspan="8">No rooms</td></tr>'}
</tbody></table>
</body></html>`;
    return send(res, 200, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  if (urlPath === '/admin-dune2/api') {
    if (!adminAuthorized(req)) {
      return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    const list = [];
    for (const room of rooms.values()) {
      const snap = roomSnapshot(room);
      list.push({
        ...snap,
        paused: !!(room.sim && room.sim.isPaused),
        mapSeed: room.mapSeed || null,
      });
    }
    return send(
      res,
      200,
      JSON.stringify({ ok: true, rev: BUILD_REV, rooms: list }),
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    );
  }

  if (
    (urlPath === '/admin-dune2/kill' || urlPath === '/admin-dune2/kill-all') &&
    (req.method === 'POST' || req.method === 'GET')
  ) {
    if (!adminAuthorized(req)) {
      return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const wantHtml = (req.headers.accept || '').includes('text/html') || req.method === 'GET';
    if (urlPath === '/admin-dune2/kill-all') {
      const ids = [...rooms.keys()];
      for (const id of ids) {
        const room = rooms.get(id);
        if (room) endMatchRoom(room, { winner: null, reason: 'admin_kill' });
        else rooms.delete(id);
      }
      console.log(`[admin] kill-all n=${ids.length}`);
      if (wantHtml) {
        res.writeHead(302, {
          Location: '/admin-dune2?token=' + encodeURIComponent(ADMIN_TOKEN),
        });
        return res.end();
      }
      return send(
        res,
        200,
        JSON.stringify({ ok: true, killed: ids }),
        { 'Content-Type': 'application/json; charset=utf-8' }
      );
    }
    const roomId = String(url.searchParams.get('room') || '')
      .trim()
      .toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      return send(
        res,
        404,
        JSON.stringify({ ok: false, error: 'no_room', room: roomId }),
        { 'Content-Type': 'application/json; charset=utf-8' }
      );
    }
    endMatchRoom(room, { winner: null, reason: 'admin_kill' });
    console.log(`[admin] kill room=${roomId}`);
    if (wantHtml) {
      res.writeHead(302, {
        Location: '/admin-dune2?token=' + encodeURIComponent(ADMIN_TOKEN),
      });
      return res.end();
    }
    return send(
      res,
      200,
      JSON.stringify({ ok: true, room: roomId }),
      { 'Content-Type': 'application/json; charset=utf-8' }
    );
  }

  // Client telemetry (SP skirmish + MP browser) — stuck armies, heartbeats
  if (urlPath === '/api/telemetry' && req.method === 'POST') {
    return readJsonBody(req, 16000)
      .then((body) => {
        const kind = String(body.kind || 'event')
          .replace(/[^a-z0-9_]/gi, '')
          .slice(0, 32) || 'event';
        const entry = {
          at: Date.now(),
          kind,
          rev: body.rev ? String(body.rev).slice(0, 24) : null,
          session: body.session ? String(body.session).slice(0, 40) : null,
          multiplayer: !!body.multiplayer,
          phase: body.phase ? String(body.phase).slice(0, 24) : null,
          tick: body.tick | 0,
          units: body.units | 0,
          stuckPath: body.stuckPath | 0,
          stuckOther: body.stuckOther | 0,
          pathStuck: body.pathStuck | 0,
          fps: body.fps | 0,
          scenario: body.scenario ? String(body.scenario).slice(0, 32) : null,
          message: body.message ? String(body.message).slice(0, 200) : null,
          n: body.n | 0,
          orderType: body.orderType ? String(body.orderType).slice(0, 24) : null,
          backend: body.backend ? String(body.backend).slice(0, 24) : null,
          ok: body.ok | 0,
          ms: body.ms | 0,
          stuckSample: Array.isArray(body.stuckSample)
            ? body.stuckSample.slice(0, 8)
            : null,
          href: body.href ? String(body.href).slice(0, 300) : null,
          ua: String(req.headers['user-agent'] || '').slice(0, 160),
          ip: String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '').slice(0, 80),
        };
        // Log interesting events always; heartbeats only when stuck
        if (kind === 'stuck_path' || kind === 'order_issue' || (kind === 'heartbeat' && entry.stuckPath >= 3)) {
          console.log(
            `[telemetry] ${kind} rev=${entry.rev || '?'} mp=${entry.multiplayer} ` +
              `tick=${entry.tick} units=${entry.units} stuckPath=${entry.stuckPath || entry.pathStuck} ` +
              `fps=${entry.fps}` +
              (entry.message ? ' ' + entry.message : '') +
              (entry.n ? ` n=${entry.n} via=${entry.backend}` : '')
          );
        } else if (kind === 'heartbeat') {
          // quieter: only mark presence
          if ((entry.tick | 0) % 2000 < 50) {
            console.log(
              `[telemetry] heartbeat rev=${entry.rev || '?'} mp=${entry.multiplayer} tick=${entry.tick} units=${entry.units}`
            );
          }
        }
        // Persist stuck events to disk for later review
        if (kind === 'stuck_path' || kind === 'order_issue') {
          feedbackStore.append(
            Object.assign({ type: 'telemetry' }, entry)
          );
        }
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
    // HTML + JS change often during playtest — do not cache-stale the client
    const noCache =
      ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': noCache
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=300',
      'X-Dune2-Rev': BUILD_REV,
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
 *   originalPlayerId?: string | null,
 * }} SeatSlot
 * @typedef {{
 *   playerId: string,
 *   name: string,
 *   ws: import('ws').WebSocket | null,
 *   connected: boolean,
 * }} SpecSlot
 * @typedef {{
 *   id: string,
 *   requestId: string,
 *   seat: string,
 *   playerId: string,
 *   name: string,
 *   ws: import('ws').WebSocket,
 *   createdAt: number,
 * }} RejoinRequest
 * @typedef {{
 *   id: string,
 *   slots: Map<string, SeatSlot>,
 *   spectators: Map<string, SpecSlot>,
 *   started: boolean,
 *   touched: number,
 *   createdAt: number,
 *   sim: import('./room-sim').RoomSim | null,
 *   allowSpectate: 'open' | 'off',
 *   rejoinRequests?: Map<string, RejoinRequest>,
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

const TITLE_MAX = 40;

/** Optional public match title (host-set). Empty → null. */
function sanitizeTitle(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
    .replace(/[<>]/g, '');
  return s || null;
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
  return HOUSE_FOR_SEAT[seat] || 'Atreides';
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
  const disconnectedSeats = [];
  for (const [seat, s] of room.slots) {
    if (!s.connected) disconnectedSeats.push(seat);
  }
  const reclaimable = disconnectedSeats.length > 0;
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
  const seatsTaken = room.slots.size;
  const canJoinSeat =
    !room.started && (seatsTaken < MAX_SEATS || reclaimable);
  // Mid-match: vacant (disconnected) seats can be reclaimed / requested
  const canRejoin = !!(room.started && room.sim && reclaimable);
  return {
    room: room.id,
    title: room.title || null,
    peers: connected,
    players: connected,
    seats,
    names,
    started: room.started,
    open: canJoinSeat, // joinable as a player (lobby + free seat)
    canJoin: canJoinSeat,
    canRejoin,
    disconnectedSeats,
    spectateOpen,
    spectators: specs,
    phase,
    tick,
    authority: 'server',
    reconnectGraceMs: RECONNECT_GRACE_MS,
  };
}

/** Public list for GET /api/live — lobby + in-progress rooms. */
function listLiveMatches() {
  const matches = [];
  const now = Date.now();
  for (const room of rooms.values()) {
    const players = connectedCount(room);
    const specs = spectatorCount(room);
    // Show rooms with at least one connected client or a running match
    if (players < 1 && specs < 1 && !room.started) continue;
    const snap = roomSnapshot(room);
    // Hide fully empty abandoned sims from the list (still reclaimable briefly)
    if (snap.players === 0 && snap.spectators === 0 && snap.started) continue;
    matches.push({
      room: snap.room,
      title: snap.title,
      names: snap.names,
      started: snap.started,
      phase: snap.phase,
      players: snap.players,
      spectators: snap.spectators,
      canJoin: !!snap.canJoin,
      canRejoin: !!snap.canRejoin,
      disconnectedSeats: snap.disconnectedSeats || [],
      canSpectate: !!snap.spectateOpen,
      // legacy: "open" meant spectate; keep for old clients as canSpectate
      open: !!snap.spectateOpen,
      tick: snap.tick,
      ageMs: Math.max(0, now - (room.createdAt || room.touched || now)),
      paused: !!(room.sim && room.sim.isPaused),
    });
  }
  // Lobbies first (joinable), then started; then by activity
  matches.sort((a, b) => {
    if (a.started !== b.started) return a.started ? 1 : -1;
    if (a.canJoin !== b.canJoin) return a.canJoin ? -1 : 1;
    return (b.tick || 0) - (a.tick || 0) || a.ageMs - b.ageMs;
  });
  return matches;
}

function makeRoom(id) {
  const now = Date.now();
  return {
    id,
    title: null,
    slots: new Map(),
    spectators: new Map(),
    started: false,
    touched: now,
    createdAt: now,
    sim: null,
    allowSpectate: 'open',
    rejoinRequests: new Map(),
  };
}

function newRejoinRequestId() {
  return (
    'rj_' +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
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

function adminAuthorized(req, body) {
  const url = new URL(req.url || '/', 'http://localhost');
  const q = url.searchParams.get('token') || url.searchParams.get('key') || '';
  const header = String(req.headers['x-admin-token'] || '');
  const fromBody = body && body.token != null ? String(body.token) : '';
  const got = q || header || fromBody;
  return got && got === ADMIN_TOKEN;
}

/** Connected player seats (not spectators). */
function connectedPlayerSeats(room) {
  const out = [];
  for (const [seat, slot] of room.slots) {
    if (slot && slot.connected) out.push(seat);
  }
  return out;
}

/**
 * End a started match: optional winner, broadcast match_end, stop sim, destroy room.
 * @param {object} room
 * @param {{ winner?: string|null, reason?: string }} [opts]
 */
function endMatchRoom(room, opts) {
  opts = opts || {};
  if (!room) return false;
  const winner = opts.winner != null ? opts.winner : null;
  const reason = opts.reason || 'ended';
  let recordingId = null;
  if (room.sim) {
    if (room.sim.game) {
      room.sim.game.winner = winner;
      room.sim.game.phase = winner ? 'ended' : 'draw';
    }
    // stop() finishes recording
    const prevRec = room.sim.recordingId;
    const info = room.sim.stop();
    recordingId = (info && info.id) || prevRec || null;
    room.sim = null;
  }
  room.started = true;
  broadcastRoom(
    room,
    {
      type: 'match_end',
      phase: winner ? 'ended' : 'draw',
      winner,
      reason,
      recordingId,
      ...roomSnapshot(room),
    },
    null
  );
  // Close clients after a tick so they receive match_end
  setTimeout(() => {
    try {
      for (const slot of room.slots.values()) {
        try {
          if (slot.ws) {
            sendJson(slot.ws, { type: 'left', reason: 'match_ended' });
            slot.ws.close();
          }
        } catch {
          /* ignore */
        }
      }
      if (room.spectators) {
        for (const spec of room.spectators.values()) {
          try {
            if (spec.ws) {
              sendJson(spec.ws, { type: 'left', reason: 'match_ended' });
              spec.ws.close();
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    rooms.delete(room.id);
  }, 400);
  console.log(
    `[room ${room.id}] match ended reason=${reason} winner=${winner || 'none'}`
  );
  return true;
}

/**
 * If fewer than 2 connected players remain in a started match, end it.
 * Sole survivor wins; zero survivors → draw.
 */
function checkSoloOrEmptyEnd(room) {
  if (!room || !room.started) return false;
  const alive = connectedPlayerSeats(room);
  if (alive.length >= 2) return false;
  if (alive.length === 1) {
    endMatchRoom(room, { winner: alive[0], reason: 'last_player' });
    return true;
  }
  endMatchRoom(room, { winner: null, reason: 'no_players' });
  return true;
}

function eliminateSeatInSim(room, seat) {
  const game = room.sim && room.sim.game;
  if (!game || !seat) return;
  const D = room.sim.D;
  game.eliminated = game.eliminated || {};
  game.eliminated[seat] = game.tick || 1;
  if (D && D.Entities) {
    for (const u of [...(game.units || [])]) {
      if (u.owner === seat) D.Entities.removeUnit(game, u);
    }
    for (const b of [...(game.buildings || [])]) {
      if (b.owner === seat) D.Entities.removeBuilding(game, b);
    }
  }
  if (D && D.Economy) {
    try {
      D.Economy.tickPower(game);
      D.Economy.recalcSpiceCap(game);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Convert a connected player into a spectator (resign).
 * Returns { ok, error? }
 */
function resignToSpectator(ws) {
  const room = ws.roomRef;
  if (!room) return { ok: false, error: 'not_in_room' };
  if (!room.started || !room.sim) return { ok: false, error: 'not_started' };
  if (isSpectatorWs(ws) || !ws.seat) return { ok: false, error: 'already_spectator' };

  const seat = ws.seat;
  const playerId = ws.playerId;
  const name = ws.displayName || 'Commander';
  const wasHost = ws.role === 'host';

  eliminateSeatInSim(room, seat);

  // Free seat
  room.slots.delete(seat);
  ensureHostRole(room);

  // Re-bind as spectator
  ws.seat = null;
  ws.role = 'spectator';
  ws.isSpectator = true;
  if (!room.spectators) room.spectators = new Map();
  room.spectators.set(playerId, {
    playerId,
    name,
    ws,
    connected: true,
  });

  touch(room);
  broadcastRoom(
    room,
    {
      type: 'player_resigned',
      seat,
      playerId,
      name,
      ...roomSnapshot(room),
    },
    null
  );
  sendJson(ws, {
    type: 'resigned',
    seat,
    spectator: true,
    role: 'spectator',
    ...roomSnapshot(room),
  });

  // If host resigned, promote another connected player
  if (wasHost) ensureHostRole(room);

  // Last player standing ends the room
  if (checkSoloOrEmptyEnd(room)) {
    return { ok: true, ended: true };
  }
  syncSimAudience(room);
  return { ok: true, ended: false };
}

/** Pause sim when nobody is connected so abandoned rooms don't starve live matches. */
function syncSimAudience(room) {
  if (!room || !room.sim || !room.started) return;
  const players = connectedCount(room);
  const specs = spectatorCount(room);
  if (players === 0 && specs === 0) {
    if (!room.sim.isPaused) {
      room.sim.pause('empty');
      room.emptySince = room.emptySince || Date.now();
      console.log(`[room ${room.id}] sim paused (no players/spectators)`);
    }
  } else {
    room.emptySince = null;
    if (room.sim.isPaused) {
      room.sim.resume();
      console.log(`[room ${room.id}] sim resumed (audience back)`);
    }
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

  // Mid-match: never free the seat on leave/drop — army stays, rejoin possible.
  // Lobby: intentional leave frees the seat for someone else.
  if (intentional && seat && !room.started) {
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

  const prevSlot = room.slots.get(seat);
  const slot = {
    playerId,
    name,
    role: role || (prevSlot && prevSlot.role) || (seat === 'player' ? 'host' : 'guest'),
    ws,
    connected: true,
    disconnectedAt: null,
    originalPlayerId:
      (prevSlot && (prevSlot.originalPlayerId || prevSlot.playerId)) || playerId,
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

/**
 * Whether a seat can be claimed (empty or reconnect grace expired).
 * Deletes expired reservations so the seat is free.
 */
function isSeatClaimable(room, seat) {
  if (!room.slots.has(seat)) return true;
  const slot = room.slots.get(seat);
  if (
    !slot.connected &&
    slot.disconnectedAt &&
    Date.now() - slot.disconnectedAt >= RECONNECT_GRACE_MS
  ) {
    room.slots.delete(seat);
    return true;
  }
  return false;
}

/**
 * First free seat, optionally preferring a house id (atreides/harkonnen/ordos).
 * Extra seats (p3 pink Harkonnen, p4 black Ordos) count for that house.
 * @param {object} room
 * @param {string|null} [preferredHouse]
 */
function findOpenSeat(room, preferredHouse) {
  const pref = normalizeHouseId(preferredHouse);
  if (pref) {
    for (const seat of seatsForHouse(pref)) {
      if (isSeatClaimable(room, seat)) return seat;
    }
  }
  for (const seat of SEAT_ORDER) {
    if (isSeatClaimable(room, seat)) return seat;
  }
  return null;
}

function sendMatchSync(ws, room, { reconnected, spectator }) {
  const snap = roomSnapshot(room);
  const names = snap.names || roomNames(room);
  sendJson(ws, {
    type: 'start',
    seed: room.mapSeed != null ? room.mapSeed : (room.sim && room.sim.seed) || 0,
    map: 'skirmish_large',
    authority: 'server',
    reconnected: !!reconnected,
    spectator: !!spectator || isSpectatorWs(ws),
    ...snap,
    names,
  });
  if (room.sim) {
    // Always full map on rejoin — lean snapshots omit tiles after first broadcast
    const payload = room.sim.snapshot({ fullMap: true });
    if (payload) {
      sendJson(ws, {
        type: 'state',
        tick: room.sim.tick,
        payload,
        speed: room.sim.speed,
        ts: Date.now(),
        reconnected: !!reconnected,
        fullMap: true,
      });
    }
  }
}

/**
 * Seats that are still in the match but currently offline (refresh / back / drop).
 */
function disconnectedSeatsIn(room) {
  const out = [];
  if (!room) return out;
  for (const [seat, slot] of room.slots) {
    if (slot && !slot.connected) out.push(seat);
  }
  return out;
}

function canAutoReclaim(slot, playerId) {
  if (!slot || !playerId) return false;
  if (slot.playerId === playerId) return true;
  if (slot.originalPlayerId && slot.originalPlayerId === playerId) return true;
  return false;
}

/**
 * Finish a rejoin: bind seat, notify room, full state sync.
 */
function completeRejoin(ws, room, seat, playerId, name, { consented }) {
  const prev = room.slots.get(seat);
  bindSeat(ws, room, seat, playerId, name, prev ? prev.role : 'guest');
  syncSimAudience(room);
  const snap = roomSnapshot(room);
  sendJson(ws, {
    type: 'joined',
    protocol: PROTOCOL,
    playerId: ws.playerId,
    name: ws.displayName,
    seat: ws.seat,
    role: ws.role,
    reconnected: true,
    consented: !!consented,
    ...snap,
  });
  broadcastRoom(
    room,
    {
      type: 'peer_reconnected',
      playerId: ws.playerId,
      name: ws.displayName,
      seat: ws.seat,
      consented: !!consented,
      ...roomSnapshot(room),
    },
    ws
  );
  if (room.started && room.sim) {
    sendMatchSync(ws, room, { reconnected: true });
  }
  console.log(
    `[room ${room.id}] rejoin seat=${seat} name=${name} consented=${!!consented}`
  );
}

/**
 * Request to reclaim a disconnected seat mid-match.
 * Same playerId → auto. Otherwise any one connected player must accept.
 */
function requestRejoin(ws, roomId, playerId, name, preferSeat) {
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
  if (!room.started || !room.sim) {
    sendJson(ws, {
      type: 'error',
      error: 'not_started',
      message: 'Match is not in progress — use Join instead.',
    });
    return;
  }

  const pid = sanitizePlayerId(playerId);
  const displayName = sanitizeName(name);

  // Leave other rooms
  if (ws.roomRef && ws.roomRef !== room) {
    detachWs(ws, true);
  }
  // Already seated in this room
  if (ws.roomRef === room && ws.seat && !isSpectatorWs(ws) && room.slots.get(ws.seat)?.connected) {
    sendJson(ws, { type: 'error', error: 'already_playing' });
    return;
  }

  // Prefer explicit seat, else own reclaim seat, else first disconnected
  let seat = preferSeat && room.slots.has(preferSeat) ? preferSeat : null;
  if (!seat) seat = findReclaimSeat(room, pid);
  if (!seat) {
    const disc = disconnectedSeatsIn(room);
    seat = disc[0] || null;
  }
  if (!seat || !room.slots.has(seat)) {
    sendJson(ws, {
      type: 'error',
      error: 'no_open_seat',
      message: 'No disconnected seat to rejoin. Spectate instead.',
    });
    return;
  }

  const slot = room.slots.get(seat);
  if (slot.connected && slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
    sendJson(ws, { type: 'error', error: 'seat_taken' });
    return;
  }

  // Original player (refresh / same browser): auto-reclaim — no vote needed
  if (canAutoReclaim(slot, pid)) {
    // Drop spectator binding if any
    if (isSpectatorWs(ws) || (ws.roomRef === room && !ws.seat)) {
      detachWs(ws, true);
    }
    completeRejoin(ws, room, seat, pid, displayName, { consented: false });
    return;
  }

  // Need consent from any currently connected player
  const approvers = connectedCount(room);
  if (approvers < 1) {
    // Nobody home to consent — allow reclaim if grace still open on empty room
    if (
      slot.disconnectedAt &&
      Date.now() - slot.disconnectedAt < RECONNECT_GRACE_MS
    ) {
      completeRejoin(ws, room, seat, pid, displayName, { consented: false });
      return;
    }
    sendJson(ws, {
      type: 'error',
      error: 'no_players_to_consent',
      message: 'No one left in the room to approve your rejoin.',
    });
    return;
  }

  if (!room.rejoinRequests) room.rejoinRequests = new Map();
  // One pending request per player
  for (const [rid, req] of [...room.rejoinRequests.entries()]) {
    if (req.playerId === pid || req.ws === ws) {
      room.rejoinRequests.delete(rid);
    }
  }

  const requestId = newRejoinRequestId();
  room.rejoinRequests.set(requestId, {
    id: requestId,
    seat,
    playerId: pid,
    name: displayName,
    ws,
    createdAt: Date.now(),
  });
  // Park requester without a seat (they'll get joined on accept)
  ws.pendingRejoinRoom = room.id;
  ws.pendingRejoinId = requestId;
  ws.playerId = pid;
  ws.displayName = displayName;

  sendJson(ws, {
    type: 'rejoin_pending',
    requestId,
    room: room.id,
    seat,
    message: 'Waiting for a player in the match to accept…',
    ...roomSnapshot(room),
  });

  // Notify all connected players (not spectators for simplicity — players decide)
  for (const s of room.slots.values()) {
    if (!s.connected || !s.ws || s.ws.readyState !== 1) continue;
    sendJson(s.ws, {
      type: 'rejoin_request',
      requestId,
      room: room.id,
      seat,
      fromPlayerId: pid,
      fromName: displayName,
      seatLabel: HOUSE_FOR_SEAT[seat] || seat,
      expiresInMs: REJOIN_REQUEST_MS,
    });
  }
  console.log(
    `[room ${room.id}] rejoin_request ${requestId} seat=${seat} from=${displayName}`
  );
}

function respondRejoin(ws, requestId, accept) {
  const room = ws.roomRef;
  if (!room || !room.rejoinRequests) {
    sendJson(ws, { type: 'error', error: 'no_request' });
    return;
  }
  if (isSpectatorWs(ws) || !ws.seat) {
    sendJson(ws, { type: 'error', error: 'spectator' });
    return;
  }
  const req = room.rejoinRequests.get(requestId);
  if (!req) {
    sendJson(ws, { type: 'error', error: 'request_expired' });
    return;
  }
  if (Date.now() - req.createdAt > REJOIN_REQUEST_MS) {
    room.rejoinRequests.delete(requestId);
    try {
      sendJson(req.ws, {
        type: 'rejoin_result',
        ok: false,
        reason: 'expired',
        message: 'Rejoin request expired.',
      });
    } catch {
      /* ignore */
    }
    sendJson(ws, { type: 'error', error: 'request_expired' });
    return;
  }

  room.rejoinRequests.delete(requestId);

  if (!accept) {
    try {
      sendJson(req.ws, {
        type: 'rejoin_result',
        ok: false,
        reason: 'declined',
        byName: ws.displayName || 'Player',
        message: (ws.displayName || 'A player') + ' declined your rejoin.',
      });
    } catch {
      /* ignore */
    }
    sendJson(ws, { type: 'rejoin_result', ok: false, reason: 'you_declined', requestId });
    // Tell other potential approvers to dismiss
    broadcastRoom(
      room,
      { type: 'rejoin_resolved', requestId, accepted: false },
      null
    );
    return;
  }

  // Accept: seat must still be disconnected
  const slot = room.slots.get(req.seat);
  if (!slot || (slot.connected && slot.ws && slot.ws.readyState === 1 && slot.ws !== req.ws)) {
    try {
      sendJson(req.ws, {
        type: 'rejoin_result',
        ok: false,
        reason: 'seat_taken',
        message: 'That seat is no longer available.',
      });
    } catch {
      /* ignore */
    }
    return;
  }

  // If requester socket died, abort
  if (!req.ws || req.ws.readyState !== 1) {
    sendJson(ws, { type: 'error', error: 'requester_gone' });
    return;
  }

  broadcastRoom(
    room,
    { type: 'rejoin_resolved', requestId, accepted: true, seat: req.seat },
    null
  );

  completeRejoin(req.ws, room, req.seat, req.playerId, req.name, {
    consented: true,
  });
  sendJson(ws, {
    type: 'rejoin_result',
    ok: true,
    reason: 'accepted',
    requestId,
    seat: req.seat,
    name: req.name,
  });
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
  // Random map seed (unique per match; stored on room for reconnect / logs)
  if (room.mapSeed == null) {
    room.mapSeed = ((Math.random() * 0x7fffffff) | 0) >>> 0;
  }
  const startMsg = {
    type: 'start',
    seed: room.mapSeed,
    map: 'skirmish_large',
    authority: 'server',
    speed: 2,
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
  const sim = new RoomSim(room.id, {
    names,
    owners,
    startMode,
    seed: room.mapSeed,
  });
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
    const winner =
      (info && info.winner) ||
      (sim.game && sim.game.winner) ||
      null;
    broadcastRoom(
      room,
      {
        type: 'match_end',
        // Always send neutral 'ended' + winner so every seat derives correctly
        phase: phase === 'draw' ? 'draw' : 'ended',
        winner,
        recordingId: (info && info.recordingId) || sim.recordingId || null,
      },
      null
    );
  };
  try {
    sim.start();
    console.log(
      `[room ${room.id}] server sim started owners=${owners.join(',')} n=${owners.length} mapSeed=${room.mapSeed}`
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

function joinExisting(ws, roomId, playerId, name, preferredHouse) {
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
  const housePref = normalizeHouseId(preferredHouse);

  // Leave any other room intentionally
  if (ws.roomRef && ws.roomRef !== room) {
    detachWs(ws, true);
  }

  let seat = findReclaimSeat(room, pid);
  let reconnected = false;

  if (seat) {
    reconnected =
      room.started || !!(room.slots.get(seat) && !room.slots.get(seat).connected);
    const prev = room.slots.get(seat);
    // Same playerId reclaiming after refresh/back — always allowed
    bindSeat(ws, room, seat, pid, displayName, prev ? prev.role : undefined);
  } else if (room.started) {
    // Match in progress: try rejoin (auto if original player, else consent flow)
    requestRejoin(ws, id, pid, displayName, null);
    return;
  } else {
    seat = findOpenSeat(room, housePref);
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

  syncSimAudience(room);
  if (room.started && room.sim) {
    // Resume into live match (and unpause if room was empty)
    sendMatchSync(ws, room, { reconnected: true });
  } else {
    maybeStartMatch(room);
  }
}

function createRoom(ws, playerId, name, title, preferredHouse) {
  if (ws.roomRef) detachWs(ws, true);
  const id = uniqueRoomCode();
  const room = makeRoom(id);
  room.title = sanitizeTitle(title);
  rooms.set(id, room);
  const pid = sanitizePlayerId(playerId);
  const displayName = sanitizeName(name);
  const housePref = normalizeHouseId(preferredHouse);
  // Prefer house seat when requested; fall back to classic host seat
  const seat = findOpenSeat(room, housePref) || 'player';
  bindSeat(ws, room, seat, pid, displayName, 'host');
  console.log(
    `[room ${id}] created title=${room.title || '(none)'} host=${displayName} seat=${seat} house=${housePref || 'default'}`
  );
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

function setRoomTitle(ws, title) {
  const room = ws.roomRef;
  if (!room) {
    sendJson(ws, { type: 'error', error: 'no_room' });
    return;
  }
  if (ws.role !== 'host') {
    sendJson(ws, { type: 'error', error: 'not_host' });
    return;
  }
  if (room.started) {
    sendJson(ws, { type: 'error', error: 'already_started' });
    return;
  }
  room.title = sanitizeTitle(title);
  touch(room);
  const snap = roomSnapshot(room);
  broadcastRoom(room, { type: 'room_update', ...snap }, null);
  sendJson(ws, { type: 'title_ok', title: room.title, ...snap });
}

/**
 * Lobby only: move this player to a free seat of the preferred house.
 */
function setSeatHouse(ws, preferredHouse) {
  const room = ws.roomRef;
  if (!room) {
    sendJson(ws, { type: 'error', error: 'no_room' });
    return;
  }
  if (room.started) {
    sendJson(ws, {
      type: 'error',
      error: 'already_started',
      message: 'Cannot change house after the match has started.',
    });
    return;
  }
  if (!ws.seat || isSpectatorWs(ws)) {
    sendJson(ws, {
      type: 'error',
      error: 'no_seat',
      message: 'Spectators cannot claim a house seat.',
    });
    return;
  }
  const house = normalizeHouseId(preferredHouse);
  if (!house) {
    sendJson(ws, {
      type: 'error',
      error: 'bad_house',
      message: 'Choose Atreides, Harkonnen, or Ordos.',
    });
    return;
  }
  if (houseIdForSeat(ws.seat) === house) {
    sendJson(ws, {
      type: 'house_ok',
      seat: ws.seat,
      role: ws.role,
      house,
      ...roomSnapshot(room),
    });
    return;
  }
  // Find a free seat of that house (not our current seat)
  const candidates = seatsForHouse(house);
  let target = null;
  for (const seat of candidates) {
    if (seat === ws.seat) continue;
    if (isSeatClaimable(room, seat)) {
      target = seat;
      break;
    }
  }
  if (!target) {
    const label = HOUSE_FOR_SEAT[candidates[0]] || house;
    sendJson(ws, {
      type: 'error',
      error: 'house_taken',
      message: label + ' has no free seats.',
    });
    return;
  }

  const prevSeat = ws.seat;
  const pid = ws.playerId;
  const displayName = ws.displayName || 'Commander';
  const role = ws.role || 'guest';
  // Free old seat then claim new one (preserve host role)
  room.slots.delete(prevSeat);
  bindSeat(ws, room, target, pid, displayName, role);
  ensureHostRole(room);
  touch(room);
  const snap = roomSnapshot(room);
  console.log(
    `[room ${room.id}] set_house ${displayName} ${prevSeat}→${target} (${house})`
  );
  sendJson(ws, {
    type: 'house_ok',
    seat: ws.seat,
    role: ws.role,
    house,
    ...snap,
  });
  broadcastRoom(
    room,
    {
      type: 'roster',
      playerId: ws.playerId,
      name: ws.displayName,
      seat: ws.seat,
      ...snap,
    },
    ws
  );
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
  syncSimAudience(room);

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
      rev: BUILD_REV,
      buildTime: BUILD_TIME,
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

      // Stamp client rev from any first message (create/join/spectate/cmd)
      if (msg.clientRev && !ws.clientRev) {
        ws.clientRev = String(msg.clientRev).slice(0, 32);
        console.log(
          `[ws] client rev=${ws.clientRev} server rev=${BUILD_REV}` +
            (ws.clientRev !== BUILD_REV ? ' ⚠ MISMATCH' : ' (match)')
        );
      }

      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong', t: msg.t || Date.now(), rev: BUILD_REV });
        return;
      }

      if (msg.type === 'create') {
        console.log(
          `[ws] create name=${msg.name || '?'} title=${msg.title || ''} house=${msg.house || ''} clientRev=${msg.clientRev || ws.clientRev || '?'}`
        );
        createRoom(ws, msg.playerId, msg.name, msg.title, msg.house);
        return;
      }

      if (msg.type === 'set_title') {
        setRoomTitle(ws, msg.title);
        return;
      }

      if (msg.type === 'set_house') {
        setSeatHouse(ws, msg.house);
        return;
      }

      if (msg.type === 'join') {
        console.log(
          `[ws] join room=${msg.room} name=${msg.name || '?'} house=${msg.house || ''} clientRev=${msg.clientRev || ws.clientRev || '?'}`
        );
        // Optional role: 'spectator' reuses join shape
        if (msg.role === 'spectator') {
          joinSpectate(ws, msg.room, msg.playerId, msg.name);
          return;
        }
        joinExisting(ws, msg.room, msg.playerId, msg.name, msg.house);
        return;
      }

      if (msg.type === 'spectate') {
        console.log(
          `[ws] spectate room=${msg.room} clientRev=${msg.clientRev || ws.clientRev || '?'}`
        );
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

      // Leave: lobby frees seat; mid-match keeps seat reserved (refresh/back recoverable)
      if (msg.type === 'leave') {
        const roomBefore = ws.roomRef;
        const wasStarted = !!(roomBefore && roomBefore.started);
        // Mid-match leave is soft so the player can rejoin; lobby is hard free
        const left = detachWs(ws, !wasStarted);
        if (left && !left.empty && left.room && !left.spectator) {
          if (wasStarted) {
            broadcastRoom(left.room, {
              type: 'peer_disconnected',
              playerId: left.playerId,
              seat: left.seat,
              name: left.name || null,
              intentional: true,
              reconnectGraceMs: RECONNECT_GRACE_MS,
              message:
                (left.name || 'Player') +
                ' left — they can rejoin with the room link (you may need to Accept).',
              ...roomSnapshot(left.room),
            });
            syncSimAudience(left.room);
          } else {
            broadcastRoom(left.room, {
              type: 'peer_left',
              playerId: left.playerId,
              seat: left.seat,
              name: left.name || null,
              intentional: true,
              ...roomSnapshot(left.room),
            });
          }
        } else if (left && !left.empty && left.room && left.spectator) {
          broadcastRoom(left.room, { type: 'roster', ...roomSnapshot(left.room) }, null);
          syncSimAudience(left.room);
        }
        sendJson(ws, { type: 'left' });
        return;
      }

      if (msg.type === 'rejoin_request') {
        requestRejoin(ws, msg.room || (ws.roomRef && ws.roomRef.id), msg.playerId, msg.name, msg.seat);
        return;
      }

      if (msg.type === 'rejoin_response') {
        respondRejoin(ws, msg.requestId, msg.accept !== false && msg.accept !== 0);
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

      // Host ends the match and destroys the room
      if (msg.type === 'end_match') {
        if (isSpectatorWs(ws)) {
          sendJson(ws, { type: 'error', error: 'spectator' });
          return;
        }
        const slot = ws.seat && room.slots.get(ws.seat);
        const isHost = (slot && slot.role === 'host') || ws.role === 'host';
        if (!isHost) {
          sendJson(ws, { type: 'error', error: 'not_host' });
          return;
        }
        if (!room.started) {
          // Lobby: notify everyone and destroy
          broadcastRoom(room, { type: 'left', reason: 'host_ended' }, null);
          for (const slot of room.slots.values()) {
            try {
              if (slot.ws) slot.ws.close();
            } catch {
              /* ignore */
            }
          }
          destroyRoom(room);
          return;
        }
        endMatchRoom(room, { winner: null, reason: 'host_ended' });
        return;
      }

      // Player resigns → spectator; last player standing ends the room
      if (msg.type === 'resign') {
        if (isSpectatorWs(ws) || !ws.seat) {
          sendJson(ws, { type: 'error', error: 'already_spectator' });
          return;
        }
        if (!room.started) {
          sendJson(ws, { type: 'error', error: 'not_started' });
          return;
        }
        resignToSpectator(ws);
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
          cap: result.cap != null ? result.cap : undefined,
          name: result.name || undefined,
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
        syncSimAudience(left.room);
      } else if (left && !left.empty && left.room && left.spectator) {
        broadcastRoom(left.room, { type: 'roster', ...roomSnapshot(left.room) }, null);
        syncSimAudience(left.room);
      }
      console.log(`[ws] disconnect (clients=${wss.clients.size} rooms=${rooms.size})`);
    });
  });

  // Sweep idle rooms + expired reconnect reservations
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      // Expire pending rejoin votes
      if (room.rejoinRequests) {
        for (const [rid, req] of [...room.rejoinRequests.entries()]) {
          if (now - req.createdAt >= REJOIN_REQUEST_MS) {
            room.rejoinRequests.delete(rid);
            try {
              if (req.ws && req.ws.readyState === 1) {
                sendJson(req.ws, {
                  type: 'rejoin_result',
                  ok: false,
                  reason: 'expired',
                  message: 'Rejoin request timed out.',
                });
              }
            } catch {
              /* ignore */
            }
            broadcastRoom(room, { type: 'rejoin_resolved', requestId: rid, accepted: false }, null);
          }
        }
      }
      // Lobby only: free expired disconnect reservations.
      // Mid-match: keep seats forever so refresh/back can rejoin until match ends.
      if (!room.started) {
        for (const [seat, slot] of [...room.slots.entries()]) {
          if (
            !slot.connected &&
            slot.disconnectedAt &&
            now - slot.disconnectedAt >= RECONNECT_GRACE_MS
          ) {
            room.slots.delete(seat);
          }
        }
      }

      const noOneHome = connectedCount(room) === 0;
      const noSpecs = spectatorCount(room) === 0;
      const stale = now - room.touched > ROOM_IDLE_MS;
      const empty = room.slots.size === 0;
      // Pause sim while empty (CPU protection); destroy after EMPTY_MATCH_MS
      if (room.started && noOneHome && noSpecs) {
        syncSimAudience(room);
        const emptyFor = room.emptySince ? now - room.emptySince : 0;
        if (emptyFor >= EMPTY_MATCH_MS) {
          console.log(`[room ${id}] destroying abandoned match (empty ${Math.round(emptyFor / 1000)}s)`);
          stopSim(room);
          rooms.delete(id);
          continue;
        }
      }

      if (
        empty ||
        (noOneHome && stale) ||
        (noOneHome && !room.started && noSpecs)
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
  }, 15_000).unref();

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
  console.log(
    `[dune2v] http://${HOST}:${PORT}  static=${ROOT}  ws=/ws  protocol=${PROTOCOL}  rev=${BUILD_REV}`
  );
  // Immediate sweep of leftover 0-cmd stubs on volume
  runRecordingCleanup('boot');
  setInterval(() => runRecordingCleanup('interval'), PRUNE_SHORT_MS).unref();
});

function shutdown(sig) {
  console.log(`[dune2v] ${sig}, shutting down — finishing open rooms/recordings`);
  // Critical: fly deploy / machine stop must finalize command-stream recordings.
  // Without this, jsonl may exist but meta stays cmds:0 and boot prune deletes it.
  try {
    for (const room of rooms.values()) {
      try {
        stopSim(room);
      } catch (e) {
        console.warn(`[dune2v] stopSim ${room && room.id}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[dune2v] shutdown room sweep failed', e.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
