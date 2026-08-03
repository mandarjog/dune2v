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
/** Matches with fewer player cmds than this are discarded (not worth replaying). */
const MIN_CMDS_TO_SAVE = 10;

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
    owners: meta.owners || null,
    startedAt: Date.now(),
    endedAt: 0,
    durationTicks: 0,
    phase: 'playing',
    baseDt: meta.baseDt || 0.05,
    seed: meta.seed != null ? meta.seed : 42,
    format: 'cmd-v1',
    // idStable: entity ids are sequential without snapshot burns (post nextId fix)
    idStable: true,
    events: 0,
    cmds: 0,
    _fd: null,
    _closed: false,
    _metaCmdFlush: 0,
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
    owners: rec.owners || null,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationTicks: rec.durationTicks,
    phase: rec.phase,
    baseDt: rec.baseDt,
    seed: rec.seed,
    format: rec.format || 'cmd-v1',
    idStable: rec.idStable !== false,
    events: rec.events,
    cmds: rec.cmds || 0,
  };
  try {
    fs.writeFileSync(metaPath(rec.id), JSON.stringify(meta));
  } catch (e) {
    console.warn('[recordings] meta write failed', e.message);
  }
}

/** Flush in-memory event/cmd counts to disk (in-progress matches). */
function touchMeta(rec) {
  if (!rec || rec._closed) return;
  writeMeta(rec);
}

function appendEvent(rec, ev) {
  if (!rec || rec._closed || !rec._fd) return;
  try {
    fs.writeSync(rec._fd, JSON.stringify(ev) + '\n');
    rec.events++;
    if (ev.type === 'cmd') {
      rec.cmds = (rec.cmds || 0) + 1;
      // Periodic meta flush so crash/OOM still lists long FFA matches
      if (rec.cmds - (rec._metaCmdFlush || 0) >= 25) {
        rec._metaCmdFlush = rec.cmds;
        writeMeta(rec);
      }
    }
  } catch (e) {
    console.warn('[recordings] event write failed', e.message);
  }
}

/** Count cmd events in a jsonl file (for orphan / crash recovery). */
function countCmdsOnDisk(id) {
  const ep = eventsPath(id);
  if (!fs.existsSync(ep)) return 0;
  try {
    const text = fs.readFileSync(ep, 'utf8');
    let n = 0;
    // Fast path: count type":"cmd" without full JSON parse
    const re = /"type"\s*:\s*"cmd"/g;
    let m;
    while ((m = re.exec(text))) n++;
    return n;
  } catch {
    return 0;
  }
}

function removeRecording(id) {
  if (!id) return false;
  let ok = false;
  for (const p of [metaPath(id), eventsPath(id)]) {
    try {
      fs.unlinkSync(p);
      ok = true;
    } catch {
      /* missing is fine */
    }
  }
  return ok;
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
  // Drop empty / short matches (not worth replaying)
  const cmds = rec.cmds | 0;
  if (cmds < MIN_CMDS_TO_SAVE) {
    removeRecording(rec.id);
    console.log(
      `[recordings] discarded ${rec.id} (${cmds} cmds < ${MIN_CMDS_TO_SAVE}, phase=${rec.phase}, ticks=${rec.durationTicks})`
    );
    pruneOld();
    pruneShort();
    return null;
  }
  writeMeta(rec);
  pruneOld();
  pruneShort();
  console.log(
    `[recordings] saved ${rec.id} format=${rec.format} events=${rec.events} cmds=${cmds} ticks=${rec.durationTicks} phase=${rec.phase}`
  );
  return {
    id: rec.id,
    events: rec.events,
    cmds: rec.cmds || 0,
    phase: rec.phase,
  };
}

function readAllMetas() {
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
    .filter(Boolean);
}

function pruneOld() {
  try {
    if (!fs.existsSync(DISK_DIR)) return;
    const metas = readAllMetas().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    while (metas.length > MAX_RECORDINGS) {
      const old = metas.pop();
      if (!old || !old.id) continue;
      removeRecording(old.id);
    }
  } catch (e) {
    console.warn('[recordings] prune failed', e.message);
  }
}

