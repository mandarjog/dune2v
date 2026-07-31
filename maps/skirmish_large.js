/* global Dune2 */
/**
 * 96×96 default skirmish map — procedurally stamped terrain.
 * Spawns: player SW, enemy NE (farther apart than classic 64²).
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});
  D.MAPS = D.MAPS || {};

  const W = 96;
  const H = 96;
  const N = W * H;

  // Terrain ids (match D.config.terrain)
  const SAND = 0;
  const DUNE = 1;
  const ROCK = 2;
  const SPICE = 3;
  const SPICE_HEAVY = 4;
  const CLIFF = 5;

  const tiles = new Uint8Array(N);
  const spiceAmount = new Float32Array(N);

  function idx(x, y) {
    return y * W + x;
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < W && y < H;
  }

  function setTile(x, y, t) {
    if (!inBounds(x, y)) return;
    tiles[idx(x, y)] = t;
  }

  function getTile(x, y) {
    if (!inBounds(x, y)) return CLIFF;
    return tiles[idx(x, y)];
  }

  /** Soft ellipse stamp: cells with dist²/rx² + dist²/ry² <= 1 */
  function stampEllipse(cx, cy, rx, ry, terrain, opts) {
    opts = opts || {};
    const x0 = Math.max(0, Math.floor(cx - rx - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + rx + 1));
    const y0 = Math.max(0, Math.floor(cy - ry - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + ry + 1));
    const rx2 = rx * rx || 1;
    const ry2 = ry * ry || 1;
    const onlyOver = opts.onlyOver; // array of allowed existing tiles, or null = any
    const skipCliff = opts.skipCliff !== false;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        const cur = getTile(x, y);
        if (skipCliff && cur === CLIFF) continue;
        if (onlyOver && onlyOver.indexOf(cur) < 0) continue;
        setTile(x, y, terrain);
      }
    }
  }

  /** Irregular rock plateau via overlapping ellipses */
  function stampRockPlateau(cx, cy, baseR, blobs) {
    stampEllipse(cx, cy, baseR, baseR * 0.85, ROCK);
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      stampEllipse(cx + b[0], cy + b[1], b[2], b[3] != null ? b[3] : b[2], ROCK);
    }
  }

  /**
   * Spice field: outer normal spice ring, heavy core.
   * amountNormal / amountHeavy written into spiceAmount.
   */
  function stampSpiceField(cx, cy, rOuter, rHeavy, amountNormal, amountHeavy) {
    const x0 = Math.max(0, Math.floor(cx - rOuter - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + rOuter + 1));
    const y0 = Math.max(0, Math.floor(cy - rOuter - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + rOuter + 1));
    const rO2 = rOuter * rOuter;
    const rH2 = rHeavy * rHeavy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > rO2) continue;
        const cur = getTile(x, y);
        if (cur === CLIFF || cur === ROCK) continue;
        const i = idx(x, y);
        if (d2 <= rH2) {
          tiles[i] = SPICE_HEAVY;
          spiceAmount[i] = amountHeavy;
        } else {
          tiles[i] = SPICE;
          spiceAmount[i] = amountNormal;
        }
      }
    }
  }

  // --- base: open sand ---
  tiles.fill(SAND);

  // Border cliffs (1-tile frame)
  for (let x = 0; x < W; x++) {
    setTile(x, 0, CLIFF);
    setTile(x, H - 1, CLIFF);
  }
  for (let y = 0; y < H; y++) {
    setTile(0, y, CLIFF);
    setTile(W - 1, y, CLIFF);
  }

  // Scattered dunes (visual only, walkable)
  const dunePatches = [
    [22, 30, 5, 3],
    [40, 18, 4, 6],
    [55, 40, 6, 3],
    [70, 55, 5, 4],
    [28, 60, 4, 5],
    [48, 72, 6, 3],
    [18, 45, 3, 4],
    [75, 28, 4, 3],
    [60, 80, 5, 3],
    [35, 50, 3, 3],
  ];
  for (let i = 0; i < dunePatches.length; i++) {
    const d = dunePatches[i];
    stampEllipse(d[0], d[1], d[2], d[3], DUNE, { onlyOver: [SAND] });
  }

  // Player rock plateau — SW (around spawn ~14,78)
  stampRockPlateau(16, 76, 9, [
    [-6, -4, 5, 4],
    [5, -3, 4, 5],
    [-3, 5, 5, 4],
    [4, 4, 4, 3],
    [-8, 2, 3, 4],
    [7, 1, 3, 3],
  ]);
  // Extra expansion rock SW
  stampRockPlateau(28, 68, 5, [
    [4, -3, 3, 3],
    [-2, 3, 3, 2],
  ]);

  // Enemy rock plateau — NE (around spawn ~80,16)
  stampRockPlateau(79, 18, 9, [
    [6, 4, 5, 4],
    [-5, 3, 4, 5],
    [3, -5, 5, 4],
    [-4, -4, 4, 3],
    [8, -2, 3, 4],
    [-7, -1, 3, 3],
  ]);
  // Extra expansion rock NE
  stampRockPlateau(67, 28, 5, [
    [-4, 3, 3, 3],
    [2, -3, 3, 2],
  ]);

  // Mid rock islands (flanking / choke interest, leave sand corridors)
  stampRockPlateau(48, 48, 6, [
    [5, 2, 3, 3],
    [-4, -3, 3, 2],
    [2, -5, 2, 3],
  ]);
  stampRockPlateau(38, 32, 4, [[3, 1, 2, 2]]);
  stampRockPlateau(58, 62, 4, [[-2, -2, 2, 2]]);

  // Ensure sand corridors cut through mid rock so paths stay open
  // Horizontal corridor through center band
  for (let x = 30; x <= 66; x++) {
    for (let dy = -1; dy <= 1; dy++) {
      const y = 48 + dy;
      if (getTile(x, y) === ROCK) setTile(x, y, SAND);
    }
  }
  // Diagonal-ish SE–NW sand lane
  for (let t = 0; t < 40; t++) {
    const x = 28 + t;
    const y = 70 - t;
    for (let o = -1; o <= 1; o++) {
      if (getTile(x + o, y) === ROCK) setTile(x + o, y, SAND);
      if (getTile(x, y + o) === ROCK) setTile(x, y + o, SAND);
    }
  }

  // Spice fields: player-side, contested mid, enemy-side
  // Normal 100–400, heavy 200–800
  stampSpiceField(32, 58, 7, 3, 280, 550); // near player approach
  stampSpiceField(48, 40, 8, 3.5, 320, 700); // contested mid-north
  stampSpiceField(62, 36, 7, 3, 260, 520); // near enemy approach
  // Smaller side patches
  stampSpiceField(42, 70, 4, 1.5, 180, 400);
  stampSpiceField(54, 24, 4, 1.5, 180, 400);

  /**
   * MCV deploy needs a 2×2 rock footprint centered on the unit tile:
   *   tx = floor(x) - 1, ty = floor(y) - 1  → tiles [tx..tx+1]×[ty..ty+1] all ROCK.
   * Spawn on rock (not sand). Stamp a solid rock pad so E-deploy works immediately.
   */
  function ensureDeployPad(sx, sy) {
    // Force 3×3 rock around spawn so 2×2 CY always fits
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!inBounds(x, y) || getTile(x, y) === CLIFF) continue;
        setTile(x, y, ROCK);
        spiceAmount[idx(x, y)] = 0;
      }
    }
  }

  function canDeployAt(sx, sy) {
    // Same math as Orders.canDeploy for unit at (sx+0.5, sy+0.5)
    const tx = sx - 1;
    const ty = sy - 1;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (getTile(tx + dx, ty + dy) !== ROCK) return false;
      }
    }
    return true;
  }

  function pickSpawn(preferredX, preferredY, searchR) {
    ensureDeployPad(preferredX, preferredY);
    if (canDeployAt(preferredX, preferredY)) {
      return { x: preferredX, y: preferredY };
    }
    for (let r = 1; r <= searchR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = preferredX + dx;
          const y = preferredY + dy;
          if (!inBounds(x, y)) continue;
          ensureDeployPad(x, y);
          if (canDeployAt(x, y)) return { x: x, y: y };
        }
      }
    }
    return { x: preferredX, y: preferredY };
  }

  // Extra plateaus for FFA seats p2–p4 (NW, SE, mid-west)
  stampRockPlateau(18, 20, 7, [
    [4, 2, 4, 3],
    [-3, 4, 3, 4],
    [3, -4, 3, 3],
  ]);
  stampRockPlateau(76, 74, 7, [
    [-4, -2, 4, 3],
    [3, -4, 3, 4],
    [-3, 4, 3, 3],
  ]);
  stampRockPlateau(22, 50, 6, [
    [4, 0, 3, 3],
    [0, 4, 3, 3],
    [-3, -2, 3, 2],
  ]);

  // On home rock plateaus — NOT sand pads (those broke deploy)
  // player=Atreides SW, enemy=Harkonnen NE, p2=Ordos NW, p3=Atreides SE, p4=Harkonnen mid-W
  const playerSpawn = pickSpawn(16, 76, 8);
  const enemySpawn = pickSpawn(79, 18, 8);
  const p2Spawn = pickSpawn(18, 20, 8);
  const p3Spawn = pickSpawn(76, 74, 8);
  const p4Spawn = pickSpawn(22, 50, 8);

  // Re-assert border cliffs after all stamps
  for (let x = 0; x < W; x++) {
    setTile(x, 0, CLIFF);
    setTile(x, H - 1, CLIFF);
    spiceAmount[idx(x, 0)] = 0;
    spiceAmount[idx(x, H - 1)] = 0;
  }
  for (let y = 0; y < H; y++) {
    setTile(0, y, CLIFF);
    setTile(W - 1, y, CLIFF);
    spiceAmount[idx(0, y)] = 0;
    spiceAmount[idx(W - 1, y)] = 0;
  }

  D.MAPS.skirmish_large = {
    id: 'skirmish_large',
    name: 'Arrakis Skirmish (Large)',
    width: W,
    height: H,
    spawns: {
      player: playerSpawn,
      enemy: enemySpawn,
      p2: p2Spawn,
      p3: p3Spawn,
      p4: p4Spawn,
    },
    wormZones: [],
    tiles: tiles,
    spiceAmount: spiceAmount,
  };
})(typeof window !== 'undefined' ? window : globalThis);
