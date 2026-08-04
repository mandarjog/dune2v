'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Dune2 } = require('./setup.js');

function waitMsg(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeoutMs);
    function onMsg(raw) {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === type) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('spectate FOW / view', () => {
  it('fogVisible is false when game.spectator', () => {
    const game = Dune2.Game.create();
    game.spectator = true;
    assert.equal(Dune2.Map.fogVisible(game), false);
  });

  it('fogVisible is false when game.replay', () => {
    const game = Dune2.Game.create();
    game.replay = true;
    assert.equal(Dune2.Map.fogVisible(game), false);
  });

  it('fogVisible follows features.fog for normal play', () => {
    const game = Dune2.Game.create();
    const prev = Dune2.config.features.fog;
    Dune2.config.features.fog = true;
    assert.equal(Dune2.Map.fogVisible(game), true);
    game.spectator = true;
    assert.equal(Dune2.Map.fogVisible(game), false);
    Dune2.config.features.fog = prev;
  });

  it('game.create includes spectator: false', () => {
    const game = Dune2.Game.create();
    assert.equal(game.spectator, false);
  });
});

describe('live API + spectator WS', () => {
  let child;
  let port;
  let base;
  let wsUrl;

  before(async () => {
    port = 18000 + ((Math.random() * 1000) | 0);
    base = 'http://127.0.0.1:' + port;
    wsUrl = 'ws://127.0.0.1:' + port + '/ws';
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 8000;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(base + '/health');
        if (res.ok) {
          ok = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ok) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      throw new Error('server did not start on ' + port);
    }
  });

  after(() => {
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  });

  it('returns { ok, matches } array', async () => {
    const res = await fetch(base + '/api/live');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.matches));
  });

  it('health reports protocol >= 6', async () => {
    const res = await fetch(base + '/health');
    const data = await res.json();
    assert.ok(data.protocol >= 6, 'protocol bumped for spectate');
  });

  it('host can end lobby; resign makes spectator and last player wins', async () => {
    const host = await openWs(wsUrl);
    await waitMsg(host, 'hello');
    host.send(
      JSON.stringify({
        type: 'create',
        playerId: 'p_end_host',
        name: 'HostEnd',
      })
    );
    const j1 = await waitMsg(host, 'joined');
    const room = j1.room;
    const guest = await openWs(wsUrl);
    await waitMsg(guest, 'hello');
    guest.send(
      JSON.stringify({
        type: 'join',
        room,
        playerId: 'p_end_guest',
        name: 'GuestEnd',
      })
    );
    await waitMsg(guest, 'joined');
    host.send(JSON.stringify({ type: 'start_match', startMode: 'base' }));
    await waitMsg(host, 'start');
    await waitMsg(guest, 'start');

    // Guest resigns → spectator
    guest.send(JSON.stringify({ type: 'resign' }));
    const resigned = await waitMsg(guest, 'resigned');
    assert.equal(resigned.spectator, true);
    // Room should end — only host left
    const end = await waitMsg(host, 'match_end', 6000);
    assert.ok(end);
    assert.equal(end.winner, 'player'); // host seat
    assert.equal(end.reason, 'last_player');

    host.close();
    guest.close();
  });

  it('lists room after host create; spectate rejects cmds and does not take seat', async () => {
    const host = await openWs(wsUrl);
    await waitMsg(host, 'hello');
    host.send(
      JSON.stringify({
        type: 'create',
        playerId: 'p_host_test',
        name: 'HostAlice',
        title: 'Friday FFA',
      })
    );
    const joined = await waitMsg(host, 'joined');
    assert.ok(joined.room);
    assert.equal(joined.seat, 'player');
    assert.equal(joined.role, 'host');
    assert.equal(joined.spectators, 0);
    assert.equal(joined.title, 'Friday FFA');

    // Live list should include lobby room (joinable before start)
    const listRes = await fetch(base + '/api/live');
    const list = await listRes.json();
    assert.equal(list.ok, true);
    const entry = list.matches.find((m) => m.room === joined.room);
    assert.ok(entry, 'room appears in /api/live');
    assert.equal(entry.names.player, 'HostAlice');
    assert.equal(entry.players, 1);
    assert.equal(entry.title, 'Friday FFA');
    assert.equal(entry.canJoin, true);
    assert.equal(entry.started, false);
    assert.equal(entry.canSpectate, true);

    // Spectator joins without taking seat
    const spec = await openWs(wsUrl);
    await waitMsg(spec, 'hello');
    spec.send(
      JSON.stringify({
        type: 'spectate',
        room: joined.room,
        playerId: 'p_spec_test',
        name: 'Watcher',
      })
    );
    const sj = await waitMsg(spec, 'joined');
    assert.equal(sj.role, 'spectator');
    assert.equal(sj.seat, null);
    assert.equal(sj.spectator, true);
    assert.ok(sj.spectators >= 1);

    // Still open for a second player
    assert.equal(sj.open, true);
    assert.ok(sj.players <= 1);

    // Commands rejected
    spec.send(JSON.stringify({ type: 'cmd', payload: { op: 'stop', ids: [1] } }));
    const cmdRes = await waitMsg(spec, 'cmd_result');
    assert.equal(cmdRes.ok, false);
    assert.equal(cmdRes.reason, 'spectator');

    // Guest can still join as player
    const guest = await openWs(wsUrl);
    await waitMsg(guest, 'hello');
    guest.send(
      JSON.stringify({
        type: 'join',
        room: joined.room,
        playerId: 'p_guest_test',
        name: 'GuestBob',
      })
    );
    const gj = await waitMsg(guest, 'joined');
    assert.equal(gj.seat, 'enemy');
    assert.notEqual(gj.role, 'spectator');

    // Host must start (no longer auto-starts at 2 so FFA lobbies can fill)
    host.send(JSON.stringify({ type: 'start_match' }));

    // Match should start — spectator gets start
    const start = await waitMsg(spec, 'start', 6000);
    assert.equal(start.spectator, true);
    assert.equal(start.map, 'skirmish_large');
    assert.ok(start.owners && start.owners.length >= 2);

    // State broadcast reaches spectator
    const state = await waitMsg(spec, 'state', 6000);
    assert.ok(state.payload);

    // Leave spectator does not destroy room
    spec.send(JSON.stringify({ type: 'leave' }));
    await waitMsg(spec, 'left');
    spec.close();

    const list2 = await (await fetch(base + '/api/live')).json();
    const still = list2.matches.find((m) => m.room === joined.room);
    assert.ok(still, 'room still live after spectator left');
    assert.ok(still.started);

    host.close();
    guest.close();
  });
});
