'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LINES = 500;

function feedbackPath() {
  const base = process.env.RECORDINGS_DIR
    ? path.resolve(process.env.RECORDINGS_DIR, '..')
    : path.join(__dirname, '..', 'data');
  return path.join(base, 'feedback.jsonl');
}

function ensureParent(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function append(entry) {
  const file = feedbackPath();
  if (!ensureParent(file)) return false;
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    prune(file);
    return true;
  } catch (e) {
    console.warn('[feedback] write failed', e.message);
    return false;
  }
}

function prune(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const keep = lines.slice(-MAX_LINES);
    fs.writeFileSync(file, keep.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}

function count() {
  try {
    const file = feedbackPath();
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

module.exports = { append, count, feedbackPath };
