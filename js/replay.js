/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const BASE_DT = 0.05;

  function formatClock(ticks) {
    const sec = Math.max(0, Math.floor((ticks || 0) * BASE_DT));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /**
   * Replay from command-stream recordings (format cmd-v1).
   * Also accepts legacy snapshot "frames" recordings.
   */
  D.Replay = {
    active: false,
    recording: null,
    events: [],
    eventIndex: 0,
    speed: 1,
    _acc: 0,
    _playing: false,
    _targetTick: 0,
    _scrubbing: false,
    game: null,

    isActive() {
      return !!D.Replay.active;
    },

    baseDt() {
      return BASE_DT;
    },

    durationTicks() {
      const rec = D.Replay.recording;
      if (!rec) return 0;
      if (rec.durationTicks != null && rec.durationTicks > 0) return rec.durationTicks | 0;
      const ev = D.Replay.events;
      if (!ev.length) return 0;
      let max = 0;
      for (const e of ev) if ((e.t | 0) > max) max = e.t | 0;
      return max;
    },

    currentTick(game) {
      return (game && game.tick) || 0;
    },

    formatClock,

    async list() {
      const res = await fetch('/api/recordings', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'list_failed');
      return data.recordings || [];
    },

    async load(id) {
      const res = await fetch('/api/recordings/' + encodeURIComponent(id), {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'load_failed');
      return data.recording;
    },

    start(game, recording) {
      if (!game || !recording) return false;
      D.Replay.stop(game);

      const events = recording.events || recording.frames || [];
      if (!events.length) return false;

      // Drop MP socket so leftover state snapshots cannot stomp the replay
      // (host often still connected after match_end; guest may already have left).
      if (D.Net && typeof D.Net.leave === 'function') {
        try {
          D.Net.leave();
        } catch (e) {
          /* ignore */
        }
      }

      // Detect format
      const isCmd =
        recording.format === 'cmd-v1' ||
        (events[0] && (events[0].type === 'init' || events[0].type === 'cmd'));

      D.Replay.game = game;
      D.Replay.recording = recording;
      D.Replay.events = events;
      D.Replay.eventIndex = 0;
      D.Replay.speed = 1;
      D.Replay._acc = 0;
      D.Replay._playing = true;
      D.Replay.active = true;
      D.Replay._isCmd = isCmd;
      D.Replay._frameIndex = 0;
      D.Replay._scrubbing = false;

      game.multiplayer = false;
      game.replay = true;
      game._serverSim = true; // allow Game.tick
      game.phase = 'playing';
      game.playerNames = recording.names || null;
      game.localOwner = 'player';
      game.netRole = null;
      game.speedMult = 1;
      game.placement = null;
      game.selection = game.selection || { ids: [], box: null };
      game.selection.ids = [];
      game.selection.box = null;
      // Spectator: renderer skips FOW via game.replay (sim FOW stays on for accuracy)

      if (isCmd) {
        if (!D.Replay._bootCmd(game, events)) {
          D.Replay.stop(game);
          return false;
        }
      } else {
        if (!D.Replay._bootLegacy(game, events)) {
          D.Replay.stop(game);
          return false;
        }
      }

      if (D.Renderer) D.Renderer.rebuildTerrain(game);
      if (D.UI) {
        D.UI.hideMenu();
        if (D.UI.hideLobby) D.UI.hideLobby();
        if (D.UI.hideEnd) D.UI.hideEnd();
        if (D.UI.hideReplays) D.UI.hideReplays();
        D.UI.setChatVisible(false);
        D.UI.setMpSpeedVisible(false);
        D.UI.showReplayBar(true);
        D.UI.refreshReplayScrub(game);
        D.UI.refresh(game);
      }
      // Shareable deep link
      try {
        if (recording.id) {
          const u = new URL(location.href);
          u.searchParams.delete('room');
          u.searchParams.set('replay', recording.id);
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        }
      } catch (e) {
        /* ignore */
      }
      const a = (recording.names && recording.names.player) || 'Atreides';
      const b = (recording.names && recording.names.enemy) || 'Harkonnen';
      const mins = (D.Replay.durationTicks() * BASE_DT / 60).toFixed(1);
      D.Game.pushMessage(
        game,
        'Replay ' +
          a +
          ' vs ' +
          b +
          ' · ~' +
          mins +
          ' min sim · FOW off · scrub to skip quiet stretches · Space pause · Esc exit' +
          (recording.id ? ' · ?replay=' + recording.id : '')
      );
      return true;
    },

    _bootCmd(game, events) {
      const init = events.find((e) => e.type === 'init');
      if (init && init.state) {
        if (!D.Save.loadInto(game, init.state)) return false;
      } else {
        const rec = D.Replay.recording || {};
        D.config.seed = rec.seed != null ? rec.seed : D.config.seed;
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
      }
      game.replay = true;
      game._serverSim = true;
      game.multiplayer = false;
      game.phase = 'playing';
      game.placement = null;
      if (game.selection) {
        game.selection.ids = [];
        game.selection.box = null;
      }
      // Skip past init event
      D.Replay.eventIndex = 0;
      while (
        D.Replay.eventIndex < events.length &&
        events[D.Replay.eventIndex].type === 'init'
      ) {
        D.Replay.eventIndex++;
      }
      D.Replay._targetTick = game.tick || 0;
      D.Replay._acc = 0;
      return true;
    },

    _bootLegacy(game, frames) {
      const first = frames[0];
      const state = first.state || first;
      if (!D.Save.applyNetState(game, state, { localOwner: 'player' })) {
        if (!D.Save.loadInto(game, state)) return false;
      }
      game.replay = true;
      game._serverSim = true;
      game.multiplayer = false;
      game.phase = 'playing';
      D.Replay._frameIndex = 0;
      return true;
    },

    stop(game) {
      D.Replay.active = false;
      D.Replay._playing = false;
      D.Replay.recording = null;
      D.Replay.events = [];
      D.Replay.eventIndex = 0;
      D.Replay._scrubbing = false;
      if (game) {
        game.replay = false;
        game._serverSim = false;
        game._replaySeeking = false;
        game.placement = null;
        game.phase = 'menu';
      }
      if (D.UI) D.UI.showReplayBar(false);
      try {
        const u = new URL(location.href);
        if (u.searchParams.has('replay')) {
          u.searchParams.delete('replay');
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        }
      } catch (e) {
        /* ignore */
      }
    },

    /** Absolute share URL for a recording id. */
    shareUrl(id) {
      try {
        const u = new URL(location.href);
        u.search = '';
        u.hash = '';
        u.searchParams.set('replay', String(id));
        return u.toString();
      } catch (e) {
        return location.origin + '/?replay=' + encodeURIComponent(id);
      }
    },

    setSpeed(s) {
      const n = Number(s);
      if (n > 0 && n <= 16) D.Replay.speed = n;
    },

    togglePause() {
      D.Replay._playing = !D.Replay._playing;
      return D.Replay._playing;
    },

    /**
     * Jump to a sim tick. Backward = reboot from init + fast-forward.
     * Forward = bulk sim. Pauses after seek so you can inspect.
     */
    seekTo(game, targetTick, opts) {
      opts = opts || {};
      if (!D.Replay.active || !game || !D.Replay._isCmd) return false;
      const dur = D.Replay.durationTicks();
      let tGoal = Math.max(0, Math.min(dur, targetTick | 0));
      const cur = game.tick | 0;

      if (tGoal < cur || opts.forceRestart) {
        if (!D.Replay._bootCmd(game, D.Replay.events)) return false;
        if (D.Renderer) D.Renderer.rebuildTerrain(game);
      }

      // Fast-forward (skip heavy fog until the end)
      game._replaySeeking = true;
      game.replay = true;
      game._serverSim = true;
      const events = D.Replay.events;
      let steps = 0;
      const maxSteps = dur + 200;
      while ((game.tick | 0) < tGoal && game.phase === 'playing' && steps < maxSteps) {
        steps++;
        D.Replay._applyEventsAtTick(game, game.tick | 0);
        if (game.phase !== 'playing') break;
        D.Game.tick(game, BASE_DT);
      }
      game._replaySeeking = false;
      if (D.Map) {
        D.Map.recomputeFog(game, 'player');
        D.Map.recomputeFog(game, 'enemy');
      }
      D.Replay._acc = 0;
      if (opts.pause !== false) {
        D.Replay._playing = false;
        const b = document.getElementById('btn-replay-pause');
        if (b) b.textContent = 'Play';
      }
      if (D.UI) {
        D.UI.refreshReplayScrub(game);
        D.UI.refresh(game);
      }
      return true;
    },

    /** Apply all events scheduled at tick t (cmds with ev.t <= t that are due). */
    _applyEventsAtTick(game, t) {
      const events = D.Replay.events;
      while (D.Replay.eventIndex < events.length) {
        const ev = events[D.Replay.eventIndex];
        if (ev.t > t) break;
        D.Replay.eventIndex++;
        if (ev.type === 'cmd' && ev.payload) {
          D.Replay._applyCmd(game, ev.seat, ev.payload);
        } else if (ev.type === 'speed') {
          // Match wall-clock speed changes are ignored; viewer controls speed.
        } else if (ev.type === 'end') {
          game.phase = ev.phase || game.phase;
          D.Replay._playing = false;
          return true;
        }
      }
      return false;
    },

    /**
     * Advance replay. Cmd mode re-sims; legacy applies snapshots.
     */
    tick(game, frameMs) {
      if (!D.Replay.active || !game) return;
      if (D.Replay._scrubbing) return;
      if (!D.Replay._playing) {
        if (D.UI) D.UI.refreshReplayScrub(game);
        return;
      }

      if (D.Replay._isCmd) {
        D.Replay._tickCmd(game, frameMs);
      } else {
        D.Replay._tickLegacy(game, frameMs);
      }
      if (D.UI) D.UI.refreshReplayScrub(game);
    },

    _tickCmd(game, frameMs) {
      // Advance sim at BASE_DT * speed relative to wall clock
      // 1× → 20 ticks/sec
      const ticksPerSec = (1 / BASE_DT) * D.Replay.speed;
      D.Replay._acc += (frameMs / 1000) * ticksPerSec;

      // Higher speeds need more catch-up so 4×–8× feel smooth
      const guardMax = Math.min(400, Math.max(40, Math.ceil(30 * D.Replay.speed)));
      let guard = 0;
      while (D.Replay._acc >= 1 && guard < guardMax) {
        D.Replay._acc -= 1;
        guard++;

        const t = game.tick | 0;
        if (D.Replay._applyEventsAtTick(game, t)) {
          D.Game.pushMessage(
            game,
            'Replay finished (' + (game.phase || 'end') + '). Esc → menu.'
          );
          if (D.UI) D.UI.refreshReplayScrub(game);
          return;
        }

        if (game.phase !== 'playing') {
          D.Replay._playing = false;
          return;
        }

        game.replay = true;
        game._serverSim = true;
        D.Game.tick(game, BASE_DT);

        if (D.Replay.eventIndex >= D.Replay.events.length && game.phase === 'playing') {
          if (game.tick > (D.Replay.recording.durationTicks || 0) + 40) {
            D.Replay._playing = false;
            D.Game.pushMessage(game, 'Replay finished. Esc → menu.');
          }
        }
      }
    },

    _applyCmd(game, seat, payload) {
      if (!payload || !payload.op) return;
      const owner = seat === 'enemy' ? 'enemy' : 'player';
      // Mirror server applyCommand lightly
      try {
        if (payload.op === 'order') {
          const ids = (payload.ids || []).filter((id) => {
            const e = D.Entities.getById(game, id);
            return e && e.owner === owner && e.hp > 0;
          });
          if (!ids.length) return;
          const order = payload.order || { type: 'stop' };
          D.Orders.issue(game, ids, order);
          if (order.type === 'deploy') {
            for (const id of ids) {
              const u = game.units.find((x) => x.id === id);
              if (u && u.type === 'mcv') D.Orders.tryDeploy(game, u);
            }
          }
        } else if (payload.op === 'stop') {
          const ids = (payload.ids || []).filter((id) => {
            const e = D.Entities.getById(game, id);
            return e && e.owner === owner;
          });
          D.Orders.stop(game, ids);
        } else if (payload.op === 'build') {
          D.Economy.beginStructure(
            game,
            owner,
            payload.type,
            payload.tileX | 0,
            payload.tileY | 0
          );
        } else if (payload.op === 'produce') {
          D.Economy.enqueueUnit(game, payload.buildingId, payload.unitType);
        } else if (payload.op === 'cancelQueue') {
          D.Economy.cancelQueue(game, payload.buildingId, payload.index | 0);
        } else if (payload.op === 'rally') {
          D.Orders.setRally(game, payload.buildingId, payload.x, payload.y);
        }
      } catch (e) {
        console.warn('[replay] cmd failed', e);
      }
    },

    _tickLegacy(game, frameMs) {
      const frames = D.Replay.events;
      if (D.Replay._frameIndex >= frames.length - 1) {
        D.Replay._playing = false;
        D.Game.pushMessage(game, 'Replay finished. Esc → menu.');
        return;
      }
      const BASE_FRAME_MS = 500;
      D.Replay._acc += frameMs * D.Replay.speed;
      while (D.Replay._acc >= BASE_FRAME_MS && D.Replay._frameIndex < frames.length - 1) {
        D.Replay._acc -= BASE_FRAME_MS;
        D.Replay._frameIndex++;
        const fr = frames[D.Replay._frameIndex];
        const state = fr.state || fr;
        if (!state) continue;
        if (!fr.full && game.map && state.map && !state.map.tiles) {
          state.map.tiles = Array.from(game.map.tiles);
        }
        D.Save.applyNetState(game, state, { localOwner: game.localOwner || 'player' });
        game.replay = true;
        game._serverSim = true;
        game.multiplayer = false;
        game.phase =
          state.phase === 'victory' || state.phase === 'defeat' ? state.phase : 'playing';
        D.Map.recomputeFog(game, 'player');
        D.Map.recomputeFog(game, 'enemy');
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
