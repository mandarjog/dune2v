/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const MAX_FRAME_MS = 100;

  D.Loop = {
    _running: false,
    _lastMs: 0,
    _accMs: 0,
    _raf: 0,
    _frames: 0,
    _fpsT: 0,
    game: null,

    start(game) {
      D.Loop.game = game;
      D.Loop._running = true;
      D.Loop._lastMs = performance.now();
      D.Loop._accMs = 0;
      D.Loop._frames = 0;
      D.Loop._fpsT = D.Loop._lastMs;
      const frame = (now) => {
        if (!D.Loop._running) return;
        D.Loop._raf = requestAnimationFrame(frame);
        D.Loop.tickFrame(now);
      };
      D.Loop._raf = requestAnimationFrame(frame);
    },

    stop() {
      D.Loop._running = false;
      if (D.Loop._raf) cancelAnimationFrame(D.Loop._raf);
    },

    tickFrame(nowMs) {
      const game = D.Loop.game;
      if (!game) return;

      let frameMs = Math.min(nowMs - D.Loop._lastMs, MAX_FRAME_MS);
      D.Loop._lastMs = nowMs;
      D.Loop._accMs += frameMs;

      // FPS
      D.Loop._frames++;
      if (nowMs - D.Loop._fpsT >= 500) {
        game.stats.fps = (D.Loop._frames * 1000) / (nowMs - D.Loop._fpsT);
        D.Loop._frames = 0;
        D.Loop._fpsT = nowMs;
      }

      const dtSec = D.config.DT_SEC;
      const stepMs = dtSec * 1000;
      // SP speed multiplier only (MP speed is server-side wall clock)
      const speed =
        game.replay || game.multiplayer
          ? 1
          : Math.max(0.25, Math.min(3, Number(game.speedMult) || 1));

      // input poll uses real dt for smooth camera (replay: pan only)
      if (D.Input) D.Input.poll(game, frameMs / 1000);

      if (game.replay && D.Replay) {
        D.Replay.tick(game, frameMs);
        D.Loop._accMs = 0;
      } else if (game.phase === 'playing') {
        // frameMs already added once; scale remaining for speed
        if (speed !== 1) D.Loop._accMs += frameMs * (speed - 1);
        let guard = 0;
        // Large armies: fewer catch-up ticks so one slow frame does not cascade
        const nU = game.units ? game.units.length : 0;
        const maxCatch = nU > 80 ? (speed > 1 ? 6 : 3) : speed > 1 ? 12 : 5;
        while (D.Loop._accMs >= stepMs && guard < maxCatch) {
          D.Game.tick(game, dtSec);
          D.Loop._accMs -= stepMs;
          guard++;
        }
        if (D.Loop._accMs > stepMs * 6) D.Loop._accMs = 0;
      } else {
        D.Loop._accMs = 0;
      }

      if (D.Renderer) D.Renderer.draw(game);
      if (D.UI) {
        // HUD stats; selection panel only rebuilds when signature changes.
        // MP clients don't advance tick locally — refresh on a time cadence too.
        const mpHud = game.multiplayer && nowMs - (D.Loop._lastUiMs || 0) >= 200;
        if (mpHud) D.Loop._lastUiMs = nowMs;
        if (game.tick % 4 === 0 || game.phase !== 'playing' || mpHud) D.UI.refresh(game);
        D.UI.updateDebug(game);
      }
      // SP + MP client health → server (stuck armies, heartbeats)
      if (D.Telemetry && D.Telemetry.tick) D.Telemetry.tick(game, nowMs);

      // Autosave every ~15s (or ~30s if huge army — localStorage JSON is expensive)
      if (
        D.Save &&
        !game.multiplayer &&
        game.phase === 'playing' &&
        game.tick > 0
      ) {
        const nU = game.units ? game.units.length : 0;
        const every = nU > 80 ? 600 : 300;
        if (game.tick % every === 0) D.Save.write(game);
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
