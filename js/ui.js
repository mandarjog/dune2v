/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  let els = {};
  /** Last selection panel signature — avoid nuking produce buttons every frame */
  let lastSelSig = '';
  let boundGame = null;

  function $(id) {
    return document.getElementById(id);
  }

  function me(game) {
    return D.Game.me(game);
  }

  function myColor(game) {
    return me(game) === 'player' ? D.config.colors.player : D.config.colors.enemy;
  }

  function ownerColor(owner) {
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
      extra = `|b${b.id}|${b.type}|${Math.floor(b.buildProgress * 100)}|q${q}|hp${Math.ceil(b.hp)}`;
    } else if (units.length === 1 && !buildings.length) {
      const u = units[0];
      extra = `|u${u.id}|${u.type}|hp${Math.ceil(u.hp)}|c${Math.floor(u.cargo || 0)}`;
    } else {
      extra = `|m${units.length}:${buildings.length}`;
    }
    return ids + extra + '|' + me(game);
  }

  function houseLabel(owner) {
    return owner === 'player' ? 'Atreides (blue)' : 'Harkonnen (red)';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  D.UI = {
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
          let r;
          if (D.Net) {
            r = D.Net.command(game, { op: 'produce', buildingId, unitType });
          } else {
            r = D.Economy.enqueueUnit(game, buildingId, unitType);
          }
          if (r && r.ok) {
            const name = D.config.units[unitType]?.name || unitType;
            D.Game.pushMessage(game, 'Training ' + name);
            lastSelSig = '';
            D.UI.refresh(game);
            if (D.Save && !game.multiplayer) D.Save.write(game);
          } else if (r && !r.deferred) {
            const msg =
              r.reason === 'credits'
                ? 'Not enough credits'
                : r.reason === 'queue'
                  ? 'Production queue full'
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
            D.Orders.issue(game, [id], { type: 'deploy' });
          }
          lastSelSig = '';
          D.UI.refresh(game);
        }
      });

      // Don't let sidebar clicks clear map selection / start box-select
      const sidebar = $('sidebar');
      sidebar?.addEventListener('mousedown', (e) => e.stopPropagation());

      $('btn-start')?.addEventListener('click', () => {
        if (game.multiplayer && D.Net) D.Net.leave();
        game.multiplayer = false;
        game.localOwner = 'player';
        game.netRole = null;
        D.config.features.ai = true;
        if (D.Save) D.Save.clear();
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
        lastSelSig = '';
        D.UI.hideMenu();
        D.UI.hideLobby();
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
        if (D.Save) D.Save.write(game);
      });

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

      $('btn-mp-host')?.addEventListener('click', () => {
        if (!D.Net) return;
        const name = els.mpNameInput ? els.mpNameInput.value : undefined;
        D.UI.hideMenu();
        D.UI.showLobby('Creating room…');
        D.Net.host(name);
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
        D.UI.hideMenu();
        D.UI.showLobby('Joining room…');
        D.Net.join(code, name);
      });

      $('btn-join-go')?.addEventListener('click', () => {
        if (!D.Net || !D.UI._pendingJoinRoom) return;
        const nameEl = els.joinNameInput || $('join-name-input');
        const name = nameEl ? nameEl.value : undefined;
        // Keep menu name field in sync
        if (els.mpNameInput && nameEl) els.mpNameInput.value = nameEl.value;
        D.UI.hideJoinPrompt();
        D.UI.hideMenu();
        D.UI.showLobby('Joining room ' + D.UI._pendingJoinRoom + '…');
        D.Net.join(D.UI._pendingJoinRoom, name);
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

      $('btn-lobby-copy')?.addEventListener('click', async () => {
        const url = D.Net && D.Net.roomUrl();
        if (!url) return;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
            D.Game.pushMessage(game, 'Room link copied.');
          } else {
            const el = els.lobbyLink;
            if (el) {
              el.focus();
              el.select();
              document.execCommand('copy');
              D.Game.pushMessage(game, 'Room link copied.');
            }
          }
        } catch (err) {
          D.Game.pushMessage(game, 'Copy failed — select the link manually.');
        }
        D.UI.refreshLobby();
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
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
        lastSelSig = '';
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
      });

      $('btn-end-restart')?.addEventListener('click', () => {
        els.endModal.classList.add('hidden');
        if (game.multiplayer) {
          if (D.Net) D.Net.leave();
          game.multiplayer = false;
          game.localOwner = 'player';
          D.config.features.ai = true;
          D.UI.showMenu();
          return;
        }
        if (D.Save) D.Save.clear();
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
        lastSelSig = '';
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
      });

      $('btn-end-menu')?.addEventListener('click', () => {
        els.endModal.classList.add('hidden');
        game.phase = 'menu';
        if (game.multiplayer && D.Net) D.Net.leave();
        game.multiplayer = false;
        game.localOwner = 'player';
        D.config.features.ai = true;
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
            ev === 'status'
          ) {
            D.UI.refreshLobby();
          }
          if (ev === 'match_started') {
            D.UI.hideLobby();
            D.UI.hideMenu();
            lastSelSig = '';
            D.UI.refreshMatchup(game);
            D.UI.refresh(game);
          }
          if (ev === 'error') {
            const err = (data && data.error) || D.Net.lastError || 'error';
            const map = {
              room_full: 'That room is full (2 players).',
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

    refreshLobby() {
      if (!els.lobbyModal || !D.Net) return;
      const code = D.Net.room || '—';
      const url = D.Net.roomUrl() || '';
      if (els.lobbyCode) els.lobbyCode.textContent = code;
      if (els.lobbyLink) {
        els.lobbyLink.value = url;
      }
      if (els.lobbyRoster) {
        const seats = D.Net.seats || {};
        const rows = [];
        const renderSeat = (seat, house, css) => {
          const info = seats[seat];
          const name = (info && info.name) || (seat === D.Net.seat ? D.Net.name : null);
          const you = seat === D.Net.seat;
          const online = info && info.connected !== false;
          if (name) {
            const tag = you ? ' (you)' : online ? '' : ' (offline)';
            rows.push(
              `<div class="seat-row"><span class="seat-house">${house}</span>` +
                `<span class="seat-name ${css}${you ? ' you' : ''}${
                  online ? '' : ' offline'
                }">${escapeHtml(name)}${tag}</span></div>`
            );
          } else {
            rows.push(
              `<div class="seat-row"><span class="seat-house">${house}</span>` +
                `<span class="empty">waiting…</span></div>`
            );
          }
        };
        renderSeat('player', 'Atreides · blue', 'atreides');
        renderSeat('enemy', 'Harkonnen · red', 'harkonnen');
        els.lobbyRoster.innerHTML = rows.join('');
      }
      if (els.lobbySeat) {
        if (D.Net.seat) {
          els.lobbySeat.textContent =
            'Playing as ' +
            houseLabel(D.Net.seat) +
            (D.Net.role === 'host' ? ' · room host' : '');
        } else {
          els.lobbySeat.textContent = '';
        }
      }
      if (els.lobbyStatus) {
        if (D.Net.status === 'connecting') {
          els.lobbyStatus.textContent = 'Connecting…';
        } else if (D.Net.status === 'lobby') {
          const n = D.Net.peers || 1;
          if (n < 2) {
            els.lobbyStatus.textContent =
              'Waiting for opponent… share the link below. Real-time match starts when they join.';
          } else {
            els.lobbyStatus.textContent = 'Both commanders ready — starting match…';
          }
        } else if (D.Net.status === 'playing') {
          els.lobbyStatus.textContent = 'Match in progress.';
        } else if (D.Net.lastError) {
          els.lobbyStatus.textContent = D.Net.lastError;
        }
      }
    },

    refreshMatchup(game) {
      const el = els.mpMatchup || $('mp-matchup');
      if (!el) return;
      if (!game.multiplayer) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
      }
      const names = game.playerNames || {
        player: D.Net ? D.Net.nameFor('player') : 'Atreides',
        enemy: D.Net ? D.Net.nameFor('enemy') : 'Harkonnen',
      };
      const local = me(game);
      const a = escapeHtml(names.player || 'Atreides');
      const h = escapeHtml(names.enemy || 'Harkonnen');
      el.innerHTML =
        `<span class="${local === 'player' ? 'you' : ''}">${a}</span>` +
        ` <span style="opacity:.5">vs</span> ` +
        `<span class="${local === 'enemy' ? 'you' : ''}">${h}</span>`;
      el.classList.remove('hidden');
    },

    showPause(show) {
      if (!els.pauseModal) return;
      if (show) els.pauseModal.classList.remove('hidden');
      else els.pauseModal.classList.add('hidden');
    },

    showEnd(game) {
      if (!els.endModal) return;
      const modal = els.endModal;
      modal.classList.remove('hidden');
      const local = D.Game.localEndPhase(game);
      modal.querySelector('.modal').classList.toggle('victory', local === 'victory');
      modal.querySelector('.modal').classList.toggle('defeat', local === 'defeat');
      const h2 = modal.querySelector('h2');
      const p = modal.querySelector('p');
      const names = game.playerNames;
      const myName =
        (names && names[D.Game.me(game)]) ||
        (D.Net && D.Net.name) ||
        'Commander';
      const foeName =
        (names && names[D.Game.foe(game)]) ||
        (D.Net && D.Net.nameFor(D.Game.foe(game))) ||
        'Opponent';
      if (local === 'victory') {
        h2.textContent = 'Victory';
        p.textContent = game.multiplayer
          ? myName + ' defeats ' + foeName + '. The Emperor acknowledges your control of Arrakis.'
          : 'The Emperor acknowledges your control of Arrakis.';
      } else {
        h2.textContent = 'Defeat';
        p.textContent = game.multiplayer
          ? foeName + ' triumphs over ' + myName + '. The spice must flow… elsewhere.'
          : 'Your base has fallen. The spice must flow… elsewhere.';
      }
      if (D.Save && !game.multiplayer) D.Save.clear();
    },

    buildStructureButtons(game) {
      const root = els.buildMenu;
      if (!root) return;
      root.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'section-title';
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
        'wall',
        'radar',
      ];
      for (const type of order) {
        const def = D.config.buildings[type];
        if (!def || !def.buildable) continue;
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
        btn.title = `${def.name} — ${def.cost} credits`;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (game.phase !== 'playing') return;
          const o = me(game);
          if (!D.Economy.hasTech(game, o, def.requires)) {
            D.Game.pushMessage(game, 'Requires ' + (def.requires || 'tech'));
            return;
          }
          if (game.structureBuilder?.[o] != null) {
            const busy = game.buildings.find((b) => b.id === game.structureBuilder[o]);
            if (busy && busy.buildProgress < 1) {
              D.Game.pushMessage(game, 'Already constructing…');
              return;
            }
          }
          D.Input.startPlacement(game, type);
          D.Game.pushMessage(game, 'Place ' + def.name);
        });
        grid.appendChild(btn);
      }
    },

    /** Lightweight HUD update; rebuild selection panel only when needed */
    refresh(game) {
      if (!els.credits) return;
      const o = me(game);
      D.UI.refreshMatchup(game);

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

      // structure buttons enable/disable only
      const grid = $('structure-btns');
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
          const busy =
            game.structureBuilder?.[o] != null &&
            game.buildings.some(
              (b) => b.id === game.structureBuilder[o] && b.buildProgress < 1
            );
          btn.disabled = !tech || !hasCY || busy || game.phase !== 'playing';
          btn.classList.toggle('active', game.placement && game.placement.type === type);
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

      if (game.phase === 'victory' || game.phase === 'defeat') {
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
        btn.disabled = game.phase !== 'playing' || !D.Economy.canAfford(game, o, cost);
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
          ${u.type === 'harvester' ? `<div class="meta">Cargo ${Math.floor(u.cargo)}/${u.cargoMax}</div>` : ''}
          ${u.type === 'mcv' ? `<div class="hint">Press <b>E</b> to deploy Construction Yard on rock.</div>` : ''}
          ${u.type === 'harvester' ? `<div class="hint">Press <b>H</b> or RMB spice to harvest.</div>` : ''}
        `;
        row.appendChild(ic);
        row.appendChild(text);
        info.appendChild(row);
        if (u.type === 'mcv' && u.owner === o) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'game-btn primary';
          btn.dataset.deploy = '1';
          btn.dataset.unitId = String(u.id);
          btn.textContent = 'Deploy (E)';
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
        `;
        row.appendChild(ic);
        row.appendChild(text);
        info.appendChild(row);

        if (b.owner === o && b.buildProgress >= 1 && def?.produces && def.produces.length) {
          const title = document.createElement('div');
          title.className = 'section-title';
          title.textContent = 'Produce';
          unitMenu.appendChild(title);
          const g = document.createElement('div');
          g.className = 'btn-grid';
          for (const ut of def.produces) {
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
            label.innerHTML = `<strong>${udef.name}</strong><span class="meta ${can ? '' : 'cant-afford'}">${udef.cost}¢ · ${udef.buildTime}s${can ? '' : ' — need credits'}</span>`;
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.disabled = game.phase !== 'playing' || !can;
            btn.title = can
              ? `Train ${udef.name} (${udef.cost} credits, ${udef.buildTime}s)`
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
      } else {
        info.innerHTML = `<div class="title">${units.length} units, ${buildings.length} buildings</div>
          <div class="meta">Ctrl+1-9 assign group · 1-9 recall</div>`;
      }
    },

    updateDebug(game) {
      if (!els.debug || !els.debug.classList.contains('visible')) return;
      const o = me(game);
      els.debug.textContent = [
        `fps ${game.stats.fps | 0}  sim ${game.stats.simMs.toFixed(2)}ms`,
        `tick ${game.tick}  phase ${game.phase}  me=${o}`,
        `units ${game.units.length}  bld ${game.buildings.length}`,
        `credits ${game.credits[o] | 0}/${game.spiceCap[o]}`,
        `power ${game.power[o].prod}/${game.power[o].need} r=${game.power[o].ratio.toFixed(2)}`,
        game.multiplayer
          ? `mp ${game.netRole} room ${game.roomCode || D.Net?.room || '?'} peers ${D.Net?.peers || 0}`
          : `ai ${game.ai.state}  repaths ${game._repathsThisTick || 0}`,
        `cam ${game.camera.x | 0},${game.camera.y | 0}`,
        D.Save && D.Save.has() ? 'save: yes' : 'save: no',
      ].join('\n');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
