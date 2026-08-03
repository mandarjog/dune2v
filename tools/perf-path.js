#!/usr/bin/env node
'use strict';

/**
 * Backend pathfinding performance harness.
 *
 * Simulates mass army moves on skirmish_large (96×96) with starter bases +
 * extra buildings for blocked tiles — same sim code as the multiplayer server.
 *
 * Usage:
 *   node tools/perf-path.js
 *   npm run perf:path
 *
 * Env:
 *   PERF_SIZES=50,100,200   unit counts (default 50,100,200)
 *   PERF_ITERS=5            repeats per scenario (default 5; first is warmup)
 *   PERF_JSON=1             also print a JSON summary line
 */

const os = require('os');
const { loadGame, ROOT } = require('../server/game-loader');

const SIZES = String(process.env.PERF_SIZES || '50,100,200')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0);
const ITERS = Math.max(1, parseInt(process.env.PERF_ITERS || '5', 10) || 5);
/** astar | hybrid | flow — default hybrid (production). Set PERF_COMPARE=1 to run all. */
const BACKEND = process.env.PERF_BACKEND || 'hybrid';
const COMPARE = process.env.PERF_COMPARE === '1';

const D = loadGame();

function now() {
  return performance.now();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function stats(samples) {
  const a = samples.slice().sort((x, y) => x - y);
  const sum = a.reduce((s, v) => s + v, 0);
  return {
    n: a.length,
    min: a[0] || 0,
    max: a[a.length - 1] || 0,
    mean: a.length ? sum / a.length : 0,
    p50: percentile(a, 50),
    p95: percentile(a, 95),
  };
}

/** Build a mid-game-ish map: two starter bases + extra factories/walls. */
function buildWorld() {
  const game = D.Game.create();
  D.Game.startSkirmish(game, D.MAPS.skirmish_large, {
    owners: ['player', 'enemy'],
    startMode: 'base',
    names: { player: 'PerfA', enemy: 'PerfB' },
  });
  game.multiplayer = true;
  game._serverSim = true;

  // Extra structures near both bases (block pathfinding a bit like a real match)
  const extras = [
    { type: 'barracks', owner: 'player', tx: 20, ty: 72 },
    { type: 'lightFactory', owner: 'player', tx: 24, ty: 74 },
    { type: 'heavyFactory', owner: 'player', tx: 12, ty: 72 },
    { type: 'silo', owner: 'player', tx: 19, ty: 70 },
    { type: 'silo', owner: 'player', tx: 21, ty: 70 },
    { type: 'gunTurret', owner: 'player', tx: 28, ty: 70 },
    { type: 'wall', owner: 'player', tx: 30, ty: 72 },
    { type: 'wall', owner: 'player', tx: 30, ty: 73 },
    { type: 'wall', owner: 'player', tx: 30, ty: 74 },
    { type: 'barracks', owner: 'enemy', tx: 74, ty: 20 },
    { type: 'lightFactory', owner: 'enemy', tx: 70, ty: 18 },
    { type: 'heavyFactory', owner: 'enemy', tx: 78, ty: 20 },
    { type: 'silo', owner: 'enemy', tx: 76, ty: 24 },
    { type: 'gunTurret', owner: 'enemy', tx: 68, ty: 26 },
    { type: 'wall', owner: 'enemy', tx: 66, ty: 22 },
    { type: 'wall', owner: 'enemy', tx: 66, ty: 23 },
  ];
  for (const e of extras) {
    if (!D.Map.canPlace(game, e.type, e.tx, e.ty, e.owner, { skipProximity: true })) {
      // try nearby
      let placed = false;
      for (let r = 1; r <= 4 && !placed; r++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            if (D.Map.canPlace(game, e.type, e.tx + dx, e.ty + dy, e.owner, { skipProximity: true })) {
              D.Entities.createBuilding(game, e.type, e.owner, e.tx + dx, e.ty + dy, {
                complete: true,
              });
              placed = true;
            }
          }
        }
      }
      continue;
    }
    D.Entities.createBuilding(game, e.type, e.owner, e.tx, e.ty, { complete: true });
  }
  D.Map.rebuildBlocked(game);
  return game;
}

/**
 * Spawn N infantry in a grid near player spawn (walkable sand/rock).
 * Returns unit ids.
 */
function spawnArmy(game, n, owner) {
  const spawn = game.map.spawns[owner] || game.map.spawns.player;
  const ids = [];
  let x0 = (spawn && spawn.x) || 18;
  let y0 = (spawn && spawn.y) || 72;
  // Spread on sand just east of base so paths aren't all same-tile
  x0 = Math.min(game.map.width - 8, x0 + 6);
  y0 = Math.max(4, y0 - 4);

  let placed = 0;
  let row = 0;
  while (placed < n && row < 40) {
    for (let col = 0; col < 20 && placed < n; col++) {
      const x = x0 + col * 0.9 + (row % 2) * 0.4;
      const y = y0 - row * 0.9;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (!D.Map.isWalkable(game.map, tx, ty)) continue;
      const u = D.Entities.createUnit(game, 'infantry', owner, x, y);
      ids.push(u.id);
      placed++;
    }
    row++;
  }
  // Fill remainder anywhere walkable if grid was too blocked
  if (ids.length < n) {
    for (let ty = 10; ty < game.map.height - 10 && ids.length < n; ty++) {
      for (let tx = 10; tx < game.map.width - 10 && ids.length < n; tx++) {
        if (!D.Map.isWalkable(game.map, tx, ty)) continue;
        if ((tx + ty) % 3 !== 0) continue;
        const u = D.Entities.createUnit(game, 'infantry', owner, tx + 0.5, ty + 0.5);
        ids.push(u.id);
      }
    }
  }
  return ids;
}

