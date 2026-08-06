/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const BASE_DT = 0.05;
  /** Must match server/room-sim.js STATE_EVERY — old recordings burned one id per snapshot. */
  const STATE_EVERY = 2;

  function formatClock(ticks) {
    const sec = Math.max(0, Math.floor((ticks || 0) * BASE_DT));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /**
   * Replay from command-stream recordings (format cmd-v1).
   * Also accepts legacy snapshot "frames" recordings.
   */
  D.Replay = {
    active: false,
    recording: null,
    events: [],
    eventIndex: 0,
    speed: 1,
    _acc: 0,
    _playing: false,
    _targetTick: 0,
    _scrubbing: false,
    game: null,

    isActive() {
      return !!D.Replay.active;
    },

    baseDt() {
      return BASE_DT;
    },

    durationTicks() {
      const rec = D.Replay.recording;
      if (!rec) return 0;
      if (rec.durationTicks != null && rec.durationTicks > 0) return rec.durationTicks | 0;
      const ev = D.Replay.events;
      if (!ev.length) return 0;
      let max = 0;
      for (const e of ev) if ((e.t | 0) > max) max = e.t | 0;
      return max;
    },

    currentTick(game) {
      return (game && game.tick) || 0;
    },

    formatClock,

    async list() {
      const res = await fetch('/api/recordings', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'list_failed');
      return data.recordings || [];
    },

    async load(id) {
      const res = await fetch('/api/recordings/' + encodeURIComponent(id), {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'load_failed');
      return data.recording;
    },

    start(game, recording, opts) {
      if (!game || !recording) return false;
      opts = opts || {};

      const events = recording.events || recording.frames || [];
      if (!events.length) return false;

      // Capture viewer seat BEFORE leave() clears Net.seat — otherwise every
      // Watch forces localOwner='player' and flips victory/defeat for guests.
      const viewSeat = D.Replay._resolveViewSeat(game, recording, opts);

      D.Replay.stop(game);

      // Drop MP socket so leftover state snapshots cannot stomp the replay
      // (host often still connected after match_end; guest may already have left).
      if (D.Net && typeof D.Net.leave === 'function') {
        try {
          D.Net.leave();
        } catch (e) {
          /* ignore */
        }
      }

      // Detect format
      const isCmd =
        recording.format === 'cmd-v1' ||
        (events[0] && (events[0].type === 'init' || events[0].type === 'cmd'));

      D.Replay.game = game;
      D.Replay.recording = recording;
      D.Replay.events = events;
      D.Replay.eventIndex = 0;
      D.Replay.speed = 1;
      D.Replay._acc = 0;
      D.Replay._playing = true;
      D.Replay.active = true;
      D.Replay._isCmd = isCmd;
      D.Replay._frameIndex = 0;
      D.Replay._scrubbing = false;
      D.Replay._endShown = false;
      D.Replay._viewSeat = viewSeat;
      // Pre-fix recordings: serialize() called nextId() every snapshot and on
      // init, so live entity ids (produce buildingId, order unit ids) do not
      // match a clean re-sim. Emulate those burns so cmds resolve.
      D.Replay._idBurnCompat = recording.idStable !== true;

      // Authoritative winner from meta (end event applied later may refine)
      const metaWinner =
        recording.winner !== undefined && recording.winner !== null
          ? recording.winner
          : null;

      // Match server: multiplayer + _serverSim so combat/orders take the same branches
      game.multiplayer = true;
      game.replay = true;
      game._serverSim = true; // allow Game.tick
      game.phase = 'playing';
      game.winner = null;
      game.playerNames = recording.names || null;
      // Prefer the seat the viewer actually played; else neutral spectator framing
      if (viewSeat) {
        game.localOwner = viewSeat;
        game.spectator = false;
      } else {
        game.localOwner = 'player';
        game.spectator = true; // showEnd → "Match over · X wins" not flipped Victory
      }
      game.netRole = null;
      game.speedMult = 1;
      game.placement = null;
      game.selection = game.selection || { ids: [], box: null };
      game.selection.ids = [];
      game.selection.box = null;
      if (metaWinner != null) game._recordingWinner = metaWinner;
      else game._recordingWinner = null;
      // Spectator: renderer skips FOW via game.replay (sim FOW stays on for accuracy)

      if (isCmd) {
        if (!D.Replay._bootCmd(game, events)) {
          D.Replay.stop(game);
          return false;
        }
      } else {
        if (!D.Replay._bootLegacy(game, events)) {
          D.Replay.stop(game);
          return false;
        }
      }

      if (D.Renderer) D.Renderer.rebuildTerrain(game);
      if (D.UI) {
        D.UI.hideMenu();
        if (D.UI.hideLobby) D.UI.hideLobby();
        if (D.UI.hideEnd) D.UI.hideEnd();
        if (D.UI.hideReplays) D.UI.hideReplays();
        D.UI.setChatVisible(false);
        D.UI.setMpSpeedVisible(false);
        D.UI.showReplayBar(true);
        D.UI.refreshReplayScrub(game);
        D.UI.refresh(game);
      }
      // Shareable deep link
      try {
        if (recording.id) {
          const u = new URL(location.href);
          u.searchParams.delete('room');
          u.searchParams.set('replay', recording.id);
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        }
      } catch (e) {
        /* ignore */
      }
      const a = (recording.names && recording.names.player) || 'Atreides';
      const b = (recording.names && recording.names.enemy) || 'Harkonnen';
      const mins = (D.Replay.durationTicks() * BASE_DT / 60).toFixed(1);
      D.Game.pushMessage(
        game,
        'Replay ' +
          a +
          ' vs ' +
          b +
          ' · ~' +
          mins +
          ' min sim · FOW off · scrub to skip quiet stretches · Space pause · Esc exit' +
          (recording.id ? ' · ?replay=' + recording.id : '')
      );
      return true;
    },

    /**
     * Who is watching: opts.viewAs > Net.seat > game.localOwner (if still set
     * from the match) > null (objective spectator).
     */
    _resolveViewSeat(game, recording, opts) {
      opts = opts || {};
      const seats =
        (recording && recording.owners) ||
        (game && game.activeOwners) ||
        null;
      const valid = (s) => {
        if (!s || typeof s !== 'string') return null;
        if (D.Seats && D.Seats.isSeat && !D.Seats.isSeat(s)) return null;
        if (seats && seats.length && seats.indexOf(s) < 0) return null;
        return s;
      };
      return (
        valid(opts.viewAs) ||
        valid(D.Net && D.Net.seat) ||
        valid(game && !game.spectator ? game.localOwner : null) ||
        null
      );
    },

    /** Apply recorded end outcome without thrashing draw/victory from re-sim alone. */
    _applyEndOutcome(game, ev) {
      const rec = D.Replay.recording || {};
      let winner = null;
      if (ev && ev.winner !== undefined && ev.winner !== null) winner = ev.winner;
      else if (rec.winner !== undefined && rec.winner !== null) winner = rec.winner;
      else if (game._recordingWinner != null) winner = game._recordingWinner;
      else if (game.winner != null) winner = game.winner;
      else winner = D.Replay._inferWinnerFromState(game);

      const phaseHint = (ev && ev.phase) || rec.phase || game.phase;
      if (phaseHint === 'draw' && winner == null) {
        game.phase = 'draw';
        game.winner = null;
      } else if (winner != null) {
        game.winner = winner;
        game.phase = 'ended';
      } else if (phaseHint === 'victory' || phaseHint === 'defeat') {
        // Legacy 1v1: phase was host-relative (player seat)
        game.phase = 'ended';
        game.winner = phaseHint === 'victory' ? 'player' : 'enemy';
      } else if (phaseHint === 'ended') {
        game.phase = 'ended';
      } else {
        game.phase = phaseHint || 'ended';
      }
      D.Replay._playing = false;
    },

    _inferWinnerFromState(game) {
      if (!game || !D.Game || !D.Game.isDefeated) return null;
      const owners = D.Seats ? D.Seats.active(game) : ['player', 'enemy'];
      const alive = owners.filter((o) => !D.Game.isDefeated(game, o));
      return alive.length === 1 ? alive[0] : null;
    },

    _bootCmd(game, events) {
      const init = events.find((e) => e.type === 'init');
      if (init && init.state) {
        if (!D.Save.loadInto(game, init.state)) return false;
      } else {
        const rec = D.Replay.recording || {};
        D.config.seed = rec.seed != null ? rec.seed : D.config.seed;
        D.Game.startSkirmish(game, D.MAPS.skirmish1);
      }
      // FFA: restore seats from init or recording meta (older inits lacked activeOwners)
      const recMeta = D.Replay.recording || {};
      if (init && init.state && init.state.activeOwners && init.state.activeOwners.length) {
        game.activeOwners = init.state.activeOwners.slice();
      } else if (recMeta.owners && recMeta.owners.length) {
        game.activeOwners = recMeta.owners.slice();
      } else if (recMeta.names) {
        const seats = Object.keys(recMeta.names).filter(
          (s) => D.Seats && D.Seats.isSeat && D.Seats.isSeat(s)
        );
        if (seats.length >= 2) game.activeOwners = seats;
      }
      if (init && init.state && init.state.playerNames) {
        game.playerNames = init.state.playerNames;
      } else if (recMeta.names) {
        game.playerNames = recMeta.names;
      }
      if (D.Seats && D.Seats.ensureBuckets) {
        D.Seats.ensureBuckets(game, game.activeOwners);
      }
      if (D.Map && D.Map.initFog) D.Map.initFog(game);
      game.replay = true;
      game._serverSim = true;
      game.multiplayer = true;
      game.phase = 'playing';
      game.winner = null;
      // Preserve view seat / spectator mode across seek reboots
      if (D.Replay._viewSeat) {
        game.localOwner = D.Replay._viewSeat;
        game.spectator = false;
      } else {
        game.localOwner = game.localOwner || 'player';
        game.spectator = true;
      }
      game.placement = null;
      if (game.selection) {
        game.selection.ids = [];
        game.selection.box = null;
      }
      // Old init serialize consumed one id via nextId(); server continued at +1
      if (D.Replay._idBurnCompat && D.Entities && D.Entities.peekNextId) {
        D.Entities.setNextId(D.Entities.peekNextId() + 1);
      }
      // Skip past init event
      D.Replay.eventIndex = 0;
      while (
        D.Replay.eventIndex < events.length &&
        events[D.Replay.eventIndex].type === 'init'
      ) {
        D.Replay.eventIndex++;
      }
      D.Replay._targetTick = game.tick || 0;
      D.Replay._acc = 0;
      return true;
    },

    /** Emulate MP snapshot id burns from the buggy serialize(nextId()). */
    _burnSnapshotId() {
      if (!D.Replay._idBurnCompat || !D.Entities || !D.Entities.nextId) return;
      D.Entities.nextId();
    },

    _bootLegacy(game, frames) {
      const first = frames[0];
      const state = first.state || first;
      if (!D.Save.applyNetState(game, state, { localOwner: 'player' })) {
        if (!D.Save.loadInto(game, state)) return false;
      }
      game.replay = true;
      game._serverSim = true;
      game.multiplayer = false;
      game.phase = 'playing';
      D.Replay._frameIndex = 0;
      return true;
    },

    stop(game) {
      D.Replay.active = false;
      D.Replay._playing = false;
      D.Replay.recording = null;
      D.Replay.events = [];
      D.Replay.eventIndex = 0;
      D.Replay._scrubbing = false;
      D.Replay._endShown = false;
      D.Replay._viewSeat = null;
      if (game) {
        game.replay = false;
        game._serverSim = false;
        game._replaySeeking = false;
        game.placement = null;
        game.phase = 'menu';
        game.spectator = false;
        game._recordingWinner = null;
      }
      if (D.UI) D.UI.showReplayBar(false);
      try {
        const u = new URL(location.href);
        if (u.searchParams.has('replay')) {
          u.searchParams.delete('replay');
          history.replaceState(null, '', u.pathname + u.search + u.hash);
        }
      } catch (e) {
        /* ignore */
      }
    },

    /** Absolute share URL for a recording id. */
    shareUrl(id) {
      const rid = String(id || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .toUpperCase();
      if (!rid) return location.origin + '/';
      try {
        // Build from origin+pathname only — avoid wiping path or inheriting ?room=
        const path = location.pathname || '/';
        return (
          location.origin +
          path +
          (path.endsWith('/') ? '' : '') +
          '?replay=' +
          encodeURIComponent(rid)
        );
      } catch (e) {
        return (location.origin || '') + '/?replay=' + encodeURIComponent(rid);
      }
    },

    setSpeed(s) {
      const n = Number(s);
      if (n > 0 && n <= 16) D.Replay.speed = n;
    },

    togglePause() {
      D.Replay._playing = !D.Replay._playing;
      return D.Replay._playing;
    },

    /**
     * Jump to a sim tick. Backward = reboot from init + fast-forward.
     * Forward = bulk sim. Pauses after seek so you can inspect.
     */
    seekTo(game, targetTick, opts) {
      opts = opts || {};
      if (!D.Replay.active || !game || !D.Replay._isCmd) return false;
      const dur = D.Replay.durationTicks();
      let tGoal = Math.max(0, Math.min(dur, targetTick | 0));
      const cur = game.tick | 0;

      if (tGoal < cur || opts.forceRestart) {
        if (!D.Replay._bootCmd(game, D.Replay.events)) return false;
        if (D.Renderer) D.Renderer.rebuildTerrain(game);
      }

      // Fast-forward (skip heavy fog until the end)
      game._replaySeeking = true;
      game.replay = true;
      game._serverSim = true;
      const events = D.Replay.events;
      let steps = 0;
      const maxSteps = dur + 200;
      while ((game.tick | 0) < tGoal && game.phase === 'playing' && steps < maxSteps) {
        steps++;
        D.Replay._applyEventsAtTick(game, game.tick | 0);
        if (game.phase !== 'playing') break;
        D.Game.tick(game, BASE_DT);
        if (D.Replay._idBurnCompat && (game.tick | 0) % STATE_EVERY === 0) {
          D.Replay._burnSnapshotId();
        }
      }
      game._replaySeeking = false;
      if (D.Map) {
        D.Map.recomputeFog(game, 'player');
        D.Map.recomputeFog(game, 'enemy');
      }
      D.Replay._acc = 0;
      if (opts.pause !== false) {
        D.Replay._playing = false;
        const b = document.getElementById('btn-replay-pause');
        if (b) b.textContent = 'Play';
      }
      if (D.UI) {
        D.UI.refreshReplayScrub(game);
        D.UI.refresh(game);
      }
      return true;
    },

    /** Apply all events scheduled at tick t (cmds with ev.t <= t that are due). */
    _applyEventsAtTick(game, t) {
      const events = D.Replay.events;
      while (D.Replay.eventIndex < events.length) {
        const ev = events[D.Replay.eventIndex];
        if (ev.t > t) break;
        D.Replay.eventIndex++;
        if (ev.type === 'cmd' && ev.payload) {
          D.Replay._applyCmd(game, ev.seat, ev.payload);
        } else if (ev.type === 'speed') {
          // Match wall-clock speed changes are ignored; viewer controls speed.
        } else if (ev.type === 'keyframe' && ev.state) {
          D.Replay._applyKeyframe(game, ev.state);
        } else if (ev.type === 'end') {
          D.Replay._applyEndOutcome(game, ev);
          return true;
        }
      }
      return false;
    },

    /**
     * Advance replay. Cmd mode re-sims; legacy applies snapshots.
     */
    tick(game, frameMs) {
      if (!D.Replay.active || !game) return;
      if (D.Replay._scrubbing) return;
      if (!D.Replay._playing) {
        if (D.UI) D.UI.refreshReplayScrub(game);
        return;
      }

      if (D.Replay._isCmd) {
        D.Replay._tickCmd(game, frameMs);
      } else {
        D.Replay._tickLegacy(game, frameMs);
      }
      if (D.UI) D.UI.refreshReplayScrub(game);
    },

    _tickCmd(game, frameMs) {
      // Advance sim at BASE_DT * speed relative to wall clock
      // 1× → 20 ticks/sec
      const ticksPerSec = (1 / BASE_DT) * D.Replay.speed;
      D.Replay._acc += (frameMs / 1000) * ticksPerSec;

      // Higher speeds need more catch-up so 4×–8× feel smooth
      const guardMax = Math.min(400, Math.max(40, Math.ceil(30 * D.Replay.speed)));
      let guard = 0;
      while (D.Replay._acc >= 1 && guard < guardMax) {
        D.Replay._acc -= 1;
        guard++;

        const t = game.tick | 0;
        if (D.Replay._applyEventsAtTick(game, t)) {
          D.Replay._finishReplay(game);
          return;
        }

        if (game.phase !== 'playing') {
          // Re-sim hit checkWinLoss before the recorded end event — keep winner
          // if present, then prefer meta/end winner when we catch up.
          D.Replay._playing = false;
          D.Replay._preferRecordingWinner(game);
          D.Replay._finishReplay(game);
          return;
        }

        game.replay = true;
        game._serverSim = true;
        D.Game.tick(game, BASE_DT);
        // Old server burned one entity id on every even-tick state snapshot
        if (D.Replay._idBurnCompat && (game.tick | 0) % STATE_EVERY === 0) {
          D.Replay._burnSnapshotId();
        }

        if (D.Replay.eventIndex >= D.Replay.events.length && game.phase === 'playing') {
          if (game.tick > (D.Replay.recording.durationTicks || 0) + 40) {
            D.Replay._preferRecordingWinner(game);
            D.Replay._finishReplay(game);
          }
        }
      }
    },

    _applyKeyframe(game, state) {
      if (!state || !D.Save || !D.Save.applyReplayKeyframe) return;
      D.Save.applyReplayKeyframe(game, state);
      game.replay = true;
      game._serverSim = true;
      game.multiplayer = true;
      game.phase = 'playing';
      if (D.Replay._viewSeat) {
        game.localOwner = D.Replay._viewSeat;
        game.spectator = false;
      }
    },

    /**
     * Resolve unit ids for an order. Old recordings (idStable=false) may desync
     * ids; fall back by role so the army still moves. Stable recordings must use
     * exact ids — army-wide fallback makes Watch look like a different match.
     */
    _resolveOrderIds(game, owner, ids, order) {
      const wanted = ids || [];
      const direct = [];
      for (const id of wanted) {
        const e = D.Entities.getById(game, id);
        if (e && e.owner === owner && e.hp > 0 && e.tileW == null) direct.push(id);
      }
      if (direct.length === wanted.length && wanted.length > 0) return direct;

      // idStable / modern streams: never invent a different selection
      if (!D.Replay._idBurnCompat) {
        return direct;
      }

      const ot = (order && order.type) || 'move';
      const units = game.units.filter((u) => u.owner === owner && u.hp > 0);
      const harvs = units.filter((u) => u.type === 'harvester');
      const mcvs = units.filter((u) => u.type === 'mcv');
      const army = units.filter((u) => u.type !== 'harvester' && u.type !== 'mcv');

      if (ot === 'deploy') return mcvs.map((u) => u.id);
      if (ot === 'harvest') {
        if (direct.length) return direct;
        return harvs.map((u) => u.id);
      }
      if (ot === 'stop') {
        if (direct.length) return direct;
        if (wanted.length >= 2) return units.map((u) => u.id);
        return direct;
      }
      if (direct.length && direct.length >= Math.ceil(wanted.length * 0.5)) {
        return direct;
      }
      if (wanted.length >= 2) {
        const out = army.map((u) => u.id);
        if (wanted.length > army.length) {
          for (const h of harvs) out.push(h.id);
        }
        return out;
      }
      if (direct.length) return direct;
      if (army.length === 1) return [army[0].id];
      if (army.length === 0 && harvs.length === 1) return [harvs[0].id];
      return [];
    },

    /** Prefer live-match winner stored on the recording over a desynced re-sim. */
    _preferRecordingWinner(game) {
      const rec = D.Replay.recording || {};
      const w =
        rec.winner != null
          ? rec.winner
          : game._recordingWinner != null
            ? game._recordingWinner
            : null;
      if (w != null) {
        game.winner = w;
        if (game.phase === 'draw' || game.phase === 'playing') game.phase = 'ended';
      }
    },

    _finishReplay(game) {
      D.Replay._playing = false;
      D.Replay._preferRecordingWinner(game);
      // One-shot status line (avoid "draw" spam from repeated refresh/showEnd)
      if (!D.Replay._endShown) {
        D.Replay._endShown = true;
        let label = game.phase || 'end';
        if (game.winner != null) {
          label =
            (D.Seats && D.Seats.label
              ? D.Seats.label(game.winner, game.playerNames)
              : game.winner) + ' wins';
        } else if (game.phase === 'draw') {
          label = 'draw';
        }
        D.Game.pushMessage(game, 'Replay finished (' + label + '). Esc → menu.');
      }
      if (D.UI) D.UI.refreshReplayScrub(game);
    },

    _applyCmd(game, seat, payload) {
      if (!payload || !payload.op) return;
      const owner =
        D.Seats && D.Seats.isSeat(seat)
          ? seat
          : seat === 'enemy'
            ? 'enemy'
            : 'player';
      // Mirror server applyCommand lightly
      try {
        if (payload.op === 'order') {
          const order = payload.order || { type: 'stop' };
          const ids = D.Replay._resolveOrderIds(game, owner, payload.ids || [], order);
          if (!ids.length) return;
          D.Orders.issue(game, ids, order);
          if (order.type === 'deploy') {
            let any = false;
            for (const id of ids) {
              const u = game.units.find((x) => x.id === id);
              if (u && u.type === 'mcv' && D.Orders.tryDeploy(game, u)) any = true;
            }
            // Server force-broadcast after deploy → one extra id burn (old bug)
            if (any) D.Replay._burnSnapshotId();
          }
        } else if (payload.op === 'stop') {
          const ids = D.Replay._resolveOrderIds(game, owner, payload.ids || [], {
            type: 'stop',
          });
          if (ids.length) D.Orders.stop(game, ids);
        } else if (payload.op === 'build') {
          D.Economy.beginStructure(
            game,
            owner,
            payload.type,
            payload.tileX | 0,
            payload.tileY | 0
          );
        } else if (payload.op === 'produce') {
          const r = D.Economy.enqueueUnit(game, payload.buildingId, payload.unitType, {
            owner,
          });
          if (!r || !r.ok) {
            console.warn(
              '[replay] produce failed',
              payload.unitType,
              'b',
              payload.buildingId,
              r && r.reason
            );
          }
        } else if (payload.op === 'cancelQueue') {
          let b = game.buildings.find((x) => x.id === payload.buildingId);
          if (!b) {
            b = game.buildings.find(
              (x) => x.owner === owner && (x.buildQueue || []).length && x.hp > 0
            );
          }
          if (b) D.Economy.cancelQueue(game, b.id, payload.index | 0);
        } else if (payload.op === 'rally') {
          let b = game.buildings.find((x) => x.id === payload.buildingId);
          if (!b) {
            b = game.buildings.find(
              (x) =>
                x.owner === owner &&
                (x.type === 'barracks' ||
                  x.type === 'lightFactory' ||
                  x.type === 'heavyFactory') &&
                x.buildProgress >= 1
            );
          }
          if (b) D.Orders.setRally(game, b.id, payload.x, payload.y);
        }
      } catch (e) {
        console.warn('[replay] cmd failed', e);
      }
    },

    _tickLegacy(game, frameMs) {
      const frames = D.Replay.events;
      if (D.Replay._frameIndex >= frames.length - 1) {
        D.Replay._playing = false;
        D.Game.pushMessage(game, 'Replay finished. Esc → menu.');
        return;
      }
      const BASE_FRAME_MS = 500;
      D.Replay._acc += frameMs * D.Replay.speed;
      while (D.Replay._acc >= BASE_FRAME_MS && D.Replay._frameIndex < frames.length - 1) {
        D.Replay._acc -= BASE_FRAME_MS;
        D.Replay._frameIndex++;
        const fr = frames[D.Replay._frameIndex];
        const state = fr.state || fr;
        if (!state) continue;
        if (!fr.full && game.map && state.map && !state.map.tiles) {
          state.map.tiles = Array.from(game.map.tiles);
        }
        D.Save.applyNetState(game, state, { localOwner: game.localOwner || 'player' });
        game.replay = true;
        game._serverSim = true;
        game.multiplayer = false;
        game.phase =
          state.phase === 'victory' || state.phase === 'defeat' ? state.phase : 'playing';
        D.Map.recomputeFog(game, 'player');
        D.Map.recomputeFog(game, 'enemy');
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
