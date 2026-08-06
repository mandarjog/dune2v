'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Dune2 } = require('./setup.js');

function waitMsg(ws, type, timeoutMs = 5000) {
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

describe('FOW reset on room change', () => {
  it('initFog clears explored so prior match cannot leave map open', () => {
    const game = Dune2.Game.create();
    Dune2.Game.startSkirmish(game, Dune2.MAPS.skirmish1);
    Dune2.config.features.fog = true;
    Dune2.Map.initFog(game);
    // Simulate fog-off filling explored
    Dune2.config.features.fog = false;
    Dune2.Map.recomputeFog(game, 'player');
    let n = game.map.width * game.map.height;
    let explored = 0;
    for (let i = 0; i < n; i++) if (game.fog.player.explored[i]) explored++;
    assert.equal(explored, n);
    // New match style reset
    Dune2.config.features.fog = true;
    Dune2.Map.initFog(game);
    Dune2.Map.recomputeFog(game, 'player');
    explored = 0;
    for (let i = 0; i < n; i++) if (game.fog.player.explored[i]) explored++;
    assert.ok(explored < n * 0.2, 'explored should be starter vision only, got ' + explored);
  });
});

describe('mid-match rejoin + consent', () => {
  let child;
  let port;
  let base;
  let wsUrl;

  before(async () => {
    // Avoid clashing with parallel spectate.test.js (18xxx) when node --test fans out
    port = 21000 + (process.pid % 1000) + ((Math.random() * 200) | 0);
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

  it('health protocol >= 8', async () => {
    const res = await fetch(base + '/health');
    const data = await res.json();
    assert.ok(data.protocol >= 8, 'protocol ' + data.protocol);
  });

  it('same playerId auto-rejoins after disconnect (refresh/back)', async () => {
    const host = await openWs(wsUrl);
    await waitMsg(host, 'hello');
    host.send(
      JSON.stringify({ type: 'create', playerId: 'p_rj_host', name: 'HostRJ' })
    );
    const j1 = await waitMsg(host, 'joined');
    const room = j1.room;

    const guest = await openWs(wsUrl);
    await waitMsg(guest, 'hello');
    guest.send(
      JSON.stringify({
        type: 'join',
        room,
        playerId: 'p_rj_guest',
        name: 'GuestRJ',
      })
    );
    await waitMsg(guest, 'joined');
    host.send(JSON.stringify({ type: 'start_match' }));
    await waitMsg(host, 'start');
    await waitMsg(guest, 'start');
    await waitMsg(guest, 'state');

    // Guest "refresh": drop without leave (soft disconnect)
    guest.close();
    await waitMsg(host, 'peer_disconnected');

    // Live list shows canRejoin
    const list = await (await fetch(base + '/api/live')).json();
    const entry = list.matches.find((m) => m.room === room);
    assert.ok(entry, 'room listed');
    assert.equal(entry.canRejoin, true);

    // Same playerId rejoins
    const guest2 = await openWs(wsUrl);
    await waitMsg(guest2, 'hello');
    guest2.send(
      JSON.stringify({
        type: 'join',
        room,
        playerId: 'p_rj_guest',
        name: 'GuestRJ',
      })
    );
    const back = await waitMsg(guest2, 'joined');
    assert.equal(back.reconnected, true);
    assert.equal(back.seat, 'enemy');
    const st = await waitMsg(guest2, 'state');
    assert.ok(st.payload && st.payload.map && st.payload.map.tiles, 'full map on rejoin');
    assert.equal(st.fullMap || st.reconnected, true);

    host.close();
    guest2.close();
  });

  it('different playerId needs consent from one connected player', async () => {
    const host = await openWs(wsUrl);
    await waitMsg(host, 'hello');
    host.send(
      JSON.stringify({ type: 'create', playerId: 'p_rj2_host', name: 'Host2' })
    );
    const j1 = await waitMsg(host, 'joined');
    const room = j1.room;

    const guest = await openWs(wsUrl);
    await waitMsg(guest, 'hello');
    guest.send(
      JSON.stringify({
        type: 'join',
        room,
        playerId: 'p_rj2_guest',
        name: 'Guest2',
      })
    );
    await waitMsg(guest, 'joined');
    host.send(JSON.stringify({ type: 'start_match' }));
    await waitMsg(host, 'start');
    await waitMsg(guest, 'start');

    guest.close();
    await waitMsg(host, 'peer_disconnected');

    // New browser / new playerId wants the empty seat
    const other = await openWs(wsUrl);
    await waitMsg(other, 'hello');
    other.send(
      JSON.stringify({
        type: 'rejoin_request',
        room,
        playerId: 'p_rj2_other',
        name: 'OtherGuy',
      })
    );
    const pending = await waitMsg(other, 'rejoin_pending');
    assert.ok(pending.requestId);

    const req = await waitMsg(host, 'rejoin_request');
    assert.equal(req.fromName, 'OtherGuy');
    assert.equal(req.requestId, pending.requestId);

    host.send(
      JSON.stringify({
        type: 'rejoin_response',
        requestId: req.requestId,
        accept: true,
      })
    );
    const joined = await waitMsg(other, 'joined');
    assert.equal(joined.reconnected, true);
    assert.equal(joined.consented, true);
    assert.equal(joined.seat, 'enemy');

    host.close();
    other.close();
  });

  it('mid-match leave keeps seat (soft) so original can rejoin', async () => {
    const host = await openWs(wsUrl);
    await waitMsg(host, 'hello');
    host.send(
      JSON.stringify({ type: 'create', playerId: 'p_rj3_host', name: 'Host3' })
    );
    const j1 = await waitMsg(host, 'joined');
    const room = j1.room;
    const guest = await openWs(wsUrl);
    await waitMsg(guest, 'hello');
    guest.send(
      JSON.stringify({
        type: 'join',
        room,
        playerId: 'p_rj3_guest',
        name: 'Guest3',
      })
    );
    await waitMsg(guest, 'joined');
    host.send(JSON.stringify({ type: 'start_match' }));
    await waitMsg(host, 'start');
    await waitMsg(guest, 'start');

    guest.send(JSON.stringify({ type: 'leave' }));
    await waitMsg(guest, 'left');
    // Host should get disconnect, not match_end
    const disc = await waitMsg(host, 'peer_disconnected');
    assert.ok(disc.seat === 'enemy');
    try {
      guest.close();
    } catch {
      /* ignore */
    }

    const guest2 = await openWs(wsUrl);
    await waitMsg(guest2, 'hello', 8000);
    guest2.send(
      JSON.stringify({
        type: 'join',
        room,
        playerId: 'p_rj3_guest',
        name: 'Guest3',
      })
    );
    const back = await waitMsg(guest2, 'joined', 8000);
    assert.equal(back.seat, 'enemy');
    assert.equal(back.reconnected, true);

    host.close();
    guest2.close();
  });
});
