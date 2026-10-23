/* Brick Breaker Web — persistence (localStorage, with an in-memory fallback).
 *
 * The desktop build deliberately kept scores in memory only; the web build can
 * afford real persistence, so best score/combo/level, the chosen instrument,
 * mute state and the combo-light-show preference survive reloads.
 */
(function (global) {
  'use strict';

  var BB = global.BB;
  var KEY = BB.config.STORAGE_KEY;

  var DEFAULTS = {
    bestScore: 0,
    bestCombo: 0,
    bestLevel: 1,
    instrument: BB.config.DEFAULT_INSTRUMENT,
    muted: false,
    lightShow: true
  };

  function Storage(options) {
    options = options || {};
    this.key = options.key || KEY;
    this.memory = null;
    this.available = true;
    try {
      var probe = '__bb_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
    } catch (error) {
      this.available = false;
    }
  }

  Storage.prototype.load = function () {
    var data = null;
    try {
      var raw = this.available
        ? global.localStorage.getItem(this.key)
        : (this.memory ? this.memory : null);
      if (raw) data = JSON.parse(raw);
    } catch (error) {
      data = null;
    }
    var merged = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        merged[k] = DEFAULTS[k];
      }
    }
    if (data && typeof data === 'object') {
      if (Number.isFinite(data.bestScore)) merged.bestScore = Math.max(0, Math.floor(data.bestScore));
      if (Number.isFinite(data.bestCombo)) merged.bestCombo = Math.max(0, Math.floor(data.bestCombo));
      if (Number.isFinite(data.bestLevel)) merged.bestLevel = Math.max(1, Math.floor(data.bestLevel));
      if (typeof data.instrument === 'string' && BB.INSTRUMENTS[data.instrument]) {
        merged.instrument = data.instrument;
      }
      if (typeof data.muted === 'boolean') merged.muted = data.muted;
      if (typeof data.lightShow === 'boolean') merged.lightShow = data.lightShow;
    }
    return merged;
  };

  Storage.prototype.save = function (data) {
    var payload;
    try {
      payload = JSON.stringify(data);
    } catch (error) {
      return false;
    }
    try {
      if (this.available) {
        global.localStorage.setItem(this.key, payload);
      } else {
        this.memory = payload;
      }
      return true;
    } catch (error) {
      this.memory = payload;
      return false;
    }
  };

  Storage.prototype.update = function (partial) {
    var current = this.load();
    for (var k in partial) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) current[k] = partial[k];
    }
    this.save(current);
    return current;
  };

  Storage.prototype.clear = function () {
    try {
      if (this.available) global.localStorage.removeItem(this.key);
      else this.memory = null;
    } catch (error) { /* ignore */ }
  };

  Storage.DEFAULTS = DEFAULTS;
  BB.Storage = Storage;
})(typeof window !== 'undefined' ? window : globalThis);
