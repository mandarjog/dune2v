/* global Dune2 */
/**
 * Multi-seat FFA support (2–5 players).
 * Seat ids keep `player` / `enemy` for the first two (save/replay compat),
 * then `p2`…`p4`. Houses cycle Atreides → Harkonnen → Ordos and repeat.
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  const IDS = ['player', 'enemy', 'p2', 'p3', 'p4'];

  const HOUSES = [
    {
      id: 'atreides',
      name: 'Atreides',
      color: '#4a90d9',
      colorDark: '#2a5a9a',
    },
    {
      id: 'harkonnen',
      name: 'Harkonnen',
      color: '#c0392b',
      colorDark: '#8a2018',
    },
    {
      id: 'ordos',
      name: 'Ordos',
      color: '#27ae60',
      colorDark: '#1a6b3c',
    },
  ];

  D.Seats = {
    MAX: 5,
    MIN_START: 2,
    IDS: IDS.slice(),
    HOUSES: HOUSES,

    index(seat) {
      const i = IDS.indexOf(seat);
      return i >= 0 ? i : 0;
    },

    isSeat(seat) {
      return IDS.indexOf(seat) >= 0;
    },

    /** House def for a seat (cycles every 3). */
    house(seat) {
      return HOUSES[D.Seats.index(seat) % HOUSES.length];
    },

    color(seat) {
      const h = D.Seats.house(seat);
      return h ? h.color : '#888';
    },

    /**
     * Display label: "Ordos-Alex" or "Atreides" if no name.
     * @param {string} seat
     * @param {object|null} names map seat -> display name
     */
    label(seat, names) {
      const h = D.Seats.house(seat);
      const n = names && names[seat] ? String(names[seat]).trim() : '';
      if (n && h) return h.name + '-' + n;
      if (h) return h.name;
      return seat || '?';
    },

    /** Short house name only. */
    houseName(seat) {
      const h = D.Seats.house(seat);
      return h ? h.name : seat;
    },

    /** Active owners in this match (default 1v1). */
    active(game) {
      if (game && game.activeOwners && game.activeOwners.length) {
        return game.activeOwners.filter((s) => D.Seats.isSeat(s));
      }
      return ['player', 'enemy'];
    },

    /** Ensure economy/power/fog buckets exist for each owner. */
    ensureBuckets(game, owners) {
      const list = owners || D.Seats.active(game);
      if (!game.credits) game.credits = {};
      if (!game.spiceCap) game.spiceCap = {};
      if (!game.power) game.power = {};
      if (!game.structureBuilder) game.structureBuilder = {};
      if (!game.players) game.players = {};
      const base = D.config.economy.baseSpiceCap;
      const start = D.config.economy.startingCredits;
      for (const o of list) {
        if (game.credits[o] == null) game.credits[o] = start;
        if (game.spiceCap[o] == null) game.spiceCap[o] = base;
        if (!game.power[o]) game.power[o] = { prod: 0, need: 0, ratio: 1 };
        if (game.structureBuilder[o] === undefined) game.structureBuilder[o] = null;
        const h = D.Seats.house(o);
        game.players[o] = {
          house: h.id,
          color: h.color,
        };
      }
    },

    emptyCredits() {
      const o = {};
      for (const id of IDS) o[id] = 0;
      return o;
    },

    emptySpiceCap() {
      const o = {};
      const base = (D.config.economy && D.config.economy.baseSpiceCap) || 500;
      for (const id of IDS) o[id] = base;
      return o;
    },

    emptyPower() {
      const o = {};
      for (const id of IDS) o[id] = { prod: 0, need: 0, ratio: 1 };
      return o;
    },

    /** Spawn key on map def: player/enemy/p2… */
    spawnFor(mapDef, seat) {
      if (!mapDef || !mapDef.spawns) return null;
      if (mapDef.spawns[seat]) return mapDef.spawns[seat];
      // fallback: cycle existing spawns
      const keys = Object.keys(mapDef.spawns);
      if (!keys.length) return null;
      return mapDef.spawns[keys[D.Seats.index(seat) % keys.length]];
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
