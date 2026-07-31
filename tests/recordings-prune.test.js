'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('recordings pruneShort', () => {
  let dir;
  let recordings;
  let MIN;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune2-rec-'));
    process.env.RECORDINGS_DIR = dir;
    delete require.cache[require.resolve('../server/recordings')];
    recordings = require('../server/recordings');
    MIN = recordings.MIN_CMDS_TO_SAVE || 10;
  });

  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.RECORDINGS_DIR;
    delete require.cache[require.resolve('../server/recordings')];
  });

  it('removes cmds < min and keeps cmds >= min', () => {
    fs.writeFileSync(
      path.join(dir, 'ZERO1.meta.json'),
      JSON.stringify({ id: 'ZERO1', cmds: 0, events: 1, endedAt: 1 })
    );
    fs.writeFileSync(path.join(dir, 'ZERO1.jsonl'), '{}\n');

    fs.writeFileSync(
      path.join(dir, 'SHORT2.meta.json'),
      JSON.stringify({ id: 'SHORT2', cmds: MIN - 1, events: 5, endedAt: 2 })
    );
    fs.writeFileSync(path.join(dir, 'SHORT2.jsonl'), '{"type":"cmd"}\n');

    fs.writeFileSync(
      path.join(dir, 'GOOD3.meta.json'),
      JSON.stringify({ id: 'GOOD3', cmds: MIN, events: 15, endedAt: 99, phase: 'victory' })
    );
    fs.writeFileSync(path.join(dir, 'GOOD3.jsonl'), '{"type":"cmd"}\n');

    fs.writeFileSync(
      path.join(dir, 'GOOD4.meta.json'),
      JSON.stringify({ id: 'GOOD4', cmds: MIN + 5, events: 20, endedAt: 100, phase: 'defeat' })
    );
    fs.writeFileSync(path.join(dir, 'GOOD4.jsonl'), '{"type":"cmd"}\n');

    const r = recordings.pruneShort();
    assert.equal(r.minCmds, MIN);
    assert.ok(r.removed.some((id) => String(id).startsWith('ZERO1')));
    assert.ok(r.removed.some((id) => String(id).startsWith('SHORT2')));
    assert.ok(!fs.existsSync(path.join(dir, 'ZERO1.meta.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'SHORT2.meta.json')));
    assert.ok(fs.existsSync(path.join(dir, 'GOOD3.meta.json')));
    assert.ok(fs.existsSync(path.join(dir, 'GOOD4.meta.json')));
    const list = recordings.list();
    assert.equal(list.length, 2);
    assert.ok(list.every((m) => (m.cmds | 0) >= MIN));
  });

  it('finish with fewer than min cmds discards files', () => {
    const rec = recordings.begin({ room: 'T', names: { player: 'a' } });
    for (let i = 0; i < MIN - 1; i++) {
      recordings.appendEvent(rec, {
        t: i,
        type: 'cmd',
        seat: 'player',
        payload: { op: 'stop', ids: [] },
      });
    }
    const info = recordings.finish(rec, 'playing', 100);
    assert.equal(info, null);
    assert.ok(!fs.existsSync(path.join(dir, rec.id + '.meta.json')));
  });

  it('finish with min cmds keeps recording', () => {
    const rec = recordings.begin({ room: 'T2', names: { player: 'a' } });
    for (let i = 0; i < MIN; i++) {
      recordings.appendEvent(rec, {
        t: i,
        type: 'cmd',
        seat: 'player',
        payload: { op: 'stop', ids: [] },
      });
    }
    const info = recordings.finish(rec, 'victory', 200);
    assert.ok(info);
    assert.equal(info.cmds, MIN);
    assert.ok(fs.existsSync(path.join(dir, rec.id + '.meta.json')));
  });
});
