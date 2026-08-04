/* global Dune2 */
/**
 * 96×96 skirmish map — procedurally stamped terrain.
 * Spawns: player SW, enemy NE, p2 NW, p3 SE, p4 mid-W (with jitter).
 *
 * Call D.MAPS.generateSkirmishLarge(seed) for a fresh layout.
 * D.MAPS.skirmish_large is the classic fixed seed-42 layout (tests / SP default).
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

  /**
   * @param {number} [seed] map RNG seed (default 42 = classic layout)
   * @returns {object} map def for Map.createFromDef
   */
  function generateSkirmishLarge(seed) {
    seed = seed != null ? seed >>> 0 : 42;
    // Local mulberry32 so we don't clobber D.rng mid-game generation
    let state = seed || 1;
    function rnd() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function rint(a, b) {
      return a + Math.floor(rnd() * (b - a + 1));
    }
    function rjitter(base, amp) {
      return base + (rnd() * 2 - 1) * amp;
    }

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

    function stampEllipse(cx, cy, rx, ry, terrain, opts) {
      opts = opts || {};
      const x0 = Math.max(0, Math.floor(cx - rx - 1));
      const x1 = Math.min(W - 1, Math.ceil(cx + rx + 1));
      const y0 = Math.max(0, Math.floor(cy - ry - 1));
      const y1 = Math.min(H - 1, Math.ceil(cy + ry + 1));
      const onlyOver = opts.onlyOver;
      const skipCliff = opts.skipCliff !== false;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5 - cx) / (rx || 1);
          const dy = (y + 0.5 - cy) / (ry || 1);
          if (dx * dx + dy * dy > 1) continue;
          const cur = getTile(x, y);
          if (skipCliff && cur === CLIFF) continue;
          if (onlyOver && onlyOver.indexOf(cur) < 0) continue;
          setTile(x, y, terrain);
        }
      }
    }

    function stampRockPlateau(cx, cy, baseR, blobs) {
      stampEllipse(cx, cy, baseR, baseR * 0.85, ROCK);
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        stampEllipse(cx + b[0], cy + b[1], b[2], b[3] != null ? b[3] : b[2], ROCK);
      }
    }

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

    function randomBlobs(n, maxOff, rMin, rMax) {
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push([
          rjitter(0, maxOff),
          rjitter(0, maxOff),
          rint(rMin, rMax),
          rint(rMin, rMax),
        ]);
      }
      return out;
    }

    // --- base: open sand ---
    tiles.fill(SAND);
    for (let x = 0; x < W; x++) {
      setTile(x, 0, CLIFF);
      setTile(x, H - 1, CLIFF);
    }
    for (let y = 0; y < H; y++) {
      setTile(0, y, CLIFF);
      setTile(W - 1, y, CLIFF);
    }

    // Scattered dunes
    const duneCount = rint(8, 14);
    for (let i = 0; i < duneCount; i++) {
      stampEllipse(
        rint(8, W - 9),
        rint(8, H - 9),
        rint(3, 7),
        rint(2, 6),
        DUNE,
        { onlyOver: [SAND] }
      );
    }

    // Home plateaus — corners stay fair, positions jitter
    // player SW, enemy NE, p2 NW, p3 SE, p4 mid-W
    const homes = [
      { seat: 'player', cx: rint(12, 22), cy: rint(70, 80), r: rint(8, 10) },
      { seat: 'enemy', cx: rint(74, 84), cy: rint(14, 24), r: rint(8, 10) },
      { seat: 'p2', cx: rint(14, 24), cy: rint(14, 26), r: rint(6, 8) },
      { seat: 'p3', cx: rint(72, 82), cy: rint(70, 80), r: rint(6, 8) },
      { seat: 'p4', cx: rint(16, 28), cy: rint(44, 56), r: rint(5, 7) },
    ];
    for (const h of homes) {
      stampRockPlateau(h.cx, h.cy, h.r, randomBlobs(rint(4, 7), h.r * 0.7, 2, 5));
      // Expansion rock toward map center
      const towardX = (W / 2 - h.cx) * 0.35;
      const towardY = (H / 2 - h.cy) * 0.35;
      stampRockPlateau(
        h.cx + towardX + rjitter(0, 3),
        h.cy + towardY + rjitter(0, 3),
        rint(4, 6),
        randomBlobs(3, 4, 2, 3)
      );
    }

    // Mid rock islands
    const midN = rint(2, 5);
    for (let i = 0; i < midN; i++) {
      stampRockPlateau(
        rint(32, 64),
        rint(32, 64),
        rint(3, 6),
        randomBlobs(rint(2, 4), 4, 2, 3)
      );
    }

    // Sand corridors so pathing stays open through mid
    const corrY = rint(44, 52);
    for (let x = 28; x <= 68; x++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (getTile(x, corrY + dy) === ROCK) setTile(x, corrY + dy, SAND);
      }
    }
    const laneX0 = rint(24, 32);
    const laneY0 = rint(66, 74);
    for (let t = 0; t < 42; t++) {
      const x = laneX0 + t;
      const y = laneY0 - t;
      for (let o = -1; o <= 1; o++) {
        if (getTile(x + o, y) === ROCK) setTile(x + o, y, SAND);
        if (getTile(x, y + o) === ROCK) setTile(x, y + o, SAND);
      }
    }

    // Spice fields — near each home approach + contested mid
    for (const h of homes) {
      const ax = h.cx + (W / 2 - h.cx) * 0.4 + rjitter(0, 4);
      const ay = h.cy + (H / 2 - h.cy) * 0.4 + rjitter(0, 4);
      stampSpiceField(ax, ay, rint(5, 8), rint(2, 4), rint(200, 320), rint(450, 700));
    }
    stampSpiceField(rint(40, 56), rint(36, 52), rint(6, 9), rint(2, 4), rint(280, 360), rint(550, 750));
    // Side patches
    for (let i = 0; i < rint(2, 4); i++) {
      stampSpiceField(
        rint(16, 80),
        rint(16, 80),
        rint(3, 5),
        rint(1, 2),
        rint(150, 220),
        rint(350, 480)
      );
    }

    function ensureDeployPad(sx, sy) {
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
      preferredX = Math.round(preferredX);
      preferredY = Math.round(preferredY);
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

    const spawns = {};
    for (const h of homes) {
      spawns[h.seat] = pickSpawn(h.cx, h.cy, 10);
    }

    // Re-assert border cliffs
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

    return {
      id: 'skirmish_large',
      name: 'Arrakis Skirmish (Large)',
      width: W,
      height: H,
      seed: seed,
      spawns: spawns,
      wormZones: [],
      tiles: tiles,
      spiceAmount: spiceAmount,
    };
  }

  D.MAPS.generateSkirmishLarge = generateSkirmishLarge;
  // Classic fixed layout for SP default / tests that expect seed 42 shape
  D.MAPS.skirmish_large = generateSkirmishLarge(42);
})(typeof window !== 'undefined' ? window : globalThis);
