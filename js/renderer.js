/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  let canvas = null;
  let ctx = null;
  let minimap = null;
  let mctx = null;
  let terrainCanvas = null;
  let tctx = null;
  /** 1px/tile fog mask (shroud + dim) — much cheaper than per-tile fillRect */
  let fogCanvas = null;
  let fctx = null;
  let fogCacheOwner = null;
  let viewW = 800;
  let viewH = 600;

  function ts() {
    return D.config.TILE_SIZE;
  }

  function ownerColor(owner) {
    if (D.Seats && D.Seats.color) return D.Seats.color(owner);
    return owner === 'player' ? D.config.colors.player : D.config.colors.enemy;
  }

  function terrainColor(id, spiceAmt) {
    const C = D.config.colors;
    const T = D.config.terrain;
    switch (id) {
      case T.SAND:
        return C.sand;
      case T.DUNE:
        return C.dune;
      case T.ROCK:
        return C.rock;
      case T.SPICE:
        return C.spice;
      case T.SPICE_HEAVY:
        return C.spiceHeavy;
      case T.CLIFF:
        return C.cliff;
      default:
        return '#000';
    }
  }

  function me(game) {
    return D.Game.me(game);
  }

  D.Renderer = {
    init(gameCanvas, minimapCanvas) {
      canvas = gameCanvas;
      ctx = canvas.getContext('2d');
      minimap = minimapCanvas;
      mctx = minimap.getContext('2d');
      terrainCanvas = document.createElement('canvas');
      tctx = terrainCanvas.getContext('2d');
      D.Renderer.resize();
    },

    resize() {
      if (!canvas) return;
      const wrap = canvas.parentElement;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      viewW = wrap.clientWidth || 800;
      viewH = wrap.clientHeight || 600;
      canvas.width = Math.floor(viewW * dpr);
      canvas.height = Math.floor(viewH * dpr);
      canvas.style.width = viewW + 'px';
      canvas.style.height = viewH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    viewSize() {
      return { w: viewW, h: viewH };
    },

    worldToScreen(game, wx, wy) {
      const t = ts();
      return {
        x: wx * t - game.camera.x,
        y: wy * t - game.camera.y,
      };
    },

    screenToWorld(game, sx, sy) {
      const t = ts();
      return {
        x: (sx + game.camera.x) / t,
        y: (sy + game.camera.y) / t,
      };
    },

    rebuildTerrain(game) {
      if (!game.map) return;
      const map = game.map;
      const t = ts();
      terrainCanvas.width = map.width * t;
      terrainCanvas.height = map.height * t;
      for (let ty = 0; ty < map.height; ty++) {
        for (let tx = 0; tx < map.width; tx++) {
          const i = ty * map.width + tx;
          const id = map.tiles[i];
          tctx.fillStyle = terrainColor(id, map.spiceAmount[i]);
          tctx.fillRect(tx * t, ty * t, t, t);
          // subtle spice density tint
          if (id === D.config.terrain.SPICE || id === D.config.terrain.SPICE_HEAVY) {
            const a = Math.min(0.35, map.spiceAmount[i] / 1500);
            tctx.fillStyle = `rgba(255,120,0,${a})`;
            tctx.fillRect(tx * t, ty * t, t, t);
          }
          // grid tick every 4
          if ((tx + ty) % 2 === 0 && id === D.config.terrain.ROCK) {
            tctx.fillStyle = 'rgba(0,0,0,0.06)';
            tctx.fillRect(tx * t, ty * t, t, t);
          }
        }
      }
      // concrete overlays (slab pattern)
      for (const b of game.buildings) {
        if (b.type !== 'concrete' || b.buildProgress < 1) continue;
        D.Sprites.drawBuilding(
          tctx,
          'concrete',
          b.tileX * t,
          b.tileY * t,
          b.tileW * t,
          b.tileH * t,
          { ownerColor: D.config.colors.concrete }
        );
      }
      map.terrainDirty = false;
    },

    clampCamera(game) {
      if (!game.map) return;
      const t = ts();
      const maxX = Math.max(0, game.map.width * t - viewW);
      const maxY = Math.max(0, game.map.height * t - viewH);
      game.camera.x = Math.max(0, Math.min(maxX, game.camera.x));
      game.camera.y = Math.max(0, Math.min(maxY, game.camera.y));
    },

    draw(game) {
      if (!ctx || !game.map) return;
      if (game.map.terrainDirty) D.Renderer.rebuildTerrain(game);
      D.Renderer.clampCamera(game);

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, viewW, viewH);

      // terrain
      ctx.drawImage(
        terrainCanvas,
        game.camera.x,
        game.camera.y,
        viewW,
        viewH,
        0,
        0,
        viewW,
        viewH
      );

      // FOW on terrain only — entities draw above so your buildings never
      // disappear under "explored but not visible" dimming when a harvester leaves.
      // Replay: spectator view (no FOW overlay; both houses drawn).
      if (D.Map.fogVisible(game) && game.fog) {
        D.Renderer.drawFog(game);
      }

      // buildings (player always; enemy if explored)
      const sortedBuildings = game.buildings.slice().sort((a, b) => a.id - b.id);
      for (const b of sortedBuildings) {
        D.Renderer.drawBuilding(game, b);
      }

      // units (player always; enemy only if currently visible)
      const sortedUnits = game.units.slice().sort((a, b) => a.id - b.id);
      for (const u of sortedUnits) {
        if (!D.Renderer.shouldDrawUnit(game, u)) continue;
        D.Renderer.drawUnit(game, u);
      }

      // projectiles — show if shell tile or path endpoint is visible to local player
      const local = me(game);
      for (const p of game.projectiles || []) {
        if (D.Map.fogVisible(game) && p.owner !== local) {
          const visHere = D.Map.isVisible(game, local, Math.floor(p.x), Math.floor(p.y));
          const visTgt =
            p.tx != null && D.Map.isVisible(game, local, Math.floor(p.tx), Math.floor(p.ty));
          if (!visHere && !visTgt) continue;
        }
        const s = D.Renderer.worldToScreen(game, p.x, p.y);
        const friendly = p.owner === local;
        const col = friendly ? '#9cf' : '#f96';
        const big = p.fromTurret || p.kind === 'shell' || p.heavy;
        const heavy = !!p.heavy;
        // Trail toward target for readability (longer for siege / LRT)
        if (p.tx != null && p.ty != null) {
          const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
          const tail = heavy ? 22 : big ? 14 : 8;
          ctx.strokeStyle = col;
          ctx.globalAlpha = heavy ? 0.55 : 0.35;
          ctx.lineWidth = heavy ? 3.5 : big ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - Math.cos(ang) * tail, s.y - Math.sin(ang) * tail);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(s.x, s.y, heavy ? 7 : big ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = heavy ? 1.5 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Sandworms (under FOW if not visible)
      if (game.worms && game.worms.length) {
        for (const w of game.worms) {
          if (
            D.Map.fogVisible(game) &&
            !D.Map.isVisible(game, local, Math.floor(w.x), Math.floor(w.y)) &&
            !D.Map.isExplored(game, local, Math.floor(w.x), Math.floor(w.y))
          ) {
            continue;
          }
          D.Renderer.drawWorm(game, w);
        }
      }

      // fx
      if (game.fx) {
        for (const f of game.fx) {
          const fx = f.x != null ? f.x : f.x0;
          const fy = f.y != null ? f.y : f.y0;
          if (
            D.Map.fogVisible(game) &&
            fx != null &&
            !D.Map.isVisible(game, local, Math.floor(fx), Math.floor(fy)) &&
            !D.Map.isExplored(game, local, Math.floor(fx), Math.floor(fy))
          ) {
            continue;
          }
          if (f.type === 'tracer') {
            const s0 = D.Renderer.worldToScreen(game, f.x0, f.y0);
            const s1 = D.Renderer.worldToScreen(game, f.x1, f.y1);
            ctx.strokeStyle = f.color || '#fff';
            ctx.lineWidth = f.wide ? 3.5 : 2;
            ctx.globalAlpha = Math.max(0, Math.min(1, f.life * (f.wide ? 6 : 10)));
            ctx.beginPath();
            ctx.moveTo(s0.x, s0.y);
            ctx.lineTo(s1.x, s1.y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1;
          } else if (f.type === 'muzzle') {
            const s = D.Renderer.worldToScreen(game, f.x, f.y);
            const a = Math.max(0, f.life * 8);
            ctx.fillStyle = f.color || '#ffc';
            ctx.globalAlpha = a;
            ctx.beginPath();
            ctx.arc(s.x, s.y, (f.r || 0.3) * ts() * (1.4 - f.life), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          } else if (f.type === 'explode') {
            const s = D.Renderer.worldToScreen(game, f.x, f.y);
            ctx.fillStyle = `rgba(255,160,40,${Math.max(0, f.life * 2)})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, (f.r || 0.5) * ts() * (1.2 - f.life), 0, Math.PI * 2);
            ctx.fill();
          } else if (f.type === 'wormsign' || f.type === 'worm_body' || f.type === 'worm_gulp') {
            const s = D.Renderer.worldToScreen(game, f.x, f.y);
            const life = Math.max(0, f.life || 0);
            const rad = (f.r || 1) * ts() * (0.6 + life);
            ctx.strokeStyle =
              f.type === 'worm_gulp'
                ? `rgba(80,40,10,${Math.min(1, life * 3)})`
                : `rgba(90,60,20,${Math.min(0.85, life * 4)})`;
            ctx.lineWidth = f.type === 'wormsign' ? 2.5 : 3;
            ctx.beginPath();
            ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
            ctx.stroke();
            if (f.type === 'wormsign') {
              ctx.strokeStyle = `rgba(200,150,60,${Math.min(0.5, life * 2)})`;
              ctx.beginPath();
              ctx.arc(s.x, s.y, rad * 0.55, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      }

      // placement ghost
      if (game.placement && game.phase === 'playing') {
        D.Renderer.drawGhost(game);
      }

      // selection box
      if (game.selection.box) {
        const b = game.selection.box;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.setLineDash([]);
      }

      // hover tile
      if (game.hoverTile && game.phase === 'playing') {
        const t = ts();
        const s = D.Renderer.worldToScreen(game, game.hoverTile.tx, game.hoverTile.ty);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.strokeRect(s.x, s.y, t, t);
      }

      D.Renderer.drawMinimap(game);
    },

    shouldDrawUnit(game, u) {
      if (!D.Map.fogVisible(game)) return true;
      const o = me(game);
      if (u.owner === o) return true;
      return D.Map.isVisible(game, o, Math.floor(u.x), Math.floor(u.y));
    },

    shouldDrawBuilding(game, b) {
      if (!D.Map.fogVisible(game)) return true;
      const o = me(game);
      if (b.owner === o) return true;
      // explored buildings remain visible (classic)
      const c = D.Entities.buildingCenter(b);
      return (
        D.Map.isExplored(game, o, Math.floor(c.x), Math.floor(c.y)) ||
        D.Map.isVisible(game, o, Math.floor(c.x), Math.floor(c.y))
      );
    },

    drawFog(game) {
      if (!D.Map.fogVisible(game)) return;
      const map = game.map;
      const owner = me(game);
      const fog = game.fog[owner];
      if (!fog) return;
      const t = ts();
      const w = map.width;
      const h = map.height;

      // Rebuild 1px-per-tile fog mask only when sim marks dirty (not every frame)
      if (
        !fogCanvas ||
        fogCanvas.width !== w ||
        fogCanvas.height !== h ||
        fogCacheOwner !== owner ||
        game._fogDrawDirty
      ) {
        if (!fogCanvas) {
          fogCanvas = document.createElement('canvas');
          fctx = fogCanvas.getContext('2d', { alpha: true });
        }
        if (fogCanvas.width !== w || fogCanvas.height !== h) {
          fogCanvas.width = w;
          fogCanvas.height = h;
        }
        const img = fctx.createImageData(w, h);
        const d = img.data;
        // Shroud ~#000 opaque; explored-not-visible dim ~45% black
        for (let i = 0; i < w * h; i++) {
          const p = i * 4;
          if (!fog.explored[i]) {
            d[p] = 0;
            d[p + 1] = 0;
            d[p + 2] = 0;
            d[p + 3] = 255;
          } else if (!fog.visible[i]) {
            d[p] = 0;
            d[p + 1] = 0;
            d[p + 2] = 0;
            d[p + 3] = 115; // ~0.45 * 255
          } else {
            d[p + 3] = 0;
          }
        }
        fctx.putImageData(img, 0, 0);
        fogCacheOwner = owner;
        game._fogDrawDirty = false;
      }

      // Scale mask to world pixels and align with camera
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        fogCanvas,
        0,
        0,
        w,
        h,
        -game.camera.x,
        -game.camera.y,
        w * t,
        h * t
      );
    },

    drawBuilding(game, b) {
      if (b.type === 'concrete') return; // drawn into terrain cache
      if (!D.Renderer.shouldDrawBuilding(game, b)) return;
      const t = ts();
      const s = D.Renderer.worldToScreen(game, b.tileX, b.tileY);
      const w = b.tileW * t;
      const h = b.tileH * t;
      const col = ownerColor(b.owner);
      const alpha = b.buildProgress < 1 ? 0.4 + 0.6 * b.buildProgress : 1;
      const time = game.tick * D.config.DT_SEC;

      // scaffolding under construction
      if (b.buildProgress < 1) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(s.x + 1, s.y + 1, w - 2, h - 2);
        ctx.setLineDash([]);
        ctx.restore();
      }

      D.Sprites.drawBuilding(ctx, b.type, s.x, s.y, w, h, {
        ownerColor: col,
        alpha,
        time,
        powered: game.power[b.owner]?.ratio >= 0.5,
        facing: b._aimFacing || -Math.PI / 2,
      });

      if (b.buildProgress < 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(s.x + 4, s.y + h - 10, w - 8, 5);
        ctx.fillStyle = D.config.colors.hpOk;
        ctx.fillRect(s.x + 4, s.y + h - 10, (w - 8) * b.buildProgress, 5);
      }

      if (b.buildProgress >= 1 && b.hp < b.hpMax) {
        D.Renderer.drawHpBar(s.x + 4, s.y - 6, w - 8, b.hp / b.hpMax);
      }

      if (game.selection.ids.includes(b.id)) {
        ctx.strokeStyle = D.config.colors.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(s.x + 0.5, s.y + 0.5, w - 1, h - 1);
      }
    },

    drawWorm(game, w) {
      const s = D.Renderer.worldToScreen(game, w.x, w.y);
      const t = ts();
      if (w.phase === 'rumble') {
        const pulse = 0.5 + 0.5 * Math.sin((game.tick || 0) * 0.4);
        const rad = (1.2 + pulse * 0.5) * t;
        ctx.strokeStyle = `rgba(120,80,30,${0.35 + pulse * 0.35})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(90,55,15,${0.12 + pulse * 0.1})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rad * 0.7, 0, Math.PI * 2);
        ctx.fill();
        // Wormsign chevrons
        ctx.strokeStyle = `rgba(220,170,60,${0.5 + pulse * 0.3})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          const a = ((game.tick || 0) * 0.08 + i * 2.1) % (Math.PI * 2);
          const rr = rad * 0.45;
          ctx.beginPath();
          ctx.moveTo(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
          ctx.lineTo(
            s.x + Math.cos(a) * (rr + 8),
            s.y + Math.sin(a) * (rr + 8)
          );
          ctx.stroke();
        }
        return;
      }
      if (w.phase === 'surface' || w.phase === 'dive') {
        const dive = w.phase === 'dive' ? Math.max(0.2, 1 - (w.phaseT || 0)) : 1;
        const rad = 1.15 * t * dive;
        // Body ring
        ctx.fillStyle = `rgba(55,35,12,${0.75 * dive})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(180,120,40,${0.9 * dive})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        // Maw
        ctx.fillStyle = `rgba(20,10,5,${0.9 * dive})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rad * 0.45, 0, Math.PI * 2);
        ctx.fill();
        // Teeth hints
        ctx.strokeStyle = `rgba(230,200,140,${0.7 * dive})`;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + (game.tick || 0) * 0.05;
          ctx.beginPath();
          ctx.moveTo(s.x + Math.cos(a) * rad * 0.5, s.y + Math.sin(a) * rad * 0.5);
          ctx.lineTo(s.x + Math.cos(a) * rad * 0.85, s.y + Math.sin(a) * rad * 0.85);
          ctx.stroke();
        }
      }
    },

    drawUnit(game, u) {
      const t = ts();
      const s = D.Renderer.worldToScreen(game, u.x, u.y);
      const col = ownerColor(u.owner);
      const def = D.config.units[u.type];
      const size =
        def && def.kind === 'infantry' ? t * 0.7 : u.type === 'mcv' || u.type === 'harvester' ? t * 1.05 : t * 0.9;
      const half = size / 2;

      D.Sprites.drawUnit(ctx, u.type, s.x - half, s.y - half, size, size, {
        ownerColor: col,
        facing: u.facing || 0,
        cargoRatio: u.cargoMax ? u.cargo / u.cargoMax : 0,
      });

      if (game.selection.ids.includes(u.id) || u.selected) {
        ctx.strokeStyle = D.config.colors.selection;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, half + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Flashing alert when pathing/dock/silos stuck
      if (u.stuck) {
        const pulse = 0.45 + 0.55 * Math.abs(Math.sin((game.tick || 0) * 0.35));
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.fillStyle = u.stuckReason === 'silos' ? '#e0c040' : '#ff4040';
        ctx.beginPath();
        ctx.arc(s.x + half * 0.55, s.y - half * 0.55, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.globalAlpha = Math.min(1, pulse + 0.2);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Outer ring pulse
        ctx.globalAlpha = pulse * 0.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, half + 6 + pulse * 3, 0, Math.PI * 2);
        ctx.strokeStyle = u.stuckReason === 'silos' ? '#e0c040' : '#ff4040';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      if (u.hp < u.hpMax) {
        D.Renderer.drawHpBar(s.x - half, s.y - half - 6, size, u.hp / u.hpMax);
      }
    },

    drawHpBar(x, y, w, ratio) {
      ctx.fillStyle = '#222';
      ctx.fillRect(x, y, w, 4);
      const c =
        ratio > 0.6
          ? D.config.colors.hpOk
          : ratio > 0.3
            ? D.config.colors.hpMid
            : D.config.colors.hpLow;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w * Math.max(0, ratio), 4);
    },

    drawGhost(game) {
      const p = game.placement;
      const def = D.config.buildings[p.type];
      if (!def) return;
      const t = ts();
      const ok = D.Map.canPlace(game, p.type, p.tileX, p.tileY, me(game));
      const s = D.Renderer.worldToScreen(game, p.tileX, p.tileY);
      const w = def.tileW * t;
      const h = def.tileH * t;
      ctx.fillStyle = ok ? 'rgba(74,144,217,0.18)' : 'rgba(192,57,43,0.22)';
      ctx.fillRect(s.x, s.y, w, h);
      D.Sprites.drawBuilding(ctx, p.type, s.x, s.y, w, h, {
        ownerColor: ok ? (me(game) === 'player' ? D.config.colors.player : D.config.colors.enemy) : (me(game) === 'player' ? D.config.colors.enemy : D.config.colors.player),
        alpha: 0.55,
        time: game.tick * D.config.DT_SEC,
        powered: true,
      });
      ctx.strokeStyle = ok ? '#4a90d9' : '#c0392b';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, w - 1, h - 1);
    },

    drawMinimap(game) {
      if (!mctx || !minimap || !game.map) return;
      const map = game.map;
      const mw = minimap.width;
      const mh = minimap.height;
      const sx = mw / map.width;
      const sy = mh / map.height;

      // terrain sample
      if (!D.Renderer._mmCache || game.map.terrainDirty) {
        // draw live each frame is fine at 64x64
      }
      mctx.fillStyle = '#000';
      mctx.fillRect(0, 0, mw, mh);

      for (let ty = 0; ty < map.height; ty++) {
        for (let tx = 0; tx < map.width; tx++) {
          const i = ty * map.width + tx;
          if (D.Map.fogVisible(game) && game.fog && !game.fog[me(game)].explored[i]) {
            mctx.fillStyle = '#000';
          } else {
            mctx.fillStyle = terrainColor(map.tiles[i]);
          }
          mctx.fillRect(tx * sx, ty * sy, Math.ceil(sx), Math.ceil(sy));
        }
      }

      // dim unexplored overlay already black; dim explored not visible
      if (D.Map.fogVisible(game) && game.fog) {
        mctx.fillStyle = 'rgba(0,0,0,0.35)';
        for (let ty = 0; ty < map.height; ty++) {
          for (let tx = 0; tx < map.width; tx++) {
            const i = ty * map.width + tx;
            if (game.fog[me(game)].explored[i] && !game.fog[me(game)].visible[i]) {
              mctx.fillRect(tx * sx, ty * sy, Math.ceil(sx), Math.ceil(sy));
            }
          }
        }
      }

      const o = me(game);
      // Radar (powered): enemy blips on minimap in explored fog, not only active vision
      const hasRadar = game.buildings.some(
        (b) =>
          b.owner === o &&
          b.type === 'radar' &&
          b.buildProgress >= 1 &&
          b.hp > 0 &&
          b.powered !== false
      );

      // buildings — both sides in replay; radar helps enemy base outlines if explored
      for (const b of game.buildings) {
        if (b.type === 'concrete') continue;
        if (game.replay || !D.Map.fogVisible(game) || b.owner === o) {
          /* draw */
        } else if (hasRadar) {
          const c = D.Entities.buildingCenter(b);
          if (!D.Map.isExplored(game, o, Math.floor(c.x), Math.floor(c.y))) continue;
        } else if (!D.Renderer.shouldDrawBuilding(game, b)) {
          continue;
        }
        mctx.fillStyle = ownerColor(b.owner);
        mctx.fillRect(
          b.tileX * sx,
          b.tileY * sy,
          Math.max(1, b.tileW * sx),
          Math.max(1, b.tileH * sy)
        );
      }

      // units — radar shows enemy in explored areas on the minimap
      for (const u of game.units) {
        if (u.owner === o || game.replay || !D.Map.fogVisible(game)) {
          // own / spectator
        } else if (hasRadar) {
          if (!D.Map.isExplored(game, o, Math.floor(u.x), Math.floor(u.y))) continue;
        } else if (!D.Map.isVisible(game, o, Math.floor(u.x), Math.floor(u.y))) {
          continue;
        }
        mctx.fillStyle = ownerColor(u.owner);
        const r = u.owner === o ? 2 : hasRadar && u.owner !== o ? 2.5 : 2;
        mctx.fillRect(u.x * sx - r / 2, u.y * sy - r / 2, r, r);
      }

      // worm blips
      if (game.worms) {
        for (const w of game.worms) {
          if (
            D.Map.fogVisible(game) &&
            !game.replay &&
            !D.Map.isVisible(game, o, Math.floor(w.x), Math.floor(w.y)) &&
            !D.Map.isExplored(game, o, Math.floor(w.x), Math.floor(w.y))
          ) {
            continue;
          }
          mctx.strokeStyle = w.phase === 'rumble' ? '#c9a227' : '#5c3a14';
          mctx.lineWidth = 1.5;
          mctx.beginPath();
          mctx.arc(w.x * sx, w.y * sy, w.phase === 'surface' ? 4 : 3, 0, Math.PI * 2);
          mctx.stroke();
        }
      }

      // camera rect
      const t = ts();
      mctx.strokeStyle = '#fff';
      mctx.lineWidth = 1;
      mctx.strokeRect(
        (game.camera.x / t) * sx,
        (game.camera.y / t) * sy,
        (viewW / t) * sx,
        (viewH / t) * sy
      );
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
