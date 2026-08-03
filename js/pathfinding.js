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

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /** Min-heap of { i, c } by cost c */
  function heapPush(h, node) {
    h.push(node);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].c <= h[i].c) break;
      const t = h[p];
      h[p] = h[i];
      h[i] = t;
      i = p;
    }
  }

  function heapPop(h) {
    const n = h.length;
    if (!n) return null;
    const out = h[0];
    const last = h.pop();
    if (n === 1) return out;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < h.length && h[l].c < h[s].c) s = l;
      if (r < h.length && h[r].c < h[s].c) s = r;
      if (s === i) break;
      const t = h[s];
      h[s] = h[i];
      h[i] = t;
      i = s;
    }
    return out;
  }

  /**
   * Nearest walkable tile within maxR of (x,y). Used for goals and unstuck starts.
   * @returns {{gx:number,gy:number}|null}
   */
  function nearestWalkable(map, x, y, maxR) {
    let gx = Math.floor(x);
    let gy = Math.floor(y);
    if (D.Map.isWalkable(map, gx, gy)) return { gx, gy };
    const R = maxR != null ? maxR : 6;
    for (let r = 1; r <= R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          if (D.Map.isWalkable(map, gx + dx, gy + dy)) {
            return { gx: gx + dx, gy: gy + dy };
          }
        }
      }
    }
    return null;
  }

  /**
   * Resolve goal to a walkable tile (same policy as A*).
   * @returns {{gx:number,gy:number}|null}
   */
  function resolveGoal(map, x1, y1) {
    return nearestWalkable(map, x1, y1, 6);
  }

  /**
   * A* + flow-field pathfinding.
   *
   * Metrics: every A* find is timed. Flow builds recorded separately.
   * Use beginBatch/endBatch around group orders or tick repaths.
   */
  D.Path = {
    metrics: {
      finds: 0,
      fails: 0,
      totalMs: 0,
      totalExpanded: 0,
      lastMs: 0,
      lastExpanded: 0,
      lastOk: false,
      maxMs: 0,
      batchActive: false,
      batchFinds: 0,
      batchMs: 0,
      batchOk: 0,
      batchFail: 0,
      batchExpanded: 0,
      // Flow field
      flowBuilds: 0,
      flowBuildMs: 0,
      flowExtracts: 0,
      flowExtractMs: 0,
      lastBackend: 'astar',
      lastFlowBuildMs: 0,
      lastFlowTiles: 0,
    },

    resetMetrics() {
      const m = D.Path.metrics;
      m.finds = 0;
      m.fails = 0;
      m.totalMs = 0;
      m.totalExpanded = 0;
      m.lastMs = 0;
      m.lastExpanded = 0;
      m.lastOk = false;
      m.maxMs = 0;
      m.batchActive = false;
      m.batchFinds = 0;
      m.batchMs = 0;
      m.batchOk = 0;
      m.batchFail = 0;
      m.batchExpanded = 0;
      m.flowBuilds = 0;
      m.flowBuildMs = 0;
      m.flowExtracts = 0;
      m.flowExtractMs = 0;
      m.lastBackend = 'astar';
      m.lastFlowBuildMs = 0;
      m.lastFlowTiles = 0;
    },

    beginBatch() {
      const m = D.Path.metrics;
      m.batchActive = true;
      m.batchFinds = 0;
      m.batchMs = 0;
      m.batchOk = 0;
      m.batchFail = 0;
      m.batchExpanded = 0;
    },

    endBatch() {
      const m = D.Path.metrics;
      m.batchActive = false;
      return {
        finds: m.batchFinds,
        ms: m.batchMs,
        ok: m.batchOk,
        fail: m.batchFail,
        expanded: m.batchExpanded,
        avgMs: m.batchFinds ? m.batchMs / m.batchFinds : 0,
        backend: m.lastBackend,
        flowBuildMs: m.lastFlowBuildMs,
      };
    },

    _record(ms, expanded, ok) {
      const m = D.Path.metrics;
      m.finds++;
      m.totalMs += ms;
      m.totalExpanded += expanded;
      m.lastMs = ms;
      m.lastExpanded = expanded;
      m.lastOk = ok;
      if (ms > m.maxMs) m.maxMs = ms;
      if (!ok) m.fails++;
      if (m.batchActive) {
        m.batchFinds++;
        m.batchMs += ms;
        m.batchExpanded += expanded;
        if (ok) m.batchOk++;
        else m.batchFail++;
      }
    },

    /**
     * Dijkstra integration field from goal + next-step toward goal.
     * @returns {{ w,h,gx,gy,cost:Float32Array,next:Int32Array,reached:number }|null}
     * next[i] = linear index of next tile toward goal, or -1 at goal / unreachable
     */
    buildFlowField(map, x1, y1) {
      const t0 = nowMs();
      const goal = resolveGoal(map, x1, y1);
      if (!goal) {
        D.Path.metrics.lastFlowBuildMs = nowMs() - t0;
        D.Path.metrics.lastBackend = 'flow';
        return null;
      }
      const { gx, gy } = goal;
      const w = map.width;
      const h = map.height;
      const n = w * h;
      // Float64: Float32 + heap "stale" checks (c !== cost[i]) dropped most nodes
      const cost = new Float64Array(n);
      const next = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        cost[i] = Infinity;
        next[i] = -1;
      }

      const gi = gy * w + gx;
      cost[gi] = 0;
      next[gi] = -1;

      const heap = [];
      heapPush(heap, { i: gi, c: 0 });
      let reached = 1;

      while (heap.length) {
        const cur = heapPop(heap);
        if (!cur) break;
        // Stale heap entry (decrease-key via re-insert)
        if (cur.c > cost[cur.i]) continue;
        const cx = cur.i % w;
        const cy = (cur.i / w) | 0;
        const base = cost[cur.i];

        for (let ni = 0; ni < 8; ni++) {
          const dx = NEIGHBORS[ni][0];
          const dy = NEIGHBORS[ni][1];
          const edge = NEIGHBORS[ni][2];
          const nx = cx + dx;
          const ny = cy + dy;
          if (!canStep(map, cx, cy, nx, ny)) continue;
          // Expand *from goal outward*: neighbor is farther from goal.
          // Next step for neighbor toward goal is the current cell.
          const nj = ny * w + nx;
          const tentative = base + edge;
          if (tentative < cost[nj]) {
            if (cost[nj] === Infinity) reached++;
            cost[nj] = tentative;
            next[nj] = cur.i;
            heapPush(heap, { i: nj, c: tentative });
          }
        }
      }

      const ms = nowMs() - t0;
      const m = D.Path.metrics;
      m.flowBuilds++;
      m.flowBuildMs += ms;
      m.lastFlowBuildMs = ms;
      m.lastFlowTiles = reached;
      m.lastBackend = 'flow';
      if (m.batchActive) m.batchMs += ms;

      return { w, h, gx, gy, cost, next, reached, buildMs: ms };
    },

    /**
     * Walk integration field into a waypoint list (tile centers).
     * @returns {Array<{x:number,y:number}>|null}
     */
    pathFromField(field, x0, y0) {
      if (!field) return null;
      const t0 = nowMs();
      const w = field.w;
      let x = Math.floor(x0);
      let y = Math.floor(y0);
      if (x < 0 || y < 0 || x >= w || y >= field.h) {
        D.Path.metrics.flowExtracts++;
        return null;
      }
      const startI = y * w + x;
      if (field.cost[startI] === Infinity) {
        D.Path.metrics.flowExtracts++;
        D.Path.metrics.flowExtractMs += nowMs() - t0;
        return null;
      }

      const maxSteps =
        (D.config.path && D.config.path.maxFlowPathSteps) || w * field.h;
      const path = [];
      let i = startI;
      let steps = 0;
      // If already on goal
      if (x === field.gx && y === field.gy) {
        path.push({ x: field.gx + 0.5, y: field.gy + 0.5 });
        D.Path.metrics.flowExtracts++;
        D.Path.metrics.flowExtractMs += nowMs() - t0;
        if (D.Path.metrics.batchActive) {
          D.Path.metrics.batchFinds++;
          D.Path.metrics.batchOk++;
        }
        return path;
      }

      while (steps < maxSteps) {
        const ni = field.next[i];
        if (ni < 0) break;
        const nx = ni % w;
        const ny = (ni / w) | 0;
        path.push({ x: nx + 0.5, y: ny + 0.5 });
        i = ni;
        x = nx;
        y = ny;
        steps++;
        if (x === field.gx && y === field.gy) break;
      }

      const ms = nowMs() - t0;
      const m = D.Path.metrics;
      m.flowExtracts++;
      m.flowExtractMs += ms;
      if (m.batchActive) {
        m.batchFinds++;
        m.batchMs += ms;
        if (path.length) m.batchOk++;
        else m.batchFail++;
      }

      return path.length ? path : null;
    },

    /**
     * Assign paths for many units to one goal using a single flow field.
     * @param {object} map
     * @param {Array<{x,y,path}>} units
     * @param {number} x1
     * @param {number} y1
     * @returns {{ ok:number, fail:number, field:object|null, buildMs:number }}
     */
    assignGroupFlow(map, units, x1, y1) {
      const field = D.Path.buildFlowField(map, x1, y1);
      let ok = 0;
      let fail = 0;
      if (!field) {
        for (const u of units) {
          u.path = [];
          fail++;
        }
        return { ok: 0, fail, field: null, buildMs: D.Path.metrics.lastFlowBuildMs };
      }
      for (const u of units) {
        const p = D.Path.pathFromField(field, u.x, u.y);
        if (p && p.length) {
          u.path = p;
          ok++;
        } else {
          // Fallback A* for units outside the reached component
          const ap = D.Path.find(map, u.x, u.y, x1, y1);
          if (ap && ap.length) {
            u.path = ap;
            ok++;
          } else {
            u.path = [];
            fail++;
          }
        }
      }
      D.Path.metrics.lastBackend = 'flow';
      return { ok, fail, field, buildMs: field.buildMs };
    },

    /**
     * Hybrid / configurable group point-move assignment.
     * @param {object} map
     * @param {Array} units unit objects with x,y,path
     * @param {number} x1
     * @param {number} y1
     * @returns {'flow'|'astar'}
     */
    assignGroupMove(map, units, x1, y1) {
      const cfg = (D.config && D.config.path) || {};
      const backend = cfg.backend || 'hybrid';
      const minG = cfg.flowMinGroup != null ? cfg.flowMinGroup : 5;
      const n = units.length;
      const useFlow =
        backend === 'flow' || (backend === 'hybrid' && n >= minG);

      if (useFlow && n > 0) {
        D.Path.assignGroupFlow(map, units, x1, y1);
        return 'flow';
      }
      // Per-unit A*
      D.Path.metrics.lastBackend = 'astar';
      D.Path.metrics.lastFlowBuildMs = 0;
      for (const u of units) {
        u.path = D.Path.find(map, u.x, u.y, x1, y1) || [];
      }
      return 'astar';
    },

    find(map, x0, y0, x1, y1) {
      const t0 = nowMs();
      let expanded = 0;

      // Units can drift onto blocked tiles (buildings/cliffs) after combat push;
      // snap start so we don't hard-fail pathing and flash "stuck".
      let sx = Math.floor(x0);
      let sy = Math.floor(y0);
      if (!D.Map.isWalkable(map, sx, sy)) {
        const start = nearestWalkable(map, x0, y0, 4);
        if (!start) {
          D.Path._record(nowMs() - t0, 0, false);
          return null;
        }
        sx = start.gx;
        sy = start.gy;
      }
      const goal = resolveGoal(map, x1, y1);

      if (!goal) {
        D.Path._record(nowMs() - t0, 0, false);
        return null;
      }
      const gx = goal.gx;
      const gy = goal.gy;

      if (sx === gx && sy === gy) {
        D.Path._record(nowMs() - t0, 0, true);
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
          D.Path._record(nowMs() - t0, expanded, true);
          return path;
        }

        for (const [dx, dy, costN] of NEIGHBORS) {
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          if (!canStep(map, cur.x, cur.y, nx, ny)) continue;
          const nk = key(nx, ny);
          if (closed.has(nk)) continue;
          const tentative = (gScore.get(ck) || 0) + costN;
          if (tentative < (gScore.get(nk) ?? Infinity)) {
            came.set(nk, { x: cur.x, y: cur.y });
            gScore.set(nk, tentative);
            const f = tentative + heuristic(nx, ny, gx, gy);
            fScore.set(nk, f);
            open.push({ x: nx, y: ny, f });
          }
        }
      }
      D.Path._record(nowMs() - t0, expanded, false);
      return null;
    },

    canStep,
    resolveGoal,
    nearestWalkable,
  };
})(typeof window !== 'undefined' ? window : globalThis);