function clearArmy(game, ids) {
  for (const id of ids) {
    const u = game.units.find((x) => x.id === id);
    if (u) D.Entities.removeUnit(game, u);
  }
}

/** Goals: short local, mid map, long diagonal toward enemy base. */
function goals(game) {
  const ps = game.map.spawns.player || { x: 16, y: 76 };
  const es = game.map.spawns.enemy || { x: 79, y: 18 };
  return {
    short: { x: ps.x + 12 + 0.5, y: ps.y - 8 + 0.5, label: 'short (~15 tiles)' },
    mid: { x: 48.5, y: 48.5, label: 'mid (map center)' },
    long: { x: es.x - 4 + 0.5, y: es.y + 6 + 0.5, label: 'long (toward enemy)' },
  };
}

/**
 * Measure Orders.issue move for N units (includes setOrder + Path.find per unit).
 */
function measureIssueMove(game, n, goal) {
  const ids = spawnArmy(game, n, 'player');
  // Clear any paths
  for (const id of ids) {
    const u = game.units.find((x) => x.id === id);
    if (u) {
      u.path = [];
      u.order = null;
    }
  }

  D.Path.resetMetrics();
  const wall0 = now();
  D.Orders.issue(game, ids, { type: 'move', x: goal.x, y: goal.y });
  const wallMs = now() - wall0;

  const st = game.stats || {};
  const m = D.Path.metrics;
  let withPath = 0;
  let pathLenSum = 0;
  for (const id of ids) {
    const u = game.units.find((x) => x.id === id);
    if (u && u.path && u.path.length) {
      withPath++;
      pathLenSum += u.path.length;
    }
  }

  const result = {
    requested: n,
    spawned: ids.length,
    wallMs,
    backend: st.pathLastBackend || m.lastBackend || '?',
    flowBuildMs: st.pathLastFlowBuildMs || m.lastFlowBuildMs || 0,
    pathBatchMs: st.pathLastIssueMs || m.batchMs || m.totalMs,
    pathFinds: st.pathLastIssueCount || m.finds,
    pathOk: st.pathLastIssueOk != null ? st.pathLastIssueOk : m.finds - m.fails,
    pathFail: m.fails,
    withPath,
    avgPathLen: withPath ? pathLenSum / withPath : 0,
    expanded: m.totalExpanded,
    avgMsPerFind: m.finds ? m.totalMs / m.finds : 0,
    maxSingleMs: m.maxMs,
    aStarFinds: m.finds,
  };

  clearArmy(game, ids);
  return result;
}

/**
 * Pure Path.find loop (no order machinery) — lower bound of A* cost.
 */
function measurePureFinds(game, n, goal) {
  const ids = spawnArmy(game, n, 'player');
  const units = ids.map((id) => game.units.find((x) => x.id === id)).filter(Boolean);
  D.Path.resetMetrics();
  const wall0 = now();
  let ok = 0;
  for (const u of units) {
    const p = D.Path.find(game.map, u.x, u.y, goal.x, goal.y);
    if (p && p.length) ok++;
  }
  const wallMs = now() - wall0;
  const m = D.Path.metrics;
  clearArmy(game, ids);
  return {
    requested: n,
    spawned: units.length,
    wallMs,
    pathFinds: m.finds,
    pathOk: ok,
    pathFail: m.fails,
    expanded: m.totalExpanded,
    avgMsPerFind: m.finds ? m.totalMs / m.finds : 0,
    maxSingleMs: m.maxMs,
  };
}

/** Sim tick cost with N units all mid-path (follow + budgeted repath). */
function measureTickLoad(game, n, goal) {
  const ids = spawnArmy(game, n, 'player');
  D.Orders.issue(game, ids, { type: 'move', x: goal.x, y: goal.y });
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t0 = now();
    D.Game.tick(game, 0.05);
    samples.push(now() - t0);
  }
  clearArmy(game, ids);
  // remove leftover projectiles noise
  game.projectiles = [];
  game.fx = [];
  return stats(samples);
}

function fmtMs(x) {
  return x.toFixed(2) + 'ms';
}

function printHost(backendLabel) {
  console.log('=== Pathfinding performance (backend / Node sim) ===');
  console.log('host     ', os.hostname());
  console.log('platform ', os.platform(), os.arch());
  console.log('cpus     ', os.cpus().length + '× ' + (os.cpus()[0] && os.cpus()[0].model));
  console.log('node     ', process.version);
  console.log('cwd      ', ROOT);
  console.log('map      ', D.MAPS.skirmish_large.width + '×' + D.MAPS.skirmish_large.height);
  console.log(
    'path     ',
    'backend=' + backendLabel,
    'flowMinGroup=' + D.config.path.flowMinGroup,
    'maxNodes=' + D.config.path.maxNodes
  );
  console.log('sizes    ', SIZES.join(', '));
  console.log('iters    ', ITERS, '(first discarded as warmup where noted)');
  console.log('');
}

