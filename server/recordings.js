'use strict';

/**
 * In-memory (+ optional disk) match recordings for replay.
 * Frames are thinned snapshots so size stays manageable.
 */
const fs = require('fs');
const path = require('path');

const MAX_RECORDINGS = 40;
const DISK_DIR = process.env.RECORDINGS_DIR
  ? path.resolve(process.env.RECORDINGS_DIR)
  : path.join(__dirname, '..', 'data', 'recordings');

/** @type {Map<string, object>} */
const store = new Map();

function ensureDir() {
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function list() {
  const items = [...store.values()].map(metaOf).sort((a, b) => b.endedAt - a.endedAt);
  // Also surface disk files not in memory
  try {
    if (fs.existsSync(DISK_DIR)) {
      for (const f of fs.readdirSync(DISK_DIR)) {
        if (!f.endsWith('.json')) continue;
        const id = f.replace(/\.json$/, '');
        if (store.has(id)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(DISK_DIR, f), 'utf8'));
          store.set(id, raw);
          items.push(metaOf(raw));
        } catch {
          /* skip bad file */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return items.sort((a, b) => b.endedAt - a.endedAt).slice(0, MAX_RECORDINGS);
}

function metaOf(rec) {
  return {
    id: rec.id,
    room: rec.room,
    names: rec.names || {},
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationTicks: rec.durationTicks || 0,
    phase: rec.phase || 'unknown',
    frames: (rec.frames && rec.frames.length) || 0,
  };
}

function get(id) {
  if (store.has(id)) return store.get(id);
  try {
    const p = path.join(DISK_DIR, id + '.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      store.set(id, raw);
      return raw;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function save(rec) {
  if (!rec || !rec.id) return false;
  store.set(rec.id, rec);
  // Cap memory
  if (store.size > MAX_RECORDINGS) {
    const ordered = [...store.values()].sort((a, b) => a.endedAt - b.endedAt);
    while (store.size > MAX_RECORDINGS) {
      const old = ordered.shift();
      if (old) store.delete(old.id);
    }
  }
  if (ensureDir()) {
    try {
      fs.writeFileSync(path.join(DISK_DIR, rec.id + '.json'), JSON.stringify(rec));
    } catch (e) {
      console.warn('[recordings] disk write failed', e.message);
    }
  }
  console.log(
    `[recordings] saved ${rec.id} frames=${rec.frames.length} ticks=${rec.durationTicks} phase=${rec.phase}`
  );
  return true;
}

function newId() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

module.exports = { list, get, save, newId, metaOf, DISK_DIR };
