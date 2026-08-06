/* global Dune2 */
/**
 * Lightweight client → server telemetry for SP and MP.
 * Lets us see skirmish stuck/path issues that never hit MP room logs.
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const ENDPOINT = '/api/telemetry';
  let lastStuckReport = 0;
  let lastHeartbeat = 0;
  let sessionId = null;

  function sid() {
    if (sessionId) return sessionId;
    try {
      sessionId = sessionStorage.getItem('dune2_tel_sid');
      if (!sessionId) {
        sessionId =
          's_' +
          Math.random().toString(36).slice(2, 10) +
          Date.now().toString(36).slice(-4);
        sessionStorage.setItem('dune2_tel_sid', sessionId);
      }
    } catch (e) {
      sessionId = 's_' + Math.random().toString(36).slice(2, 10);
    }
    return sessionId;
  }

  function basePayload(game) {
    const stuck = [];
    let stuckPath = 0;
    let stuckOther = 0;
    if (game && game.units) {
      for (const u of game.units) {
        if (!u.stuck) continue;
        if (u.stuckReason === 'path') stuckPath++;
        else stuckOther++;
        if (stuck.length < 8) {
          stuck.push({
            id: u.id,
            type: u.type,
            owner: u.owner,
            reason: u.stuckReason || '?',
            x: Math.round(u.x * 10) / 10,
            y: Math.round(u.y * 10) / 10,
            order: u.order && u.order.type,
            pathLen: (u.path && u.path.length) || 0,
          });
        }
      }
    }
    return {
      session: sid(),
      rev: (D.buildRev && D.buildRev()) || (D.BUILD && D.BUILD.rev) || '?',
      multiplayer: !!(game && game.multiplayer),
      spectator: !!(game && game.spectator),
      phase: game && game.phase,
      tick: game && game.tick,
      scenario: game && game.stats && game.stats.scenario,
      units: game && game.units ? game.units.length : 0,
      stuckPath,
      stuckOther,
      stuckSample: stuck,
      fps: game && game.stats ? Math.round(game.stats.fps || 0) : 0,
      href:
        typeof location !== 'undefined' ? String(location.href).slice(0, 300) : '',
    };
  }

  function send(kind, extra, game) {
    if (typeof fetch === 'undefined') return;
    if (typeof location !== 'undefined' && location.protocol === 'file:') return;
    const body = Object.assign(basePayload(game || D.Loop && D.Loop.game), extra || {}, {
      kind: kind || 'event',
      at: Date.now(),
    });
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        cache: 'no-store',
      }).catch(function () {
        /* ignore offline */
      });
    } catch (e) {
      /* ignore */
    }
  }

  D.Telemetry = {
    /** Call from game loop periodically (SP + MP client). */
    tick(game, nowMs) {
      if (!game || game.phase !== 'playing') return;
      nowMs = nowMs || (typeof performance !== 'undefined' ? performance.now() : Date.now());

      // Heartbeat every 45s so we know sessions exist
      if (nowMs - lastHeartbeat > 45000) {
        lastHeartbeat = nowMs;
        send('heartbeat', null, game);
      }

      // Stuck army report (throttled)
      let pathN = 0;
      if (game.units) {
        for (const u of game.units) {
          if (u.stuck && u.stuckReason === 'path') pathN++;
        }
      }
      if (pathN >= 3 && nowMs - lastStuckReport > 12000) {
        lastStuckReport = nowMs;
        send(
          'stuck_path',
          {
            pathStuck: pathN,
            message: pathN + ' units stuck with no path',
          },
          game
        );
      }
    },

    report(kind, extra, game) {
      send(kind, extra, game);
    },

    /** Fire once when a large group move is issued. */
    orderIssue(game, n, orderType, backend, ok, ms) {
      if (n < 8) return;
      // Replay re-issues hundreds of group moves — do not flood /api/telemetry
      if (game && game.replay) return;
      send(
        'order_issue',
        {
          n: n,
          orderType: orderType,
          backend: backend,
          ok: ok,
          ms: ms != null ? Math.round(ms) : null,
        },
        game
      );
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
