/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  let els = {};
  /** Last selection panel signature — avoid nuking produce buttons every frame */
  let lastSelSig = '';
  let boundGame = null;
  /** Alert ids already shown (under attack / elim chat) */
  const seenAlertIds = new Set();
  let attackFlashTimer = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function me(game) {
    return D.Game.me(game);
  }

  function myColor(game) {
    if (D.Seats && D.Seats.color) return D.Seats.color(me(game));
    return me(game) === 'player' ? D.config.colors.player : D.config.colors.enemy;
  }

  function ownerColor(owner) {
    if (D.Seats && D.Seats.color) return D.Seats.color(owner);
    return owner === 'player' ? D.config.colors.player : D.config.colors.enemy;
  }

  function selectionSignature(game) {
    const ids = game.selection.ids.slice().sort((a, b) => a - b).join(',');
    const buildings = game.buildings.filter((b) => game.selection.ids.includes(b.id));
    const units = game.units.filter((u) => game.selection.ids.includes(u.id));
    let extra = '';
    if (buildings.length === 1 && !units.length) {
      const b = buildings[0];
      const q = (b.buildQueue || [])
        .map((item) => item.type + ':' + Math.floor((item.progress || 0) * 20))
        .join(',');
      const bam =
        b.weapon && b.weapon.ammoMax ? Math.floor(b.weapon.ammo || 0) : -1;
      extra = `|b${b.id}|${b.type}|${Math.floor(b.buildProgress * 100)}|q${q}|hp${Math.ceil(b.hp)}|a${bam}`;
    } else if (units.length === 1 && !buildings.length) {
      const u = units[0];
      const am =
        u.weapon && u.weapon.ammoMax
          ? Math.floor(u.weapon.ammo || 0)
          : -1;
      extra = `|u${u.id}|${u.type}|hp${Math.ceil(u.hp)}|c${Math.floor(u.cargo || 0)}|a${am}`;
    } else {
      extra = `|m${units.length}:${buildings.length}`;
    }
    return ids + extra + '|' + me(game);
  }

  function houseLabel(owner) {
    if (D.Seats && D.Seats.label) {
      return D.Seats.label(owner, boundGame && boundGame.playerNames);
    }
    return owner === 'player' ? 'Atreides (blue)' : 'Harkonnen (red)';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const HOUSE_STORAGE_KEY = 'dune2_house';
  const HOUSE_SPECIAL = {
    atreides: 'LRT',
    harkonnen: 'Siege Tank',
    ordos: 'Saboteur',
  };

  function houseDisplayName(id) {
    const h = D.Seats && D.Seats.normalizeHouse ? D.Seats.normalizeHouse(id) : id;
    if (h === 'harkonnen') return 'Harkonnen';
    if (h === 'ordos') return 'Ordos';
    return 'Atreides';
  }

  function houseClass(id) {
    const h = D.Seats && D.Seats.normalizeHouse ? D.Seats.normalizeHouse(id) : id;
    return 'house-' + (h || 'atreides');
  }

  D.UI = {
    /** 'base' | 'mcv' from menu/lobby checkboxes (or config). */
    selectedStartMode() {
      const lobby = $('opt-lobby-mcv-start');
      const menu = $('opt-mcv-start');
      if (lobby && !lobby.classList.contains('hidden') && lobby.checked) return 'mcv';
      if (menu && menu.checked) return 'mcv';
      if (D.config.skirmish && D.config.skirmish.startMode === 'mcv') return 'mcv';
      return 'base';
    },

    /** Preferred house id for SP / host / join. */
    selectedHouse() {
      const pick =
        document.querySelector('#sp-house-pick .house-chip.selected') ||
        document.querySelector('#mp-house-pick .house-chip.selected');
      if (pick && pick.dataset.house) {
        return (
          (D.Seats && D.Seats.normalizeHouse
            ? D.Seats.normalizeHouse(pick.dataset.house)
            : pick.dataset.house) || 'atreides'
        );
      }
      try {
        const saved = localStorage.getItem(HOUSE_STORAGE_KEY);
        if (saved && D.Seats && D.Seats.normalizeHouse) {
          return D.Seats.normalizeHouse(saved) || 'atreides';
        }
        if (saved) return String(saved).toLowerCase();
      } catch (e) {
        /* ignore */
      }
      return 'atreides';
    },

    /**
     * Sync all house-pick chip groups to a house id and persist.
     * @param {string} houseId
     * @param {string|null} [onlyGroupId] limit to one pick container id
     */
    setSelectedHouse(houseId, onlyGroupId) {
      const h =
        (D.Seats && D.Seats.normalizeHouse
          ? D.Seats.normalizeHouse(houseId)
          : String(houseId || '').toLowerCase()) || 'atreides';
      try {
        localStorage.setItem(HOUSE_STORAGE_KEY, h);
      } catch (e) {
        /* ignore */
      }
      const groups = onlyGroupId
        ? [$(onlyGroupId)].filter(Boolean)
        : [
            $('sp-house-pick'),
            $('mp-house-pick'),
            $('join-house-pick'),
            $('lobby-house-pick'),
          ].filter(Boolean);
      for (const group of groups) {
        // Lobby pick mirrors current seat separately; still allow force-sync from menu
        if (group.id === 'lobby-house-pick' && onlyGroupId !== 'lobby-house-pick') {
          continue;
        }
        group.querySelectorAll('.house-chip').forEach((btn) => {
          const on = btn.dataset.house === h;
          btn.classList.toggle('selected', on);
          btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      D.UI.updateHouseHints();
    },

    updateHouseHints() {
      const h = D.UI.selectedHouse();
      const pair =
        D.Seats && D.Seats.skirmishPair
          ? D.Seats.skirmishPair(h)
          : { house: h, aiOwner: 'enemy' };
      const youName = houseDisplayName(pair.house || h);
      const aiHouse =
        D.Seats && D.Seats.houseId
          ? D.Seats.houseId(pair.aiOwner || 'enemy')
          : 'harkonnen';
      const aiName = houseDisplayName(aiHouse);
      const youSpec = HOUSE_SPECIAL[pair.house || h] || '';
      const aiSpec = HOUSE_SPECIAL[aiHouse] || '';
      const hint = $('sp-house-hint');
      if (hint) {
        hint.innerHTML =
          'You: <b class="' +
          houseClass(pair.house || h) +
          '">' +
          youName +
          '</b>' +
          (youSpec ? ' (' + youSpec + ')' : '') +
          ' · AI: <b class="' +
          houseClass(aiHouse) +
          '">' +
          aiName +
          '</b>' +
          (aiSpec ? ' (' + aiSpec + ')' : '');
      }
      const joinHint = $('join-house-hint');
      if (joinHint) {
        const pref =
          document.querySelector('#join-house-pick .house-chip.selected') ||
          document.querySelector('#mp-house-pick .house-chip.selected');
        const jh =
          (pref && pref.dataset.house) ||
          D.UI.selectedHouse();
        const jn = houseDisplayName(jh);
        joinHint.innerHTML =
          'Prefer <b class="' +
          houseClass(jh) +
          '">' +
          jn +
          '</b> if free; otherwise the next open seat.';
      }
    },

    bindHousePicks() {
      const onChip = (groupId, e) => {
        const btn = e.target.closest('.house-chip');
        if (!btn || !btn.dataset.house) return;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        if (groupId === 'lobby-house-pick') {
          D.UI.setSelectedHouse(btn.dataset.house, 'lobby-house-pick');
          if (D.Net && D.Net.setHouse) {
            const st = $('lobby-house-status');
            if (st) st.textContent = 'Requesting ' + houseDisplayName(btn.dataset.house) + '…';
            D.Net.setHouse(btn.dataset.house);
          }
          return;
        }
        // Keep SP + MP + join in sync for convenience
        D.UI.setSelectedHouse(btn.dataset.house);
      };
      for (const id of [
        'sp-house-pick',
        'mp-house-pick',
        'join-house-pick',
        'lobby-house-pick',
      ]) {
        const el = $(id);
        if (!el || el._houseBound) continue;
        el._houseBound = true;
        el.addEventListener('click', (e) => onChip(id, e));
      }
      // Restore saved preference
      let saved = 'atreides';
      try {
        const s = localStorage.getItem(HOUSE_STORAGE_KEY);
        if (s) {
          saved =
            (D.Seats && D.Seats.normalizeHouse
              ? D.Seats.normalizeHouse(s)
              : s) || 'atreides';
        }
      } catch (e) {
        /* ignore */
      }
      D.UI.setSelectedHouse(saved);
    },

    init(game) {
      boundGame = game;
      els = {
        credits: $('stat-credits'),
        power: $('stat-power'),
        powerFill: $('power-fill'),
        buildMenu: $('build-menu'),
        unitMenu: $('unit-menu'),
        selectionInfo: $('selection-info'),
        messages: $('messages'),
        menuModal: $('menu-modal'),
        lobbyModal: $('lobby-modal'),
        pauseModal: $('pause-modal'),
        endModal: $('end-modal'),
        debug: $('debug-overlay'),
        btnContinue: $('btn-continue'),
        lobbyStatus: $('lobby-status'),
        lobbyLink: $('lobby-link'),
        lobbyCode: $('lobby-code'),
        lobbySeat: $('lobby-seat'),
        lobbyRoster: $('lobby-roster'),
        mpNameInput: $('mp-name-input'),
        mpMatchup: $('mp-matchup'),
        joinModal: $('join-modal'),
        joinNameInput: $('join-name-input'),
        joinRoomLabel: $('join-room-label'),
        chatPanel: $('chat-panel'),
        chatHud: $('chat-hud'),
        chatHudLog: $('chat-hud-log'),
        chatForm: $('chat-form'),
        chatInput: $('chat-input'),
        feedbackModal: $('feedback-modal'),
        feedbackText: $('feedback-text'),
        feedbackContact: $('feedback-contact'),
        feedbackStatus: $('feedback-status'),
        helpModal: $('help-modal'),
        speedModal: $('speed-modal'),
        speedModalText: $('speed-modal-text'),
        speedHud: $('speed-hud'),
        mpSpeedWrap: $('mp-speed-wrap'),
        mpSpeedSelect: $('mp-speed-select'),
        replaysModal: $('replays-modal'),
        replaysList: $('replays-list'),
        replaysStatus: $('replays-status'),
        replayBar: $('replay-bar'),
        liveModal: $('live-modal'),
        liveList: $('live-list'),
        liveStatus: $('live-status'),
      };

      D.UI._pendingJoinRoom = null;

      // Restore saved multiplayer display name into both name fields
      const savedName = D.Net ? D.Net.loadStoredName() : 'Commander';
      if (els.mpNameInput) {
        els.mpNameInput.value = savedName;
        els.mpNameInput.addEventListener('change', () => {
          if (D.Net) D.Net.saveName(els.mpNameInput.value);
        });
        els.mpNameInput.addEventListener('keydown', (e) => {
          if (e.code === 'Enter') {
            e.preventDefault();
            if (D.Net) D.Net.saveName(els.mpNameInput.value);
            els.mpNameInput.blur();
          }
        });
      }
      if (els.joinNameInput) {
        els.joinNameInput.value = savedName;
        els.joinNameInput.addEventListener('keydown', (e) => {
          if (e.code === 'Enter') {
            e.preventDefault();
            $('btn-join-go')?.click();
          }
        });
      }

      // Event delegation — survive DOM rebuilds; never lose clicks mid-frame
      els.unitMenu?.addEventListener('click', (e) => {
        const produceBtn = e.target.closest('[data-produce]');
        if (produceBtn && !produceBtn.disabled) {
          e.preventDefault();
          e.stopPropagation();
          const buildingId = Number(produceBtn.dataset.buildingId);
          const unitType = produceBtn.dataset.produce;
          // Remember type so re-clicks / Space can train more without re-picking
          game.stickyProduce = { buildingId, unitType };
          let r;
          if (D.Net) {
            r = D.Net.command(game, { op: 'produce', buildingId, unitType });
          } else {
            r = D.Economy.enqueueUnit(game, buildingId, unitType);
          }
          if (r && r.ok) {
            const name = D.config.units[unitType]?.name || unitType;
            D.Game.pushMessage(game, 'Training ' + name + ' (click again or Q for more)');
            lastSelSig = '';
            D.UI.refresh(game);
            if (D.Save && !game.multiplayer) D.Save.write(game);
          } else if (r && !r.deferred) {
            const msg =
              r.reason === 'credits'
                ? 'Not enough credits'
                : r.reason === 'queue'
                  ? 'Production queue full'
                  : r.reason === 'army_cap'
                    ? 'Army at cap (' +
                      (r.cap || (D.Economy.armyCap && D.Economy.armyCap()) || 35) +
                      ' units).'
                    : r.reason === 'building'
                      ? 'Factory not ready'
                      : 'Cannot train: ' + (r.reason || '?');
            D.Game.pushMessage(game, msg);
          }
          return;
        }
        const cancelBtn = e.target.closest('[data-cancel-queue]');
        if (cancelBtn) {
          e.preventDefault();
          e.stopPropagation();
          const buildingId = Number(cancelBtn.dataset.buildingId);
          if (D.Net) {
            D.Net.command(game, { op: 'cancelQueue', buildingId, index: 0 });
          } else {
            D.Economy.cancelQueue(game, buildingId, 0);
          }
          lastSelSig = '';
          D.UI.refresh(game);
          return;
        }
        const deployBtn = e.target.closest('[data-deploy]');
        if (deployBtn) {
          e.preventDefault();
          const id = Number(deployBtn.dataset.unitId);
          if (D.Net) {
            D.Net.command(game, { op: 'order', ids: [id], order: { type: 'deploy' } });
          } else {
            const u = game.units.find((x) => x.id === id);
            if (u && !D.Orders.tryDeploy(game, u)) {
              D.Game.pushMessage(
                game,
                'Cannot deploy — need a clear 2×2 rock pad (move fully onto rock).'
              );
            }
          }
          lastSelSig = '';
          D.UI.refresh(game);
          return;
        }
        const detBtn = e.target.closest('[data-detonate]');
        if (detBtn) {
          e.preventDefault();
          const id = Number(detBtn.dataset.unitId);
          if (D.Net) {
            D.Net.command(game, { op: 'order', ids: [id], order: { type: 'detonate' } });
          } else {
            const u = game.units.find((x) => x.id === id);
            if (u) D.Orders.tryDetonate(game, u);
          }
          lastSelSig = '';
          D.UI.refresh(game);
        }
      });

      // Don't let sidebar clicks clear map selection / start box-select
      const sidebar = $('sidebar');
      sidebar?.addEventListener('mousedown', (e) => e.stopPropagation());

      function startLocalSkirmish(kind) {
        if (game.multiplayer && D.Net) D.Net.leave();
        game.multiplayer = false;
        game.spectator = false;
        game.netRole = null;
        D.config.features.ai = true;
        if (D.Save) D.Save.clear();
        const params = new URLSearchParams(location.search);
        const pair =
          D.Seats && D.Seats.skirmishPair
            ? D.Seats.skirmishPair(D.UI.selectedHouse())
            : { localOwner: 'player', owners: ['player', 'enemy'] };
        game.localOwner = pair.localOwner;
        if (kind === 'mass' && D.Scenario) {
          const opts = D.Scenario.parseOpts
            ? D.Scenario.parseOpts(params)
            : { perSide: 80, fog: false };
          // Mass scenario still uses classic seats unless extended later
          game.localOwner = 'player';
          D.Scenario.startMassArmies(game, opts);
        } else {
          // Re-apply ?fog=0 before start so startSkirmish vision is correct
          if (D.applyUrlFeatures) D.applyUrlFeatures(params);
          D.Game.startSkirmish(game, D.MAPS.skirmish_large || D.MAPS.skirmish1, {
            startMode: D.UI.selectedStartMode(),
            owners: pair.owners,
          });
        }
        // Always re-assert URL fog after start (mass defaults off; ?fog=1 forces on)
        if (D.applyUrlFeatures) D.applyUrlFeatures(params);
        if (kind === 'mass') {
          const f = params.get('fog');
          if (f === '1' || f === 'true') D.config.features.fog = true;
          else D.config.features.fog = false; // mass default
        }
        if (D.refreshFogState) D.refreshFogState(game);
        if (D.showBuildRev) D.showBuildRev();
        lastSelSig = '';
        // Drop leftover MP elim banner / chat alerts from the previous match
        D.UI.resetMatchHud(game);
        D.UI.hideMenu();
        D.UI.hideLobby();
        D.UI.hideLiveMatches();
        D.UI.buildStructureButtons(game);
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
        if (D.Save) D.Save.write(game);
        D.Game.pushMessage(
          game,
          'Build ' +
            ((D.buildRev && D.buildRev()) || '?') +
            ' · FOW ' +
            (D.config.features.fog ? 'ON' : 'OFF')
        );
      }

      $('btn-start')?.addEventListener('click', () => startLocalSkirmish('normal'));
      $('btn-start-mass')?.addEventListener('click', () => startLocalSkirmish('mass'));

      $('btn-continue')?.addEventListener('click', () => {
        if (game.multiplayer) return;
        const data = D.Save && D.Save.read();
        if (!data || !D.Save.loadInto(game, data)) {
          D.Game.pushMessage(game, 'No valid save found.');
          return;
        }
        lastSelSig = '';
        D.UI.hideMenu();
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
        D.Game.pushMessage(game, 'Game restored.');
      });

      const openFeedback = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        D.UI.showFeedback();
      };
      $('btn-feedback')?.addEventListener('click', openFeedback);
      $('btn-feedback-corner')?.addEventListener('click', openFeedback);

      const openHelp = (e) => {
        e?.preventDefault?.();
        D.UI.showHelp();
      };
      $('btn-help-corner')?.addEventListener('click', openHelp);
      $('btn-help-menu')?.addEventListener('click', openHelp);
      $('btn-help-menu-footer')?.addEventListener('click', openHelp);
      $('btn-help-sidebar')?.addEventListener('click', openHelp);
      $('btn-help-close')?.addEventListener('click', () => D.UI.hideHelp());

      $('btn-speed-accept')?.addEventListener('click', () => {
        if (D.Net) D.Net.respondSpeed(true);
        D.UI.hideSpeedModal();
      });
      $('btn-speed-reject')?.addEventListener('click', () => {
        if (D.Net) D.Net.respondSpeed(false);
        D.UI.hideSpeedModal();
      });

      $('btn-rejoin-accept')?.addEventListener('click', () => {
        const id = D.UI._rejoinRequestId;
        if (D.Net && id) D.Net.respondRejoin(id, true);
        D.UI.hideRejoinModal();
      });
      $('btn-rejoin-reject')?.addEventListener('click', () => {
        const id = D.UI._rejoinRequestId;
        if (D.Net && id) D.Net.respondRejoin(id, false);
        D.UI.hideRejoinModal();
      });

      els.mpSpeedSelect?.addEventListener('change', () => {
        const v = Number(els.mpSpeedSelect.value);
        if (!boundGame || !Number.isFinite(v)) return;
        if (boundGame.replay) {
          if (D.Replay) {
            D.Replay.setSpeed(v);
            D.Game.pushMessage(boundGame, 'Replay ' + v + '×');
            D.UI.refreshSpeedHud(boundGame);
          }
          return;
        }
        if (boundGame.spectator) return;
        if (boundGame.multiplayer && D.Net) {
          D.Net.requestSpeed(v);
          D.Game.pushMessage(boundGame, 'Requested ' + v + '× speed — waiting for opponent…');
          return;
        }
        // Single-player: apply immediately
        boundGame.speedMult = v;
        D.Game.pushMessage(boundGame, 'Speed ' + v + '×');
        D.UI.refreshSpeedHud(boundGame);
      });

      $('btn-mp-resign')?.addEventListener('click', () => {
        if (!boundGame || !boundGame.multiplayer || boundGame.spectator) return;
        if (!D.Net) return;
        if (!confirm('Resign and become a spectator? Your base will be removed.')) return;
        D.Net.resign();
      });
      $('btn-mp-end-match')?.addEventListener('click', () => {
        if (!boundGame || !boundGame.multiplayer || !D.Net) return;
        if (!D.Net.isHost(boundGame)) {
          D.Game.pushMessage(boundGame, 'Only the host can end the match.');
          return;
        }
        if (!confirm('End match for everyone and close the room?')) return;
        D.Net.endMatch();
      });

      $('btn-end-watch')?.addEventListener('click', () => {
        D.UI.watchRecording(D.UI.lastRecordingId());
      });
      $('btn-end-copy-replay')?.addEventListener('click', async () => {
        await D.UI.copyReplayLink(D.UI.lastRecordingId());
      });

      $('btn-replays')?.addEventListener('click', () => D.UI.showReplays());
      $('btn-replays-close')?.addEventListener('click', () => D.UI.hideReplays());
      $('btn-replays-refresh')?.addEventListener('click', () => D.UI.loadReplaysList());

      $('btn-live')?.addEventListener('click', () => D.UI.showLiveMatches());
      $('btn-live-close')?.addEventListener('click', () => D.UI.hideLiveMatches());
      $('btn-live-refresh')?.addEventListener('click', () => D.UI.loadLiveList());

      $('btn-replay-pause')?.addEventListener('click', () => {
        if (!D.Replay) return;
        const on = D.Replay.togglePause();
        const b = $('btn-replay-pause');
        if (b) b.textContent = on ? 'Pause' : 'Play';
      });
      $('btn-replay-exit')?.addEventListener('click', () => {
        if (D.Replay && boundGame) D.Replay.stop(boundGame);
        D.UI.showMenu();
      });
      document.querySelectorAll('[data-replay-speed]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!D.Replay) return;
          D.Replay.setSpeed(Number(btn.getAttribute('data-replay-speed')));
          D.Game.pushMessage(boundGame, 'Replay ' + D.Replay.speed + '×');
          if (D.UI) D.UI.refreshSpeedHud(boundGame);
        });
      });

      // Timeline scrubber: preview while dragging, seek on release (change)
      const scrub = $('replay-scrub');
      if (scrub) {
        scrub.addEventListener('pointerdown', () => {
          if (D.Replay) D.Replay._scrubbing = true;
        });
        scrub.addEventListener('input', () => {
          if (!D.Replay || !D.Replay.active || !boundGame) return;
          D.Replay._scrubbing = true;
          const dur = D.Replay.durationTicks() || 1;
          const t = Math.round((Number(scrub.value) / 1000) * dur);
          const timeEl = $('replay-time');
          if (timeEl) {
            timeEl.textContent =
              D.Replay.formatClock(t) + ' / ' + D.Replay.formatClock(dur) + ' …';
          }
        });
        scrub.addEventListener('change', () => {
          if (!D.Replay || !D.Replay.active || !boundGame) return;
          const dur = D.Replay.durationTicks() || 1;
          const t = Math.round((Number(scrub.value) / 1000) * dur);
          D.Replay.seekTo(boundGame, t, { pause: true });
          D.Replay._scrubbing = false;
          D.Game.pushMessage(
            boundGame,
            'Seek ' + D.Replay.formatClock(t) + ' / ' + D.Replay.formatClock(dur)
          );
        });
      }
      $('btn-feedback-cancel')?.addEventListener('click', () => {
        D.UI.hideFeedback();
      });
      $('btn-feedback-send')?.addEventListener('click', () => {
        D.UI.submitFeedback();
      });

      els.chatForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        D.UI.sendChat();
      });

      // Enter focuses chat when multiplayer (unless typing in an input already)
      window.addEventListener('keydown', (e) => {
        if (e.code !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        if (!boundGame || !boundGame.multiplayer || boundGame.phase !== 'playing') return;
        const input = els.chatInput || $('chat-input');
        if (!input || (els.chatPanel && els.chatPanel.classList.contains('hidden'))) return;
        e.preventDefault();
        input.focus();
      });

      D.UI.bindHousePicks();

      $('btn-mp-host')?.addEventListener('click', () => {
        if (!D.Net) return;
        const name = els.mpNameInput ? els.mpNameInput.value : undefined;
        const titleEl = $('mp-title-input');
        const title = titleEl ? titleEl.value : '';
        const house = D.UI.selectedHouse();
        D.UI.hideMenu();
        D.UI.showLobby('Creating room…');
        D.Net.host(name, { title, house });
      });

      $('btn-mp-join')?.addEventListener('click', () => {
        const input = $('mp-code-input');
        const code = ((input && input.value) || '').trim().toUpperCase();
        if (!D.Net) return;
        if (!code) {
          D.Game.pushMessage(game, 'Enter a room code to join.');
          return;
        }
        const name = els.mpNameInput ? els.mpNameInput.value : undefined;
        const house = D.UI.selectedHouse();
        D.UI.hideMenu();
        D.UI.showLobby('Joining room…');
        D.Net.join(code, name, { house });
      });

      $('btn-join-go')?.addEventListener('click', () => {
        if (!D.Net || !D.UI._pendingJoinRoom) return;
        const nameEl = els.joinNameInput || $('join-name-input');
        const name = nameEl ? nameEl.value : undefined;
        // Keep menu name field in sync
        if (els.mpNameInput && nameEl) els.mpNameInput.value = nameEl.value;
        const joinChip = document.querySelector(
          '#join-house-pick .house-chip.selected'
        );
        const house =
          (joinChip && joinChip.dataset.house) || D.UI.selectedHouse();
        D.UI.hideJoinPrompt();
        D.UI.hideMenu();
        D.UI.showLobby('Joining room ' + D.UI._pendingJoinRoom + '…');
        D.Net.join(D.UI._pendingJoinRoom, name, { house });
        D.UI._pendingJoinRoom = null;
      });

      $('btn-join-cancel')?.addEventListener('click', () => {
        D.UI._pendingJoinRoom = null;
        D.UI.hideJoinPrompt();
        try {
          const u = new URL(location.href);
          u.searchParams.delete('room');
          u.searchParams.delete('name');
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        } catch (e) {
          /* ignore */
        }
        D.UI.showMenu();
      });

      $('btn-lobby-start')?.addEventListener('click', () => {
        if (!D.Net || D.Net.role !== 'host') {
          D.Game.pushMessage(boundGame, 'Only the host can start the match.');
          return;
        }
        const mcvOnly = !!($('opt-lobby-mcv-start') && $('opt-lobby-mcv-start').checked);
        if (!D.Net.startMatch || !D.Net.startMatch({ startMode: mcvOnly ? 'mcv' : 'base' })) {
          D.Game.pushMessage(boundGame, 'Could not start — still connecting?');
          return;
        }
        D.Game.pushMessage(
          boundGame,
          mcvOnly ? 'Starting (MCV-only)…' : 'Starting (base ready)…'
        );
      });

      // Sync menu MCV checkbox → lobby (host)
      $('opt-mcv-start')?.addEventListener('change', () => {
        const lobby = $('opt-lobby-mcv-start');
        const menu = $('opt-mcv-start');
        if (lobby && menu) lobby.checked = menu.checked;
      });
      $('opt-lobby-mcv-start')?.addEventListener('change', () => {
        const lobby = $('opt-lobby-mcv-start');
        const menu = $('opt-mcv-start');
        if (lobby && menu && D.Net && D.Net.role === 'host') {
          menu.checked = lobby.checked;
        }
      });
      // Recharge (tank/tower magazines) — SP live toggle
      const syncRecharge = () => {
        const cb = $('opt-recharge');
        if (!cb) return;
        D.config.features.recharge = !!cb.checked;
        try {
          localStorage.setItem('dune2_recharge', cb.checked ? '1' : '0');
        } catch (e) {
          /* ignore */
        }
        if (boundGame) D.UI.refresh(boundGame);
      };
      $('opt-recharge')?.addEventListener('change', syncRecharge);
      try {
        const saved = localStorage.getItem('dune2_recharge');
        const cb = $('opt-recharge');
        if (cb && saved === '0') {
          cb.checked = false;
          D.config.features.recharge = false;
        } else if (cb && saved === '1') {
          cb.checked = true;
          D.config.features.recharge = true;
        } else if (cb) {
          cb.checked = !!(D.config.features && D.config.features.recharge);
        }
      } catch (e) {
        /* ignore */
      }

      $('btn-lobby-copy')?.addEventListener('click', async () => {
        await D.UI.copyRoomLink();
      });

      $('btn-lobby-cancel')?.addEventListener('click', () => {
        if (D.Net) D.Net.leave();
        // strip room from URL without reload
        try {
          const u = new URL(location.href);
          u.searchParams.delete('room');
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        } catch (e) {
          /* ignore */
        }
        D.UI.hideLobby();
        D.UI.showMenu();
      });

      $('btn-resume')?.addEventListener('click', () => {
        game.phase = 'playing';
        D.UI.showPause(false);
        if (D.Save && !game.multiplayer) D.Save.write(game);
      });

      $('btn-restart')?.addEventListener('click', () => {
        D.UI.showPause(false);
        if (game.multiplayer) return;
        if (D.Save) D.Save.clear();
        const pair =
          D.Seats && D.Seats.skirmishPair
            ? D.Seats.skirmishPair(D.UI.selectedHouse())
            : { localOwner: 'player', owners: ['player', 'enemy'] };
        game.localOwner = pair.localOwner;
        D.Game.startSkirmish(game, D.MAPS.skirmish_large || D.MAPS.skirmish1, {
          startMode: D.UI.selectedStartMode(),
          owners: pair.owners,
        });
        lastSelSig = '';
        D.UI.resetMatchHud(game);
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
      });

      $('btn-end-restart')?.addEventListener('click', () => {
        els.endModal.classList.add('hidden');
        if (game.replay && D.Replay) {
          D.Replay.stop(game);
          D.UI.resetMatchHud(game);
          D.UI.showMenu();
          return;
        }
        if (game.multiplayer) {
          if (D.Net) D.Net.leave();
          game.multiplayer = false;
          game.spectator = false;
          game.localOwner = 'player';
          D.config.features.ai = true;
          D.UI.setChatVisible(false);
          D.UI.setMpSpeedVisible(false);
          D.UI.resetMatchHud(game);
          D.UI.showMenu();
          return;
        }
        if (D.Save) D.Save.clear();
        game.speedMult =
          (D.config.skirmish && D.config.skirmish.defaultSpeed) || 2;
        const pair =
          D.Seats && D.Seats.skirmishPair
            ? D.Seats.skirmishPair(D.UI.selectedHouse())
            : { localOwner: 'player', owners: ['player', 'enemy'] };
        game.localOwner = pair.localOwner;
        D.Game.startSkirmish(game, D.MAPS.skirmish_large || D.MAPS.skirmish1, {
          startMode: D.UI.selectedStartMode(),
          owners: pair.owners,
        });
        lastSelSig = '';
        D.UI.resetMatchHud(game);
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
      });

      $('btn-end-menu')?.addEventListener('click', () => {
        els.endModal.classList.add('hidden');
        game.phase = 'menu';
        D.UI.resetMatchHud(game);
        if (game.multiplayer && D.Net) D.Net.leave();
        game.multiplayer = false;
        game.spectator = false;
        game.localOwner = 'player';
        D.config.features.ai = true;
        D.UI.setChatVisible(false);
        if (D.Save) D.Save.clear();
        D.UI.updateContinueButton();
        D.UI.showMenu();
      });

      if (D.Net) {
        D.Net.on((ev, data) => {
          if (
            ev === 'joined' ||
            ev === 'peer_joined' ||
            ev === 'peer_reconnected' ||
            ev === 'peer_left' ||
            ev === 'peer_disconnected' ||
            ev === 'roster' ||
            ev === 'house_ok' ||
            ev === 'status'
          ) {
            D.UI.refreshLobby();
            if (ev === 'house_ok') {
              const st = $('lobby-house-status');
              if (st) {
                const lab =
                  D.Net.labelFor && D.Net.seat
                    ? D.Net.labelFor(D.Net.seat)
                    : houseLabel(D.Net.seat);
                st.textContent = lab ? 'Now playing as ' + lab + '.' : 'House updated.';
              }
            }
          }
          if (ev === 'error' && data && (data.error === 'house_taken' || data.error === 'house_unavailable')) {
            const st = $('lobby-house-status');
            if (st) {
              st.textContent =
                data.message || 'That house is unavailable.';
            }
            D.UI.refreshLobby();
          }
          if (ev === 'match_started') {
            D.UI.hideLobby();
            D.UI.hideMenu();
            D.UI.hideLiveMatches();
            lastSelSig = '';
            if (game) D.UI.resetMatchHud(game);
            const spec = !!(game && game.spectator);
            D.UI.setChatVisible(!!(game && game.multiplayer));
            D.UI.setMpSpeedVisible(!!(game && game.multiplayer && !spec && game.phase === 'playing'));
            D.UI.refreshMpMatchActions(game);
            D.UI.refreshMatchup(game);
            D.UI.refreshSpeedHud(game);
            // House specials depend on seat
            if (game) D.UI.buildStructureButtons(game);
            D.UI.refresh(game);
          }
          if (ev === 'joined') {
            const spec = !!(game && game.spectator) || (data && data.role === 'spectator');
            D.UI.setChatVisible(!!(game && game.multiplayer));
            D.UI.setMpSpeedVisible(
              !!(game && game.multiplayer && !spec && game.phase === 'playing')
            );
            D.UI.refreshMpMatchActions(game);
            if (game) D.UI.buildStructureButtons(game);
            if (spec) {
              D.UI.hideLiveMatches();
              D.UI.hideMenu();
              // Lobby wait until match starts — show thin lobby status if not started
              if (data && data.started) {
                D.UI.hideLobby();
              } else {
                D.UI.showLobby('Spectating — waiting for match to start…');
              }
            }
          }
          if (ev === 'resigned') {
            D.UI.setMpSpeedVisible(false);
            D.UI.refreshMpMatchActions(game);
            D.UI.refresh(game);
          }
          if (ev === 'player_resigned') {
            D.UI.refreshMatchup(game);
            D.UI.refreshMpMatchActions(game);
          }
          if (ev === 'left' || ev === 'disconnect') {
            D.UI.setChatVisible(false);
            D.UI.setMpSpeedVisible(false);
            D.UI.refreshMpMatchActions(null);
            D.UI.hideSpeedModal();
          }
          if (ev === 'chat') {
            D.UI.appendChat(data);
          }
          if (ev === 'speed_request') {
            D.UI.showSpeedRequest(data);
          }
          if (ev === 'speed') {
            if (game) game.netSpeed = data.speed;
            D.UI.hideSpeedModal();
            D.UI.refreshSpeedHud(game);
            if (els.mpSpeedSelect) els.mpSpeedSelect.value = String(data.speed);
            D.Game.pushMessage(game, 'Speed set to ' + data.speed + '×');
          }
          if (ev === 'speed_rejected') {
            D.UI.hideSpeedModal();
            D.Game.pushMessage(
              game,
              (data.byName || 'Opponent') + ' declined ' + data.speed + '× speed.'
            );
          }
          if (ev === 'rejoin_request') {
            D.UI.showRejoinRequest(data);
          }
          if (ev === 'rejoin_resolved') {
            D.UI.hideRejoinModal();
          }
          if (ev === 'rejoin_pending') {
            D.UI.hideMenu();
            D.UI.hideLiveMatches();
          }
          if (ev === 'peer_reconnected' && data && data.consented) {
            D.Game.pushMessage(
              game,
              (data.name || 'Player') + ' rejoined (you accepted).'
            );
          }
          if (ev === 'match_end') {
            if (data.recordingId) {
              if (D.Net) D.Net.lastRecordingId = data.recordingId;
              if (boundGame) boundGame.lastRecordingId = data.recordingId;
              D.Game.pushMessage(
                game,
                'Match recorded — Watch replay or Copy link (?replay=' +
                  data.recordingId +
                  ')'
              );
            }
            if (data.winner !== undefined && game) game.winner = data.winner;
            if (game && game.phase === 'playing') {
              game.phase = data.phase === 'draw' ? 'draw' : 'ended';
            }
            // Always show end screen with winner-derived local outcome
            D.UI.showEnd(game);
            if (data.recordingId) D.UI.syncEndRecordingButtons(data.recordingId);
          }
          if (ev === 'error') {
            const err = (data && data.error) || D.Net.lastError || 'error';
            const map = {
              room_full:
                'That room is full (5 players max). Use Live matches to spectate.',
              match_started:
                'Match already started — open Live matches and Spectate instead.',
              need_players: 'Need at least 2 players to start.',
              not_host: 'Only the host can start the match.',
              spectators_full: 'Too many spectators in that room.',
              no_room: 'Room not found (may have ended).',
              spectate_off: 'Spectating is disabled for that room.',
              no_host: 'Multiplayer needs the game server (npm start or Fly).',
              no_ws: 'WebSocket not available in this browser.',
              connect_failed: 'Could not connect to multiplayer server.',
              bad_room: 'Invalid room code.',
            };
            if (els.lobbyStatus) {
              els.lobbyStatus.textContent = map[err] || ('Error: ' + err);
            }
            // stay on lobby if open, else toast
            if (!els.lobbyModal || els.lobbyModal.classList.contains('hidden')) {
              D.Game.pushMessage(game, map[err] || err);
            }
          }
          if (ev === 'disconnect') {
            D.UI.refreshLobby();
          }
        });
      }

      D.UI.buildStructureButtons(game);
      D.UI.updateContinueButton();
      D.UI.showMenu();
    },

    updateContinueButton() {
      const btn = els.btnContinue || $('btn-continue');
      if (!btn) return;
      const ok = D.Save && D.Save.has() && !(boundGame && boundGame.multiplayer);
      btn.style.display = ok ? '' : 'none';
      btn.disabled = !ok;
    },

    showMenu() {
      D.UI.updateContinueButton();
      els.menuModal?.classList.remove('hidden');
    },

    hideMenu() {
      els.menuModal?.classList.add('hidden');
    },

    showLobby(statusText) {
      if (!els.lobbyModal) return;
      D.UI.hideJoinPrompt();
      els.lobbyModal.classList.remove('hidden');
      if (statusText && els.lobbyStatus) els.lobbyStatus.textContent = statusText;
      D.UI.refreshLobby();
    },

    hideLobby() {
      els.lobbyModal?.classList.add('hidden');
    },

    /**
     * Shared-link join: ask for a name before connecting.
     * @param {string} roomCode
     * @param {string} [prefillName]
     */
    showJoinPrompt(roomCode, prefillName) {
      const code = String(roomCode || '')
        .trim()
        .toUpperCase();
      if (!code) return;
      D.UI._pendingJoinRoom = code;
      D.UI.hideMenu();
      D.UI.hideLobby();
      const modal = els.joinModal || $('join-modal');
      const label = els.joinRoomLabel || $('join-room-label');
      const nameInput = els.joinNameInput || $('join-name-input');
      if (label) label.textContent = 'Room ' + code;
      if (nameInput) {
        const saved = prefillName || (D.Net && D.Net.loadStoredName()) || 'Commander';
        nameInput.value = saved;
        // Focus after paint so the joiner can type immediately
        setTimeout(() => {
          try {
            nameInput.focus();
            nameInput.select();
          } catch (e) {
            /* ignore */
          }
        }, 0);
      }
      modal?.classList.remove('hidden');
    },

    hideJoinPrompt() {
      const modal = els.joinModal || $('join-modal');
      modal?.classList.add('hidden');
    },

    setChatVisible(show) {
      const panel = els.chatPanel || $('chat-panel');
      const hud = els.chatHud || $('chat-hud');
      if (panel) panel.classList.toggle('hidden', !show);
      if (hud) hud.classList.toggle('hidden', !show);
      if (!show) {
        const log = els.chatHudLog || $('chat-hud-log');
        if (log) log.innerHTML = '';
      }
    },

    appendChat(msg) {
      if (!msg) return;
      const hud = els.chatHud || $('chat-hud');
      const log = els.chatHudLog || $('chat-hud-log');
      if (!log) return;
      if (hud) hud.classList.remove('hidden');

      const isSystem = !!(msg.system || msg.kind === 'system' || msg.kind === 'under_attack' || msg.kind === 'eliminated');
      const mine = !isSystem && msg.seat && boundGame && msg.seat === D.Game.me(boundGame);
      const line = document.createElement('div');
      line.className =
        'chat-hud-line ' +
        (isSystem ? 'system' : mine ? 'mine' : 'theirs') +
        (msg.kind === 'under_attack' ? ' alert-attack' : '') +
        (msg.kind === 'eliminated' ? ' alert-elim' : '');

      const who = document.createElement('span');
      who.className = 'who';
      const name = isSystem
        ? 'SYSTEM'
        : msg.name ||
          (msg.seat === 'enemy' ? 'Harkonnen' : 'Atreides');
      who.textContent = name;

      const body = document.createElement('span');
      body.className = 'body';
      body.textContent = isSystem ? ' ' + (msg.text || '') : ': ' + (msg.text || '');

      line.appendChild(who);
      line.appendChild(body);
      log.appendChild(line);
      while (log.children.length > 16) log.removeChild(log.firstChild);

      // Fade like classic RTS chat after a few seconds
      const FADE_MS = isSystem ? 14000 : 10000;
      const REMOVE_MS = isSystem ? 16000 : 12000;
      setTimeout(() => line.classList.add('fading'), FADE_MS);
      setTimeout(() => {
        if (line.parentNode) line.parentNode.removeChild(line);
      }, REMOVE_MS);
    },

    /** System line on the map chat HUD (not the sidebar message log). */
    appendSystemChat(text, kind) {
      D.UI.appendChat({
        system: true,
        kind: kind || 'system',
        text: text || '',
        name: 'SYSTEM',
      });
    },

    /** Red edge flash when local forces take damage. */
    flashUnderAttack() {
      const wrap = $('game-wrap') || document.getElementById('game-wrap');
      if (!wrap) return;
      wrap.classList.remove('under-attack-flash');
      // reflow so re-adding restarts animation
      void wrap.offsetWidth;
      wrap.classList.add('under-attack-flash');
      if (attackFlashTimer) clearTimeout(attackFlashTimer);
      attackFlashTimer = setTimeout(() => {
        wrap.classList.remove('under-attack-flash');
        attackFlashTimer = 0;
      }, 900);
    },

    /**
     * Apply server snapshot alerts for the local seat (and broadcast notices).
     * @param {object} game
     * @param {Array} alerts
     */
    consumeNetAlerts(game, alerts) {
      if (!game || !alerts || !alerts.length) return;
      const me = D.Game.me(game);
      for (const a of alerts) {
        if (!a || a.id == null) continue;
        if (seenAlertIds.has(a.id)) continue;
        seenAlertIds.add(a.id);
        // Bound set growth
        if (seenAlertIds.size > 80) {
          const arr = [...seenAlertIds];
          for (let i = 0; i < 40; i++) seenAlertIds.delete(arr[i]);
        }

        const forMe = !a.seat || a.seat === me;
        if (a.kind === 'under_attack' && forMe && !game.spectator) {
          D.UI.flashUnderAttack();
          D.UI.appendSystemChat(a.text || 'We are under attack!', 'under_attack');
          // Optional: snap attention — do not force camera (annoying mid-fight)
          continue;
        }
        if (a.kind === 'wormsign' && forMe && !game.spectator) {
          D.UI.flashUnderAttack();
          D.UI.appendSystemChat(a.text || 'Wormsign!', 'under_attack');
          continue;
        }
        if (a.kind === 'worm_eat' && forMe && !game.spectator) {
          D.UI.appendSystemChat(a.text || 'A sandworm struck!', 'under_attack');
          continue;
        }
        if (a.kind === 'eliminated' && a.seat === me && !game.spectator) {
          D.UI.appendSystemChat(a.text || 'You are eliminated.', 'eliminated');
          D.UI.showEliminatedBanner(game, true);
          continue;
        }
        if (a.kind === 'elim_notice' || (a.kind === 'eliminated' && a.seat !== me)) {
          if (forMe || !a.seat) {
            D.UI.appendSystemChat(a.text || 'A house has fallen.', 'system');
          }
          continue;
        }
        if (a.kind === 'match_end') {
          // End modal handles this; optional chat line
          if (a.text) D.UI.appendSystemChat(a.text, 'system');
        }
      }

      // Keep banner in sync even if alert was missed
      if (
        game.eliminated &&
        game.eliminated[me] != null &&
        game.phase === 'playing' &&
        !game.spectator
      ) {
        D.UI.showEliminatedBanner(game, true);
      }
    },

    /**
     * Clear elim banner, system chat flashes, and seen-alert set so a new
     * skirmish does not inherit “ELIMINATED” from the previous MP match.
     */
    resetMatchHud(game) {
      seenAlertIds.clear();
      D.UI.showEliminatedBanner(game, false);
      const log = $('chat-hud-log');
      if (log) log.innerHTML = '';
      const wrap = $('game-wrap');
      if (wrap) wrap.classList.remove('under-attack-flash');
      if (attackFlashTimer) {
        clearTimeout(attackFlashTimer);
        attackFlashTimer = 0;
      }
      // SP is never mid-FFA eliminated
      if (game) {
        game.spectator = !!game.spectator && !!game.multiplayer;
        if (!game.multiplayer) game.spectator = false;
      }
    },

    showEliminatedBanner(game, show) {
      let el = $('elim-banner');
      if (!show) {
        if (el) el.classList.add('hidden');
        return;
      }
      if (!el) {
        const wrap = $('game-wrap');
        if (!wrap) return;
        el = document.createElement('div');
        el.id = 'elim-banner';
        el.className = 'elim-banner';
        el.innerHTML =
          '<strong>ELIMINATED</strong><span>Your Construction Yard and MCV are gone. Watch the rest of the match.</span>';
        wrap.appendChild(el);
      }
      el.classList.remove('hidden');
    },

    sendChat() {
      const input = els.chatInput || $('chat-input');
      if (!input || !D.Net) return;
      const text = input.value;
      if (!D.Net.sendChat(text)) return;
      input.value = '';
      input.focus();
    },

    /**
     * Fill Units / Towers stat tables from live config (always current).
     */
    fillHelpStatsTables() {
      const unitsBody = document.querySelector('#help-units-table tbody');
      const towersBody = document.querySelector('#help-towers-table tbody');
      if (!D.config) return;

      const magLabel = (w) => {
        if (!w || !w.recharge) return '—';
        const m =
          w.magazine != null
            ? w.magazine
            : (D.config.recharge && D.config.recharge.magazine) || 5;
        return String(m);
      };
      const ammoRegenLabel = (w) => {
        if (!w || !w.recharge) return '—';
        const sec =
          (D.config.recharge && D.config.recharge.regenSec) != null
            ? D.config.recharge.regenSec
            : 20;
        return sec + 's full';
      };
      const houseLabel = (def) => {
        if (!def.houses || !def.houses.length) return '';
        return (
          ' <span class="house-tag">(' +
          def.houses
            .map((h) => h.charAt(0).toUpperCase() + h.slice(1))
            .join(', ') +
          ')</span>'
        );
      };
      const unitOrder = [
        'infantry',
        'trooper',
        'saboteur',
        'trike',
        'quad',
        'combatTank',
        'siegeTank',
        'harvester',
        'mcv',
      ];

      if (unitsBody) {
        const rows = [];
        for (const id of unitOrder) {
          const def = D.config.units[id];
          if (!def) continue;
          const w = def.weapon;
          let regen = ammoRegenLabel(w);
          if (def.hpRegenPerSec) {
            regen =
              (regen !== '—' ? regen + ' · ' : '') +
              def.hpRegenPerSec +
              ' HP/s';
          }
          if (def.detonate) {
            regen =
              (regen !== '—' ? regen + ' · ' : '') +
              'detonate';
          }
          rows.push(
            '<tr>' +
              '<td>' +
              escapeHtml(def.name) +
              houseLabel(def) +
              '</td>' +
              '<td>' +
              def.cost +
              '</td>' +
              '<td>' +
              def.hp +
              '</td>' +
              '<td>' +
              (def.armor != null ? def.armor : 0) +
              '</td>' +
              '<td>' +
              (def.speed != null ? def.speed : '—') +
              '</td>' +
              '<td>' +
              (def.sight != null ? def.sight : '—') +
              '</td>' +
              '<td>' +
              (w && w.range != null
                ? w.minRange
                  ? w.minRange + '–' + w.range
                  : w.range
                : '—') +
              '</td>' +
              '<td>' +
              (w && w.damage != null ? w.damage : '—') +
              '</td>' +
              '<td>' +
              (w && w.cooldown != null ? w.cooldown + 's' : '—') +
              '</td>' +
              '<td>' +
              magLabel(w) +
              '</td>' +
              '<td>' +
              regen +
              '</td>' +
              '</tr>'
          );
        }
        unitsBody.innerHTML = rows.join('');
      }

      if (towersBody) {
        const towerIds = ['gunTurret', 'longRangeTower', 'constructionYard'];
        const rows = [];
        for (const id of towerIds) {
          const def = D.config.buildings[id];
          if (!def || !def.weapon) continue;
          const w = def.weapon;
          rows.push(
            '<tr>' +
              '<td>' +
              escapeHtml(def.name) +
              houseLabel(def) +
              '</td>' +
              '<td>' +
              (def.cost != null ? def.cost : '—') +
              '</td>' +
              '<td>' +
              def.hp +
              '</td>' +
              '<td>' +
              (def.power != null ? def.power : '—') +
              '</td>' +
              '<td>' +
              (def.sight != null ? def.sight : '—') +
              '</td>' +
              '<td>' +
              (w.minRange ? w.minRange + '–' + w.range : w.range) +
              '</td>' +
              '<td>' +
              w.damage +
              '</td>' +
              '<td>' +
              w.cooldown +
              's</td>' +
              '<td>' +
              magLabel(w) +
              '</td>' +
              '<td>' +
              ammoRegenLabel(w) +
              '</td>' +
              '</tr>'
          );
        }
        towersBody.innerHTML = rows.join('');
      }
    },

    showHelp() {
      const modal = els.helpModal || $('help-modal');
      D.UI.fillHelpStatsTables();
      modal?.classList.remove('hidden');
    },

    hideHelp() {
      const modal = els.helpModal || $('help-modal');
      modal?.classList.add('hidden');
    },

    isHelpOpen() {
      const modal = els.helpModal || $('help-modal');
      return !!(modal && !modal.classList.contains('hidden'));
    },

    isFeedbackOpen() {
      const modal = els.feedbackModal || $('feedback-modal');
      return !!(modal && !modal.classList.contains('hidden'));
    },

    setMpSpeedVisible(show) {
      const wrap = els.mpSpeedWrap || $('mp-speed-wrap');
      if (wrap) wrap.classList.toggle('hidden', !show);
    },

    /** Resign / End match buttons during live MP. */
    refreshMpMatchActions(game) {
      const wrap = $('mp-match-actions');
      const btnResign = $('btn-mp-resign');
      const btnEnd = $('btn-mp-end-match');
      if (!wrap) return;
      const mp =
        game &&
        game.multiplayer &&
        !game.replay &&
        (game.phase === 'playing' || game.phase === 'paused');
      wrap.classList.toggle('hidden', !mp);
      if (!mp) return;
      const spec = !!game.spectator;
      if (btnResign) btnResign.classList.toggle('hidden', spec);
      if (btnEnd) {
        const host = D.Net && D.Net.isHost && D.Net.isHost(game);
        btnEnd.classList.toggle('hidden', !host || spec);
      }
    },

    /** Show speed dropdown for SP (instant) or MP (request). Hidden in menu. */
    updateSpeedControl(game) {
      if (!game) {
        D.UI.setMpSpeedVisible(false);
        D.UI.refreshMpMatchActions(null);
        return;
      }
      if (game.replay || game.spectator) {
        D.UI.setMpSpeedVisible(false);
        D.UI.refreshMpMatchActions(game);
        return;
      }
      const playing = game.phase === 'playing' || game.phase === 'paused';
      D.UI.setMpSpeedVisible(playing);
      D.UI.syncSpeedSelect(game);
      D.UI.refreshMpMatchActions(game);
      const sel = els.mpSpeedSelect || $('mp-speed-select');
      if (sel) {
        sel.title = game.multiplayer
          ? 'Request speed change (opponent must accept)'
          : 'Game speed (applies immediately)';
      }
    },

    syncSpeedSelect(game) {
      const sel = els.mpSpeedSelect || $('mp-speed-select');
      if (!sel || !game) return;
      let v = 1;
      if (game.multiplayer) v = game.netSpeed || 1;
      else v = game.speedMult || 1;
      const s = String(v);
      // Ensure option exists
      if (![...sel.options].some((o) => o.value === s)) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s + '×';
        sel.appendChild(opt);
      }
      if (sel.value !== s) sel.value = s;
    },

    hideEnd() {
      const modal = els.endModal || $('end-modal');
      modal?.classList.add('hidden');
    },

    async watchRecording(id) {
      if (!id || !D.Replay || !boundGame) {
        D.Game.pushMessage(boundGame, 'No recording id for this match.');
        return;
      }
      try {
        // Capture seat before async + Replay.start → Net.leave()
        const viewAs =
          (D.Net && D.Net.seat) ||
          (boundGame && !boundGame.spectator ? boundGame.localOwner : null) ||
          null;
        D.UI.hideEnd();
        D.UI.hideMenu();
        D.UI.hideReplays();
        const rec = await D.Replay.load(id);
        if (!D.Replay.start(boundGame, rec, { viewAs })) {
          throw new Error('start_failed');
        }
      } catch (err) {
        D.Game.pushMessage(boundGame, 'Failed to load replay ' + id);
        D.UI.showMenu();
      }
    },

    showRejoinRequest(msg) {
      if (!msg || !msg.requestId) return;
      D.UI._rejoinRequestId = msg.requestId;
      const modal = $('rejoin-modal');
      const text = $('rejoin-modal-text');
      const who = msg.fromName || 'A player';
      const seat =
        msg.seatLabel ||
        (D.Seats && D.Seats.label ? D.Seats.label(msg.seat) : msg.seat) ||
        'their seat';
      if (text) {
        text.textContent =
          who +
          ' wants to rejoin as ' +
          seat +
          ' (likely refreshed or hit Back). Accept to let them control their army again?';
      }
      modal?.classList.remove('hidden');
      D.Game.pushMessage(
        boundGame,
        who + ' requests rejoin — Accept or Decline in the dialog.'
      );
    },

    hideRejoinModal() {
      D.UI._rejoinRequestId = null;
      $('rejoin-modal')?.classList.add('hidden');
    },

    showSpeedRequest(msg) {
      if (!boundGame || !msg) return;
      // Requester already knows
      if (msg.fromSeat && msg.fromSeat === D.Game.me(boundGame)) {
        D.Game.pushMessage(
          boundGame,
          'Waiting for opponent to accept ' + msg.speed + '×…'
        );
        return;
      }
      const modal = els.speedModal || $('speed-modal');
      const text = els.speedModalText || $('speed-modal-text');
      if (text) {
        text.textContent =
          (msg.fromName || 'Opponent') +
          ' requests ' +
          msg.speed +
          '× game speed. Accept?';
      }
      modal?.classList.remove('hidden');
    },

    hideSpeedModal() {
      const modal = els.speedModal || $('speed-modal');
      modal?.classList.add('hidden');
    },

    refreshSpeedHud(game) {
      const hud = els.speedHud || $('speed-hud');
      if (!hud || !game) return;
      let s = 1;
      let label = '';
      if (game.replay && D.Replay) {
        s = D.Replay.speed;
        label = 'REPLAY ' + s + '×';
      } else if (game.spectator) {
        s = game.netSpeed || 1;
        label = 'SPECTATING' + (s !== 1 ? ' ' + s + '×' : '');
      } else if (game.multiplayer) {
        s = game.netSpeed || 1;
        label = s === 1 ? '' : s + '×';
      } else {
        s = game.speedMult || 1;
        label = s === 1 ? '' : 'SP ' + s + '×';
      }
      if (!label) {
        hud.classList.add('hidden');
        hud.textContent = '';
      } else {
        hud.classList.remove('hidden');
        hud.textContent = label;
      }
    },

    showReplayBar(show) {
      const bar = els.replayBar || $('replay-bar');
      if (!bar) return;
      bar.classList.toggle('hidden', !show);
      D.UI.setMpSpeedVisible(false);
      D.UI.setChatVisible(false);
      if (show && boundGame) D.UI.refreshReplayScrub(boundGame);
    },

    /** Update scrub slider + clock from current replay tick. */
    refreshReplayScrub(game) {
      if (!game || !game.replay || !D.Replay || !D.Replay.active) return;
      if (D.Replay._scrubbing) return;
      const scrub = $('replay-scrub');
      const timeEl = $('replay-time');
      const status = $('replay-status');
      const dur = D.Replay.durationTicks() || 1;
      const cur = Math.min(dur, game.tick | 0);
      if (scrub) {
        const v = Math.round((cur / dur) * 1000);
        if (Number(scrub.value) !== v) scrub.value = String(v);
      }
      if (timeEl) {
        timeEl.textContent =
          D.Replay.formatClock(cur) + ' / ' + D.Replay.formatClock(dur);
      }
      if (status) {
        status.textContent =
          (D.Replay._playing ? 'Replay' : 'Paused') +
          ' ' +
          (D.Replay.speed || 1) +
          '×';
      }
    },

    async showReplays() {
      const modal = els.replaysModal || $('replays-modal');
      modal?.classList.remove('hidden');
      await D.UI.loadReplaysList();
    },

    hideReplays() {
      const modal = els.replaysModal || $('replays-modal');
      modal?.classList.add('hidden');
    },

    async showLiveMatches() {
      const modal = els.liveModal || $('live-modal');
      modal?.classList.remove('hidden');
      try {
        const u = new URL(location.href);
        u.searchParams.set('live', '1');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch (e) {
        /* ignore */
      }
      await D.UI.loadLiveList();
    },

    hideLiveMatches() {
      const modal = els.liveModal || $('live-modal');
      modal?.classList.add('hidden');
      try {
        const u = new URL(location.href);
        if (u.searchParams.has('live')) {
          u.searchParams.delete('live');
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        }
      } catch (e) {
        /* ignore */
      }
    },

    async loadLiveList() {
      const list = els.liveList || $('live-list');
      const status = els.liveStatus || $('live-status');
      if (!list) return;
      list.innerHTML = '';
      if (status) status.textContent = 'Loading…';
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        if (!res.ok) throw new Error('http_' + res.status);
        const data = await res.json();
        if (!data || !data.ok) throw new Error('bad_response');
        const items = data.matches || [];
        if (status) {
          status.textContent = items.length
            ? items.length + ' room(s) on this server'
            : 'No rooms right now — host a match or refresh.';
        }
        for (const it of items) {
          const row = document.createElement('div');
          row.className = 'replay-row';
          const names = it.names || {};
          const left = document.createElement('div');
          const phase = it.started
            ? it.phase === 'playing' || !it.phase
              ? 'in progress'
              : String(it.phase)
            : 'lobby';
          const tick = it.tick != null ? it.tick : 0;
          const mins = Math.max(0, Math.floor(tick / 20 / 60));
          const secs = Math.floor((tick / 20) % 60);
          const clock =
            it.started && tick
              ? mins + ':' + String(secs).padStart(2, '0')
              : '—';
          const title = (it.title && String(it.title).trim()) || '';
          const hostName = names.player || 'Host';
          const rosterBits = [];
          for (const k of Object.keys(names)) {
            if (names[k]) rosterBits.push(names[k]);
          }
          const who =
            rosterBits.length > 0
              ? rosterBits.join(' · ')
              : hostName;
          left.innerHTML =
            (title
              ? '<strong class="live-title">' +
                escapeHtml(title) +
                '</strong><br/>'
              : '') +
            '<span class="live-who">' +
            escapeHtml(who) +
            '</span><br/><span class="meta">' +
            escapeHtml(it.room || '') +
            ' · ' +
            phase +
            ' · ' +
            clock +
            ' · ' +
            (it.players | 0) +
            '/' +
            5 +
            ' seats · ' +
            (it.spectators | 0) +
            ' watching' +
            (!it.started && !it.canJoin ? ' · full' : '') +
            '</span>';
          const actions = document.createElement('div');
          actions.className = 'replay-row-actions';

          const playerName = () =>
            (els.mpNameInput && els.mpNameInput.value) ||
            (D.Net && D.Net.loadStoredName && D.Net.loadStoredName()) ||
            undefined;

          // Lobby + free seat → Join as player
          if (!it.started && it.canJoin) {
            const btnJoin = document.createElement('button');
            btnJoin.type = 'button';
            btnJoin.className = 'primary';
            btnJoin.textContent = 'Join';
            btnJoin.addEventListener('click', () => {
              if (!D.Net || !it.room) return;
              D.UI.hideLiveMatches();
              D.UI.hideMenu();
              D.UI.showLobby('Joining ' + (title || it.room) + '…');
              D.Net.join(it.room, playerName(), {
                house: D.UI.selectedHouse(),
              });
            });
            actions.appendChild(btnJoin);
          }

          // In progress with a disconnected seat → Rejoin (refresh/back recovery)
          if (it.started && it.canRejoin) {
            const btnRe = document.createElement('button');
            btnRe.type = 'button';
            btnRe.className = 'primary';
            btnRe.textContent = 'Rejoin';
            btnRe.title =
              'Return to a disconnected seat. Same browser auto-returns; otherwise one player must Accept.';
            btnRe.addEventListener('click', () => {
              if (!D.Net || !it.room) return;
              D.UI.hideLiveMatches();
              D.UI.hideMenu();
              D.UI.showLobby('Requesting rejoin to ' + (title || it.room) + '…');
              D.Net.requestRejoin(it.room, playerName());
            });
            actions.appendChild(btnRe);
          }

          // Spectate: in progress, or lobby while waiting
          const canSpec =
            it.canSpectate !== false && it.open !== false;
          if (canSpec) {
            const btnSpec = document.createElement('button');
            btnSpec.type = 'button';
            btnSpec.className = it.started && !it.canRejoin ? 'primary' : '';
            btnSpec.textContent = 'Spectate';
            btnSpec.addEventListener('click', () => {
              if (!D.Net || !it.room) return;
              D.UI.hideLiveMatches();
              D.UI.hideMenu();
              D.Net.spectate(it.room, playerName());
            });
            actions.appendChild(btnSpec);
          }

          if (!actions.childNodes.length) {
            const full = document.createElement('button');
            full.type = 'button';
            full.textContent = 'Full';
            full.disabled = true;
            actions.appendChild(full);
          }

          row.appendChild(left);
          row.appendChild(actions);
          list.appendChild(row);
        }
      } catch (err) {
        if (status) {
          status.textContent =
            'Could not list live matches (need the live game server).';
        }
      }
    },

    async loadReplaysList() {
      const list = els.replaysList || $('replays-list');
      const status = els.replaysStatus || $('replays-status');
      if (!list) return;
      list.innerHTML = '';
      if (status) status.textContent = 'Loading…';
      try {
        if (!D.Replay) throw new Error('no_replay');
        const items = await D.Replay.list();
        if (status) {
          status.textContent = items.length
            ? items.length + ' recording(s) on this server'
            : 'No recordings yet — finish a multiplayer match.';
        }
        for (const it of items) {
          const row = document.createElement('div');
          row.className = 'replay-row';
          const names = it.names || {};
          const left = document.createElement('div');
          const mins = Math.max(1, Math.round((it.durationTicks || 0) / 20 / 60));
          const nEv = it.cmds != null ? it.cmds + ' cmds' : (it.events || it.frames || 0) + ' events';
          const fmt = it.format === 'cmd-v1' ? 'cmd stream' : 'legacy';
          left.innerHTML =
            '<strong>' +
            escapeHtml(names.player || 'Atreides') +
            '</strong> vs <strong>' +
            escapeHtml(names.enemy || 'Harkonnen') +
            '</strong><br/><span class="meta">' +
            escapeHtml(it.phase || '') +
            (it.winner
              ? ' · winner ' +
                escapeHtml(
                  D.Seats && D.Seats.label
                    ? D.Seats.label(it.winner, it.names || names)
                    : it.winner
                )
              : '') +
            ' · ~' +
            mins +
            ' min · ' +
            nEv +
            ' · ' +
            fmt +
            ' · ' +
            escapeHtml(it.id) +
            '</span>';
          const actions = document.createElement('div');
          actions.className = 'replay-row-actions';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'primary';
          btn.textContent = 'Watch';
          btn.addEventListener('click', async () => {
            if (status) status.textContent = 'Loading ' + it.id + '…';
            try {
              await D.UI.watchRecording(it.id);
            } catch (err) {
              if (status) status.textContent = 'Failed to load replay.';
            }
          });
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.textContent = 'Copy link';
          copy.addEventListener('click', async () => {
            const url = D.Replay.shareUrl(it.id);
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(url);
                if (status) status.textContent = 'Link copied for ' + it.id;
              } else {
                window.prompt('Copy replay link:', url);
              }
            } catch (err) {
              window.prompt('Copy replay link:', url);
            }
          });
          actions.appendChild(btn);
          actions.appendChild(copy);
          row.appendChild(left);
          row.appendChild(actions);
          list.appendChild(row);
        }
      } catch (err) {
        if (status) {
          status.textContent =
            'Could not list replays (need the live game server).';
        }
      }
    },

    showFeedback() {
      const modal = els.feedbackModal || $('feedback-modal');
      if (!modal) return;
      if (els.feedbackStatus) els.feedbackStatus.textContent = '';
      // Keep prior draft if they re-open quickly; only clear status
      modal.classList.remove('hidden');
      // Above other modals while open
      modal.style.zIndex = '200';
      setTimeout(() => {
        const t = els.feedbackText || $('feedback-text');
        t?.focus();
      }, 0);
    },

    hideFeedback() {
      const modal = els.feedbackModal || $('feedback-modal');
      modal?.classList.add('hidden');
    },

    async submitFeedback() {
      const textEl = els.feedbackText || $('feedback-text');
      const contactEl = els.feedbackContact || $('feedback-contact');
      const status = els.feedbackStatus || $('feedback-status');
      const text = (textEl && textEl.value) || '';
      const contact = (contactEl && contactEl.value) || '';
      if (!text.trim()) {
        if (status) status.textContent = 'Please write a short message.';
        return;
      }
      if (status) status.textContent = 'Sending…';
      const btn = $('btn-feedback-send');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text.trim(),
            contact: contact.trim(),
            room: (boundGame && boundGame.roomCode) || (D.Net && D.Net.room) || null,
            href: location.href,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          throw new Error((data && data.error) || 'send_failed');
        }
        if (status) status.textContent = 'Thanks — feedback sent.';
        if (textEl) textEl.value = '';
        setTimeout(() => D.UI.hideFeedback(), 900);
      } catch (err) {
        if (status) {
          status.textContent =
            'Could not send (need the live server). Try again from dune2v.fly.dev.';
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    refreshLobby() {
      if (!els.lobbyModal || !D.Net) return;
      const code = D.Net.room || '—';
      const url = D.Net.roomUrl() || '';
      if (els.lobbyCode) els.lobbyCode.textContent = code;
      if (els.lobbyLink) {
        els.lobbyLink.value = url;
      }
      const titleEl = $('lobby-match-title');
      const heading = $('lobby-heading');
      const title = D.Net.roomTitle;
      if (titleEl) {
        if (title) {
          titleEl.textContent = title;
          titleEl.classList.remove('hidden');
        } else {
          titleEl.textContent = '';
          titleEl.classList.add('hidden');
        }
      }
      if (heading) {
        heading.textContent = title ? 'Lobby · ' + title : 'Multiplayer lobby';
      }
      if (els.lobbyRoster) {
        const seats = D.Net.seats || {};
        const rows = [];
        const seatIds =
          D.Seats && D.Seats.IDS ? D.Seats.IDS : ['player', 'enemy'];
        const renderSeat = (seat) => {
          const h = D.Seats ? D.Seats.house(seat) : null;
          const col = h ? h.color : '#888';
          const tint =
            seat === 'player'
              ? 'blue'
              : seat === 'enemy'
                ? 'red'
                : seat === 'p2'
                  ? 'green'
                  : seat === 'p3'
                    ? 'pink'
                    : seat === 'p4'
                      ? 'black'
                      : '';
          const house =
            (h ? h.name : seat) + (tint ? ' · ' + tint : '');
          const css = h ? h.id : '';
          const info = seats[seat];
          const name = (info && info.name) || (seat === D.Net.seat ? D.Net.name : null);
          const you = seat === D.Net.seat;
          const online = info && info.connected !== false;
          if (name) {
            const tag = you ? ' (you)' : online ? '' : ' (offline)';
            const label = h ? h.name + '-' + name : name;
            rows.push(
              `<div class="seat-row"><span class="seat-house">${escapeHtml(house)}</span>` +
                `<span class="seat-name ${css}${you ? ' you' : ''}${
                  online ? '' : ' offline'
                }" style="color:${col}">${escapeHtml(label)}${tag}</span></div>`
            );
          } else {
            // Only show empty slots up to max (always show 5 slots so people know capacity)
            rows.push(
              `<div class="seat-row"><span class="seat-house">${escapeHtml(house)}</span>` +
                `<span class="empty">open</span></div>`
            );
          }
        };
        for (const s of seatIds) renderSeat(s);
        els.lobbyRoster.innerHTML = rows.join('');
      }
      // Host-only start button; guests see "waiting for host"
      const btnStart = $('btn-lobby-start');
      const waitHost = $('lobby-wait-host');
      const lobbyMcvRow = $('lobby-mcv-row');
      const lobbyMcv = $('opt-lobby-mcv-start');
      const n = D.Net.peers || 0;
      const isHost = D.Net.role === 'host';
      const inLobby = D.Net.status === 'lobby' || D.Net.status === 'connecting';
      const started = !!(D.Net.started || D.Net.status === 'playing');
      if (lobbyMcvRow) {
        lobbyMcvRow.classList.toggle('hidden', !isHost || started);
      }
      if (lobbyMcv && isHost && !lobbyMcv._syncedOnce) {
        const menu = $('opt-mcv-start');
        if (menu) lobbyMcv.checked = menu.checked;
        lobbyMcv._syncedOnce = true;
      }
      if (btnStart) {
        const showStart = isHost && inLobby && n >= 2 && !started;
        btnStart.classList.toggle('hidden', !showStart);
        btnStart.disabled = !showStart;
        btnStart.setAttribute('aria-hidden', showStart ? 'false' : 'true');
        btnStart.textContent =
          n >= 5 ? 'Start match (full)' : 'Start match (' + n + ' players)';
      }
      if (waitHost) {
        // Guests with 2+ players: explicit wait message (not a dead Start button)
        const showWait = !isHost && inLobby && n >= 2 && !started;
        waitHost.classList.toggle('hidden', !showWait);
        waitHost.textContent =
          n + ' commanders ready — waiting for host to start…';
      }
      if (els.lobbySeat) {
        if (D.Net.seat) {
          const lab =
            D.Net.labelFor
              ? D.Net.labelFor(D.Net.seat)
              : houseLabel(D.Net.seat);
          els.lobbySeat.textContent =
            'Playing as ' + lab + (isHost ? ' · room host' : ' · guest');
        } else {
          els.lobbySeat.textContent = '';
        }
      }
      // Lobby house chips: highlight current house; disable houses with no free seat
      const lobbyPick = $('lobby-house-wrap');
      const lobbyChips = $('lobby-house-pick');
      if (lobbyPick) {
        lobbyPick.classList.toggle('hidden', started || !D.Net.seat);
      }
      if (lobbyChips && D.Net.seat && !started) {
        const curHouse =
          D.Seats && D.Seats.houseId
            ? D.Seats.houseId(D.Net.seat)
            : 'atreides';
        const seatOcc = D.Net.seats || {};
        lobbyChips.querySelectorAll('.house-chip').forEach((btn) => {
          const hid = btn.dataset.house;
          const on = hid === curHouse;
          btn.classList.toggle('selected', on);
          btn.setAttribute('aria-pressed', on ? 'true' : 'false');
          let available = on;
          if (!on && D.Seats && D.Seats.seatsForHouse) {
            available = D.Seats.seatsForHouse(hid).some((s) => {
              const info = seatOcc[s];
              return !info || !info.name;
            });
          }
          btn.disabled = !available && !on;
          btn.setAttribute(
            'aria-disabled',
            !available && !on ? 'true' : 'false'
          );
        });
      }
      if (els.lobbyStatus) {
        if (D.Net.status === 'connecting') {
          els.lobbyStatus.textContent = 'Connecting…';
        } else if (D.Net.status === 'lobby') {
          if (n < 2) {
            els.lobbyStatus.textContent = isHost
              ? 'Waiting for players (2–5)… copy the link and share it.'
              : 'Waiting for more players… host will start the match.';
          } else if (n >= 5) {
            els.lobbyStatus.textContent = isHost
              ? 'Lobby full (5) — starting…'
              : 'Lobby full — waiting for host to start…';
          } else if (isHost) {
            els.lobbyStatus.textContent =
              n +
              ' commanders in lobby. Click Start match, or wait for more (max 5).';
          } else {
            els.lobbyStatus.textContent =
              n + ' commanders — waiting for host to start.';
          }
        } else if (D.Net.status === 'playing') {
          els.lobbyStatus.textContent = 'Match in progress.';
        } else if (D.Net.lastError) {
          els.lobbyStatus.textContent = D.Net.lastError;
        }
      }
    },

    /** Copy multiplayer room share URL (robust fallbacks). */
    async copyRoomLink() {
      const status = $('lobby-copy-status');
      const input = els.lobbyLink || $('lobby-link');
      const url = (D.Net && D.Net.roomUrl && D.Net.roomUrl()) || '';
      if (input && url) input.value = url;

      const setStatus = (text, ok) => {
        if (status) {
          status.classList.remove('hidden');
          status.textContent = text;
          status.style.color = ok ? 'var(--ok)' : 'var(--danger)';
        }
        if (boundGame) D.Game.pushMessage(boundGame, text);
      };

      if (!url) {
        setStatus('No room link yet — still connecting?', false);
        return false;
      }

      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          ok = true;
        }
      } catch (e) {
        ok = false;
      }

      if (!ok && input) {
        try {
          input.focus();
          input.select();
          input.setSelectionRange(0, input.value.length);
          ok = document.execCommand('copy');
        } catch (e2) {
          ok = false;
        }
      }

      if (!ok) {
        try {
          const ta = document.createElement('textarea');
          ta.value = url;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e3) {
          ok = false;
        }
      }

      if (!ok) {
        try {
          window.prompt('Copy room link (Ctrl/Cmd+C):', url);
          ok = true; // user can copy from prompt
          setStatus('Select and copy the link from the prompt.', true);
          return true;
        } catch (e4) {
          setStatus('Copy failed — select the link field manually.', false);
          if (input) {
            input.focus();
            input.select();
          }
          return false;
        }
      }

      setStatus('Room link copied.', true);
      return true;
    },

    refreshMatchup(game) {
      const el = els.mpMatchup || $('mp-matchup');
      if (!el) return;
      if (!game.multiplayer && !game.replay && !game.spectator) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
      }
      const owners =
        (D.Seats && D.Seats.active(game)) ||
        (game.activeOwners && game.activeOwners.length
          ? game.activeOwners
          : ['player', 'enemy']);
      const names = game.playerNames || {};
      const local = me(game);
      const parts = owners.map((seat) => {
        const lab = escapeHtml(
          D.Seats ? D.Seats.label(seat, names) : names[seat] || seat
        );
        const h = D.Seats ? D.Seats.house(seat) : null;
        const col = h ? h.color : '';
        const cls =
          (h ? h.id : '') + (seat === local && !game.spectator && !game.replay ? ' you' : '');
        const st = col ? ` style="color:${col}"` : '';
        return `<span class="${cls}"${st}>${lab}</span>`;
      });
      let suffix = '';
      if (game.replay) suffix = ` <span style="opacity:.45">· REPLAY</span>`;
      else if (game.spectator) {
        const code = escapeHtml(game.roomCode || (D.Net && D.Net.room) || '');
        suffix =
          ` <span style="opacity:.55">· SPECTATING` +
          (code ? ' · ' + code : '') +
          `</span>`;
      } else if (owners.length > 2) {
        suffix = ` <span style="opacity:.45">· FFA</span>`;
      }
      el.innerHTML = parts.join(` <span style="opacity:.4">·</span> `) + suffix;
      el.classList.remove('hidden');
    },

    /** Dual-house credits/power for spectator replay / live spectate. */
    refreshReplayScoreboard(game) {
      const board = $('replay-scoreboard');
      const live = $('live-economy');
      if (!board) return;
      if (!game.replay && !game.spectator) {
        board.classList.add('hidden');
        board.innerHTML = '';
        live?.classList.remove('hidden');
        return;
      }
      live?.classList.add('hidden');
      board.classList.remove('hidden');

      const names = game.playerNames || {};
      const owners =
        (D.Seats && D.Seats.active(game)) ||
        (game.activeOwners && game.activeOwners.length
          ? game.activeOwners
          : ['player', 'enemy']);
      const sides = owners.map((owner) => {
        const h = D.Seats ? D.Seats.house(owner) : null;
        return {
          owner,
          css: h ? h.id : '',
          label: D.Seats ? D.Seats.label(owner, names) : names[owner] || owner,
          house: h ? h.name : owner,
          color: h ? h.color : '#888',
        };
      });

      function card(s) {
        const c = Math.floor(game.credits[s.owner] || 0);
        const cap = game.spiceCap[s.owner] || 0;
        const p = game.power[s.owner] || { prod: 0, need: 0 };
        const ratio = p.need > 0 ? Math.min(1, p.prod / p.need) : 1;
        const barCol =
          ratio < 0.5 ? 'var(--danger)' : ratio < 1 ? 'var(--accent)' : 'var(--ok)';
        const units = game.units.filter((u) => u.owner === s.owner && u.hp > 0).length;
        const blds = game.buildings.filter(
          (b) => b.owner === s.owner && b.hp > 0 && b.type !== 'concrete'
        ).length;
        return (
          `<div class="replay-score-card ${s.css}" style="border-color:${s.color}">` +
          `<div class="house" style="color:${s.color}" title="${escapeHtml(s.house)}">${escapeHtml(s.label)}</div>` +
          `<div class="line"><span class="k">Credits</span><span class="v">${c} / ${cap}</span></div>` +
          `<div class="line"><span class="k">Power</span><span class="v">${p.prod} / ${p.need}</span></div>` +
          `<div class="line"><span class="k">Army</span><span class="v">${units}u · ${blds}b</span></div>` +
          `<div class="pwr-bar"><span style="width:${Math.round(ratio * 100)}%;background:${barCol}"></span></div>` +
          `</div>`
        );
      }

      board.innerHTML =
        `<div class="replay-score-row" style="grid-template-columns:repeat(${Math.min(3, sides.length)},1fr)">${sides.map(card).join('')}</div>`;
    },

    showPause(show) {
      if (!els.pauseModal) return;
      if (show) els.pauseModal.classList.remove('hidden');
      else els.pauseModal.classList.add('hidden');
    },

    showEnd(game) {
      if (!els.endModal || !game) return;
      D.UI.showEliminatedBanner(game, false);
      const modal = els.endModal;
      modal.classList.remove('hidden');
      const local = D.Game.localEndPhase(game);
      modal.querySelector('.modal').classList.toggle('victory', local === 'victory');
      modal.querySelector('.modal').classList.toggle('defeat', local === 'defeat' || local === 'draw');
      const h2 = modal.querySelector('h2');
      const p = modal.querySelector('p');
      const names = game.playerNames;
      const myLabel = D.Seats
        ? D.Seats.label(D.Game.me(game), names)
        : (names && names[D.Game.me(game)]) ||
          (D.Net && D.Net.name) ||
          'Commander';
      const winLabel = game.winner
        ? D.Seats
          ? D.Seats.label(game.winner, names)
          : game.winner
        : D.Seats
          ? D.Seats.label(D.Game.foe(game), names)
          : 'Opponent';
      if (game.spectator || game.replay) {
        h2.textContent = 'Match over';
        p.textContent =
          (game.winner
            ? winLabel + ' wins.'
            : local === 'draw'
              ? 'Draw — no houses remain.'
              : 'Ended.') +
          (game.replay ? ' Esc exits replay.' : ' Esc returns to menu.');
      } else if (local === 'draw') {
        h2.textContent = 'Draw';
        p.textContent = 'No houses remain. The desert claims all.';
      } else if (local === 'victory') {
        h2.textContent = 'Victory';
        p.textContent = game.multiplayer
          ? myLabel + ' prevails. The Emperor acknowledges your control of Arrakis.'
          : 'The Emperor acknowledges your control of Arrakis.';
      } else {
        h2.textContent = 'Defeat';
        p.textContent = game.multiplayer
          ? winLabel + ' triumphs. ' + myLabel + ' has fallen. The spice must flow… elsewhere.'
          : 'Your base has fallen. The spice must flow… elsewhere.';
      }
      const recId = D.UI.lastRecordingId();
      D.UI.syncEndRecordingButtons(recId);
      if (D.Save && !game.multiplayer) D.Save.clear();
    },

    lastRecordingId() {
      if (D.Net && D.Net.lastRecordingId) return D.Net.lastRecordingId;
      if (boundGame && boundGame.lastRecordingId) return boundGame.lastRecordingId;
      return null;
    },

    syncEndRecordingButtons(recId) {
      const note = $('end-recording-note');
      const btnWatch = $('btn-end-watch');
      const btnCopy = $('btn-end-copy-replay');
      if (recId) {
        if (note) {
          note.classList.remove('hidden');
          note.textContent =
            'Recording ' + recId + ' — Watch here, or Copy link to share.';
        }
        btnWatch?.classList.remove('hidden');
        btnCopy?.classList.remove('hidden');
        btnCopy && (btnCopy.disabled = false);
      } else {
        note?.classList.add('hidden');
        btnWatch?.classList.add('hidden');
        btnCopy?.classList.add('hidden');
      }
    },

    async copyReplayLink(id) {
      const note = $('end-recording-note');
      if (!id) {
        const msg = 'No recording id yet — wait a second after the match ends.';
        if (note) {
          note.classList.remove('hidden');
          note.textContent = msg;
        }
        if (boundGame) D.Game.pushMessage(boundGame, msg);
        return false;
      }
      const url =
        D.Replay && D.Replay.shareUrl
          ? D.Replay.shareUrl(id)
          : location.origin + '/?replay=' + encodeURIComponent(id);
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          ok = true;
        }
      } catch (err) {
        ok = false;
      }
      if (!ok) {
        // Fallback: selectable prompt (clipboard often blocked inside modals)
        try {
          ok = !!(window.prompt('Copy replay link (Ctrl/Cmd+C):', url));
        } catch (e2) {
          ok = false;
        }
      }
      if (!ok) {
        // Last resort: temp input + execCommand
        try {
          const ta = document.createElement('textarea');
          ta.value = url;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e3) {
          ok = false;
        }
      }
      const msg = ok
        ? 'Replay link copied.'
        : 'Could not copy — link: ' + url;
      if (note) {
        note.classList.remove('hidden');
        note.textContent = ok
          ? 'Link copied: ' + url
          : 'Copy failed. Link: ' + url;
      }
      if (boundGame) D.Game.pushMessage(boundGame, msg);
      return ok;
    },

    buildStructureButtons(game) {
      const root = els.buildMenu;
      if (!root) return;
      root.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'section-title';
      title.id = 'structure-queue-status';
      title.textContent = 'Structures';
      root.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'btn-grid';
      grid.id = 'structure-btns';
      root.appendChild(grid);

      const order = [
        'concrete',
        'windtrap',
        'refinery',
        'silo',
        'barracks',
        'lightFactory',
        'heavyFactory',
        'gunTurret',
        'longRangeTower',
        'wall',
        'radar',
      ];
      const owner = me(game);
      for (const type of order) {
        const def = D.config.buildings[type];
        if (!def || !def.buildable) continue;
        if (D.Seats && D.Seats.allows && !D.Seats.allows(owner, def)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'game-btn icon-btn';
        btn.dataset.type = type;
        const icon = D.Sprites.getIconCanvas(
          'building',
          type,
          40,
          myColor(game)
        );
        icon.className = 'btn-icon';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'btn-label';
        label.innerHTML = `<strong>${def.name}</strong><span class="meta">${def.cost}¢ · ${def.power >= 0 ? '+' : ''}${def.power}⚡</span>`;
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.title =
          def.name +
          ' — ' +
          def.cost +
          ' credits' +
          (type === 'concrete' ? ' · rock only' : '') +
          (def.houses && def.houses.length
            ? ' · ' + (D.Seats && D.Seats.house ? D.Seats.house(owner).name : '') + ' only'
            : '');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (game.phase !== 'playing' || game.replay || game.spectator) return;
          const o = me(game);
          if (!D.Economy.hasTech(game, o, def.requires)) {
            const need = def.requires || 'tech';
            D.Game.pushMessage(
              game,
              'Requires a completed ' +
                (D.config.buildings[need] ? D.config.buildings[need].name : need)
            );
            return;
          }
          const n = D.Economy.structureQueueCount(game, o);
          const maxQ = D.Economy.structureQueueMax();
          if (n >= maxQ) {
            D.Game.pushMessage(game, 'Construction queue full (' + maxQ + ' max).');
            return;
          }
          D.Input.startPlacement(game, type);
          // startPlacement already toasts place instructions
          if (n > 0) {
            D.Game.pushMessage(game, 'Queue slot ' + (n + 1) + '/' + maxQ);
          }
        });
        grid.appendChild(btn);
      }
    },

    /** Lightweight HUD update; rebuild selection panel only when needed */
    refresh(game) {
      if (!els.credits) return;
      const o = me(game);
      D.UI.refreshMatchup(game);
      D.UI.refreshReplayScoreboard(game);
      D.UI.refreshSpeedHud(game);
      D.UI.updateSpeedControl(game);

      // Live economy is single-seat; replay / spectate use dual scoreboard instead
      if (!game.replay && !game.spectator) {
        const c = Math.floor(game.credits[o] || 0);
        const cap = game.spiceCap[o] || 0;
        els.credits.textContent = `${c} / ${cap}`;
        const p = game.power[o] || { prod: 0, need: 0, ratio: 1 };
        els.power.textContent = `${p.prod} / ${p.need}`;
        const ratio = p.need > 0 ? Math.min(1, p.prod / p.need) : 1;
        if (els.powerFill) {
          els.powerFill.style.width = Math.round(ratio * 100) + '%';
          els.powerFill.style.background =
            ratio < 0.5 ? 'var(--danger)' : ratio < 1 ? 'var(--accent)' : 'var(--ok)';
        }
      }

      // structure buttons enable/disable only
      const grid = $('structure-btns');
      const maxQ = D.Economy.structureQueueMax();
      const qCount = D.Economy.structureQueueCount(game, o);
      const qTitle = $('structure-queue-status');
      if (qTitle) {
        qTitle.textContent =
          qCount > 0 ? 'Building ' + qCount + '/' + maxQ : 'Structures';
      }
      if (grid) {
        for (const btn of grid.querySelectorAll('button')) {
          const type = btn.dataset.type;
          const def = D.config.buildings[type];
          const tech = D.Economy.hasTech(game, o, def.requires);
          const hasCY = game.buildings.some(
            (b) =>
              b.owner === o &&
              b.type === 'constructionYard' &&
              b.buildProgress >= 1
          );
          const queueFull = qCount >= maxQ;
          const viewOnly = !!(game.replay || game.spectator);
          btn.disabled =
            !tech ||
            !hasCY ||
            queueFull ||
            game.phase !== 'playing' ||
            viewOnly;
          btn.classList.toggle(
            'active',
            !!(game.placement && game.placement.type === type && !viewOnly)
          );
          if (queueFull) {
            btn.title = (def.name || type) + ' — queue full (' + maxQ + ' max)';
          }
        }
      }

      const sig = selectionSignature(game);
      if (sig !== lastSelSig) {
        lastSelSig = sig;
        D.UI.renderSelection(game);
      } else {
        D.UI.syncProduceAffordability(game);
        D.UI.syncQueueProgress(game);
      }

      // Mid-FFA elimination banner while match still playing
      if (
        game.phase === 'playing' &&
        game.multiplayer &&
        !game.spectator &&
        game.eliminated &&
        game.eliminated[me(game)] != null
      ) {
        D.UI.showEliminatedBanner(game, true);
      }

      // Replay uses the scrub bar + one status line — do not re-open Draw/Victory.
      if (
        !game.replay &&
        (game.phase === 'victory' ||
          game.phase === 'defeat' ||
          game.phase === 'ended' ||
          game.phase === 'draw')
      ) {
        if (els.endModal?.classList.contains('hidden')) D.UI.showEnd(game);
      }
    },

    invalidateSelection() {
      lastSelSig = '';
    },

    syncProduceAffordability(game) {
      if (!els.unitMenu) return;
      const o = me(game);
      for (const btn of els.unitMenu.querySelectorAll('[data-produce]')) {
        const cost = Number(btn.dataset.cost || 0);
        btn.disabled =
          game.phase !== 'playing' ||
          !!game.replay ||
          !!game.spectator ||
          !D.Economy.canAfford(game, o, cost);
      }
    },

    syncQueueProgress(game) {
      const el = $('queue-status');
      if (!el) return;
      const id = Number(el.dataset.buildingId);
      const b = game.buildings.find((x) => x.id === id);
      if (!b) return;
      if (!b.buildQueue.length) {
        el.textContent = '';
        return;
      }
      el.textContent =
        'Queue: ' +
        b.buildQueue
          .map(
            (item, i) =>
              `${D.config.units[item.type]?.name || item.type}${
                i === 0 ? ` ${Math.floor(item.progress * 100)}%` : ''
              }`
          )
          .join(', ');
    },

    renderSelection(game) {
      const info = els.selectionInfo;
      const unitMenu = els.unitMenu;
      if (!info || !unitMenu) return;
      info.innerHTML = '';
      unitMenu.innerHTML = '';
      const o = me(game);

      const ids = game.selection.ids;
      if (!ids.length) {
        info.innerHTML = '<div class="meta">No selection</div>';
        return;
      }

      const units = game.units.filter((u) => ids.includes(u.id));
      const buildings = game.buildings.filter((b) => ids.includes(b.id));

      if (units.length === 1 && !buildings.length) {
        const u = units[0];
        const def = D.config.units[u.type];
        const row = document.createElement('div');
        row.className = 'sel-row';
        const ic = D.Sprites.getIconCanvas('unit', u.type, 48, ownerColor(u.owner));
        ic.className = 'sel-icon';
        const text = document.createElement('div');
        text.innerHTML = `
          <div class="title">${def?.name || u.type}</div>
          <div class="meta">${u.owner === o ? 'yours' : u.owner} · HP ${Math.ceil(u.hp)}/${u.hpMax}</div>
          <div class="hp-bar"><span style="width:${(u.hp / u.hpMax) * 100}%"></span></div>
          ${
            D.config.features.recharge &&
            u.weapon &&
            u.weapon.ammoMax
              ? `<div class="meta">Ammo ${Math.floor(u.weapon.ammo)}/${u.weapon.ammoMax}</div>
          <div class="hp-bar ammo-bar" title="Magazine recharge"><span style="width:${
            (Math.min(u.weapon.ammoMax, u.weapon.ammo) / u.weapon.ammoMax) * 100
          }%;background:var(--accent,#c9a227)"></span></div>`
              : ''
          }
          ${u.type === 'harvester' ? `<div class="meta">Cargo ${Math.floor(u.cargo)}/${u.cargoMax}</div>` : ''}
          ${u.type === 'mcv' ? `<div class="hint">Press <b>E</b> to deploy Construction Yard on rock.</div>` : ''}
          ${u.type === 'saboteur' ? `<div class="hint">Regens HP · press <b>D</b> to detonate (splash).</div>` : ''}
          ${u.type === 'harvester' ? `<div class="hint">Press <b>H</b> or RMB spice to harvest.</div>` : ''}
        `;
        row.appendChild(ic);
        row.appendChild(text);
        info.appendChild(row);
        if (u.type === 'mcv' && u.owner === o && !game.spectator && !game.replay) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'game-btn primary';
          btn.dataset.deploy = '1';
          btn.dataset.unitId = String(u.id);
          btn.textContent = 'Deploy (E)';
          unitMenu.appendChild(btn);
        }
        if (u.type === 'saboteur' && u.owner === o && !game.spectator && !game.replay) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'game-btn danger';
          btn.dataset.detonate = '1';
          btn.dataset.unitId = String(u.id);
          btn.textContent = 'Detonate (D)';
          unitMenu.appendChild(btn);
        }
      } else if (buildings.length === 1 && !units.length) {
        const b = buildings[0];
        const def = D.config.buildings[b.type];
        const row = document.createElement('div');
        row.className = 'sel-row';
        const ic = D.Sprites.getIconCanvas(
          'building',
          b.type,
          48,
          ownerColor(b.owner)
        );
        ic.className = 'sel-icon';
        const text = document.createElement('div');
        text.innerHTML = `
          <div class="title">${def?.name || b.type}</div>
          <div class="meta">HP ${Math.ceil(b.hp)}/${b.hpMax}${
            b.buildProgress < 1 ? ` · Building ${Math.floor(b.buildProgress * 100)}%` : ''
          }</div>
          <div class="hp-bar"><span style="width:${(b.hp / b.hpMax) * 100}%"></span></div>
          ${
            D.config.features.recharge &&
            b.weapon &&
            b.weapon.ammoMax &&
            b.buildProgress >= 1
              ? `<div class="meta">Ammo ${Math.floor(b.weapon.ammo)}/${b.weapon.ammoMax}</div>
          <div class="hp-bar ammo-bar" title="Magazine recharge"><span style="width:${
            (Math.min(b.weapon.ammoMax, b.weapon.ammo) / b.weapon.ammoMax) * 100
          }%;background:var(--accent,#c9a227)"></span></div>`
              : ''
          }
        `;
        row.appendChild(ic);
        row.appendChild(text);
        info.appendChild(row);

        if (
          b.owner === o &&
          b.buildProgress >= 1 &&
          def?.produces &&
          def.produces.length &&
          !game.spectator &&
          !game.replay
        ) {
          const title = document.createElement('div');
          title.className = 'section-title';
          title.textContent = 'Produce';
          unitMenu.appendChild(title);
          const g = document.createElement('div');
          g.className = 'btn-grid';
          const produceTypes =
            D.Economy.produceList
              ? D.Economy.produceList(b.type, o)
              : (def.produces || []).filter((ut) => {
                  const ud = D.config.units[ut];
                  return ud && (!D.Seats || !D.Seats.allows || D.Seats.allows(o, ud));
                });
          for (const ut of produceTypes) {
            const udef = D.config.units[ut];
            if (!udef) continue;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'game-btn icon-btn';
            btn.dataset.produce = ut;
            btn.dataset.buildingId = String(b.id);
            btn.dataset.cost = String(udef.cost);
            const icon = D.Sprites.getIconCanvas('unit', ut, 36, myColor(game));
            icon.className = 'btn-icon';
            const label = document.createElement('span');
            label.className = 'btn-label';
            const can = D.Economy.canAfford(game, o, udef.cost);
            const houseTag =
              udef.houses && udef.houses.length
                ? ' · ' + (D.Seats && D.Seats.house ? D.Seats.house(o).name : 'special')
                : '';
            label.innerHTML = `<strong>${udef.name}</strong><span class="meta ${can ? '' : 'cant-afford'}">${udef.cost}¢ · ${udef.buildTime}s${houseTag}${can ? '' : ' — need credits'}</span>`;
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.disabled =
              game.phase !== 'playing' || !can || !!game.replay || !!game.spectator;
            const sticky =
              game.stickyProduce &&
              game.stickyProduce.buildingId === b.id &&
              game.stickyProduce.unitType === ut;
            btn.classList.toggle('active', !!sticky);
            btn.title =
              game.replay || game.spectator
                ? 'View only'
                : can
                  ? `Train ${udef.name} (${udef.cost} credits, ${udef.buildTime}s)` +
                    (sticky ? ' · selected (Q / click again)' : '')
                  : `Need ${udef.cost} credits (have ${Math.floor(game.credits[o])}, cap ${game.spiceCap[o]}). Build silos to raise cap.`;
            g.appendChild(btn);
          }
          unitMenu.appendChild(g);

          const q = document.createElement('div');
          q.className = 'meta';
          q.id = 'queue-status';
          q.dataset.buildingId = String(b.id);
          q.style.marginTop = '6px';
          if (b.buildQueue.length) {
            q.textContent =
              'Queue: ' +
              b.buildQueue
                .map(
                  (item, i) =>
                    `${D.config.units[item.type]?.name || item.type}${
                      i === 0 ? ` ${Math.floor(item.progress * 100)}%` : ''
                    }`
                )
                .join(', ');
          }
          unitMenu.appendChild(q);

          if (b.buildQueue.length) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'game-btn';
            cancel.dataset.cancelQueue = '1';
            cancel.dataset.buildingId = String(b.id);
            cancel.textContent = 'Cancel first (50% refund)';
            unitMenu.appendChild(cancel);
          }
          const hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = 'RMB on map sets rally point. Units train over time.';
          unitMenu.appendChild(hint);
        }
      } else if (units.length > 1 && !buildings.length) {
        D.UI.renderUnitGrid(game, info, units);
      } else if (units.length >= 1) {
        // Mixed selection: show unit grid + building count
        if (units.length) D.UI.renderUnitGrid(game, info, units);
        if (buildings.length) {
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.style.marginTop = '6px';
          meta.textContent =
            buildings.length +
            ' building' +
            (buildings.length > 1 ? 's' : '') +
            ' also selected';
          info.appendChild(meta);
        }
      } else {
        info.innerHTML = `<div class="title">${units.length} units, ${buildings.length} buildings</div>
          <div class="meta">Ctrl+1-9 assign group · 1-9 recall</div>`;
      }
    },

    /**
     * Portrait grid for multi-unit selection.
     * Click = select only that unit; Ctrl/⌘+click = toggle in group.
     */
    renderUnitGrid(game, info, units) {
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = units.length + ' units selected';
      info.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'sel-unit-grid';
      const sorted = units.slice().sort((a, b) => {
        if (a.type !== b.type) return a.type < b.type ? -1 : 1;
        return a.id - b.id;
      });
      for (const u of sorted) {
        const def = D.config.units[u.type];
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'sel-unit-cell is-selected';
        cell.dataset.unitId = String(u.id);
        cell.title =
          (def?.name || u.type) +
          ' #' +
          u.id +
          ' — click: select only · Ctrl+click: toggle';
        const ic = D.Sprites.getIconCanvas('unit', u.type, 36, ownerColor(u.owner));
        cell.appendChild(ic);
        const hp = document.createElement('div');
        hp.className = 'sel-unit-hp';
        const fill = document.createElement('span');
        fill.style.width = Math.max(0, Math.min(100, (u.hp / u.hpMax) * 100)) + '%';
        if (u.hp / u.hpMax < 0.35) fill.style.background = 'var(--danger)';
        else if (u.hp / u.hpMax < 0.7) fill.style.background = 'var(--accent)';
        hp.appendChild(fill);
        cell.appendChild(hp);
        const nm = document.createElement('div');
        nm.className = 'sel-unit-name';
        nm.textContent = def?.name || u.type;
        cell.appendChild(nm);
        cell.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (game.replay) return; // allow spectator re-select within grid
          const id = u.id;
          const ctrl = !!(e.ctrlKey || e.metaKey);
          if (ctrl) {
            const set = new Set(game.selection.ids);
            if (set.has(id)) set.delete(id);
            else set.add(id);
            game.selection.ids = [...set];
          } else {
            game.selection.ids = [id];
          }
          lastSelSig = '';
          D.UI.renderSelection(game);
          D.UI.refresh(game);
        });
        grid.appendChild(cell);
      }
      info.appendChild(grid);
      const hint = document.createElement('div');
      hint.className = 'sel-unit-hint';
      hint.innerHTML =
        'Click portrait = that unit only · <b>Ctrl+click</b> toggle · then move/attack as usual';
      info.appendChild(hint);
    },

    updateDebug(game) {
      if (!els.debug || !els.debug.classList.contains('visible')) return;
      const o = me(game);
      const st = game.stats || {};
      const pm = D.Path && D.Path.metrics;
      els.debug.textContent = [
        `fps ${game.stats.fps | 0}  sim ${game.stats.simMs.toFixed(2)}ms`,
        `tick ${game.tick}  phase ${game.phase}  me=${o}`,
        `units ${game.units.length}  bld ${game.buildings.length}`,
        `credits ${game.credits[o] | 0}/${game.spiceCap[o]}`,
        `power ${game.power[o].prod}/${game.power[o].need} r=${game.power[o].ratio.toFixed(2)}`,
        game.multiplayer
          ? `mp ${game.netRole} room ${game.roomCode || D.Net?.room || '?'} peers ${D.Net?.peers || 0}`
          : `ai ${game.ai.state}  repaths ${game._repathsThisTick || 0}`,
        `path issue ${((st.pathLastIssueMs || 0)).toFixed(2)}ms n=${st.pathLastIssueCount || 0} ok=${st.pathLastIssueOk || 0} via=${st.pathLastBackend || '?'}`,
        st.pathLastBackend === 'flow'
          ? `path flow  build ${((st.pathLastFlowBuildMs || 0)).toFixed(2)}ms`
          : '',
        `path tick  ${((st.pathTickMs || 0)).toFixed(2)}ms n=${st.pathTickCount || 0} repaths=${game._repathsThisTick || 0}`,
        pm
          ? `path life  A*=${pm.finds} flowBuilds=${pm.flowBuilds || 0} maxA*=${pm.maxMs.toFixed(2)}ms`
          : '',
        `cam ${game.camera.x | 0},${game.camera.y | 0}`,
        D.Save && D.Save.has() ? 'save: yes' : 'save: no',
      ]
        .filter(Boolean)
        .join('\n');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
