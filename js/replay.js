/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const BASE_DT = 0.05;

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
    game: null,

    isActive() {
      return !!D.Replay.active;
    },

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

      game.multiplayer = false;
      game.replay = true;
      game._serverSim = true; // allow Game.tick
      game.phase = 'playing';
      game.playerNames = recording.names || null;
      game.localOwner = 'player';
      game.netRole = null;
      game.speedMult = 1;

      if (isCmd) {
        if (!D.Replay._bootCmd(game, events)) return false;
      } else {
        if (!D.Replay._bootLegacy(game, events)) return false;
      }

      if (D.Renderer) D.Renderer.rebuildTerrain(game);
      if (D.UI) {
        D.UI.hideMenu();
        D.UI.hideLobby && D.UI.hideLobby();
        D.UI.setChatVisible(false);
        D.UI.showReplayBar(true);
        D.UI.refresh(game);
      }
      const a = (recording.names && recording.names.player) || 'Atreides';
      const b = (recording.names && recording.names.enemy) || 'Harkonnen';
      D.Game.pushMessage(
        game,
        'Replay ' +
          a +
          ' vs ' +
          b +
          (isCmd ? ' (cmd stream)' : ' (legacy)') +
          ' — Space pause, [ ] speed, Esc exit'
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
      // Skip past init event
      D.Replay.eventIndex = 0;
      while (
        D.Replay.eventIndex < events.length &&
        events[D.Replay.eventIndex].type === 'init'
      ) {
        D.Replay.eventIndex++;
      }
      D.Replay._targetTick = game.tick || 0;
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
      if (game) {
        game.replay = false;
        game._serverSim = false;
        game.phase = 'menu';
      }
      if (D.UI) D.UI.showReplayBar(false);
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
     * Advance replay. Cmd mode re-sims; legacy applies snapshots.
     */
    tick(game, frameMs) {
      if (!D.Replay.active || !game) return;
      if (!D.Replay._playing) return;

      if (D.Replay._isCmd) {
        D.Replay._tickCmd(game, frameMs);
      } else {
        D.Replay._tickLegacy(game, frameMs);
      }
    },

    _tickCmd(game, frameMs) {
      const events = D.Replay.events;
      // Advance sim at BASE_DT * speed relative to wall clock
      // 1× → 20 ticks/sec
      const ticksPerSec = (1 / BASE_DT) * D.Replay.speed;
      D.Replay._acc += (frameMs / 1000) * ticksPerSec;

      let guard = 0;
      while (D.Replay._acc >= 1 && guard < 40) {
        D.Replay._acc -= 1;
        guard++;

        // Apply all cmds scheduled at current tick (before stepping)
        const t = game.tick;
        while (D.Replay.eventIndex < events.length) {
          const ev = events[D.Replay.eventIndex];
          if (ev.t > t) break;
          D.Replay.eventIndex++;
          if (ev.type === 'cmd' && ev.payload) {
            D.Replay._applyCmd(game, ev.seat, ev.payload);
          } else if (ev.type === 'speed' && ev.speed) {
            // ignore wall-clock speed during re-sim
          } else if (ev.type === 'end') {
            game.phase = ev.phase || game.phase;
            D.Replay._playing = false;
            D.Game.pushMessage(game, 'Replay finished (' + (ev.phase || 'end') + '). Esc → menu.');
            return;
          }
        }

        if (game.phase !== 'playing') {
          D.Replay._playing = false;
          return;
        }

        // One sim step
        game.replay = true;
        game._serverSim = true;
        D.Game.tick(game, BASE_DT);
        D.Map.recomputeFog(game, 'player');
        D.Map.recomputeFog(game, 'enemy');

        if (D.Replay.eventIndex >= events.length && game.phase === 'playing') {
          // Ran past last event — keep ticking a bit then stop
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