function runSuite(backendName) {
  D.config.path.backend = backendName;
  if (backendName === 'astar') {
    // force A* even for large groups
    D.config.path.flowMinGroup = 99999;
  } else if (backendName === 'flow') {
    D.config.path.flowMinGroup = 1;
  } else {
    D.config.path.flowMinGroup = 5;
  }

  printHost(backendName);
  const game = buildWorld();
  console.log(
    'world    ',
    game.buildings.length + ' buildings,',
    game.units.length + ' starter units (harvesters etc.)'
  );
  const g = goals(game);
  console.log('');

  const summary = [];

  for (const dist of ['short', 'mid', 'long']) {
    const goal = g[dist];
    console.log('── Distance: ' + goal.label + '  goal=(' + goal.x.toFixed(1) + ',' + goal.y.toFixed(1) + ')');

    for (const n of SIZES) {
      const issueSamples = [];
      let lastIssue = null;

      for (let i = 0; i < ITERS; i++) {
        lastIssue = measureIssueMove(game, n, goal);
        if (i > 0 || ITERS === 1) {
          issueSamples.push(lastIssue.wallMs);
        }
      }

      const issueSt = stats(issueSamples);
      const tickSt = measureTickLoad(game, n, goal);

      const line = {
        backend: backendName,
        distance: dist,
        units: n,
        spawned: lastIssue.spawned,
        via: lastIssue.backend,
        issue_mean_ms: issueSt.mean,
        issue_p50_ms: issueSt.p50,
        issue_p95_ms: issueSt.p95,
        issue_max_ms: issueSt.max,
        flow_build_ms: lastIssue.flowBuildMs,
        with_path: lastIssue.withPath,
        avg_path_len: lastIssue.avgPathLen,
        a_star_finds: lastIssue.aStarFinds,
        tick_mean_ms: tickSt.mean,
        tick_p95_ms: tickSt.p95,
      };
      summary.push(line);

      console.log(
        '  n=' +
          String(n).padStart(3) +
          '  issue mean=' +
          fmtMs(issueSt.mean) +
          '  p50=' +
          fmtMs(issueSt.p50) +
          '  p95=' +
          fmtMs(issueSt.p95) +
          '  max=' +
          fmtMs(issueSt.max) +
          '  via=' +
          lastIssue.backend
      );
      console.log(
        '       detail  flowBuild=' +
          fmtMs(lastIssue.flowBuildMs) +
          '  ok=' +
          lastIssue.withPath +
          '/' +
          lastIssue.spawned +
          '  avgLen=' +
          lastIssue.avgPathLen.toFixed(1) +
          '  A*finds=' +
          lastIssue.aStarFinds +
          '  tick mean=' +
          fmtMs(tickSt.mean)
      );
    }
    console.log('');
  }

  console.log('── Headline: LONG move (issue wall time) [' + backendName + '] ──');
  for (const r of summary.filter((x) => x.distance === 'long')) {
    console.log(
      '  ' +
        r.units +
        ' units: mean ' +
        fmtMs(r.issue_mean_ms) +
        '  p95 ' +
        fmtMs(r.issue_p95_ms) +
        '  via=' +
        r.via +
        '  (' +
        (r.issue_mean_ms / 50).toFixed(2) +
        '× of 50ms tick)'
    );
  }
  console.log('');
  return summary;
}

function run() {
  const backends = COMPARE ? ['astar', 'hybrid', 'flow'] : [BACKEND];
  let summary = [];
  for (const b of backends) {
    if (backends.length > 1) {
      console.log('\n########## BACKEND: ' + b + ' ##########\n');
    }
    summary = summary.concat(runSuite(b));
  }

  console.log('── Guidance (20 Hz ⇒ 50ms tick budget on shared CPU) ──');
  console.log('  < 5ms   batch: invisible');
  console.log('  5–15ms  batch: fine');
  console.log('  15–40ms batch: brief hitch possible');
  console.log('  > 50ms  batch: exceeds one sim tick');
  console.log('');

  if (COMPARE) {
    console.log('── Compare LONG / 200 units ──');
    for (const b of backends) {
      const r = summary.find((x) => x.backend === b && x.distance === 'long' && x.units === 200);
      if (r) {
        console.log(
          '  ' + b.padEnd(7) + ' mean ' + fmtMs(r.issue_mean_ms) + '  via=' + r.via
        );
      }
    }
    console.log('');
  }

  if (process.env.PERF_JSON === '1') {
    console.log(
      'JSON_SUMMARY ' +
        JSON.stringify({ host: os.hostname(), node: process.version, backends, summary })
    );
  }
}

try {
  run();
} catch (err) {
  console.error('perf-path failed:', err);
  process.exit(1);
}
