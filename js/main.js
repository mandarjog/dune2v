/* global Dune2 */
(function () {
  'use strict';
  const D = window.Dune2;

  function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('debug') === '1') {
      D.config.features.debugCheats = true;
      const el = document.getElementById('debug-overlay');
      if (el) el.classList.add('visible');
    }
    if (params.get('fog') === '0') {
      D.config.features.fog = false;
    }
    if (params.get('ai') === '0') {
      D.config.features.ai = false;
    }

    const game = D.Game.create();
    const canvas = document.getElementById('game-canvas');
    const minimap = document.getElementById('minimap');

    // minimap resolution
    minimap.width = 200;
    minimap.height = 200;

    D.Renderer.init(canvas, minimap);
    D.Input.init(game, canvas, minimap);
    if (D.Net) D.Net.init(game);
    D.UI.init(game);
    D.Loop.start(game);

    // Persist on tab close / refresh (SP only)
    window.addEventListener('beforeunload', () => {
      if (D.Save && !game.multiplayer && game.phase === 'playing') D.Save.write(game);
    });

    // Shareable multiplayer room: ?room=ABC123 → name prompt, then join
    const room = (params.get('room') || '').trim().toUpperCase();
    const replayId = (params.get('replay') || '').trim();
    if (replayId && D.Replay && D.UI) {
      // Deep-link to a match recording
      (async () => {
        try {
          D.UI.hideMenu();
          const rec = await D.Replay.load(replayId);
          if (!D.Replay.start(game, rec)) {
            D.Game.pushMessage(game, 'Could not start replay ' + replayId);
            D.UI.showMenu();
          }
        } catch (err) {
          D.Game.pushMessage(game, 'Recording not found: ' + replayId);
          D.UI.showMenu();
        }
      })();
    } else if (room && D.Net && D.UI) {
      const qName = params.get('name');
      D.UI.showJoinPrompt(room, qName || undefined);
    }

    // expose for console debugging
    window.__dune2 = { game, D };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
