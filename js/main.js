/* global Dune2 */
(function () {
  'use strict';
  const D = window.Dune2;

  /** Apply URL feature flags. Call at boot and after any skirmish start. */
  function applyUrlFeatures(params) {
    params = params || new URLSearchParams(location.search);
    // fog=0 / fog=false → off; fog=1 / fog=true → on
    const fog = params.get('fog');
    if (fog === '0' || fog === 'false') {
      D.config.features.fog = false;
    } else if (fog === '1' || fog === 'true') {
      D.config.features.fog = true;
    }
    if (params.get('ai') === '0') {
      D.config.features.ai = false;
    }
    // recharge=0/false → off; recharge=1/true → on (tanks/towers magazines)
    const rech = params.get('recharge');
    if (rech === '0' || rech === 'false') {
      D.config.features.recharge = false;
      const cb = document.getElementById('opt-recharge');
      if (cb) cb.checked = false;
    } else if (rech === '1' || rech === 'true') {
      D.config.features.recharge = true;
      const cb = document.getElementById('opt-recharge');
      if (cb) cb.checked = true;
    }
    if (params.get('debug') === '1') {
      D.config.features.debugCheats = true;
      const el = document.getElementById('debug-overlay');
      if (el) el.classList.add('visible');
    }
    if (params.get('mcv') === '1' || params.get('start') === 'mcv') {
      if (!D.config.skirmish) D.config.skirmish = {};
      D.config.skirmish.startMode = 'mcv';
      const cb = document.getElementById('opt-mcv-start');
      if (cb) cb.checked = true;
    }
  }

  /** After toggling features.fog, refresh fog buffers so the view matches. */
  function refreshFogState(game) {
    if (!game || !game.map || !D.Map) return;
    // Always wipe explored when re-applying FOW so fog=0 → fog=1 cannot leave full map open
    D.Map.initFog(game);
    const owners =
      D.Seats && D.Seats.active
        ? D.Seats.active(game)
        : ['player', 'enemy'];
    for (const o of owners) {
      D.Map.recomputeFog(game, o);
    }
    game._fogDrawDirty = true;
  }

  function showBuildRev(extra) {
    const els = [
      document.getElementById('build-rev'),
      document.getElementById('menu-build-rev'),
    ].filter(Boolean);
    if (!els.length) return;
    const rev = (D.buildRev && D.buildRev()) || (D.BUILD && D.BUILD.rev) || '?';
    const server = extra && extra.serverRev;
    let text = 'rev ' + rev;
    if (server) {
      text += server === rev ? ' · server ok' : ' · server ' + server + ' ⚠';
    }
    const title =
      'Client: ' +
      rev +
      (D.BUILD && D.BUILD.time ? '\nBuilt: ' + D.BUILD.time : '') +
      (server ? '\nServer: ' + server : '') +
      '\nFOW: ' +
      (D.config.features.fog ? 'ON' : 'OFF') +
      '\n?fog=0 disables fog of war';
    const mismatch = !!(server && server !== rev);
    for (const el of els) {
      el.textContent = text;
      el.title = title;
      el.classList.toggle('mismatch', mismatch);
    }
  }

  function boot() {
    const params = new URLSearchParams(location.search);
    applyUrlFeatures(params);
    showBuildRev();

    // Fetch live server stamp (overrides static fallback if host injects it)
    if (location.protocol !== 'file:') {
      fetch('/api/version', { cache: 'no-store' })
        .then((r) => r.json())
        .then((v) => {
          if (v && v.rev) {
            D.BUILD = D.BUILD || {};
            // Prefer server-injected script; this is a second opinion for UI
            D.BUILD.serverRev = v.rev;
            D.BUILD.serverTime = v.buildTime;
            showBuildRev({ serverRev: v.rev });
          }
        })
        .catch(() => {});
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
    // After refresh/back: session may still know last room
    const remembered =
      D.Net && D.Net.loadRememberedRoom ? D.Net.loadRememberedRoom() : null;
    const room = (params.get('room') || remembered || '').trim().toUpperCase();
    const spectateRoom = (params.get('spectate') || '').trim().toUpperCase();
    const showLive = params.get('live') === '1' || params.get('live') === 'true';
    const replayId = (params.get('replay') || '').trim();
    if (remembered && !params.get('room') && room === remembered && D.UI) {
      // Soft hint — join prompt still asks for name
      console.log('[dune2] resuming room from session after refresh/back:', remembered);
    }
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
      // Re-assert URL/mass fog and refresh vision (defends against save/order bugs)
      applyUrlFeatures(params);
      if (opts.fog === false) D.config.features.fog = false;
      if (opts.fog === true) D.config.features.fog = true;
      refreshFogState(game);
      showBuildRev();
      if (D.UI) {
        D.UI.hideMenu();
        D.UI.refresh(game);
      }
      if (D.Renderer) D.Renderer.rebuildTerrain(game);
      if (D.Save) D.Save.write(game);
      D.Game.pushMessage(
        game,
        'Build ' +
          ((D.buildRev && D.buildRev()) || '?') +
          ' · FOW ' +
          (D.config.features.fog ? 'ON' : 'OFF')
      );
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
    window.__dune2 = {
      game,
      D,
      applyUrlFeatures,
      refreshFogState,
      showBuildRev,
    };
    window.__dune2Rev = D.buildRev ? D.buildRev() : '?';
  }

  // Export helpers for UI skirmish start
  D.applyUrlFeatures = applyUrlFeatures;
  D.refreshFogState = refreshFogState;
  D.showBuildRev = showBuildRev;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
