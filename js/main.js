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

    // Shareable multiplayer room: ?room=ABC123
    const room = (params.get('room') || '').trim().toUpperCase();
    if (room && D.Net) {
      // Prefer ?name= on the link, else saved name, else input field
      const qName = params.get('name');
      const input = document.getElementById('mp-name-input');
      const name =
        qName ||
        (input && input.value) ||
        D.Net.loadStoredName();
      if (input && name) input.value = name;
      D.UI.hideMenu();
      D.UI.showLobby('Joining room ' + room + '…');
      D.Net.join(room, name);
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
