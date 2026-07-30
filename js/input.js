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
    if (D.Net) return D.Net.command(game, { op: 'order', ids, order });
    D.Orders.issue(game, ids, order);
    return { ok: true };
  }

  function issueStop(game, ids) {
    if (D.Net) return D.Net.command(game, { op: 'stop', ids });
    D.Orders.stop(game, ids);
    return { ok: true };
  }

  function pickAt(game, wx, wy) {
    const o = me(game);
    // units first (topmost by id)
    let bestU = null;
    let bestD = 0.55;
    for (const u of game.units) {
      if (u.owner !== o && !D.Map.isVisible(game, o, Math.floor(u.x), Math.floor(u.y)))
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
        b.owner !== o &&
        !D.Map.isExplored(game, o, Math.floor(b.tileX + b.tileW / 2), Math.floor(b.tileY + b.tileH / 2))
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
      if (game.phase !== 'playing' && game.phase !== 'paused') return;
      const speed = PAN_SPEED * dt;
      if (panKeys.left || keys.ArrowLeft || keys.KeyA) game.camera.x -= speed;
      if (panKeys.right || keys.ArrowRight || keys.KeyD) game.camera.x += speed;
      if (panKeys.up || keys.ArrowUp || keys.KeyW) game.camera.y -= speed;
      if (panKeys.down || keys.ArrowDown || keys.KeyS) game.camera.y += speed;
      if (D.Renderer) D.Renderer.clampCamera(game);
    },

    onKeyDown(game, e) {
      // Don't steal typing from chat / feedback / name fields
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) {
        if (e.code === 'Escape' && e.target.blur) e.target.blur();
        return;
      }

      if (e.code === 'ArrowLeft' || e.code === 'KeyA') panKeys.left = true;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') panKeys.right = true;
      if (e.code === 'ArrowUp' || e.code === 'KeyW') panKeys.up = true;
      if (e.code === 'ArrowDown' || e.code === 'KeyS') panKeys.down = true;

      if (e.code === 'Escape') {
        game.placement = null;
        // Multiplayer: no pause (desyncs host clock); cancel placement only
        if (game.multiplayer) {
          e.preventDefault();
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
        e.preventDefault();
        return;
      }

      if (game.phase !== 'playing') return;

      // Help
      if (e.key === '?' || (e.code === 'Slash' && e.shiftKey) || e.code === 'Slash') {
        // bare / also opens help when not chatting
        e.preventDefault();
        if (D.UI) D.UI.showHelp();
        return;
      }

      // SP speed ±
      if (!game.multiplayer && !game.replay) {
        const steps = [0.5, 1, 2, 4];
        if (e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
          let i = steps.indexOf(game.speedMult || 1);
          if (i < 0) i = 1;
          game.speedMult = steps[Math.min(steps.length - 1, i + 1)];
          D.Game.pushMessage(game, 'Speed ' + game.speedMult + '×');
          if (D.UI) D.UI.refreshSpeedHud(game);
          e.preventDefault();
          return;
        }
        if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
          let i = steps.indexOf(game.speedMult || 1);
          if (i < 0) i = 1;
          game.speedMult = steps[Math.max(0, i - 1)];
          D.Game.pushMessage(game, 'Speed ' + game.speedMult + '×');
          if (D.UI) D.UI.refreshSpeedHud(game);
          e.preventDefault();
          return;
        }
      }

      // Replay controls
      if (game.replay && D.Replay) {
        if (e.code === 'Space') {
          e.preventDefault();
          const on = D.Replay.togglePause();
          D.Game.pushMessage(game, on ? 'Replay playing' : 'Replay paused');
          return;
        }
        if (e.code === 'BracketLeft') {
          D.Replay.setSpeed(Math.max(0.25, D.Replay.speed / 2));
          D.Game.pushMessage(game, 'Replay ' + D.Replay.speed + '×');
          return;
        }
        if (e.code === 'BracketRight') {
          D.Replay.setSpeed(Math.min(8, D.Replay.speed * 2));
          D.Game.pushMessage(game, 'Replay ' + D.Replay.speed + '×');
          return;
        }
        if (e.code === 'Escape') {
          e.preventDefault();
          D.Replay.stop(game);
          if (D.UI) D.UI.showMenu();
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
            for (const u of mcvs) D.Orders.tryDeploy(game, u);
          }
        } else {
          D.Game.pushMessage(game, 'Select your MCV first, then press E to deploy.');
        }
        e.preventDefault();
        return;
      }

      if (e.code === 'KeyX' || e.code === 'Period') {
        issueStop(
          game,
          selectedUnits(game).map((u) => u.id)
        );
        e.preventDefault();
        return;
      }

      // M / G — move selected units to tile under cursor (no right-click needed)
      // A — attack-move to hover tile
      if (e.code === 'KeyM' || e.code === 'KeyG' || e.code === 'KeyA') {
        const units = selectedUnits(game);
        if (!units.length) {
          D.Game.pushMessage(game, 'Select unit(s), hover the map, then M/G to move (A = attack-move).');
          e.preventDefault();
          return;
        }
        const ht = game.hoverTile;
        if (!ht || ht.tx == null) {
          D.Game.pushMessage(game, 'Move the pointer over the map first, then press M.');
          e.preventDefault();
          return;
        }
        const wx = ht.tx + 0.5;
        const wy = ht.ty + 0.5;
        const attackMove = e.code === 'KeyA';
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
        // Attack enemy under cursor with A or when clicking attack on foe
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

    /** Trackpad / no-right-button: Ctrl or ⌘ + click issues orders (like RMB). */
    isOrderModifier(e) {
      return !!(e && (e.ctrlKey || e.metaKey));
    },

    onMouseDown(game, e) {
      if (game.phase !== 'playing') return;
      const pos = canvasPos(e, canvas);
      const o = me(game);

      // Right-click OR Ctrl/⌘+left-click = issue order (trackpad-friendly)
      if (e.button === 2 || (e.button === 0 && D.Input.isOrderModifier(e) && !game.placement)) {
        e.preventDefault();
        D.Input.rightClick(game, pos, e);
        return;
      }

      if (e.button === 0) {
        // placement
        if (game.placement) {
          const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
          const tx = Math.floor(world.x);
          const ty = Math.floor(world.y);
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
            if (!e.shiftKey) game.placement = null;
            if (D.UI) D.UI.refresh(game);
            if (r.queue != null && r.maxQueue != null && r.queue > 1) {
              D.Game.pushMessage(
                game,
                'Construction ' + r.queue + '/' + r.maxQueue
              );
            }
          } else if (r && !r.deferred) {
            const why =
              r.reason === 'busy'
                ? 'queue full (' + D.Economy.structureQueueMax() + ' max)'
                : r.reason || 'invalid';
            D.Game.pushMessage(game, 'Cannot place: ' + why);
          }
          return;
        }

        dragging = true;
        dragStart = pos;
        game.selection.box = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
      }
    },

    onMouseMove(game, e) {
      if (!canvas || game.phase !== 'playing') return;
      const pos = canvasPos(e, canvas);
      const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
      game.hoverTile = { tx: Math.floor(world.x), ty: Math.floor(world.y) };

      if (game.placement) {
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
      if (game.phase !== 'playing') return;
      if (e.button !== 0) return;
      // Order clicks (Ctrl/⌘) were handled on mousedown
      if (D.Input.isOrderModifier(e)) {
        dragging = false;
        game.selection.box = null;
        return;
      }
      const pos = canvasPos(e, canvas);
      const box = game.selection.box;
      dragging = false;
      game.selection.box = null;
      const o = me(game);

      if (!box) return;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const shift = e.shiftKey;

      if (w < 4 && h < 4) {
        // click select
        const world = D.Renderer.screenToWorld(game, pos.x, pos.y);
        const hit = pickAt(game, world.x, world.y);
        if (hit && hit.entity.owner === o) {
          const id = hit.entity.id;
          const now = performance.now();
          if (
            lastClick.id === id &&
            now - lastClick.t < 350 &&
            hit.kind === 'unit'
          ) {
            // double-click select-by-type
            const type = hit.entity.type;
            game.selection.ids = game.units
              .filter((u) => u.owner === o && u.type === type && u.hp > 0)
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
              u.owner === o &&
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
      if (hit && hit.entity.owner === enemy) {
        issueOrder(
          game,
          units.map((u) => u.id),
          { type: 'attack', targetId: hit.entity.id }
        );
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
            { type: e.ctrlKey ? 'attack-move' : 'move', x: world.x, y: world.y }
          );
        }
        return;
      }

      // Alt = attack-move; plain RMB / Ctrl+click = move
      const attackMove = !!(e.altKey && !e.ctrlKey && !e.metaKey);
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
      if (game.phase !== 'playing' && game.phase !== 'paused') return;
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
      game.placement = { type, tileX: 0, tileY: 0 };
    },

    cancelPlacement(game) {
      game.placement = null;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
