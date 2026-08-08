/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const keys = Object.create(null);
  let canvas = null;
  let minimap = null;
  let gameRef = null;
  let dragging = false;
  let dragStart = null;
  let panKeys = { left: false, right: false, up: false, down: false };
  let lastClick = { t: 0, id: null };
  const PAN_SPEED = 480; // px/sec

  function me(game) {
    return D.Game.me(game);
  }
  function foe(game) {
    return D.Game.foe(game);
  }

  function canvasPos(e, el) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function selectedUnits(game) {
    const o = me(game);
    return game.units.filter((u) => game.selection.ids.includes(u.id) && u.owner === o);
  }

  function selectedBuildings(game) {
    const o = me(game);
    return game.buildings.filter(
      (b) => game.selection.ids.includes(b.id) && b.owner === o
    );
  }

  function issueOrder(game, ids, order) {
    if (game && (game.replay || game.spectator)) {
      return { ok: false, reason: game.spectator ? 'spectator' : 'replay' };
    }
    if (D.Net) return D.Net.command(game, { op: 'order', ids, order });
    D.Orders.issue(game, ids, order);
    return { ok: true };
  }

  function issueStop(game, ids) {
    if (game && (game.replay || game.spectator)) {
      return { ok: false, reason: game.spectator ? 'spectator' : 'replay' };
    }
    if (D.Net) return D.Net.command(game, { op: 'stop', ids });
    D.Orders.stop(game, ids);
    return { ok: true };
  }

  function pickAt(game, wx, wy) {
    const o = me(game);
    const fullView = !!(game.replay || game.spectator || !D.Map.fogVisible(game));
    // units first (topmost by id)
    let bestU = null;
    let bestD = 0.55;
    for (const u of game.units) {
      if (
        !fullView &&
        u.owner !== o &&
        !D.Map.isVisible(game, o, Math.floor(u.x), Math.floor(u.y))
      )
        continue;
      const d = Math.hypot(u.x - wx, u.y - wy);
      if (d < bestD) {
        bestD = d;
        bestU = u;
      }
    }
    if (bestU) return { kind: 'unit', entity: bestU };

    for (const b of game.buildings) {
      if (b.type === 'concrete') continue;
      if (
        !fullView &&
        b.owner !== o &&
        !D.Map.isExplored(
          game,
          o,
          Math.floor(b.tileX + b.tileW / 2),
          Math.floor(b.tileY + b.tileH / 2)
        )
      )
        continue;
      if (
        wx >= b.tileX &&
        wy >= b.tileY &&
        wx < b.tileX + b.tileW &&
        wy < b.tileY + b.tileH
      ) {
        return { kind: 'building', entity: b };
      }
    }
    return null;
  }

  D.Input = {
    init(game, gameCanvas, minimapCanvas) {
      gameRef = game;
      canvas = gameCanvas;
      minimap = minimapCanvas;

      window.addEventListener('keydown', (e) => {
        keys[e.code] = true;
        D.Input.onKeyDown(game, e);
      });
      window.addEventListener('keyup', (e) => {
        keys[e.code] = false;
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') panKeys.left = false;
        if (e.code === 'ArrowRight' || e.code === 'KeyD') panKeys.right = false;
        if (e.code === 'ArrowUp' || e.code === 'KeyW') panKeys.up = false;
        if (e.code === 'ArrowDown' || e.code === 'KeyS') panKeys.down = false;
      });

      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('mousedown', (e) => D.Input.onMouseDown(game, e));
      canvas.addEventListener('mousemove', (e) => D.Input.onMouseMove(game, e));
      canvas.addEventListener('mouseup', (e) => D.Input.onMouseUp(game, e));
      // Middle-click / some trackpads
      canvas.addEventListener('auxclick', (e) => {
        if (game.phase !== 'playing') return;
        if (e.button === 1) {
          e.preventDefault();
          D.Input.rightClick(game, canvasPos(e, canvas), e);
        }
      });
      canvas.addEventListener('mouseleave', () => {
        dragging = false;
        game.selection.box = null;
      });

      if (minimap) {
        minimap.addEventListener('mousedown', (e) => D.Input.onMinimap(game, e));
        minimap.addEventListener('mousemove', (e) => {
          if (e.buttons === 1) D.Input.onMinimap(game, e);
        });
      }

      window.addEventListener('resize', () => {
        if (D.Renderer) D.Renderer.resize();
      });
    },

    poll(game, dt) {
      if (
        game.phase !== 'playing' &&
        game.phase !== 'paused' &&
        !game.replay &&
        !game.spectator
      )
        return;
      const speed = PAN_SPEED * dt;
      // Only panKeys (not raw keys.KeyA/S) so A/S unit orders never slide the camera
      if (panKeys.left || keys.ArrowLeft) game.camera.x -= speed;
      if (panKeys.right || keys.ArrowRight) game.camera.x += speed;
      if (panKeys.up || keys.ArrowUp) game.camera.y -= speed;
      if (panKeys.down || keys.ArrowDown) game.camera.y += speed;
      if (D.Renderer) D.Renderer.clampCamera(game);
    },

    /** Unit selected and can receive orders (A/S should not pan). */
    wantsUnitCommand(game) {
      if (!game || game.replay || game.spectator) return false;
      if (game.phase !== 'playing') return false;
      if (D.Input.isEliminatedLocal && D.Input.isEliminatedLocal(game)) return false;
      return selectedUnits(game).length > 0;
    },

    /** True when local seat has been eliminated mid-FFA (view only). */
    isEliminatedLocal(game) {
      if (!game || game.spectator || game.replay) return false;
      const me = D.Game.me(game);
      return !!(game.eliminated && game.eliminated[me] != null);
    },

    /** True when viewer must not issue orders / place buildings. */
    isSpectator(game) {
      return !!(
        game &&
        (game.replay || game.spectator || D.Input.isEliminatedLocal(game))
      );
    },

    onKeyDown(game, e) {
      // Don't steal typing from chat / feedback / name fields
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) {
        if (e.code === 'Escape' && e.target.blur) e.target.blur();
        return;
      }

      // Camera: arrows always. WASD pans only when not used as RTS unit keys.
      // Standard RTS: A=attack-move, S=stop — those win when units are selected.
      const unitCmd = D.Input.wantsUnitCommand(game);
      if (e.code === 'ArrowLeft') panKeys.left = true;
      if (e.code === 'ArrowRight') panKeys.right = true;
      if (e.code === 'ArrowUp') panKeys.up = true;
      if (e.code === 'ArrowDown') panKeys.down = true;
      if (e.code === 'KeyA' && !unitCmd) panKeys.left = true;
      if (e.code === 'KeyD') panKeys.right = true;
      if (e.code === 'KeyW') panKeys.up = true;
      if (e.code === 'KeyS' && !unitCmd) panKeys.down = true;

      // Live spectate: camera + leave only (no orders / build)
      if (game.spectator && !game.replay) {
        if (e.code === 'Escape') {
          e.preventDefault();
          if (D.UI && D.UI.isHelpOpen && D.UI.isHelpOpen()) {
            D.UI.hideHelp();
            return;
          }
          if (D.Net) D.Net.leave();
          game.spectator = false;
          game.multiplayer = false;
          game.phase = 'menu';
          if (D.UI) {
            if (D.UI.hideEnd) D.UI.hideEnd();
            D.UI.setChatVisible && D.UI.setChatVisible(false);
            D.UI.setMpSpeedVisible && D.UI.setMpSpeedVisible(false);
            D.UI.showMenu();
          }
          try {
            const u = new URL(location.href);
            u.searchParams.delete('spectate');
            u.searchParams.delete('live');
            history.replaceState(null, '', u.pathname + u.search + u.hash);
          } catch (err) {
            /* ignore */
          }
          return;
        }
        if (e.key === '?' || (e.code === 'Slash' && e.shiftKey) || e.code === 'Slash') {
          e.preventDefault();
          if (D.UI) D.UI.showHelp();
        }
        return;
      }

      // Replay: camera + transport controls only (no orders / build)
      if (game.replay && D.Replay) {
        if (e.code === 'Space') {
          e.preventDefault();
          const on = D.Replay.togglePause();
          const b = document.getElementById('btn-replay-pause');
          if (b) b.textContent = on ? 'Pause' : 'Play';
          D.Game.pushMessage(game, on ? 'Replay playing' : 'Replay paused');
          return;
        }
        if (
          e.code === 'BracketLeft' ||
          e.key === '-' ||
          e.code === 'Minus' ||
          e.code === 'NumpadSubtract'
        ) {
          D.Replay.setSpeed(Math.max(0.25, D.Replay.speed / 2));
          D.Game.pushMessage(game, 'Replay ' + D.Replay.speed + '×');
          if (D.UI) D.UI.refreshSpeedHud(game);
          e.preventDefault();
          return;
        }
        if (
          e.code === 'BracketRight' ||
          e.key === '+' ||
          e.code === 'Equal' ||
          e.code === 'NumpadAdd'
        ) {
          D.Replay.setSpeed(Math.min(8, D.Replay.speed * 2));
          D.Game.pushMessage(game, 'Replay ' + D.Replay.speed + '×');
          if (D.UI) D.UI.refreshSpeedHud(game);
          e.preventDefault();
          return;
        }
        if (e.code === 'Escape') {
          e.preventDefault();
          D.Replay.stop(game);
          if (D.UI) {
            if (D.UI.hideEnd) D.UI.hideEnd();
            D.UI.showMenu();
          }
          return;
        }
        if (e.key === '?' || (e.code === 'Slash' && e.shiftKey) || e.code === 'Slash') {
          e.preventDefault();
          if (D.UI) D.UI.showHelp();
        }
        return;
      }

      if (e.code === 'Escape') {
        e.preventDefault();
        // Close topmost modal first — never treat Esc-in-help as quit
        if (D.UI && D.UI.isHelpOpen && D.UI.isHelpOpen()) {
          D.UI.hideHelp();
          return;
        }
        if (D.UI && D.UI.isFeedbackOpen && D.UI.isFeedbackOpen()) {
          D.UI.hideFeedback();
          return;
        }
        if (game.placement) {
          game.placement = null;
          D.Game.pushMessage(game, 'Placement cancelled.');
          return;
        }
        if (game.stickyProduce) {
          game.stickyProduce = null;
          if (D.UI) {
            D.UI.invalidateSelection();
            D.UI.refresh(game);
          }
          D.Game.pushMessage(game, 'Unit type cleared.');
          return;
        }
        // Multiplayer: no pause (desyncs host clock)
        if (game.multiplayer) {
          return;
        }
        if (game.phase === 'playing') {
          game.phase = 'paused';
          if (D.Save) D.Save.write(game);
          if (D.UI) D.UI.showPause(true);
        } else if (game.phase === 'paused') {
          game.phase = 'playing';
          if (D.UI) D.UI.showPause(false);
        }
        return;
      }

      if (game.phase !== 'playing') return;

      // Confirm structure placement at tile under cursor (Space / Enter / F)
      // Shift = one-shot (clear type after place); default keeps type selected
      if (
        game.placement &&
        (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF')
      ) {
        e.preventDefault();
        D.Input.confirmPlacement(game, e.shiftKey);
        return;
      }

      // Q — re-queue last trained unit type (sticky produce)
      if (e.code === 'KeyQ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (D.Input.repeatStickyProduce(game)) {
          e.preventDefault();
          return;
        }
      }

      // Help
      if (e.key === '?' || (e.code === 'Slash' && e.shiftKey) || e.code === 'Slash') {
        // bare / also opens help when not chatting
        e.preventDefault();
        if (D.UI) D.UI.showHelp();
        return;
      }

      // SP speed ± (same steps as sidebar dropdown)
      if (!game.multiplayer && !game.replay && !game.spectator) {
        const steps = [0.5, 1, 1.5, 2, 3];
        if (e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
          let i = steps.indexOf(game.speedMult || 1);
          if (i < 0) i = 1;
          game.speedMult = steps[Math.min(steps.length - 1, i + 1)];
          D.Game.pushMessage(game, 'Speed ' + game.speedMult + '×');
          if (D.UI) {
            D.UI.refreshSpeedHud(game);
            if (D.UI.syncSpeedSelect) D.UI.syncSpeedSelect(game);
          }
          e.preventDefault();
          return;
        }
        if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
          let i = steps.indexOf(game.speedMult || 1);
          if (i < 0) i = 1;
          game.speedMult = steps[Math.max(0, i - 1)];
          D.Game.pushMessage(game, 'Speed ' + game.speedMult + '×');
          if (D.UI) {
            D.UI.refreshSpeedHud(game);
            if (D.UI.syncSpeedSelect) D.UI.syncSpeedSelect(game);
          }
          e.preventDefault();
          return;
        }
      }

      // F3 debug
      if (e.code === 'F3') {
        e.preventDefault();
        const el = document.getElementById('debug-overlay');
        if (el) el.classList.toggle('visible');
        return;
      }

      if (e.code === 'KeyE') {
        const mcvs = selectedUnits(game).filter((u) => u.type === 'mcv');
        if (mcvs.length) {
          issueOrder(
            game,
            mcvs.map((u) => u.id),
            { type: 'deploy' }
          );
          if (!game.multiplayer) {
            // SP: try immediately for snappy feedback
            let any = false;
            for (const u of mcvs) {
              if (D.Orders.tryDeploy(game, u)) any = true;
            }
            if (!any) {
              D.Game.pushMessage(
                game,
                'Cannot deploy — need a clear 2×2 rock pad (move fully onto rock, then E).'
              );
            }
          }
        } else {
          D.Game.pushMessage(game, 'Select your MCV first, then press E to deploy.');
        }
        e.preventDefault();
        return;
      }

      // D — saboteur detonate (selected saboteurs only)
      if (e.code === 'KeyD' && D.Input.wantsUnitCommand(game)) {
        const sabs = selectedUnits(game).filter((u) => u.type === 'saboteur');
        if (sabs.length) {
          e.preventDefault();
          issueOrder(
            game,
            sabs.map((u) => u.id),
            { type: 'detonate' }
          );
          if (!game.multiplayer) {
            for (const u of sabs) D.Orders.tryDetonate(game, u);
          }
          return;
        }
      }

      // S / . — stop (classic RTS S; period as extra; no pan when units selected)
      if (e.code === 'KeyS' || e.code === 'Period') {
        if (e.code === 'KeyS' && !D.Input.wantsUnitCommand(game)) {
          // no selection: let S pan (already set panKeys above)
          return;
        }
        issueStop(
          game,
          selectedUnits(game).map((u) => u.id)
        );
        panKeys.down = false; // cancel accidental pan if set
        e.preventDefault();
        return;
      }

      // F — follow unit under cursor (placement mode already handled F above)
      if (e.code === 'KeyF') {
        const units = selectedUnits(game);
        if (!units.length) {
          D.Game.pushMessage(
            game,
            'Select unit(s), hover a unit, then F to follow.'
          );
          e.preventDefault();
          return;
        }
        const ht = game.hoverTile;
        if (!ht || ht.tx == null) {
          D.Game.pushMessage(game, 'Hover a unit, then F to follow.');
          e.preventDefault();
          return;
        }
        const hit = pickAt(game, ht.tx + 0.5, ht.ty + 0.5);
        if (!hit || hit.kind !== 'unit') {
          D.Game.pushMessage(game, 'Follow target must be a unit (own or visible enemy).');
          e.preventDefault();
          return;
        }
        const target = hit.entity;
        const o = me(game);
        // Enemy must be visible (pickAt already hides fogged enemies, double-check)
        if (
          target.owner !== o &&
          D.Combat &&
          D.Combat.canSee &&
          !D.Combat.canSee(game, o, target.x, target.y)
        ) {
          D.Game.pushMessage(game, 'Cannot follow — target not visible.');
          e.preventDefault();
          return;
        }
        const ids = units.map((u) => u.id).filter((id) => id !== target.id);
        if (!ids.length) {
          D.Game.pushMessage(game, 'Cannot follow self — select other units.');
          e.preventDefault();
          return;
        }
        issueOrder(game, ids, { type: 'follow', targetId: target.id });
        const tName =
          (D.config.units[target.type] && D.config.units[target.type].name) ||
          target.type;
        D.Game.pushMessage(
          game,
          'Following ' +
            tName +
            (target.owner === o ? '' : ' (enemy)') +
            '.'
        );
        e.preventDefault();
        return;
      }

      // M / G — move to cursor (trackpad-friendly)
      // A — attack-move / attack under cursor (classic RTS; no pan when units selected)
      if (e.code === 'KeyM' || e.code === 'KeyG' || e.code === 'KeyA') {
        const units = selectedUnits(game);
        if (!units.length) {
          if (e.code === 'KeyA') {
            // no selection: A pans left (panKeys already set)
            return;
          }
          D.Game.pushMessage(
            game,
            'Select unit(s), hover the map, then M/G to move (A = attack-move).'
          );
          e.preventDefault();
          return;
        }
        const ht = game.hoverTile;
        if (!ht || ht.tx == null) {
          D.Game.pushMessage(game, 'Hover the map, then M/G to move or A to attack-move.');
          e.preventDefault();
          return;
        }
        const wx = ht.tx + 0.5;
        const wy = ht.ty + 0.5;
        const attackMove = e.code === 'KeyA';
        panKeys.left = false; // A is order, never pan while commanding
        // Harvesters on spice → harvest order when moving with M/G
        if (!attackMove) {
          const harvs = units.filter((u) => u.type === 'harvester');
          if (harvs.length && game.map && D.Map.spiceAt(game.map, ht.tx, ht.ty) > 0) {
            issueOrder(
              game,
              harvs.map((u) => u.id),
              { type: 'harvest', tileX: ht.tx, tileY: ht.ty }
            );
            const rest = units.filter((u) => u.type !== 'harvester');
            if (rest.length) {
              issueOrder(
                game,
                rest.map((u) => u.id),
                { type: 'move', x: wx, y: wy }
              );
            }
            e.preventDefault();
            return;
          }
        }
        // A on enemy = direct attack; A on ground = attack-move
        if (attackMove) {
          const hit = pickAt(game, wx, wy);
          const enemy = foe(game);
          if (hit && hit.entity.owner === enemy) {
            issueOrder(
              game,
              units.map((u) => u.id),
              { type: 'attack', targetId: hit.entity.id }
            );
            e.preventDefault();
            return;
          }
        }
        issueOrder(
          game,
          units.map((u) => u.id),
          { type: attackMove ? 'attack-move' : 'move', x: wx, y: wy }
        );
        e.preventDefault();
        return;
      }

      if (e.code === 'KeyH') {
        const harvs = selectedUnits(game).filter((u) => u.type === 'harvester');
        for (const u of harvs) {
          const spice = D.Map.findNearestSpice(game.map, u.x, u.y);
          if (spice) {
            issueOrder(game, [u.id], {
              type: 'harvest',
              tileX: spice.tx,
              tileY: spice.ty,
            });
          }
        }
        e.preventDefault();
        return;
      }

      // Control groups
      const num = e.code.match(/^Digit([1-9])$/);
      if (num) {
        const n = num[1];
        const o = me(game);
        if (e.ctrlKey || e.metaKey) {
          game.controlGroups[n] = game.selection.ids.slice();
          D.Game.pushMessage(game, 'Group ' + n + ' set');
          e.preventDefault();
        } else {
          const ids = (game.controlGroups[n] || []).filter((id) => {
            const ent = D.Entities.getById(game, id);
            return ent && ent.hp > 0 && ent.owner === o;
          });
          game.selection.ids = ids;
          if (D.UI) {
            D.UI.invalidateSelection();
            D.UI.refresh(game);
          }
          e.preventDefault();
        }
        return;
      }

      // Quicksave (SP only)
      if (e.code === 'F5') {
        e.preventDefault();
        if (game.multiplayer) return;
        if (D.Save && game.phase === 'playing') {
          if (D.Save.write(game)) D.Game.pushMessage(game, 'Game saved.');
        }
        return;
      }

      // Debug cheats (SP / host only)
      const params = new URLSearchParams(location.search);
      const debug = params.get('debug') === '1' || D.config.features.debugCheats;
      if (debug && !game.multiplayer) {
        if (e.code === 'F1') {
          e.preventDefault();
          D.Game.giveCredits(game, 1000);
        }
        if (e.code === 'F2') {
          e.preventDefault();
          D.Game.spawnEnemyArmy(game);
        }
        if (e.code === 'F4') {
          e.preventDefault();
          D.Game.revealMap(game);
        }
      }
    },

    /**
     * Trackpad / no-right-button:
     * - Ctrl/⌘ + click = order click (like RMB → move / attack enemy)
     * - Alt + click = attack-move (or Ctrl/⌘+Shift+click)
     */
    isOrderModifier(e) {
      return !!(e && (e.ctrlKey || e.metaKey));
    },

    isAttackMoveClick(e) {
      if (!e) return false;
      // Alt alone or with order-click; Shift+Ctrl/⌘ also
      if (e.altKey) return true;
      if (e.shiftKey && (e.ctrlKey || e.metaKey || e.button === 2)) return true;
      return false;
    },

    onMouseDown(game, e) {
      if (game.phase !== 'playing' && !game.replay && !game.spectator) return;
      // Replay / live spectate is view-only (camera still pans via keys / minimap)
      if (game.replay || game.spectator) {
        if (e.button === 0) {
          // allow box-select for looking around only — no orders
          dragging = true;
          dragStart = canvasPos(e, canvas);
          game.selection.box = {
            x0: dragStart.x,
            y0: dragStart.y,
            x1: dragStart.x,
            y1: dragStart.y,
          };
        }
        return;
      }
      const pos = canvasPos(e, canvas);
      const o = me(game);

      // RMB, Ctrl/⌘+LMB, or Alt+LMB = issue order (trackpad-friendly)
      const orderClick =
        e.button === 2 ||
        (e.button === 0 &&
          !game.placement &&
          (D.Input.isOrderModifier(e) || e.altKey));
      if (orderClick) {
        e.preventDefault();
        D.Input.rightClick(game, pos, e);
        return;
      }

      if (e.button === 0) {
        // placement
        if (game.placement) {
          const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
          game.hoverTile = { tx: Math.floor(world.x), ty: Math.floor(world.y) };
          game.placement.tileX = game.hoverTile.tx;
          game.placement.tileY = game.hoverTile.ty;
          // shiftKey = one-shot exit placement; default keeps building type selected
          D.Input.confirmPlacement(game, e.shiftKey);
          return;
        }

        dragging = true;
        dragStart = pos;
        game.selection.box = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
      }
    },

    onMouseMove(game, e) {
      if (!canvas || (game.phase !== 'playing' && !game.replay && !game.spectator))
        return;
      const pos = canvasPos(e, canvas);
      const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
      game.hoverTile = { tx: Math.floor(world.x), ty: Math.floor(world.y) };

      if (game.placement && !game.replay && !game.spectator) {
        game.placement.tileX = Math.floor(world.x);
        game.placement.tileY = Math.floor(world.y);
      }

      if (dragging && dragStart) {
        game.selection.box = {
          x0: Math.min(dragStart.x, pos.x),
          y0: Math.min(dragStart.y, pos.y),
          x1: Math.max(dragStart.x, pos.x),
          y1: Math.max(dragStart.y, pos.y),
        };
      }
    },

    onMouseUp(game, e) {
      if (game.phase !== 'playing' && !game.replay && !game.spectator) return;
      if (e.button !== 0) return;
      // Order clicks (Ctrl/⌘) were handled on mousedown
      if (D.Input.isOrderModifier(e) && !game.replay && !game.spectator) {
        dragging = false;
        game.selection.box = null;
        return;
      }
      const pos = canvasPos(e, canvas);
      const box = game.selection.box;
      dragging = false;
      game.selection.box = null;
      const o = me(game);
      // Spectators / replay may select any house for inspection
      const anyOwner = !!(game.replay || game.spectator);

      if (!box) return;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const shift = e.shiftKey;

      if (w < 4 && h < 4) {
        // click select
        const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
        const hit = pickAt(game, world.x, world.y);
        if (hit && (anyOwner || hit.entity.owner === o)) {
          const id = hit.entity.id;
          const now = performance.now();
          if (
            lastClick.id === id &&
            now - lastClick.t < 350 &&
            hit.kind === 'unit'
          ) {
            // double-click select-by-type
            const type = hit.entity.type;
            const owner = hit.entity.owner;
            game.selection.ids = game.units
              .filter(
                (u) =>
                  (anyOwner ? u.owner === owner : u.owner === o) &&
                  u.type === type &&
                  u.hp > 0
              )
              .map((u) => u.id);
          } else if (shift) {
            const i = game.selection.ids.indexOf(id);
            if (i >= 0) game.selection.ids.splice(i, 1);
            else game.selection.ids.push(id);
          } else {
            game.selection.ids = [id];
          }
          lastClick = { t: now, id };
        } else if (!shift) {
          game.selection.ids = [];
        }
      } else {
        // box select units
        const w0 = D.Renderer.screenToWorld(game, box.x0, box.y0);
        const w1 = D.Renderer.screenToWorld(game, box.x1, box.y1);
        const minX = Math.min(w0.x, w1.x);
        const maxX = Math.max(w0.x, w1.x);
        const minY = Math.min(w0.y, w1.y);
        const maxY = Math.max(w0.y, w1.y);
        const ids = game.units
          .filter(
            (u) =>
              (anyOwner || u.owner === o) &&
              u.hp > 0 &&
              u.x >= minX &&
              u.x <= maxX &&
              u.y >= minY &&
              u.y <= maxY
          )
          .map((u) => u.id);
        if (shift) {
          const set = new Set(game.selection.ids.concat(ids));
          game.selection.ids = [...set];
        } else {
          game.selection.ids = ids;
        }
      }
      if (D.UI) {
        D.UI.invalidateSelection();
        D.UI.refresh(game);
      }
    },

    rightClick(game, pos, e) {
      if (game.replay || game.spectator) return;
      const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
      const units = selectedUnits(game);
      const buildings = selectedBuildings(game);
      const o = me(game);
      const enemy = foe(game);

      // rally point for selected factory
      if (buildings.length === 1 && !units.length) {
        const b = buildings[0];
        const prod = ['barracks', 'lightFactory', 'heavyFactory'];
        if (prod.includes(b.type)) {
          if (D.Net) {
            D.Net.command(game, {
              op: 'rally',
              buildingId: b.id,
              x: world.x,
              y: world.y,
            });
          } else {
            D.Orders.setRally(game, b.id, world.x, world.y);
          }
          D.Game.pushMessage(game, 'Rally set');
          return;
        }
      }

      if (!units.length) return;

      const hit = pickAt(game, world.x, world.y);

      // attack enemy
      if (hit && hit.kind === 'unit' && hit.entity.owner === enemy) {
        issueOrder(
          game,
          units.map((u) => u.id),
          { type: 'attack', targetId: hit.entity.id }
        );
        return;
      }
      // attack enemy building
      if (hit && hit.kind === 'building' && hit.entity.owner === enemy) {
        issueOrder(
          game,
          units.map((u) => u.id),
          { type: 'attack', targetId: hit.entity.id }
        );
        return;
      }

      // right-click friendly unit → follow
      if (hit && hit.kind === 'unit' && hit.entity.owner === me(game)) {
        const target = hit.entity;
        const ids = units.map((u) => u.id).filter((id) => id !== target.id);
        if (ids.length) {
          issueOrder(game, ids, { type: 'follow', targetId: target.id });
        }
        return;
      }

      // harvester on spice
      const tx = Math.floor(world.x);
      const ty = Math.floor(world.y);
      const harvs = units.filter((u) => u.type === 'harvester');
      if (harvs.length && D.Map.spiceAt(game.map, tx, ty) > 0) {
        issueOrder(
          game,
          harvs.map((u) => u.id),
          { type: 'harvest', tileX: tx, tileY: ty }
        );
        const rest = units.filter((u) => u.type !== 'harvester');
        if (rest.length) {
          issueOrder(
            game,
            rest.map((u) => u.id),
            {
              type: D.Input.isAttackMoveClick(e) ? 'attack-move' : 'move',
              x: world.x,
              y: world.y,
            }
          );
        }
        return;
      }

      // Attack-move: Alt+click, Alt+RMB, or Ctrl/⌘+Shift+click (trackpad)
      // Plain RMB / Ctrl+click = move
      const attackMove = D.Input.isAttackMoveClick(e);
      issueOrder(
        game,
        units.map((u) => u.id),
        {
          type: attackMove ? 'attack-move' : 'move',
          x: world.x,
          y: world.y,
        }
      );
    },

    onMinimap(game, e) {
      if (
        game.phase !== 'playing' &&
        game.phase !== 'paused' &&
        !game.replay &&
        !game.spectator
      )
        return;
      const pos = canvasPos(e, minimap);
      const map = game.map;
      if (!map) return;
      const tx = (pos.x / minimap.clientWidth) * map.width;
      const ty = (pos.y / minimap.clientHeight) * map.height;
      const view = D.Renderer.viewSize();
      const t = D.config.TILE_SIZE;
      game.camera.x = tx * t - view.w / 2;
      game.camera.y = ty * t - view.h / 2;
      D.Renderer.clampCamera(game);
    },

    startPlacement(game, type) {
      if (game.replay || game.spectator) return;
      const ht = game.hoverTile || { tx: 0, ty: 0 };
      game.placement = {
        type,
        tileX: ht.tx | 0,
        tileY: ht.ty | 0,
      };
      // Sticky: keep building type until Esc (or Shift+place for one-shot)
      D.Game.pushMessage(
        game,
        'Place ' +
          ((D.config.buildings[type] && D.config.buildings[type].name) || type) +
          ' — click or Space/F (stays selected; Shift+place once; Esc cancel)'
      );
    },

    cancelPlacement(game) {
      game.placement = null;
    },

    /** Train another of the last unit type (sticky produce on selected factory). */
    repeatStickyProduce(game) {
      if (!game || game.replay || game.spectator || game.phase !== 'playing') {
        return false;
      }
      const sp = game.stickyProduce;
      if (!sp || !sp.unitType) return false;
      let buildingId = sp.buildingId | 0;
      // Prefer sticky factory if still selected / alive
      const selB = game.selection.ids
        .map((id) => game.buildings.find((b) => b.id === id))
        .filter(Boolean);
      const o = me(game);
      let b = game.buildings.find((x) => x.id === buildingId && x.hp > 0);
      if ((!b || b.owner !== o) && selB.length === 1 && selB[0].owner === o) {
        b = selB[0];
        buildingId = b.id;
        game.stickyProduce.buildingId = buildingId;
      }
      if (!b || b.owner !== o || b.buildProgress < 1) return false;
      const udef = D.config.units[sp.unitType];
      if (!udef || udef.builtAt !== b.type) return false;
      let r;
      if (D.Net) {
        r = D.Net.command(game, {
          op: 'produce',
          buildingId,
          unitType: sp.unitType,
        });
      } else {
        r = D.Economy.enqueueUnit(game, buildingId, sp.unitType);
      }
      if (r && r.ok) {
        const name = (udef && udef.name) || sp.unitType;
        D.Game.pushMessage(game, 'Training ' + name);
        if (D.UI) {
          D.UI.invalidateSelection();
          D.UI.refresh(game);
        }
        return true;
      }
      if (r && !r.deferred) {
        D.Game.pushMessage(
          game,
          r.reason === 'credits'
            ? 'Not enough credits'
            : r.reason === 'queue'
              ? 'Production queue full'
              : 'Cannot train: ' + (r.reason || '?')
        );
      }
      return !!r;
    },

    /**
     * Place current structure at hover / placement ghost tile.
     * @param {boolean} [oneShot] if true (Shift), clear placement after success.
     *   Default keeps the building type selected for multi-place.
     */
    confirmPlacement(game, oneShot) {
      if (
        !game ||
        game.replay ||
        game.spectator ||
        !game.placement ||
        game.phase !== 'playing'
      ) {
        return { ok: false, reason: 'none' };
      }
      const o = me(game);
      let tx = game.placement.tileX | 0;
      let ty = game.placement.tileY | 0;
      if (game.hoverTile) {
        tx = game.hoverTile.tx | 0;
        ty = game.hoverTile.ty | 0;
        game.placement.tileX = tx;
        game.placement.tileY = ty;
      }
      let r;
      if (D.Net) {
        r = D.Net.command(game, {
          op: 'build',
          type: game.placement.type,
          tileX: tx,
          tileY: ty,
        });
      } else {
        r = D.Economy.beginStructure(game, o, game.placement.type, tx, ty);
      }
      if (r && r.ok) {
        // Default: keep type selected so two towers = two clicks on the map
        if (oneShot) game.placement = null;
        if (D.UI) D.UI.refresh(game);
        if (r.queue != null && r.maxQueue != null && r.queue > 1) {
          D.Game.pushMessage(game, 'Construction ' + r.queue + '/' + r.maxQueue);
        }
        return r;
      }
      if (r && !r.deferred) {
        const why =
          r.reason === 'busy'
            ? 'queue full (' + D.Economy.structureQueueMax() + ' max)'
            : r.reason || 'invalid';
        D.Game.pushMessage(game, 'Cannot place: ' + why);
      }
      return r || { ok: false };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
