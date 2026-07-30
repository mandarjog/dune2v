/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function multFor(weapon, kind) {
    if (kind === 'infantry') return weapon.vsI;
    if (kind === 'vehicle') return weapon.vsV;
    return weapon.vsB;
  }

  function applyDamage(game, target, weapon, attackerOwner) {
    const kind = D.Entities.targetKind(target);
    const armor = target.tileW != null ? 0 : (D.config.units[target.type]?.armor || 0);
    const mult = multFor(weapon, kind);
    const dmg = Math.max(1, Math.floor(weapon.damage * mult) - armor);
    target.hp -= dmg;
    if (target.hp <= 0) {
      target.hp = 0;
      D.Combat.kill(game, target, attackerOwner);
    }
    // AI memory: building damaged
    if (target.tileW != null && target.owner === 'enemy' && attackerOwner === 'player') {
      game.ai.memory.lastAttackedBuilding = {
        x: target.tileX + target.tileW / 2,
        y: target.tileY + target.tileH / 2,
        t: game.tick,
      };
    }
    if (target.tileW != null && target.owner === 'player' && attackerOwner === 'enemy') {
      game.ai.memory.playerAttackedAt = {
        x: target.tileX + target.tileW / 2,
        y: target.tileY + target.tileH / 2,
        t: game.tick,
      };
    }
  }

  function fireHitscan(game, attacker, target, weapon) {
    applyDamage(game, target, weapon, attacker.owner);
    game.fx = game.fx || [];
    const tc =
      target.tileW != null
        ? D.Entities.buildingCenter(target)
        : { x: target.x, y: target.y };
    const from =
      attacker.tileW != null
        ? D.Entities.buildingCenter(attacker)
        : { x: attacker.x, y: attacker.y };
    game.fx.push({
      type: 'tracer',
      x0: from.x,
      y0: from.y,
      x1: tc.x,
      y1: tc.y,
      life: 0.14,
      color: attacker.owner === 'player' ? '#9cf' : '#f96',
      owner: attacker.owner,
    });
  }

  function fireProjectile(game, attacker, target, weapon) {
    const from =
      attacker.tileW != null
        ? D.Entities.buildingCenter(attacker)
        : { x: attacker.x, y: attacker.y };
    const tc =
      target.tileW != null
        ? D.Entities.buildingCenter(target)
        : { x: target.x, y: target.y };
    const isTurret = attacker.tileW != null && attacker.type === 'gunTurret';
    game.projectiles.push({
      id: D.Entities.nextFxId ? D.Entities.nextFxId() : D.Entities.nextId(),
      x: from.x,
      y: from.y,
      tx: tc.x,
      ty: tc.y,
      targetId: target.id,
      // Slightly slower shells = longer on-screen travel (esp. turrets)
      speed: isTurret
        ? (D.config.projectileSpeed || 8) * 0.75
        : D.config.projectileSpeed || 8,
      weapon,
      owner: attacker.owner,
      life: 3,
      kind: isTurret ? 'shell' : weapon.kind || 'shell',
      fromTurret: isTurret,
    });
    // Muzzle flash so fire is obvious even between net snapshots
    game.fx = game.fx || [];
    game.fx.push({
      type: 'muzzle',
      x: from.x,
      y: from.y,
      life: 0.12,
      r: isTurret ? 0.35 : 0.22,
      owner: attacker.owner,
      color: attacker.owner === 'player' ? '#9cf' : '#f96',
    });
  }

  D.Combat = {
    resolveTarget(game, u) {
      if (u.order && u.order.type === 'attack') {
        const t = D.Entities.getById(game, u.order.targetId);
        if (t && t.hp > 0) return t;
      }
      if (u.order && u.order.type === 'attack-move') {
        return D.Combat.findHostileInSight(game, u);
      }
      return null;
    },

    findHostileInSight(game, u) {
      const def = D.config.units[u.type];
      const sight = def ? def.sight : 3;
      let best = null;
      let bestD = sight + 0.01;
      for (const o of game.units) {
        if (o.owner === u.owner || o.hp <= 0) continue;
        if (!D.Combat.canSee(game, u.owner, o.x, o.y)) continue;
        const d = Math.hypot(u.x - o.x, u.y - o.y);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      for (const b of game.buildings) {
        if (b.owner === u.owner || b.hp <= 0 || b.type === 'concrete') continue;
        const c = D.Entities.buildingCenter(b);
        if (!D.Combat.canSee(game, u.owner, c.x, c.y)) continue;
        const d = Math.hypot(u.x - c.x, u.y - c.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    },

    canSee(game, owner, x, y) {
      if (!D.config.features.fog) return true;
      return D.Map.isVisible(game, owner, Math.floor(x), Math.floor(y));
    },

    kill(game, target, killerOwner) {
      if (target.tileW != null) {
        const name = D.config.buildings[target.type]?.name || target.type;
        if (target.owner === 'player' || killerOwner === 'player') {
          D.Game.pushMessage(game, name + ' destroyed.');
        }
        // explosion fx
        const c = D.Entities.buildingCenter(target);
        game.fx = game.fx || [];
        game.fx.push({ type: 'explode', x: c.x, y: c.y, life: 0.4, r: 0.8 });
        D.Entities.removeBuilding(game, target);
        D.Economy.tickPower(game);
        D.Economy.recalcSpiceCap(game);
      } else {
        game.fx = game.fx || [];
        game.fx.push({ type: 'explode', x: target.x, y: target.y, life: 0.25, r: 0.4 });
        D.Entities.removeUnit(game, target);
      }
    },

    tick(game, dt) {
      // units fire
      for (const u of game.units) {
        if (u.hp <= 0 || !u.weapon) continue;
        const def = D.config.units[u.type];
        if (!def || !def.weapon) continue;
        u.weapon.cooldownLeft = Math.max(0, u.weapon.cooldownLeft - dt);

        let target = D.Combat.resolveTarget(game, u);
        // auto-acquire only if attack-move or idle? design: only on attack orders
        if (!target && u.order && u.order.type === 'attack-move') {
          target = D.Combat.findHostileInSight(game, u);
        }

        if (!target) continue;
        const tc =
          target.tileW != null
            ? D.Entities.buildingCenter(target)
            : { x: target.x, y: target.y };
        // FOW fire gate: must currently see target tile
        if (!D.Combat.canSee(game, u.owner, tc.x, tc.y)) continue;
        const dist = Math.hypot(u.x - tc.x, u.y - tc.y);
        if (dist <= def.weapon.range) {
          u.path = []; // stop at range
          if (u.weapon.cooldownLeft === 0) {
            if (def.weapon.projectile) fireProjectile(game, u, target, def.weapon);
            else fireHitscan(game, u, target, def.weapon);
            u.weapon.cooldownLeft = def.weapon.cooldown;
          }
        }
      }

      // turrets
      for (const b of game.buildings) {
        if (b.buildProgress < 1 || !b.weapon || b.hp <= 0) continue;
        const def = D.config.buildings[b.type];
        if (!def || !def.weapon) continue;
        const power = game.power[b.owner];
        if (power.ratio < 0.5) continue; // offline
        b.weapon.cooldownLeft = Math.max(0, b.weapon.cooldownLeft - dt);
        const c = D.Entities.buildingCenter(b);
        // find target in range
        let best = null;
        let bestD = def.weapon.range + 0.01;
        for (const o of game.units) {
          if (o.owner === b.owner || o.hp <= 0) continue;
          if (!D.Combat.canSee(game, b.owner, o.x, o.y)) continue;
          const d = Math.hypot(c.x - o.x, c.y - o.y);
          if (d < bestD) {
            bestD = d;
            best = o;
          }
        }
        if (best) {
          const tc = { x: best.x, y: best.y };
          b._aimFacing = Math.atan2(tc.y - c.y, tc.x - c.x);
          if (b.weapon.cooldownLeft === 0) {
            if (def.weapon.projectile) fireProjectile(game, b, best, def.weapon);
            else fireHitscan(game, b, best, def.weapon);
            b.weapon.cooldownLeft = def.weapon.cooldown;
          }
        }
      }

      // projectiles
      for (let i = game.projectiles.length - 1; i >= 0; i--) {
        const p = game.projectiles[i];
        p.life -= dt;
        const target = D.Entities.getById(game, p.targetId);
        if (target && target.hp > 0) {
          const tc =
            target.tileW != null
              ? D.Entities.buildingCenter(target)
              : { x: target.x, y: target.y };
          p.tx = tc.x;
          p.ty = tc.y;
        }
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const dist = Math.hypot(dx, dy);
        const step = p.speed * dt;
        if (dist <= step || p.life <= 0) {
          if (target && target.hp > 0) {
            applyDamage(game, target, p.weapon, p.owner);
          }
          game.fx = game.fx || [];
          game.fx.push({ type: 'explode', x: p.tx, y: p.ty, life: 0.15, r: 0.25 });
          game.projectiles.splice(i, 1);
        } else {
          p.x += (dx / dist) * step;
          p.y += (dy / dist) * step;
        }
      }

      // fx
      if (game.fx) {
        for (let i = game.fx.length - 1; i >= 0; i--) {
          game.fx[i].life -= dt;
          if (game.fx[i].life <= 0) game.fx.splice(i, 1);
        }
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
