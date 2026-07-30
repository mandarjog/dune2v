/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function clearOrder(u) {
    u.order = null;
    u.orders = [];
    u.path = [];
    u.repathQueued = false;
  }

  function setOrder(u, order) {
    u.orders = [order];
    u.order = order;
    u.path = [];
    u.repathQueued = false;
    u.stuck = false;
    u.stuckReason = null;
    u._stuckSince = 0;
    if (u.harvest && order.type !== 'harvest') {
      u.harvest.state = 'idle';
      u.harvest.refineryId = null;
    }
  }

  function clearStuck(u) {
    u.stuck = false;
    u.stuckReason = null;
    u._stuckSince = 0;
  }

  /** Flag unit stuck + throttle a sidebar message for local/friendly units. */
  function markStuck(game, u, reason, dt) {
    u._stuckSince = (u._stuckSince || 0) + (dt || 0);
    // Require ~1.5s of continuous stuck before flashing/message
    if (u._stuckSince < 1.5) return;
    const was = u.stuck;
    u.stuck = true;
    u.stuckReason = reason || 'blocked';
    if (was && u._stuckMsgAt && game.tick - u._stuckMsgAt < 100) return;
    // Message only for units the local player owns (SP player / MP localOwner)
    const local = D.Game && D.Game.me ? D.Game.me(game) : 'player';
    if (u.owner !== local && u.owner !== 'player') return;
    // On MP server both owners get messages in snapshots via stuck flag; message once
    if (game.multiplayer && !game._serverSim && u.owner !== local) return;
    u._stuckMsgAt = game.tick;
    if (!D.Game || !D.Game.pushMessage) return;
    const name = (D.config.units[u.type] && D.config.units[u.type].name) || u.type;
    const tips = {
      path: name + ' is stuck — no path (clear walls/units or re-order).',
      dock: name + ' waiting at busy refinery dock…',
      silos: name + ' cannot unload — silos full (build silos / spend credits).',
      blocked: name + ' is stuck.',
    };
    D.Game.pushMessage(game, tips[u.stuckReason] || tips.blocked);
  }

  D.Orders = {
    issue(game, unitIds, order) {
      for (const id of unitIds) {
        const u = game.units.find((x) => x.id === id);
        if (!u || u.owner !== (order._owner || u.owner)) continue;
        // only issue to living
        if (u.hp <= 0) continue;

        if (order.type === 'deploy') {
          if (u.type !== 'mcv') continue;
          setOrder(u, { type: 'deploy' });
          continue;
        }

        if (order.type === 'harvest') {
          if (u.type !== 'harvester') continue;
          setOrder(u, { type: 'harvest', tileX: order.tileX, tileY: order.tileY });
          u.harvest.state = 'moveToSpice';
          u.harvest.tileX = order.tileX;
          u.harvest.tileY = order.tileY;
          continue;
        }

        if (order.type === 'stop') {
          clearOrder(u);
          if (u.harvest) u.harvest.state = 'idle';
          continue;
        }

        setOrder(u, Object.assign({}, order));
      }
    },

    stop(game, unitIds) {
      D.Orders.issue(game, unitIds, { type: 'stop' });
    },

    setRally(game, buildingId, x, y) {
      const b = game.buildings.find((x) => x.id === buildingId);
      if (!b) return;
      b.rallyX = x;
      b.rallyY = y;
    },

    canDeploy(game, unitId) {
      const u = game.units.find((x) => x.id === unitId);
      if (!u || u.type !== 'mcv') return false;
      const def = D.config.buildings.constructionYard;
      // center 2x2 on MCV tile
      const tx = Math.floor(u.x) - Math.floor(def.tileW / 2);
      const ty = Math.floor(u.y) - Math.floor(def.tileH / 2);
      const hasCY = game.buildings.some(
        (b) => b.owner === u.owner && b.type === 'constructionYard' && b.buildProgress >= 1
      );
      return D.Map.canPlace(game, 'constructionYard', tx, ty, u.owner, {
        skipProximity: !hasCY,
      });
    },

    tryDeploy(game, u) {
      if (!D.Orders.canDeploy(game, u.id)) return false;
      const def = D.config.buildings.constructionYard;
      const tx = Math.floor(u.x) - Math.floor(def.tileW / 2);
      const ty = Math.floor(u.y) - Math.floor(def.tileH / 2);
      const hasCY = game.buildings.some(
        (b) => b.owner === u.owner && b.type === 'constructionYard' && b.buildProgress >= 1
      );
      if (!D.Map.canPlace(game, 'constructionYard', tx, ty, u.owner, { skipProximity: !hasCY })) {
        return false;
      }
      D.Entities.createBuilding(game, 'constructionYard', u.owner, tx, ty, {
        complete: true,
      });
      D.Entities.removeUnit(game, u);
      D.Economy.tickPower(game);
      // Message for local/SP; multiplayer server sends cmd_result instead
      if (D.Game && D.Game.pushMessage && !game.multiplayer) {
        D.Game.pushMessage(game, 'Construction Yard deployed.');
      }
      return true;
    },

    /** Movement + order execution per tick */
    tick(game, dt) {
      let repaths = 0;
      const maxRepaths = D.config.path.maxRepathsPerTick;

      for (const u of game.units) {
        if (u.hp <= 0) continue;

        // Harvester FSM takes over when harvest order active or internal state active
        if (u.type === 'harvester' && u.harvest && u.order && u.order.type === 'harvest') {
          D.Orders.tickHarvester(game, u, dt, () => {
            if (repaths < maxRepaths) {
              repaths++;
              return true;
            }
            return false;
          });
          continue;
        }
        if (
          u.type === 'harvester' &&
          u.harvest &&
          u.harvest.state !== 'idle' &&
          (!u.order || u.order.type === 'harvest')
        ) {
          D.Orders.tickHarvester(game, u, dt, () => {
            if (repaths < maxRepaths) {
              repaths++;
              return true;
            }
            return false;
          });
          continue;
        }

        const order = u.order;
        if (!order) continue;

        if (order.type === 'deploy') {
          D.Orders.tryDeploy(game, u);
          continue;
        }

        if (order.type === 'move' || order.type === 'attack-move') {
          const prevX = u.x;
          const prevY = u.y;
          D.Orders.ensurePath(game, u, order.x, order.y, () => repaths++ < maxRepaths);
          D.Orders.followPath(game, u, dt);
          const d = Math.hypot(u.x - order.x, u.y - order.y);
          if (!u.path.length && u.order && u.order.type === 'move') {
            if (d < D.config.path.arrivalDist + 0.2) {
              clearStuck(u);
              clearOrder(u);
            } else {
              markStuck(game, u, 'path', dt);
            }
          } else if (
            d > 0.6 &&
            Math.hypot(u.x - prevX, u.y - prevY) < 0.001 &&
            (!u.path || !u.path.length)
          ) {
            markStuck(game, u, 'path', dt);
          } else {
            clearStuck(u);
          }
          continue;
        }

        if (order.type === 'attack') {
          const target = D.Entities.getById(game, order.targetId);
          if (!target || target.hp <= 0) {
            clearStuck(u);
            clearOrder(u);
            continue;
          }
          const tc =
            target.tileW != null
              ? D.Entities.buildingCenter(target)
              : { x: target.x, y: target.y };
          const def = D.config.units[u.type];
          const range = def && def.weapon ? def.weapon.range : 1;
          const dist = Math.hypot(u.x - tc.x, u.y - tc.y);
          if (dist > range) {
            const prevX = u.x;
            const prevY = u.y;
            D.Orders.ensurePath(game, u, tc.x, tc.y, () => repaths++ < maxRepaths);
            D.Orders.followPath(game, u, dt);
            if (
              (!u.path || !u.path.length) &&
              Math.hypot(u.x - prevX, u.y - prevY) < 0.001
            ) {
              markStuck(game, u, 'path', dt);
            } else {
              clearStuck(u);
            }
          } else {
            u.path = [];
            clearStuck(u);
          }
          continue;
        }
      }
      game._repathsThisTick = repaths;
    },

    ensurePath(game, u, tx, ty, allowRepath) {
      if (u.path && u.path.length) {
        // if goal far from path end, repath
        const last = u.path[u.path.length - 1];
        if (Math.hypot(last.x - tx, last.y - ty) < 1.5) return;
      }
      if (allowRepath && !allowRepath()) return;
      const path = D.Path.find(game.map, u.x, u.y, tx, ty);
      u.path = path || [];
    },

    followPath(game, u, dt) {
      if (!u.path.length) return;
      const def = D.config.units[u.type];
      const speed = def ? def.speed : 1;
      let remaining = speed * dt;
      while (remaining > 0 && u.path.length) {
        const wp = u.path[0];
        const dx = wp.x - u.x;
        const dy = wp.y - u.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.05) {
          u.path.shift();
          continue;
        }
        if (dist <= remaining) {
          u.x = wp.x;
          u.y = wp.y;
          remaining -= dist;
          u.path.shift();
        } else {
          u.x += (dx / dist) * remaining;
          u.y += (dy / dist) * remaining;
          remaining = 0;
        }
        // facing
        if (dist > 0.001) {
          u.facing = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        }
      }
    },

    tickHarvester(game, u, dt, allowRepath) {
      const h = u.harvest;
      const eco = D.config.economy;

      function pathTo(x, y) {
        // Recover from dead paths (stuck harvesters)
        const dist = Math.hypot(u.x - x, u.y - y);
        const prevX = u.x;
        const prevY = u.y;
        if ((!u.path || !u.path.length) && dist > 0.5) {
          h.stuckT = (h.stuckT || 0) + dt;
          // Force a repath every ~1.2s even if repath budget is exhausted
          if (h.stuckT >= 1.2) {
            h.stuckT = 0;
            const path = D.Path.find(game.map, u.x, u.y, x, y);
            u.path = path || [];
            if (!u.path.length) {
              // Nudge goal slightly and try again next cycle
              h.nudge = ((h.nudge || 0) + 1) % 4;
              const off = [
                [0.7, 0],
                [-0.7, 0],
                [0, 0.7],
                [0, -0.7],
              ][h.nudge];
              const path2 = D.Path.find(game.map, u.x, u.y, x + off[0], y + off[1]);
              u.path = path2 || [];
            }
          } else {
            D.Orders.ensurePath(game, u, x, y, allowRepath);
          }
        } else {
          h.stuckT = 0;
          D.Orders.ensurePath(game, u, x, y, allowRepath);
        }
        D.Orders.followPath(game, u, dt);
        const moved = Math.hypot(u.x - prevX, u.y - prevY);
        if (dist > 0.55 && moved < 0.001 && (!u.path || !u.path.length)) {
          markStuck(game, u, 'path', dt);
        } else if (moved > 0.001 || dist < 0.5) {
          clearStuck(u);
        }
      }

      if (h.state === 'idle') {
        // auto-seek spice if empty cargo and no order? only if harvest order
        if (u.order && u.order.type === 'harvest') {
          h.state = 'moveToSpice';
          h.stuckT = 0;
        } else if (u.cargo > 0.5) {
          // Full-ish cargo but idle — go unload
          h.state = 'moveToRefinery';
          h.refineryId = null;
          h.stuckT = 0;
        }
        return;
      }

      if (h.state === 'moveToSpice') {
        let tx = h.tileX;
        let ty = h.tileY;
        if (u.order && u.order.type === 'harvest' && u.order.tileX != null) {
          // Prefer ordered tile while it still has spice
          if (D.Map.spiceAt(game.map, u.order.tileX, u.order.tileY) > 0) {
            tx = u.order.tileX;
            ty = u.order.tileY;
            h.tileX = tx;
            h.tileY = ty;
          }
        }
        if (D.Map.spiceAt(game.map, tx, ty) <= 0) {
          const n = D.Map.findNearestSpice(game.map, u.x, u.y);
          if (!n) {
            if (u.cargo > 0.5) {
              h.state = 'moveToRefinery';
              h.refineryId = null;
            } else {
              h.state = 'idle';
              clearOrder(u);
            }
            return;
          }
          h.tileX = n.tx;
          h.tileY = n.ty;
          tx = n.tx;
          ty = n.ty;
          if (u.order && u.order.type === 'harvest') {
            u.order.tileX = tx;
            u.order.tileY = ty;
          }
        }
        const txc = tx + 0.5;
        const tyc = ty + 0.5;
        if (Math.hypot(u.x - txc, u.y - tyc) < 0.4) {
          h.state = 'harvest';
          h.stuckT = 0;
          u.path = [];
        } else {
          pathTo(txc, tyc);
        }
        return;
      }

      if (h.state === 'harvest') {
        clearStuck(u);
        const amt = D.Map.spiceAt(game.map, h.tileX, h.tileY);
        if (amt <= 0 || u.cargo >= u.cargoMax) {
          h.state = 'moveToRefinery';
          h.refineryId = null;
          h.stuckT = 0;
          return;
        }
        const take = Math.min(eco.harvestRate * dt, amt, u.cargoMax - u.cargo);
        u.cargo += take;
        D.Map.setSpice(game.map, h.tileX, h.tileY, amt - take);
        if (u.cargo >= u.cargoMax) {
          h.state = 'moveToRefinery';
          h.refineryId = null;
          h.stuckT = 0;
        }
        return;
      }

      if (h.state === 'moveToRefinery' || h.state === 'seekRefinery') {
        let ref = h.refineryId
          ? game.buildings.find((b) => b.id === h.refineryId)
          : null;
        if (!ref || ref.hp <= 0 || ref.buildProgress < 1 || ref.type !== 'refinery') {
          ref = D.Orders.findBestRefinery(game, u);
          h.refineryId = ref ? ref.id : null;
        }
        if (!ref) {
          // No refinery — hold cargo and idle (player may build one)
          h.state = 'idle';
          h.stuckT = 0;
          return;
        }
        const dx = (ref.dockTileX ?? ref.tileX) + 0.5;
        const dy = (ref.dockTileY ?? ref.tileY + ref.tileH) + 0.5;
        if (Math.hypot(u.x - dx, u.y - dy) < 0.45) {
          // dock free?
          const busy = game.units.some(
            (o) =>
              o !== u &&
              o.type === 'harvester' &&
              o.harvest &&
              o.harvest.state === 'unload' &&
              o.harvest.refineryId === ref.id
          );
          if (busy) {
            // Queue at dock: wait, then circle nearby so we don't freeze forever
            h.wait = (h.wait || 0) + dt;
            u.path = [];
            markStuck(game, u, 'dock', dt);
            if (h.wait > 1.2) {
              h.wait = 0;
              const ang = (game.tick * 0.15 + u.id) % (Math.PI * 2);
              pathTo(dx + Math.cos(ang) * 1.8, dy + Math.sin(ang) * 1.8);
            }
            return;
          }
          h.state = 'unload';
          h.wait = 0;
          h.stuckT = 0;
          clearStuck(u);
          u.path = [];
        } else {
          pathTo(dx, dy);
        }
        return;
      }

      if (h.state === 'unload') {
        const ref = game.buildings.find((b) => b.id === h.refineryId);
        if (!ref || ref.hp <= 0) {
          h.state = 'seekRefinery';
          h.stuckT = 0;
          clearStuck(u);
          return;
        }
        const owner = u.owner;
        const cap = game.spiceCap[owner];
        const credits = game.credits[owner];
        if (credits >= cap) {
          markStuck(game, u, 'silos', dt);
          return;
        }
        clearStuck(u);
        const room = cap - credits;
        const give = Math.min(eco.unloadRate * dt, u.cargo, room / eco.spiceToCredit);
        u.cargo -= give;
        game.credits[owner] = Math.min(cap, credits + give * eco.spiceToCredit);
        if (u.cargo <= 0.01) {
          u.cargo = 0;
          // resume spice
          const n = D.Map.findNearestSpice(game.map, u.x, u.y);
          if (n) {
            h.tileX = n.tx;
            h.tileY = n.ty;
            h.state = 'moveToSpice';
            h.stuckT = 0;
            if (!u.order || u.order.type !== 'harvest') {
              u.order = { type: 'harvest', tileX: n.tx, tileY: n.ty };
              u.orders = [u.order];
            } else {
              u.order.tileX = n.tx;
              u.order.tileY = n.ty;
            }
          } else {
            h.state = 'idle';
            clearOrder(u);
          }
        }
      }
    },

    findBestRefinery(game, u) {
      let best = null;
      let bestD = Infinity;
      let primary = null;
      for (const b of game.buildings) {
        if (b.owner !== u.owner || b.type !== 'refinery' || b.buildProgress < 1 || b.hp <= 0)
          continue;
        if (b.primary) primary = b;
        const dx = (b.dockTileX ?? b.tileX) + 0.5;
        const dy = (b.dockTileY ?? b.tileY) + 0.5;
        const d = Math.hypot(u.x - dx, u.y - dy);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (primary) return primary;
      return best;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
