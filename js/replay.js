/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  /**
   * Offline playback of server match recordings (snapshot stream).
   */
  D.Replay = {
    active: false,
    recording: null,
    frameIndex: 0,
    speed: 1,
    _acc: 0,
    _playing: false,
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

    /**
     * Begin playback into an existing game object.
     */
    start(game, recording) {
      if (!game || !recording || !recording.frames || !recording.frames.length) {
        return false;
      }
      D.Replay.stop(game);
      D.Replay.game = game;
      D.Replay.recording = recording;
      D.Replay.frameIndex = 0;
      D.Replay.speed = 1;
      D.Replay._acc = 0;
      D.Replay._playing = true;
      D.Replay.active = true;

      game.multiplayer = false;
      game.replay = true;
      game.phase = 'playing';
      game.playerNames = recording.names || null;
      game.localOwner = 'player';
      game.netRole = null;

      // Apply first full frame
      const first = recording.frames[0];
      if (!D.Save.applyNetState(game, first.state, { localOwner: 'player' })) {
        // Fallback: loadInto
        if (!D.Save.loadInto(game, first.state)) return false;
      }
      game.phase = 'playing';
      game.replay = true;
      if (D.Renderer) D.Renderer.rebuildTerrain(game);
      if (D.UI) {
        D.UI.hideMenu();
        D.UI.hideLobby && D.UI.hideLobby();
        D.UI.setChatVisible(false);
        D.UI.showReplayBar(true);
        D.UI.refresh(game);
      }
      D.Game.pushMessage(
        game,
        'Replay: ' +
          ((recording.names && recording.names.player) || 'Atreides') +
          ' vs ' +
          ((recording.names && recording.names.enemy) || 'Harkonnen') +
          ' — Space pause, [ ] speed, Esc exit'
      );
      return true;
    },

    stop(game) {
      D.Replay.active = false;
      D.Replay._playing = false;
      D.Replay.recording = null;
      D.Replay.frameIndex = 0;
      if (game) {
        game.replay = false;
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
     * Advance playback; called from Loop when game.replay.
     * @param {number} frameMs real ms since last frame
     */
    tick(game, frameMs) {
      if (!D.Replay.active || !D.Replay.recording || !game) return;
      if (!D.Replay._playing) return;

      const frames = D.Replay.recording.frames;
      if (D.Replay.frameIndex >= frames.length - 1) {
        D.Replay._playing = false;
        game.phase =
          D.Replay.recording.phase === 'victory' || D.Replay.recording.phase === 'defeat'
            ? D.Replay.recording.phase
            : 'playing';
        D.Game.pushMessage(game, 'Replay finished. Esc for menu.');
        if (D.UI && (game.phase === 'victory' || game.phase === 'defeat')) {
          // show end with recording names via localEndPhase from player view
        }
        return;
      }

      // Base: 1 recording frame ≈ RECORD_EVERY * 0.05s = 0.5s sim → play at wall clock
      const BASE_FRAME_MS = 500;
      D.Replay._acc += frameMs * D.Replay.speed;
      while (D.Replay._acc >= BASE_FRAME_MS && D.Replay.frameIndex < frames.length - 1) {
        D.Replay._acc -= BASE_FRAME_MS;
        D.Replay.frameIndex++;
        const fr = frames[D.Replay.frameIndex];
        if (!fr || !fr.state) continue;
        // Merge thin frames onto existing map
        if (!fr.full && game.map && fr.state.map && !fr.state.map.tiles) {
          fr.state.map.tiles = Array.from(game.map.tiles);
        }
        D.Save.applyNetState(game, fr.state, { localOwner: game.localOwner || 'player' });
        game.replay = true;
        game.phase = 'playing';
        if (fr.state.phase === 'victory' || fr.state.phase === 'defeat') {
          game.phase = fr.state.phase;
        }
        D.Map.recomputeFog(game, 'player');
        D.Map.recomputeFog(game, 'enemy');
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
