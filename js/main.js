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
    if (params.get('mcv') === '1' || params.get('start') === 'mcv') {
      if (!D.config.skirmish) D.config.skirmish = {};
      D.config.skirmish.startMode = 'mcv';
      const cb = document.getElementById('opt-mcv-start');
      if (cb) cb.checked = true;
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
    // Spectate: ?spectate=CODE · live list: ?live=1
    // Mass-army SP stress: ?scenario=mass&armies=100
    const room = (params.get('room') || '').trim().toUpperCase();
    const spectateRoom = (params.get('spectate') || '').trim().toUpperCase();
    const showLive = params.get('live') === '1' || params.get('live') === 'true';
    const replayId = (params.get('replay') || '').trim();
    const scenario = (params.get('scenario') || params.get('mass') || '').toLowerCase();
    const wantMass =
      scenario === 'mass' ||
      scenario === 'armies' ||
      scenario === 'stress' ||
      params.get('mass') === '1' ||
      params.get('mass') === 'true';

    if (wantMass && D.Scenario && !room && !spectateRoom && !replayId) {
      if (D.Save) D.Save.clear();
      game.multiplayer = false;
      game.localOwner = 'player';
      const opts = D.Scenario.parseOpts(params);
      D.Scenario.startMassArmies(game, opts);
      if (D.UI) {
        D.UI.hideMenu();
        D.UI.refresh(game);
      }
      if (D.Renderer) D.Renderer.rebuildTerrain(game);
      if (D.Save) D.Save.write(game);
    } else if (replayId && D.Replay && D.UI) {
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
    } else if (spectateRoom && D.Net && D.UI) {
      const qName = params.get('name');
      if (qName) D.Net.saveName(qName);
      D.UI.hideMenu();
      D.Net.spectate(spectateRoom, qName || undefined);
    } else if (showLive && D.UI) {
      D.UI.showLiveMatches();
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