/**
 * Delete short / empty recordings (cmds < MIN_CMDS_TO_SAVE) and orphans.
 * @returns {{ removed: string[], kept: number, minCmds: number }}
 */
function pruneShort() {
  const removed = [];
  try {
    ensureDir();
    if (!fs.existsSync(DISK_DIR)) {
      return { removed, kept: 0, minCmds: MIN_CMDS_TO_SAVE };
    }

    const files = fs.readdirSync(DISK_DIR);
    const metaIds = new Set();
    const jsonlIds = new Set();

    for (const f of files) {
      if (f.endsWith('.meta.json')) metaIds.add(f.slice(0, -'.meta.json'.length));
      else if (f.endsWith('.jsonl')) jsonlIds.add(f.slice(0, -'.jsonl'.length));
    }

    // Orphans
    for (const id of metaIds) {
      if (!jsonlIds.has(id)) {
        removeRecording(id);
        removed.push(id + '(orphan-meta)');
      }
    }
    for (const id of jsonlIds) {
      if (!metaIds.has(id)) {
        removeRecording(id);
        removed.push(id + '(orphan-jsonl)');
      }
    }

    const metas = readAllMetas();
    for (const m of metas) {
      if (!m || !m.id) continue;
      // Prefer disk count — unfinished matches used to keep meta.cmds=0 while
      // the jsonl already held the full command stream (deploy/crash).
      let cmds = m.cmds != null ? m.cmds | 0 : 0;
      const disk = countCmdsOnDisk(m.id);
      if (disk > cmds) cmds = disk;
      if (cmds < MIN_CMDS_TO_SAVE) {
        if (removeRecording(m.id)) removed.push(m.id + '(cmds=' + cmds + ')');
      } else if (disk > (m.cmds | 0)) {
        // Heal stale meta so list()/UI see the real stream
        try {
          fs.writeFileSync(
            metaPath(m.id),
            JSON.stringify({ ...m, cmds: disk, events: Math.max(m.events | 0, disk) })
          );
        } catch {
          /* ignore */
        }
      }
    }

    if (removed.length) {
      console.log(
        `[recordings] pruneShort (min=${MIN_CMDS_TO_SAVE}) removed ${removed.length}: ${removed
          .slice(0, 12)
          .join(', ')}${removed.length > 12 ? '…' : ''}`
      );
    }
    return {
      removed,
      kept: readAllMetas().filter((m) => (m.cmds | 0) >= MIN_CMDS_TO_SAVE).length,
      minCmds: MIN_CMDS_TO_SAVE,
    };
  } catch (e) {
    console.warn('[recordings] pruneShort failed', e.message);
    return { removed, kept: 0, minCmds: MIN_CMDS_TO_SAVE };
  }
}

/** @deprecated alias — prefer pruneShort */
function pruneZeroCmd() {
  return pruneShort();
}

function list() {
  ensureDir();
  try {
    if (!fs.existsSync(DISK_DIR)) return [];
    const metas = readAllMetas().map((m) => {
      // Crash recovery: meta may still say cmds:0 while jsonl has the stream
      let cmds = m.cmds | 0;
      if (cmds < MIN_CMDS_TO_SAVE && m.id) {
        const disk = countCmdsOnDisk(m.id);
        if (disk > cmds) {
          cmds = disk;
          m.cmds = disk;
          // Heal meta so next list is cheap
          try {
            fs.writeFileSync(metaPath(m.id), JSON.stringify({ ...m, cmds: disk }));
          } catch {
            /* ignore */
          }
        }
      }
      return m;
    });
    return metas
      .filter((m) => (m.cmds | 0) >= MIN_CMDS_TO_SAVE)
      .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0))
      .slice(0, MAX_RECORDINGS);
  } catch {
    return [];
  }
}

function get(id) {
  const safe = String(id || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toUpperCase();
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
  MAX_RECORDINGS,
  MIN_CMDS_TO_SAVE,
  newId,
  begin,
  appendEvent,
  touchMeta,
  countCmdsOnDisk,
  finish,
  list,
  get,
  pruneOld,
  pruneShort,
  pruneZeroCmd,
  removeRecording,
};
