/* global Dune2 */
/**
 * Client build stamp. Overwritten when served as /js/version.js from the Node
 * server (real git rev). Offline / file:// keeps this placeholder.
 */
(function (global) {
  'use strict';
  const D = (global.Dune2 = global.Dune2 || {});
  if (!D.BUILD) {
    D.BUILD = {
      rev: 'dev-local',
      time: null,
      protocol: null,
      source: 'static-fallback',
    };
  }
  D.buildRev = function buildRev() {
    return (D.BUILD && D.BUILD.rev) || 'unknown';
  };
})(typeof window !== 'undefined' ? window : globalThis);
