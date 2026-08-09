/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  function multFor(weapon, kind) {
    if (kind === 'infantry') return weapon.vsI;
    if (kind === 'vehicle') return weapon.vsV;
    return weapon.vsB;
  }

  function rechargeEnabled() {
    return !!(D.config.features && D.config.features.recharge);
  }

  /** Ensure ammo fields exist when feature is on and weapon uses recharge. */
  function ensureMagazine(entity, wdef) {
    if (!entity || !entity.weapon || !wdef || !wdef.recharge) return false;
    if (!rechargeEnabled()) return false;
    if (entity.weapon.ammoMax == null || entity.weapon.ammoMax <= 0) {
      const max =
        wdef.magazine != null
          ? wdef.magazine
          : (D.config.recharge && D.config.recharge.magazine) || 5;
      entity.weapon.ammoMax = max;
      if (entity.weapon.ammo == null) entity.weapon.ammo = max;
    }
    return true;
  }

  /** Passive magazine regen (full empty→full in regenSec). */
  function tickMagazine(entity, wdef, dt) {
    if (!ensureMagazine(entity, wdef)) return;
    const max = entity.weapon.ammoMax;
    if (entity.weapon.ammo >= max) {
      entity.weapon.ammo = max;
      return;
    }
    const fullSec =
      (D.config.recharge && D.config.recharge.regenSec) != null
        ? D.config.recharge.regenSec
        : 20;
    const rate = max / Math.max(0.5, fullSec);
    entity.weapon.ammo = Math.min(max, (entity.weapon.ammo || 0) + rate * dt);
  }

  /** Whole shots ready (matches UI floor display). Fractional ammo is only regen progress. */
  function canExpendShot(entity, wdef) {
    if (!ensureMagazine(entity, wdef)) return true; // no magazine / feature off
    return Math.floor(entity.weapon.ammo || 0) >= 1;
  }

  function expendShot(entity, wdef) {
    if (!ensureMagazine(entity, wdef)) return;
    // Spend one whole shot; keep fractional progress toward the next
    entity.weapon.ammo = Math.max(0, (entity.weapon.ammo || 0) - 1);
  }

  /** Throttled "we are under attack" for the defender (SP + MP snapshots). */
  function noteUnderAttack(game, owner, target) {
    if (!game || !owner || !target) return;
    if (game.eliminated && game.eliminated[owner] != null) return;
    game._underAttackAt = game._underAttackAt || {};
    const last = game._underAttackAt[owner] || 0;
    // ~3s at 20 Hz — avoid spamming chat/flash every shell
    if (game.tick - last < 60) return;
    game._underAttackAt[owner] = game.tick;
    const x =
      target.tileW != null
        ? target.tileX + (target.tileW || 1) / 2
        : target.x;
    const y =
      target.tileW != null
        ? target.tileY + (target.tileH || 1) / 2
        : target.y;
    if (D.Game && D.Game.pushAlert) {
      D.Game.pushAlert(game, {
        seat: owner,
        kind: 'under_attack',
        text: 'We are under attack!',
        x,
        y,
      });
    }
    // SP: flash + sidebar; MP clients read alerts from net snapshots
    if (
      !game.multiplayer &&
      !game._serverSim &&
      D.Game.me(game) === owner &&
      typeof document !== 'undefined'
    ) {
      if (D.UI && D.UI.flashUnderAttack) D.UI.flashUnderAttack();
      if (D.UI && D.UI.appendSystemChat) {
        // Show on map chat HUD if present (may be hidden in SP)
        D.UI.setChatVisible && D.UI.setChatVisible(true);
        D.UI.appendSystemChat('We are under attack!', 'under_attack');
      }
      if (D.Game && D.Game.pushMessage) D.Game.pushMessage(game, 'We are under attack!');
    }
  }

  function applyDamage(game, target, weapon, attackerOwner) {
    const kind = D.Entities.targetKind(target);
    const armor = target.tileW != null ? 0 : (D.config.units[target.type]?.armor || 0);
    const mult = multFor(weapon, kind);
    const dmg = Math.max(1, Math.floor(weapon.damage * mult) - armor);
    target.hp -= dmg;
    if (
      attackerOwner &&
      target.owner &&
      attackerOwner !== target.owner &&
      target.hp > 0
    ) {
      noteUnderAttack(game, target.owner, target);
    } else if (
      attackerOwner &&
      target.owner &&
      attackerOwner !== target.owner &&
      target.hp <= 0
    ) {
      // Still ping once when something dies under fire
      noteUnderAttack(game, target.owner, target);
    }
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

  function tracerColor(owner) {
    return D.Seats && D.Seats.tracer
      ? D.Seats.tracer(owner)
      : owner === 'player'
        ? '#9cf'
        : '#f96';
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
    const special = !!(attacker.type && D.config.units[attacker.type]?.special);
    game.fx.push({
      type: 'tracer',
      x0: from.x,
      y0: from.y,
      x1: tc.x,
      y1: tc.y,
      // Saboteurs / specials: longer brighter beam so fire is obvious
      life: special ? 0.22 : 0.14,
      wide: special,
      color: tracerColor(attacker.owner),
      owner: attacker.owner,
    });
    game.fx.push({
      type: 'muzzle',
      x: from.x,
      y: from.y,
      life: special ? 0.16 : 0.1,
      r: special ? 0.28 : 0.18,
      owner: attacker.owner,
      color: tracerColor(attacker.owner),
    });
  }

  function fireHitscanGround(game, attacker, wx, wy, weapon) {
    game.fx = game.fx || [];
    const from =
      attacker.tileW != null
        ? D.Entities.buildingCenter(attacker)
        : { x: attacker.x, y: attacker.y };
    game.fx.push({
      type: 'tracer',
      x0: from.x,
      y0: from.y,
      x1: wx,
      y1: wy,
      life: 0.14,
      color: tracerColor(attacker.owner),
      owner: attacker.owner,
    });
    game.fx.push({
      type: 'muzzle',
      x: from.x,
      y: from.y,
      life: 0.1,
      r: 0.18,
      owner: attacker.owner,
      color: tracerColor(attacker.owner),
    });
    game.fx.push({ type: 'explode', x: wx, y: wy, life: 0.18, r: 0.3 });
    // Tiny splash so ground fire can still tag units at the aim point
    splashAt(game, wx, wy, weapon, attacker.owner, 0.85);
  }

  function splashAt(game, x, y, weapon, owner, radius) {
    if (!weapon) return;
    radius = radius != null ? radius : 0.75;
    for (const o of game.units) {
      if (o.owner === owner || o.hp <= 0) continue;
      if (Math.hypot(o.x - x, o.y - y) <= radius) {
        applyDamage(game, o, weapon, owner);
      }
    }
    for (const b of game.buildings) {
      if (b.owner === owner || b.hp <= 0 || b.type === 'concrete') continue;
      const c = D.Entities.buildingCenter(b);
      if (Math.hypot(c.x - x, c.y - y) <= radius + 0.4) {
        applyDamage(game, b, weapon, owner);
      }
    }
  }

  function fireProjectile(game, attacker, target, weapon, ground) {
    const from =
      attacker.tileW != null
        ? D.Entities.buildingCenter(attacker)
        : { x: attacker.x, y: attacker.y };
    let tc;
    if (ground && ground.x != null) {
      tc = { x: ground.x, y: ground.y };
    } else if (target) {
      tc =
        target.tileW != null
          ? D.Entities.buildingCenter(target)
          : { x: target.x, y: target.y };
    } else {
      return;
    }
    // Structure guns (gun turret + long range tower) and siege shells need long on-screen travel
    const isStructureGun = attacker.tileW != null && !!(weapon && weapon.projectile);
    const isSiege = attacker.type === 'siegeTank';
    const isLrt = attacker.type === 'longRangeTower';
    const base = D.config.projectileSpeed || 8;
    let speed = base;
    if (isLrt) speed = base * 0.45; // long arc — must be readable across 10 tiles
    else if (isStructureGun) speed = base * 0.7;
    else if (isSiege) speed = base * 0.55;
    game.projectiles.push({
      id: D.Entities.nextFxId ? D.Entities.nextFxId() : D.Entities.nextId(),
      x: from.x,
      y: from.y,
      tx: tc.x,
      ty: tc.y,
      targetId: target && target.id != null ? target.id : null,
      ground: !!(ground && ground.x != null),
      speed,
      weapon,
      owner: attacker.owner,
      life: isLrt || isSiege ? 4.5 : 3,
      kind: 'shell',
      fromTurret: isStructureGun,
      heavy: isLrt || isSiege,
    });
    // Muzzle flash so fire is obvious even between net snapshots
    game.fx = game.fx || [];
    game.fx.push({
      type: 'muzzle',
      x: from.x,
      y: from.y,
      life: isLrt || isSiege ? 0.2 : 0.12,
      r: isLrt ? 0.45 : isSiege ? 0.4 : isStructureGun ? 0.35 : 0.22,
      owner: attacker.owner,
      color: tracerColor(attacker.owner),
    });
  }

  D.Combat = {
    /** True if distance is within weapon band (respects minRange for artillery). */
    inWeaponRange(weapon, dist) {
      if (!weapon) return false;
      if (dist > weapon.range) return false;
      const minR = weapon.minRange != null ? weapon.minRange : 0;
      if (minR > 0 && dist < minR) return false;
      return true;
    },

    resolveTarget(game, u) {
      // Explicit attack target
      if (u.order && u.order.type === 'attack') {
        const t = D.Entities.getById(game, u.order.targetId);
        if (t && t.hp > 0) return t;
      }
      // Attack-ground: do not auto-acquire — combat tick fires at order.x/y
      if (u.order && u.order.type === 'attack-ground') {
        return null;
      }
      // Attack-move: acquire in *sight* (may be beyond weapon range → path closer)
      if (u.order && u.order.type === 'attack-move') {
        return D.Combat.findHostileInRadius(game, u, null);
      }
      // Non-combat orders: never free-fire
      if (u.order) {
        const t = u.order.type;
        if (t === 'harvest' || t === 'deploy') return null;
        // follow: same as plain move — weapon-range auto-fire only (no chase)
      }
      // Idle / stop / plain move / follow: auto-fire only at hostiles already in
      // *weapon range* (orders.autoAcquire turns idle LOS contacts into attack).
      return D.Combat.findHostileInRadius(game, u, 'weapon');
    },

    /**
     * Nearest hostile in radius.
     * @param {'weapon'|null} mode  'weapon' = use weapon.range (+ minRange); null = use sight
     */
    findHostileInRadius(game, u, mode) {
      const def = D.config.units[u.type];
      if (!def) return null;
      let radius;
      let minR = 0;
      if (mode === 'weapon') {
        if (!def.weapon) return null;
        radius = def.weapon.range;
        minR = def.weapon.minRange != null ? def.weapon.minRange : 0;
      } else {
        radius = def.sight != null ? def.sight : 3;
      }
      let best = null;
      let bestD = radius + 0.01;
      for (const o of game.units) {
        if (o.owner === u.owner || o.hp <= 0) continue;
        if (!D.Combat.canSee(game, u.owner, o.x, o.y)) continue;
        const d = Math.hypot(u.x - o.x, u.y - o.y);
        if (d < minR || d >= bestD) continue;
        bestD = d;
        best = o;
      }
      for (const b of game.buildings) {
        if (b.owner === u.owner || b.hp <= 0 || b.type === 'concrete') continue;
        const c = D.Entities.buildingCenter(b);
        if (!D.Combat.canSee(game, u.owner, c.x, c.y)) continue;
        const d = Math.hypot(u.x - c.x, u.y - c.y);
        if (d < minR || d >= bestD) continue;
        bestD = d;
        best = b;
      }
      return best;
    },

    /** @deprecated use findHostileInRadius */
    findHostileInSight(game, u) {
      return D.Combat.findHostileInRadius(game, u, null);
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
      // Note: regenerate magazine *after* fire attempt so a 0.99→1.0 regen on the
      // same tick cannot fire while the UI still shows 0/5 (floor of 0.99).
      for (const u of game.units) {
        if (u.hp <= 0 || !u.weapon) continue;
        const def = D.config.units[u.type];
        if (!def || !def.weapon) continue;
        u.weapon.cooldownLeft = Math.max(0, u.weapon.cooldownLeft - dt);

        // Attack-ground: fire at a fixed map point (even if empty)
        if (u.order && u.order.type === 'attack-ground') {
          const gx = u.order.x;
          const gy = u.order.y;
          if (gx == null || gy == null) {
            tickMagazine(u, def.weapon, dt);
            continue;
          }
          const dist = Math.hypot(u.x - gx, u.y - gy);
          if (D.Combat.inWeaponRange(def.weapon, dist)) {
            u.facing = Math.atan2(gy - u.y, gx - u.x);
            u.path = [];
            if (u.weapon.cooldownLeft === 0 && canExpendShot(u, def.weapon)) {
              if (def.weapon.projectile) {
                fireProjectile(game, u, null, def.weapon, { x: gx, y: gy });
              } else {
                fireHitscanGround(game, u, gx, gy, def.weapon);
              }
              u.weapon.cooldownLeft = def.weapon.cooldown;
              expendShot(u, def.weapon);
            }
          }
          tickMagazine(u, def.weapon, dt);
          continue;
        }

        const target = D.Combat.resolveTarget(game, u);
        if (!target) {
          tickMagazine(u, def.weapon, dt);
          continue;
        }
        const tc =
          target.tileW != null
            ? D.Entities.buildingCenter(target)
            : { x: target.x, y: target.y };
        // FOW fire gate: must currently see target tile
        if (!D.Combat.canSee(game, u.owner, tc.x, tc.y)) {
          tickMagazine(u, def.weapon, dt);
          continue;
        }
        const dist = Math.hypot(u.x - tc.x, u.y - tc.y);
        if (D.Combat.inWeaponRange(def.weapon, dist)) {
          // Face the target so barrels / infantry aim match the shot
          u.facing = Math.atan2(tc.y - u.y, tc.x - u.x);
          // Only explicit "attack this id" holds position. Move / attack-move must
          // keep their path — clearing it every tick trapped armies in melees so
          // only units outside gun range obeyed a new group order (~1/3 moved).
          if (u.order && u.order.type === 'attack') {
            u.path = [];
          }
          if (u.weapon.cooldownLeft === 0 && canExpendShot(u, def.weapon)) {
            if (def.weapon.projectile) fireProjectile(game, u, target, def.weapon);
            else fireHitscan(game, u, target, def.weapon);
            u.weapon.cooldownLeft = def.weapon.cooldown;
            expendShot(u, def.weapon);
          }
        }
        tickMagazine(u, def.weapon, dt);
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
        const minR = def.weapon.minRange != null ? def.weapon.minRange : 0;
        // find target in [minRange, range] — LRT ignores melee under the barrel
        let best = null;
        let bestD = def.weapon.range + 0.01;
        for (const o of game.units) {
          if (o.owner === b.owner || o.hp <= 0) continue;
          if (!D.Combat.canSee(game, b.owner, o.x, o.y)) continue;
          const d = Math.hypot(c.x - o.x, c.y - o.y);
          if (d < minR || d >= bestD) continue;
          bestD = d;
          best = o;
        }
        if (best) {
          const tc = { x: best.x, y: best.y };
          b._aimFacing = Math.atan2(tc.y - c.y, tc.x - c.x);
          if (b.weapon.cooldownLeft === 0 && canExpendShot(b, def.weapon)) {
            if (def.weapon.projectile) fireProjectile(game, b, best, def.weapon);
            else fireHitscan(game, b, best, def.weapon);
            b.weapon.cooldownLeft = def.weapon.cooldown;
            expendShot(b, def.weapon);
          }
        }
        tickMagazine(b, def.weapon, dt);
      }

      // projectiles
      for (let i = game.projectiles.length - 1; i >= 0; i--) {
        const p = game.projectiles[i];
        p.life -= dt;
        const target =
          p.targetId != null ? D.Entities.getById(game, p.targetId) : null;
        if (target && target.hp > 0 && !p.ground) {
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
          if (target && target.hp > 0 && !p.ground) {
            applyDamage(game, target, p.weapon, p.owner);
          } else if (p.ground) {
            splashAt(game, p.tx, p.ty, p.weapon, p.owner, p.heavy ? 1.1 : 0.8);
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
