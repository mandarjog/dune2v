'use strict';

/**
 * Match recordings — stream frames to disk (Fly volume), not RAM.
 * Format:
 *   /data/recordings/{id}.meta.json  — list metadata
 *   /data/recordings/{id}.jsonl      — one JSON object per line (frames)
 */
const fs = require('fs');
const path = require('path');

const MAX_RECORDINGS = 30;

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
function framesPath(id) {
  return path.join(DISK_DIR, id + '.jsonl');
}

/**
 * Start a streaming recording. Caller pushes frames; finish() closes files.
 */
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
    frames: 0,
    _fd: null,
    _closed: false,
  };
  try {
    rec._fd = fs.openSync(framesPath(id), 'w');
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
    frames: rec.frames,
  };
  try {
    fs.writeFileSync(metaPath(rec.id), JSON.stringify(meta));
  } catch (e) {
    console.warn('[recordings] meta write failed', e.message);
  }
}

/** Append one frame (already a plain object). */
function appendFrame(rec, frame) {
  if (!rec || rec._closed || !rec._fd) return;
  try {
    fs.writeSync(rec._fd, JSON.stringify(frame) + '\n');
    rec.frames++;
  } catch (e) {
    console.warn('[recordings] frame write failed', e.message);
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
    `[recordings] saved ${rec.id} frames=${rec.frames} ticks=${rec.durationTicks} phase=${rec.phase}`
  );
  return { id: rec.id, frames: rec.frames, phase: rec.phase };
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
      try {
        fs.unlinkSync(metaPath(old.id));
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(framesPath(old.id));
      } catch {
        /* ignore */
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
  const fp = framesPath(safe);
  if (!fs.existsSync(mp) || !fs.existsSync(fp)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    const frames = [];
    for (const line of lines) {
      try {
        frames.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return { ...meta, frames };
  } catch (e) {
    console.warn('[recordings] get failed', e.message);
    return null;
  }
}

module.exports = {
  DISK_DIR,
  newId,
  begin,
  appendFrame,
  finish,
  list,
  get,
};
