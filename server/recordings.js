'use strict';

/**
 * Match recordings as an event stream (TSDB-style), not full-state dumps.
 *
 *   /data/recordings/{id}.meta.json
 *   /data/recordings/{id}.jsonl   — one event per line:
 *     { "t":0, "type":"init", "state":{...} }     // map + starting entities once
 *     { "t":42, "type":"cmd", "seat":"player", "payload":{...} }
 *     { "t":900, "type":"end", "phase":"victory" }
 *
 * Replay re-simulates from init + cmds (tiny on disk).
 */
const fs = require('fs');
const path = require('path');

const MAX_RECORDINGS = 40;

const DISK_DIR = process.env.RECORDINGS_DIR
  ? path.resolve(process.env.RECORDINGS_DIR)
  : path.join(__dirname, '..', 'data', 'recordings');

function ensureDir() {
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.warn('[recordings] mkdir failed', e.message);
    return false;
  }
}

function newId() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

function metaPath(id) {
  return path.join(DISK_DIR, id + '.meta.json');
}
function eventsPath(id) {
  return path.join(DISK_DIR, id + '.jsonl');
}

function begin(meta) {
  ensureDir();
  const id = newId();
  const rec = {
    id,
    room: meta.room || '',
    names: meta.names || {},
    startedAt: Date.now(),
    endedAt: 0,
    durationTicks: 0,
    phase: 'playing',
    baseDt: meta.baseDt || 0.05,
    seed: meta.seed != null ? meta.seed : 42,
    format: 'cmd-v1',
    events: 0,
    cmds: 0,
    _fd: null,
    _closed: false,
  };
  try {
    rec._fd = fs.openSync(eventsPath(id), 'w');
  } catch (e) {
    console.warn('[recordings] open failed', e.message);
    rec._fd = null;
  }
  writeMeta(rec);
  return rec;
}

function writeMeta(rec) {
  if (!ensureDir()) return;
  const meta = {
    id: rec.id,
    room: rec.room,
    names: rec.names,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationTicks: rec.durationTicks,
    phase: rec.phase,
    baseDt: rec.baseDt,
    seed: rec.seed,
    format: rec.format || 'cmd-v1',
    events: rec.events,
    cmds: rec.cmds || 0,
  };
  try {
    fs.writeFileSync(metaPath(rec.id), JSON.stringify(meta));
  } catch (e) {
    console.warn('[recordings] meta write failed', e.message);
  }
}

function appendEvent(rec, ev) {
  if (!rec || rec._closed || !rec._fd) return;
  try {
    fs.writeSync(rec._fd, JSON.stringify(ev) + '\n');
    rec.events++;
    if (ev.type === 'cmd') rec.cmds = (rec.cmds || 0) + 1;
  } catch (e) {
    console.warn('[recordings] event write failed', e.message);
  }
}

function finish(rec, phase, durationTicks) {
  if (!rec || rec._closed) return null;
  rec._closed = true;
  rec.phase = phase || 'unknown';
  rec.durationTicks = durationTicks || 0;
  rec.endedAt = Date.now();
  if (rec._fd != null) {
    try {
      fs.closeSync(rec._fd);
    } catch {
      /* ignore */
    }
    rec._fd = null;
  }
  writeMeta(rec);
  pruneOld();
  console.log(
    `[recordings] saved ${rec.id} format=${rec.format} events=${rec.events} cmds=${rec.cmds || 0} ticks=${rec.durationTicks} phase=${rec.phase}`
  );
  return {
    id: rec.id,
    events: rec.events,
    cmds: rec.cmds || 0,
    phase: rec.phase,
  };
}

function pruneOld() {
  try {
    if (!fs.existsSync(DISK_DIR)) return;
    const metas = fs
      .readdirSync(DISK_DIR)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(DISK_DIR, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    while (metas.length > MAX_RECORDINGS) {
      const old = metas.pop();
      if (!old || !old.id) continue;
      for (const p of [metaPath(old.id), eventsPath(old.id)]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    console.warn('[recordings] prune failed', e.message);
  }
}

function list() {
  ensureDir();
  try {
    if (!fs.existsSync(DISK_DIR)) return [];
    return fs
      .readdirSync(DISK_DIR)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(DISK_DIR, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
      .slice(0, MAX_RECORDINGS);
  } catch {
    return [];
  }
}

function get(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  const mp = metaPath(safe);
  const ep = eventsPath(safe);
  if (!fs.existsSync(mp) || !fs.existsSync(ep)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const lines = fs.readFileSync(ep, 'utf8').split('\n').filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return { ...meta, events, frames: events }; // frames alias for older client list UI
  } catch (e) {
    console.warn('[recordings] get failed', e.message);
    return null;
  }
}

module.exports = {
  DISK_DIR,
  newId,
  begin,
  appendEvent,
  finish,
  list,
  get,
};
