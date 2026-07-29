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
    return ids + extra;
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
        pauseModal: $('pause-modal'),
        endModal: $('end-modal'),
        debug: $('debug-overlay'),
        btnContinue: $('btn-continue'),
      };

      // Event delegation — survive DOM rebuilds; never lose clicks mid-frame
      els.unitMenu?.addEventListener('click', (e) => {
        const produceBtn = e.target.closest('[data-produce]');
        if (produceBtn && !produceBtn.disabled) {
          e.preventDefault();
          e.stopPropagation();
          const buildingId = Number(produceBtn.dataset.buildingId);
          const unitType = produceBtn.dataset.produce;
          const r = D.Economy.enqueueUnit(game, buildingId, unitType);
          if (!r.ok) {
            const msg =
              r.reason === 'credits'
                ? 'Not enough credits'
                : r.reason === 'queue'
                  ? 'Production queue full'
                  : r.reason === 'building'
                    ? 'Factory not ready'
                    : 'Cannot train: ' + r.reason;
            D.Game.pushMessage(game, msg);
          } else {
            const name = D.config.units[unitType]?.name || unitType;
            D.Game.pushMessage(game, 'Training ' + name);
            lastSelSig = ''; // force panel refresh to show queue
            D.UI.refresh(game);
            if (D.Save) D.Save.write(game);
          }
          return;
        }
        const cancelBtn = e.target.closest('[data-cancel-queue]');
        if (cancelBtn) {
          e.preventDefault();
          e.stopPropagation();
          D.Economy.cancelQueue(game, Number(cancelBtn.dataset.buildingId), 0);
          lastSelSig = '';
          D.UI.refresh(game);
          return;
        }
        const deployBtn = e.target.closest('[data-deploy]');
        if (deployBtn) {
          e.preventDefault();
          D.Orders.issue(game, [Number(deployBtn.dataset.unitId)], { type: 'deploy' });
          lastSelSig = '';
          D.UI.refresh(game);
        }
      });

      // Don't let sidebar clicks clear map selection / start box-select
      const sidebar = $('sidebar');
      sidebar?.addEventListener('mousedown', (e) => e.stopPropagation());

      $('btn-start')?.addEventListener('click', () => {
        if (D.Save) D.Save.clear();
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
        lastSelSig = '';
        D.UI.hideMenu();
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
        if (D.Save) D.Save.write(game);
      });

      $('btn-continue')?.addEventListener('click', () => {
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

      $('btn-resume')?.addEventListener('click', () => {
        game.phase = 'playing';
        D.UI.showPause(false);
        if (D.Save) D.Save.write(game);
      });

      $('btn-restart')?.addEventListener('click', () => {
        D.UI.showPause(false);
        if (D.Save) D.Save.clear();
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
        lastSelSig = '';
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
      });

      $('btn-end-restart')?.addEventListener('click', () => {
        els.endModal.classList.add('hidden');
        if (D.Save) D.Save.clear();
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
        lastSelSig = '';
        D.UI.refresh(game);
        D.Renderer.rebuildTerrain(game);
      });

      $('btn-end-menu')?.addEventListener('click', () => {
        els.endModal.classList.add('hidden');
        game.phase = 'menu';
        if (D.Save) D.Save.clear();
        D.UI.updateContinueButton();
        D.UI.showMenu();
      });

      D.UI.buildStructureButtons(game);
      D.UI.updateContinueButton();
      D.UI.showMenu();
    },

    updateContinueButton() {
      const btn = els.btnContinue || $('btn-continue');
      if (!btn) return;
      const ok = D.Save && D.Save.has();
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

    showPause(show) {
      if (!els.pauseModal) return;
      if (show) els.pauseModal.classList.remove('hidden');
      else els.pauseModal.classList.add('hidden');
    },

    showEnd(game) {
      if (!els.endModal) return;
      const modal = els.endModal;
      modal.classList.remove('hidden');
      modal.querySelector('.modal').classList.toggle('victory', game.phase === 'victory');
      modal.querySelector('.modal').classList.toggle('defeat', game.phase === 'defeat');
      const h2 = modal.querySelector('h2');
      const p = modal.querySelector('p');
      if (game.phase === 'victory') {
        h2.textContent = 'Victory';
        p.textContent = 'The Emperor acknowledges your control of Arrakis.';
      } else {
        h2.textContent = 'Defeat';
        p.textContent = 'Your base has fallen. The spice must flow… elsewhere.';
      }
      if (D.Save) D.Save.clear();
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
          D.config.colors.player
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
          if (!D.Economy.hasTech(game, 'player', def.requires)) {
            D.Game.pushMessage(game, 'Requires ' + (def.requires || 'tech'));
            return;
          }
          if (game.structureBuilder?.player != null) {
            const busy = game.buildings.find((b) => b.id === game.structureBuilder.player);
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

      const c = Math.floor(game.credits.player);
      const cap = game.spiceCap.player;
      els.credits.textContent = `${c} / ${cap}`;
      const p = game.power.player;
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
          const tech = D.Economy.hasTech(game, 'player', def.requires);
          const hasCY = game.buildings.some(
            (b) =>
              b.owner === 'player' &&
              b.type === 'constructionYard' &&
              b.buildProgress >= 1
          );
          const busy =
            game.structureBuilder?.player != null &&
            game.buildings.some(
              (b) => b.id === game.structureBuilder.player && b.buildProgress < 1
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
        // keep produce affordability in sync without rebuild
        D.UI.syncProduceAffordability(game);
        D.UI.syncQueueProgress(game);
      }

      if (game.phase === 'victory' || game.phase === 'defeat') {
        if (els.endModal?.classList.contains('hidden')) D.UI.showEnd(game);
      }
    },

    /** Force selection panel rebuild (e.g. after click select) */
    invalidateSelection() {
      lastSelSig = '';
    },

    syncProduceAffordability(game) {
      if (!els.unitMenu) return;
      for (const btn of els.unitMenu.querySelectorAll('[data-produce]')) {
        const cost = Number(btn.dataset.cost || 0);
        btn.disabled = game.phase !== 'playing' || !D.Economy.canAfford(game, 'player', cost);
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
          <div class="meta">${u.owner} · HP ${Math.ceil(u.hp)}/${u.hpMax}</div>
          <div class="hp-bar"><span style="width:${(u.hp / u.hpMax) * 100}%"></span></div>
          ${u.type === 'harvester' ? `<div class="meta">Cargo ${Math.floor(u.cargo)}/${u.cargoMax}</div>` : ''}
          ${u.type === 'mcv' ? `<div class="hint">Press <b>E</b> to deploy Construction Yard on rock.</div>` : ''}
          ${u.type === 'harvester' ? `<div class="hint">Press <b>H</b> or RMB spice to harvest.</div>` : ''}
        `;
        row.appendChild(ic);
        row.appendChild(text);
        info.appendChild(row);
        if (u.type === 'mcv') {
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

        if (b.buildProgress >= 1 && def?.produces && def.produces.length) {
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
            const icon = D.Sprites.getIconCanvas(
              'unit',
              ut,
              36,
              D.config.colors.player
            );
            icon.className = 'btn-icon';
            const label = document.createElement('span');
            label.className = 'btn-label';
            const can = D.Economy.canAfford(game, 'player', udef.cost);
            label.innerHTML = `<strong>${udef.name}</strong><span class="meta ${can ? '' : 'cant-afford'}">${udef.cost}¢ · ${udef.buildTime}s${can ? '' : ' — need credits'}</span>`;
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.disabled = game.phase !== 'playing' || !can;
            btn.title = can
              ? `Train ${udef.name} (${udef.cost} credits, ${udef.buildTime}s)`
              : `Need ${udef.cost} credits (have ${Math.floor(game.credits.player)}, cap ${game.spiceCap.player}). Build silos to raise cap.`;
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
      els.debug.textContent = [
        `fps ${game.stats.fps | 0}  sim ${game.stats.simMs.toFixed(2)}ms`,
        `tick ${game.tick}  phase ${game.phase}`,
        `units ${game.units.length}  bld ${game.buildings.length}`,
        `credits ${game.credits.player | 0}/${game.spiceCap.player}`,
        `power ${game.power.player.prod}/${game.power.player.need} r=${game.power.player.ratio.toFixed(2)}`,
        `ai ${game.ai.state}  repaths ${game._repathsThisTick || 0}`,
        `cam ${game.camera.x | 0},${game.camera.y | 0}`,
        D.Save && D.Save.has() ? 'save: yes' : 'save: no',
      ].join('\n');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
