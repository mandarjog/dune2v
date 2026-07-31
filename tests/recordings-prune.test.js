'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('recordings pruneZeroCmd', () => {
  let dir;
  let recordings;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune2-rec-'));
    process.env.RECORDINGS_DIR = dir;
    // Fresh require with env set
    delete require.cache[require.resolve('../server/recordings')];
    recordings = require('../server/recordings');
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

  it('removes 0-cmd metas and keeps cmd>0', () => {
    // junk
    fs.writeFileSync(
      path.join(dir, 'ZERO1.meta.json'),
      JSON.stringify({ id: 'ZERO1', cmds: 0, events: 1, endedAt: 1 })
    );
    fs.writeFileSync(path.join(dir, 'ZERO1.jsonl'), '{}\n');
    // unfinished stub
    fs.writeFileSync(
      path.join(dir, 'STUB2.meta.json'),
      JSON.stringify({ id: 'STUB2', cmds: 0, events: 0, endedAt: 0, phase: 'playing' })
    );
    fs.writeFileSync(path.join(dir, 'STUB2.jsonl'), '');
    // good
    fs.writeFileSync(
      path.join(dir, 'GOOD3.meta.json'),
      JSON.stringify({ id: 'GOOD3', cmds: 12, events: 15, endedAt: 99, phase: 'victory' })
    );
    fs.writeFileSync(path.join(dir, 'GOOD3.jsonl'), '{"type":"cmd"}\n');

    const r = recordings.pruneZeroCmd();
    assert.ok(r.removed.some((id) => id.startsWith('ZERO1')));
    assert.ok(r.removed.some((id) => id.startsWith('STUB2')));
    assert.ok(!fs.existsSync(path.join(dir, 'ZERO1.meta.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'STUB2.meta.json')));
    assert.ok(fs.existsSync(path.join(dir, 'GOOD3.meta.json')));
    const list = recordings.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'GOOD3');
  });

  it('finish with 0 cmds discards files', () => {
    const rec = recordings.begin({ room: 'T', names: { player: 'a' } });
    // no cmds appended
    const info = recordings.finish(rec, 'playing', 100);
    assert.equal(info, null);
    assert.ok(!fs.existsSync(path.join(dir, rec.id + '.meta.json')));
  });
});
