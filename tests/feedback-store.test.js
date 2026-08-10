'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('feedback vs telemetry stores', () => {
  let dir;
  let prev;
  let feedbackStore;
  let telemetryStore;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune2-fb-'));
    prev = process.env.RECORDINGS_DIR;
    process.env.RECORDINGS_DIR = path.join(dir, 'recordings');
    fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
    delete require.cache[require.resolve('../server/feedback-store')];
    delete require.cache[require.resolve('../server/telemetry-store')];
    feedbackStore = require('../server/feedback-store');
    telemetryStore = require('../server/telemetry-store');
  });

  after(() => {
    if (prev == null) delete process.env.RECORDINGS_DIR;
    else process.env.RECORDINGS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes human notes and telemetry to different files', () => {
    assert.ok(feedbackStore.append({ at: 1, text: 'hello player' }));
    assert.ok(telemetryStore.append({ type: 'telemetry', kind: 'order_issue' }));
    const fb = feedbackStore.feedbackPath();
    const tel = telemetryStore.telemetryPath();
    assert.notEqual(fb, tel);
    assert.match(fb, /feedback\.jsonl$/);
    assert.match(tel, /telemetry\.jsonl$/);
    const fbTxt = fs.readFileSync(fb, 'utf8');
    const telTxt = fs.readFileSync(tel, 'utf8');
    assert.match(fbTxt, /hello player/);
    assert.doesNotMatch(fbTxt, /order_issue/);
    assert.match(telTxt, /order_issue/);
    assert.doesNotMatch(telTxt, /hello player/);
    assert.equal(feedbackStore.count(), 1);
    assert.equal(telemetryStore.count(), 1);
  });
});
