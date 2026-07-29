/* global Dune2 */
/**
 * Procedural geometric sprites for buildings & units.
 * No external assets — drawn with Canvas 2D paths.
 * draw*(ctx, x, y, w, h, opts) — top-left box in pixel space.
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const iconCache = new Map();

  function shade(hex, amt) {
    // amt -1..1
    const n = hex.replace('#', '');
    const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
    const num = parseInt(full, 16);
    let r = (num >> 16) & 255;
    let g = (num >> 8) & 255;
    let b = num & 255;
    r = Math.max(0, Math.min(255, r + Math.round(255 * amt)));
    g = Math.max(0, Math.min(255, g + Math.round(255 * amt)));
    b = Math.max(0, Math.min(255, b + Math.round(255 * amt)));
    return `rgb(${r},${g},${b})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function basePad(ctx, x, y, w, h, col, opts) {
    const pad = opts.pad != null ? opts.pad : 0.06;
    const px = w * pad;
    const py = h * pad;
    // foundation slab
    ctx.fillStyle = 'rgba(30,28,24,0.85)';
    ctx.fillRect(x, y, w, h);
    // main body
    const bx = x + px;
    const by = y + py;
    const bw = w - px * 2;
    const bh = h - py * 2;
    const grad = ctx.createLinearGradient(bx, by, bx, by + bh);
    grad.addColorStop(0, shade(col, 0.18));
    grad.addColorStop(0.5, col);
    grad.addColorStop(1, shade(col, -0.28));
    ctx.fillStyle = grad;
    roundRect(ctx, bx, by, bw, bh, Math.min(bw, bh) * 0.08);
    ctx.fill();
    ctx.strokeStyle = shade(col, -0.45);
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.04);
    ctx.stroke();
    // top highlight edge
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + 2, by + 2);
    ctx.lineTo(bx + bw - 2, by + 2);
    ctx.stroke();
    return { bx, by, bw, bh, m: Math.min(bw, bh) };
  }

  function accent(ctx, col) {
    return shade(col, 0.35);
  }

  function metal(ctx, x, y, w, h) {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#9a9a9a');
    g.addColorStop(0.5, '#6a6a6a');
    g.addColorStop(1, '#3a3a3a');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#222';
    ctx.strokeRect(x, y, w, h);
  }

  function sandTone() {
    return '#c2a05a';
  }

  // ─── Buildings ───────────────────────────────────────────

  function drawConcrete(ctx, x, y, w, h) {
    ctx.fillStyle = '#7a7a7a';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.strokeStyle = '#555';
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    // tile seams
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + 2);
    ctx.lineTo(x + w / 2, y + h - 2);
    ctx.moveTo(x + 2, y + h / 2);
    ctx.lineTo(x + w - 2, y + h / 2);
    ctx.stroke();
  }

  function drawConstructionYard(ctx, x, y, w, h, col) {
    const b = basePad(ctx, x, y, w, h, col, {});
    // crane arm
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = Math.max(2, b.m * 0.08);
    ctx.beginPath();
    ctx.moveTo(b.bx + b.bw * 0.2, b.by + b.bh * 0.75);
    ctx.lineTo(b.bx + b.bw * 0.2, b.by + b.bh * 0.15);
    ctx.lineTo(b.bx + b.bw * 0.75, b.by + b.bh * 0.2);
    ctx.stroke();
    // hook
    ctx.beginPath();
    ctx.moveTo(b.bx + b.bw * 0.75, b.by + b.bh * 0.2);
    ctx.lineTo(b.bx + b.bw * 0.75, b.by + b.bh * 0.45);
    ctx.stroke();
    ctx.fillStyle = '#f0c040';
    ctx.fillRect(b.bx + b.bw * 0.7, b.by + b.bh * 0.45, b.bw * 0.1, b.bh * 0.12);
    // cabin
    metal(ctx, b.bx + b.bw * 0.35, b.by + b.bh * 0.5, b.bw * 0.35, b.bh * 0.35);
    ctx.fillStyle = accent(ctx, col);
    ctx.fillRect(b.bx + b.bw * 0.4, b.by + b.bh * 0.55, b.bw * 0.12, b.bh * 0.1);
  }

  function drawWindtrap(ctx, x, y, w, h, col, opts) {
    const b = basePad(ctx, x, y, w, h, col, {});
    const cx = b.bx + b.bw * 0.5;
    const cy = b.by + b.bh * 0.48;
    const r = b.m * 0.32;
    // tower
    metal(ctx, cx - b.bw * 0.08, b.by + b.bh * 0.55, b.bw * 0.16, b.bh * 0.35);
    // rotor hub
    ctx.fillStyle = '#eee';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    // blades (animate with time if provided)
    const ang = opts.time != null ? opts.time * 2.5 : 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(230,230,240,0.92)';
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 0.15, -r * 0.15);
      ctx.lineTo(0, -r);
      ctx.lineTo(-r * 0.15, -r * 0.15);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // glow ring when powered
    if (opts.powered !== false) {
      ctx.strokeStyle = 'rgba(120,200,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawRefinery(ctx, x, y, w, h, col) {
    const b = basePad(ctx, x, y, w, h, col, {});
    // spice tanks
    for (let i = 0; i < 2; i++) {
      const tx = b.bx + b.bw * (0.12 + i * 0.28);
      const ty = b.by + b.bh * 0.2;
      const tw = b.bw * 0.22;
      const th = b.bh * 0.55;
      const g = ctx.createLinearGradient(tx, ty, tx + tw, ty);
      g.addColorStop(0, '#e09020');
      g.addColorStop(0.5, '#c06000');
      g.addColorStop(1, '#8a4000');
      ctx.fillStyle = g;
      roundRect(ctx, tx, ty, tw, th, tw * 0.2);
      ctx.fill();
      ctx.strokeStyle = '#4a2000';
      ctx.stroke();
      // band
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(tx, ty + th * 0.4, tw, th * 0.12);
    }
    // dock bay
    metal(ctx, b.bx + b.bw * 0.62, b.by + b.bh * 0.35, b.bw * 0.3, b.bh * 0.5);
    ctx.fillStyle = '#222';
    ctx.fillRect(b.bx + b.bw * 0.68, b.by + b.bh * 0.55, b.bw * 0.18, b.bh * 0.28);
    // chimney
    ctx.fillStyle = '#444';
    ctx.fillRect(b.bx + b.bw * 0.72, b.by + b.bh * 0.1, b.bw * 0.08, b.bh * 0.28);
  }

  function drawSilo(ctx, x, y, w, h, col) {
    const b = basePad(ctx, x, y, w, h, col, {});
    const cx = b.bx + b.bw * 0.5;
    const top = b.by + b.bh * 0.12;
    const bot = b.by + b.bh * 0.88;
    const rad = b.bw * 0.32;
    // cylinder
    const g = ctx.createLinearGradient(cx - rad, 0, cx + rad, 0);
    g.addColorStop(0, '#d4881a');
    g.addColorStop(0.45, '#f0b040');
    g.addColorStop(1, '#8a5010');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - rad, top + rad * 0.4);
    ctx.lineTo(cx - rad, bot - rad * 0.2);
    ctx.quadraticCurveTo(cx - rad, bot, cx, bot);
    ctx.quadraticCurveTo(cx + rad, bot, cx + rad, bot - rad * 0.2);
    ctx.lineTo(cx + rad, top + rad * 0.4);
    ctx.ellipse(cx, top + rad * 0.4, rad, rad * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade('#e0a030', 0.2);
    ctx.beginPath();
    ctx.ellipse(cx, top + rad * 0.4, rad, rad * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    // house stripe
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - rad * 0.7, (top + bot) / 2);
    ctx.lineTo(cx + rad * 0.7, (top + bot) / 2);
    ctx.stroke();
  }

  function drawBarracks(ctx, x, y, w, h, col) {
    const b = basePad(ctx, x, y, w, h, col, {});
    // pitched roof
    ctx.fillStyle = shade(col, -0.35);
    ctx.beginPath();
    ctx.moveTo(b.bx + b.bw * 0.08, b.by + b.bh * 0.42);
    ctx.lineTo(b.bx + b.bw * 0.5, b.by + b.bh * 0.12);
    ctx.lineTo(b.bx + b.bw * 0.92, b.by + b.bh * 0.42);
    ctx.closePath();
    ctx.fill();
    // body
    ctx.fillStyle = shade(col, -0.1);
    ctx.fillRect(b.bx + b.bw * 0.12, b.by + b.bh * 0.42, b.bw * 0.76, b.bh * 0.45);
    // door
    ctx.fillStyle = '#2a2018';
    ctx.fillRect(b.bx + b.bw * 0.4, b.by + b.bh * 0.55, b.bw * 0.2, b.bh * 0.32);
    // windows
    ctx.fillStyle = '#f0e080';
    ctx.fillRect(b.bx + b.bw * 0.2, b.by + b.bh * 0.55, b.bw * 0.12, b.bh * 0.12);
    ctx.fillRect(b.bx + b.bw * 0.68, b.by + b.bh * 0.55, b.bw * 0.12, b.bh * 0.12);
    // flag
    ctx.strokeStyle = '#ccc';
    ctx.beginPath();
    ctx.moveTo(b.bx + b.bw * 0.5, b.by + b.bh * 0.12);
    ctx.lineTo(b.bx + b.bw * 0.5, b.by + b.bh * 0.02);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillRect(b.bx + b.bw * 0.5, b.by + b.bh * 0.02, b.bw * 0.18, b.bh * 0.08);
  }

  function drawLightFactory(ctx, x, y, w, h, col) {
    const b = basePad(ctx, x, y, w, h, col, {});
    metal(ctx, b.bx + b.bw * 0.1, b.by + b.bh * 0.2, b.bw * 0.8, b.bh * 0.55);
    // garage door
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(b.bx + b.bw * 0.22, b.by + b.bh * 0.4, b.bw * 0.56, b.bh * 0.32);
    ctx.strokeStyle = '#555';
    for (let i = 1; i < 4; i++) {
      const yy = b.by + b.bh * 0.4 + (b.bh * 0.32 * i) / 4;
      ctx.beginPath();
      ctx.moveTo(b.bx + b.bw * 0.22, yy);
      ctx.lineTo(b.bx + b.bw * 0.78, yy);
      ctx.stroke();
    }
    // sign: light vehicle
    ctx.fillStyle = accent(ctx, col);
    ctx.beginPath();
    ctx.moveTo(b.bx + b.bw * 0.35, b.by + b.bh * 0.28);
    ctx.lineTo(b.bx + b.bw * 0.65, b.by + b.bh * 0.28);
    ctx.lineTo(b.bx + b.bw * 0.58, b.by + b.bh * 0.36);
    ctx.lineTo(b.bx + b.bw * 0.42, b.by + b.bh * 0.36);
    ctx.closePath();
    ctx.fill();
    // smokestack
    ctx.fillStyle = '#333';
    ctx.fillRect(b.bx + b.bw * 0.78, b.by + b.bh * 0.08, b.bw * 0.1, b.bh * 0.2);
  }

  function drawHeavyFactory(ctx, x, y, w, h, col) {
    const b = basePad(ctx, x, y, w, h, col, {});
    metal(ctx, b.bx + b.bw * 0.06, b.by + b.bh * 0.18, b.bw * 0.88, b.bh * 0.6);
    // big bay
    ctx.fillStyle = '#111';
    ctx.fillRect(b.bx + b.bw * 0.15, b.by + b.bh * 0.38, b.bw * 0.7, b.bh * 0.35);
    // tank silhouette inside
    ctx.fillStyle = shade(col, 0.1);
    ctx.beginPath();
    ctx.moveTo(b.bx + b.bw * 0.28, b.by + b.bh * 0.58);
    ctx.lineTo(b.bx + b.bw * 0.35, b.by + b.bh * 0.48);
    ctx.lineTo(b.bx + b.bw * 0.65, b.by + b.bh * 0.48);
    ctx.lineTo(b.bx + b.bw * 0.72, b.by + b.bh * 0.58);
    ctx.closePath();
    ctx.fill();
    // dual stacks
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(b.bx + b.bw * 0.2, b.by + b.bh * 0.05, b.bw * 0.1, b.bh * 0.2);
    ctx.fillRect(b.bx + b.bw * 0.35, b.by + b.bh * 0.08, b.bw * 0.1, b.bh * 0.17);
    // hazard stripe
    ctx.fillStyle = '#e0c040';
    ctx.fillRect(b.bx + b.bw * 0.15, b.by + b.bh * 0.72, b.bw * 0.7, b.bh * 0.06);
    ctx.fillStyle = '#222';
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(
        b.bx + b.bw * 0.15 + i * b.bw * 0.12,
        b.by + b.bh * 0.72,
        b.bw * 0.06,
        b.bh * 0.06
      );
    }
  }

  function drawGunTurret(ctx, x, y, w, h, col, opts) {
    const b = basePad(ctx, x, y, w, h, col, { pad: 0.08 });
    const cx = b.bx + b.bw / 2;
    const cy = b.by + b.bh / 2;
    const r = b.m * 0.38;
    // base ring
    ctx.fillStyle = shade(col, -0.2);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.stroke();
    // dome
    const g = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r * 0.75);
    g.addColorStop(0, shade(col, 0.25));
    g.addColorStop(1, shade(col, -0.35));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
    ctx.fill();
    // barrel
    const ang = opts.facing != null ? opts.facing : -Math.PI / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    metal(ctx, r * 0.3, -r * 0.12, r * 0.95, r * 0.24);
    ctx.fillStyle = '#222';
    ctx.fillRect(r * 1.1, -r * 0.08, r * 0.2, r * 0.16);
    ctx.restore();
  }

  function drawWall(ctx, x, y, w, h, col) {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, shade(col, 0.15));
    g.addColorStop(1, shade(col, -0.35));
    ctx.fillStyle = g;
    ctx.fillRect(x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.84);
    ctx.strokeStyle = '#111';
    ctx.strokeRect(x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.84);
    // battlements
    const n = 3;
    const bw = (w * 0.84) / n;
    ctx.fillStyle = shade(col, -0.1);
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) {
        ctx.fillRect(
          x + w * 0.08 + i * bw + 1,
          y + h * 0.02,
          bw - 2,
          h * 0.14
        );
      }
    }
  }

  function drawRadar(ctx, x, y, w, h, col, opts) {
    const b = basePad(ctx, x, y, w, h, col, {});
    const cx = b.bx + b.bw * 0.5;
    const cy = b.by + b.bh * 0.42;
    const r = b.m * 0.28;
    // dish base
    metal(ctx, cx - b.bw * 0.06, cy, b.bw * 0.12, b.bh * 0.45);
    // dish
    ctx.save();
    ctx.translate(cx, cy);
    const spin = opts.time != null ? opts.time * 1.2 : 0;
    ctx.rotate(Math.sin(spin) * 0.4);
    ctx.fillStyle = '#d0d8e0';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.3, r * 0.55, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#445';
    ctx.stroke();
    // sweep glow
    ctx.fillStyle = 'rgba(100,220,140,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r * 1.1, spin, spin + 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // screen blip box
    ctx.fillStyle = '#0a2010';
    ctx.fillRect(b.bx + b.bw * 0.15, b.by + b.bh * 0.72, b.bw * 0.7, b.bh * 0.16);
    ctx.fillStyle = '#3f8';
    ctx.beginPath();
    ctx.arc(
      b.bx + b.bw * (0.3 + 0.4 * (0.5 + 0.5 * Math.sin((opts.time || 0) * 3))),
      b.by + b.bh * 0.8,
      2,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // ─── Units ───────────────────────────────────────────────

  function drawInfantry(ctx, x, y, w, h, col) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    // body
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.08, s * 0.28, 0, Math.PI * 2);
    ctx.fill();
    // head
    ctx.fillStyle = shade(col, 0.2);
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.22, s * 0.16, 0, Math.PI * 2);
    ctx.fill();
    // rifle
    ctx.strokeStyle = '#222';
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.1, cy);
    ctx.lineTo(cx + s * 0.42, cy - s * 0.05);
    ctx.stroke();
  }

  function drawTrooper(ctx, x, y, w, h, col) {
    drawInfantry(ctx, x, y, w, h, col);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    // rocket tube on shoulder
    ctx.fillStyle = '#333';
    ctx.fillRect(cx - s * 0.35, cy - s * 0.15, s * 0.2, s * 0.35);
    ctx.fillStyle = '#555';
    ctx.fillRect(cx - s * 0.38, cy - s * 0.2, s * 0.26, s * 0.1);
  }

  function drawTrike(ctx, x, y, w, h, col, opts) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(opts.facing || 0);
    // body
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(s * 0.4, 0);
    ctx.lineTo(s * 0.1, -s * 0.28);
    ctx.lineTo(-s * 0.35, -s * 0.22);
    ctx.lineTo(-s * 0.35, s * 0.22);
    ctx.lineTo(s * 0.1, s * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.stroke();
    // wheels
    ctx.fillStyle = '#222';
    [[-0.2, -0.3], [-0.2, 0.3], [0.2, 0]].forEach(([wx, wy]) => {
      ctx.beginPath();
      ctx.arc(s * wx, s * wy, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawQuad(ctx, x, y, w, h, col, opts) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(opts.facing || 0);
    ctx.fillStyle = col;
    roundRect(ctx, -s * 0.4, -s * 0.28, s * 0.8, s * 0.56, s * 0.08);
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.stroke();
    // turret
    ctx.fillStyle = shade(col, -0.15);
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2);
    ctx.fill();
    metal(ctx, s * 0.1, -s * 0.05, s * 0.35, s * 0.1);
    // 4 wheels
    ctx.fillStyle = '#1a1a1a';
    [
      [-0.28, -0.32],
      [-0.28, 0.32],
      [0.22, -0.32],
      [0.22, 0.32],
    ].forEach(([wx, wy]) => {
      ctx.beginPath();
      ctx.arc(s * wx, s * wy, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawCombatTank(ctx, x, y, w, h, col, opts) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(opts.facing || 0);
    // treads
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(-s * 0.42, -s * 0.34, s * 0.84, s * 0.16);
    ctx.fillRect(-s * 0.42, s * 0.18, s * 0.84, s * 0.16);
    // hull
    ctx.fillStyle = col;
    roundRect(ctx, -s * 0.38, -s * 0.22, s * 0.76, s * 0.44, s * 0.06);
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.stroke();
    // turret
    ctx.fillStyle = shade(col, -0.12);
    ctx.beginPath();
    ctx.arc(-s * 0.05, 0, s * 0.18, 0, Math.PI * 2);
    ctx.fill();
    // cannon
    metal(ctx, s * 0.05, -s * 0.06, s * 0.48, s * 0.12);
    ctx.restore();
  }

  function drawHarvester(ctx, x, y, w, h, col, opts) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(opts.facing || 0);
    // body
    ctx.fillStyle = col;
    roundRect(ctx, -s * 0.45, -s * 0.28, s * 0.9, s * 0.56, s * 0.06);
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.stroke();
    // cabin
    metal(ctx, s * 0.1, -s * 0.18, s * 0.28, s * 0.36);
    ctx.fillStyle = accent(ctx, col);
    ctx.fillRect(s * 0.16, -s * 0.1, s * 0.12, s * 0.1);
    // spice hopper
    const cargo = opts.cargoRatio != null ? opts.cargoRatio : 0;
    ctx.fillStyle = '#3a2a10';
    ctx.fillRect(-s * 0.38, -s * 0.18, s * 0.4, s * 0.36);
    ctx.fillStyle = '#e09020';
    ctx.fillRect(-s * 0.38, -s * 0.18 + s * 0.36 * (1 - cargo), s * 0.4, s * 0.36 * cargo);
    // scoop
    ctx.fillStyle = '#555';
    ctx.fillRect(-s * 0.55, -s * 0.12, s * 0.12, s * 0.24);
    ctx.restore();
  }

  function drawMCV(ctx, x, y, w, h, col, opts) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(w, h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(opts.facing || 0);
    // trailer
    ctx.fillStyle = col;
    roundRect(ctx, -s * 0.48, -s * 0.3, s * 0.7, s * 0.6, s * 0.05);
    ctx.fill();
    // cab
    ctx.fillStyle = shade(col, -0.15);
    roundRect(ctx, s * 0.15, -s * 0.26, s * 0.32, s * 0.52, s * 0.05);
    ctx.fill();
    ctx.fillStyle = '#89c';
    ctx.fillRect(s * 0.28, -s * 0.14, s * 0.14, s * 0.14);
    // folded crane
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-s * 0.3, -s * 0.1);
    ctx.lineTo(-s * 0.1, -s * 0.35);
    ctx.lineTo(s * 0.1, -s * 0.2);
    ctx.stroke();
    // wheels
    ctx.fillStyle = '#222';
    [-0.3, 0, 0.28].forEach((wx) => {
      ctx.fillRect(s * wx - s * 0.06, s * 0.28, s * 0.12, s * 0.1);
    });
    ctx.restore();
  }

  const buildingDrawers = {
    concrete: (ctx, x, y, w, h) => drawConcrete(ctx, x, y, w, h),
    constructionYard: drawConstructionYard,
    windtrap: drawWindtrap,
    refinery: drawRefinery,
    silo: drawSilo,
    barracks: drawBarracks,
    lightFactory: drawLightFactory,
    heavyFactory: drawHeavyFactory,
    gunTurret: drawGunTurret,
    wall: drawWall,
    radar: drawRadar,
  };

  const unitDrawers = {
    infantry: drawInfantry,
    trooper: drawTrooper,
    trike: drawTrike,
    quad: drawQuad,
    combatTank: drawCombatTank,
    harvester: drawHarvester,
    mcv: drawMCV,
  };

  D.Sprites = {
    /** Draw building into ctx at pixel rect. opts: { ownerColor, time, powered, facing, alpha } */
    drawBuilding(ctx, type, x, y, w, h, opts) {
      opts = opts || {};
      const col = opts.ownerColor || '#4a90d9';
      ctx.save();
      if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
      const fn = buildingDrawers[type];
      if (fn) fn(ctx, x, y, w, h, col, opts);
      else {
        basePad(ctx, x, y, w, h, col, {});
      }
      ctx.restore();
    },

    /** Draw unit into ctx at pixel rect centered conceptually in box. */
    drawUnit(ctx, type, x, y, w, h, opts) {
      opts = opts || {};
      const col = opts.ownerColor || '#4a90d9';
      ctx.save();
      if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
      const fn = unitDrawers[type];
      if (fn) fn(ctx, x, y, w, h, col, opts);
      else {
        ctx.fillStyle = col;
        ctx.fillRect(x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6);
      }
      ctx.restore();
    },

    /**
     * Cached square icon as a new <img> (or canvas clone) for UI.
     * Returns a fresh DOM node each call so it can be appended safely.
     */
    getIconCanvas(kind, type, size, ownerColor) {
      const key = `${kind}:${type}:${size}:${ownerColor || ''}`;
      let dataUrl = iconCache.get(key);
      if (!dataUrl) {
        const c = document.createElement('canvas');
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        c.width = Math.round(size * dpr);
        c.height = Math.round(size * dpr);
        const ictx = c.getContext('2d');
        ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ictx.fillStyle = '#1c1814';
        ictx.fillRect(0, 0, size, size);
        ictx.strokeStyle = '#3d3428';
        ictx.strokeRect(0.5, 0.5, size - 1, size - 1);
        const pad = size * 0.1;
        const col = ownerColor || '#4a90d9';
        if (kind === 'building') {
          D.Sprites.drawBuilding(ictx, type, pad, pad, size - pad * 2, size - pad * 2, {
            ownerColor: col,
            time: 0.8,
            powered: true,
          });
        } else {
          D.Sprites.drawUnit(ictx, type, pad, pad, size - pad * 2, size - pad * 2, {
            ownerColor: col,
            facing: -0.4,
            cargoRatio: type === 'harvester' ? 0.6 : 0,
          });
        }
        dataUrl = c.toDataURL('image/png');
        iconCache.set(key, dataUrl);
      }
      const img = document.createElement('img');
      img.src = dataUrl;
      img.width = size;
      img.height = size;
      img.alt = type;
      img.draggable = false;
      return img;
    },

    clearCache() {
      iconCache.clear();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
