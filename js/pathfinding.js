/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function key(x, y) {
    return y * 4096 + x;
  }

  function heuristic(ax, ay, bx, by) {
    // Octile
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  }

  function canStep(map, x, y, nx, ny) {
    if (!D.Map.isWalkable(map, nx, ny)) return false;
    const dx = nx - x;
    const dy = ny - y;
    if (dx !== 0 && dy !== 0) {
      // no corner cutting
      if (!D.Map.isWalkable(map, x + dx, y) || !D.Map.isWalkable(map, x, y + dy)) {
        return false;
      }
    }
    return true;
  }

  const NEIGHBORS = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  /**
   * A* on tile grid. Start/goal in tile coords (ints).
   * Returns array of {x,y} tile centers, or null.
   */
  D.Path = {
    find(map, x0, y0, x1, y1) {
      const sx = Math.floor(x0);
      const sy = Math.floor(y0);
      let gx = Math.floor(x1);
      let gy = Math.floor(y1);

      if (!D.Map.isWalkable(map, sx, sy)) return null;

      // If goal blocked, search nearby walkable
      if (!D.Map.isWalkable(map, gx, gy)) {
        let found = false;
        for (let r = 1; r <= 3 && !found; r++) {
          for (let dy = -r; dy <= r && !found; dy++) {
            for (let dx = -r; dx <= r && !found; dx++) {
              if (D.Map.isWalkable(map, gx + dx, gy + dy)) {
                gx = gx + dx;
                gy = gy + dy;
                found = true;
              }
            }
          }
        }
        if (!found) return null;
      }

      if (sx === gx && sy === gy) {
        return [{ x: gx + 0.5, y: gy + 0.5 }];
      }

      const maxNodes = D.config.path.maxNodes;
      const open = [];
      const came = new Map();
      const gScore = new Map();
      const fScore = new Map();
      const closed = new Set();

      const sk = key(sx, sy);
      gScore.set(sk, 0);
      fScore.set(sk, heuristic(sx, sy, gx, gy));
      open.push({ x: sx, y: sy, f: fScore.get(sk) });

      let expanded = 0;

      while (open.length && expanded < maxNodes) {
        // pop lowest f
        let bi = 0;
        for (let i = 1; i < open.length; i++) {
          if (open[i].f < open[bi].f) bi = i;
        }
        const cur = open[bi];
        open[bi] = open[open.length - 1];
        open.pop();
        const ck = key(cur.x, cur.y);
        if (closed.has(ck)) continue;
        closed.add(ck);
        expanded++;

        if (cur.x === gx && cur.y === gy) {
          // reconstruct
          const path = [];
          let cx = cur.x;
          let cy = cur.y;
          path.push({ x: cx + 0.5, y: cy + 0.5 });
          let k = key(cx, cy);
          while (came.has(k)) {
            const p = came.get(k);
            cx = p.x;
            cy = p.y;
            path.push({ x: cx + 0.5, y: cy + 0.5 });
            k = key(cx, cy);
          }
          path.reverse();
          // drop first if it's start tile
          if (path.length > 1) path.shift();
          return path;
        }

        for (const [dx, dy, cost] of NEIGHBORS) {
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          if (!canStep(map, cur.x, cur.y, nx, ny)) continue;
          const nk = key(nx, ny);
          if (closed.has(nk)) continue;
          const tentative = (gScore.get(ck) || 0) + cost;
          if (tentative < (gScore.get(nk) ?? Infinity)) {
            came.set(nk, { x: cur.x, y: cur.y });
            gScore.set(nk, tentative);
            const f = tentative + heuristic(nx, ny, gx, gy);
            fScore.set(nk, f);
            open.push({ x: nx, y: ny, f });
          }
        }
      }
      return null;
    },

    canStep,
  };
})(typeof window !== 'undefined' ? window : globalThis);
