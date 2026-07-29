/* global Dune2 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});

  let state = 1;

  D.rng = {
    seed(s) {
      state = (s >>> 0) || 1;
    },
    getState() {
      return state;
    },
    setState(s) {
      state = s >>> 0;
    },
    /** Mulberry32 */
    next() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) {
      return min + Math.floor(D.rng.next() * (max - min + 1));
    },
    pick(arr) {
      if (!arr.length) return undefined;
      return arr[Math.floor(D.rng.next() * arr.length)];
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
