/* Brick Breaker Web — M7 AUDIO.
 *
 * Same design as the Python build: NOTE_TABLE is the instrument-independent
 * score, INSTRUMENTS are data-only timbres, and the engine renders the notes
 * live. On the web we do not need hand-written PCM loops — Web Audio gives us
 * oscillators, periodic waves (harmonic spectra), gain envelopes and noise
 * transients for free. Audio is unlocked on the first user gesture (browser
 * autoplay policy); everything degrades gracefully to silence.
 */
(function (global) {
  'use strict';

  var BB = global.BB;
  var config = BB.config;

  /* ---------------------------------------------------------------------
   * The score: identical pitches / durations / levels to the desktop build.
   * name: { startHz, endHz, ms, volume }
   * ------------------------------------------------------------------- */
  var NOTE_TABLE = {};
  (function () {
    for (var index = 0; index < config.BRICK_TONES; index += 1) {
      var hz = 520 + index * 55;
      NOTE_TABLE['brick' + index] = { startHz: hz, endHz: hz * 1.35, ms: 60, volume: 0.22 };
    }
    NOTE_TABLE.paddle = { startHz: 300, endHz: 380, ms: 70, volume: 0.30 };
    NOTE_TABLE.wall = { startHz: 430, endHz: 430, ms: 45, volume: 0.16 };
    NOTE_TABLE.crack = { startHz: 240, endHz: 180, ms: 70, volume: 0.24 };
    NOTE_TABLE.launch = { startHz: 300, endHz: 700, ms: 120, volume: 0.24 };
    NOTE_TABLE.life_lost = { startHz: 420, endHz: 110, ms: 520, volume: 0.28 };
    NOTE_TABLE.level_clear = { startHz: 520, endHz: 1050, ms: 320, volume: 0.26 };
    NOTE_TABLE.game_over = { startHz: 440, endHz: 90, ms: 800, volume: 0.30 };
    NOTE_TABLE.preview = { startHz: 660, endHz: 990, ms: 140, volume: 0.22 };
  })();

  /* ---------------------------------------------------------------------
   * The timbres.  Data only: harmonic partials, attack, decay shape and a
   * pick/hammer transient.  `noiseHz` scales the band-pass centre frequency.
   * ------------------------------------------------------------------- */
  var INSTRUMENTS = {
    SINE: {
      key: 'SINE',
      label: 'SINE',
      name: 'Sine',
      blurb: 'The original v1.0.0 voice: pure sine blips.',
      partials: [1],
      attack: 0.002,
      decayRatio: 0.6,
      linear: true,
      noise: 0,
      noiseHz: 2,
      gain: 1
    },
    PIANO: {
      key: 'PIANO',
      label: 'PIANO',
      name: 'Piano',
      blurb: 'Hammer attack, six harmonics, exponential decay.',
      partials: [1, 0.45, 0.28, 0.16, 0.09, 0.05],
      attack: 0.003,
      decayRatio: 0.35,
      linear: false,
      noise: 0.10,
      noiseHz: 2.4,
      gain: 1.65
    },
    CLASSICAL: {
      key: 'CLASSICAL',
      label: 'CLASSICAL',
      name: 'Classical guitar',
      blurb: 'Nylon strings: soft attack, warm, fewer highs.',
      partials: [1, 0.32, 0.12, 0.05, 0.02],
      attack: 0.006,
      decayRatio: 0.50,
      linear: false,
      noise: 0.06,
      noiseHz: 1.6,
      gain: 1.35
    },
    ACOUSTIC: {
      key: 'ACOUSTIC',
      label: 'ACOUSTIC',
      name: 'Acoustic guitar',
      blurb: 'Steel strings: bright pick attack, strong harmonics.',
      partials: [1, 0.55, 0.34, 0.20, 0.11, 0.06],
      attack: 0.003,
      decayRatio: 0.38,
      linear: false,
      noise: 0.16,
      noiseHz: 3.0,
      gain: 1.5
    }
  };

  var INSTRUMENT_KEYS = ['SINE', 'PIANO', 'CLASSICAL', 'ACOUSTIC'];

  function AudioEngine(options) {
    options = options || {};
    this.enabled = typeof (global.AudioContext || global.webkitAudioContext) === 'function';
    this.muted = !!options.muted;
    this.instrument = INSTRUMENTS[options.instrument] ? options.instrument : config.DEFAULT_INSTRUMENT;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this._noiseBuffer = null;
    this._waves = {};
    this._unlocking = null;
  }

  AudioEngine.prototype.supported = function () {
    return this.enabled;
  };

  AudioEngine.prototype.isReady = function () {
    return !!(this.ctx && this.ctx.state === 'running');
  };

  AudioEngine.prototype.instrumentKeys = function () {
    return INSTRUMENT_KEYS.slice();
  };

  AudioEngine.prototype.instrumentData = function (key) {
    return INSTRUMENTS[key || this.instrument];
  };

  AudioEngine.prototype.instrumentLabel = function () {
    return this.instrumentData().label;
  };

  AudioEngine.prototype._notify = function () {
    if (this.onChange) {
      this.onChange({ instrument: this.instrument, muted: this.muted });
    }
  };

  /* Must be called from a user gesture (pointerdown / keydown). */
  AudioEngine.prototype.unlock = function () {
    var self = this;
    if (!this.enabled) return Promise.resolve(false);
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        return this.ctx.resume().then(function () { return true; }, function () { return false; });
      }
      return Promise.resolve(true);
    }
    if (this._unlocking) return this._unlocking;

    var Ctor = global.AudioContext || global.webkitAudioContext;
    this._unlocking = Promise.resolve().then(function () {
      var ctx = new Ctor({ latencyHint: 'interactive' });
      var master = ctx.createGain();
      master.gain.value = 0.8;
      var compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 22;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.18;
      master.connect(compressor);
      compressor.connect(ctx.destination);

      self.ctx = ctx;
      self.master = master;
      self.compressor = compressor;
      self._buildNoiseBuffer();
      self._prebuildWaves();
      if (ctx.state === 'suspended') {
        return ctx.resume().then(function () { return true; }, function () { return false; });
      }
      return true;
    }).then(function (ok) {
      self._unlocking = null;
      return ok;
    }, function () {
      self._unlocking = null;
      self.enabled = false;
      return false;
    });
    return this._unlocking;
  };

  AudioEngine.prototype._buildNoiseBuffer = function () {
    var ctx = this.ctx;
    var length = Math.floor(ctx.sampleRate * 0.12);
    var buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this._noiseBuffer = buffer;
  };

  AudioEngine.prototype._waveFor = function (instrument) {
    var cached = this._waves[instrument.key];
    if (cached) return cached;
    var partials = instrument.partials;
    var real = new Float32Array(partials.length + 1);
    var imag = new Float32Array(partials.length + 1);
    for (var h = 0; h < partials.length; h += 1) {
      imag[h + 1] = partials[h];
    }
    var wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this._waves[instrument.key] = wave;
    return wave;
  };

  AudioEngine.prototype._prebuildWaves = function () {
    var keys = INSTRUMENT_KEYS;
    for (var i = 0; i < keys.length; i += 1) {
      this._waveFor(INSTRUMENTS[keys[i]]);
    }
  };

  AudioEngine.prototype._playNoise = function (instrument, note, time, duration) {
    if (!instrument.noise || !this._noiseBuffer) return;
    var ctx = this.ctx;
    var source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    var centre = BB.clamp(note.startHz * instrument.noiseHz, 300, 9000);
    filter.frequency.setValueAtTime(centre, time);
    filter.Q.value = 1.1;
    var gain = ctx.createGain();
    var peak = instrument.noise * note.volume * 1.2;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(0.06, duration * 0.5));
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(time);
    source.stop(time + 0.08);
  };

  AudioEngine.prototype.play = function (name) {
    if (!this.ctx || this.muted || !this.enabled) return false;
    var note = NOTE_TABLE[name];
    if (!note) return false;
    var instrument = INSTRUMENTS[this.instrument] || INSTRUMENTS[config.DEFAULT_INSTRUMENT];
    var ctx = this.ctx;
    var time = ctx.currentTime + 0.003;
    var duration = Math.max(0.02, note.ms / 1000);
    var peak = note.volume * instrument.gain * 0.9;

    var oscillator = ctx.createOscillator();
    oscillator.setPeriodicWave(this._waveFor(instrument));
    oscillator.frequency.setValueAtTime(note.startHz, time);
    if (note.endHz !== note.startHz) {
      oscillator.frequency.linearRampToValueAtTime(note.endHz, time + duration);
    }

    var gain = ctx.createGain();
    if (instrument.linear) {
      gain.gain.setValueAtTime(peak, time);
      gain.gain.linearRampToValueAtTime(0.0001, time + duration);
    } else {
      var attack = Math.max(0.002, instrument.attack);
      var decayTau = Math.max(0.012, duration * instrument.decayRatio / 2.4);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(peak, time + attack);
      gain.gain.setTargetAtTime(0.0001, time + attack, decayTau);
    }
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.06);

    this._playNoise(instrument, note, time, duration);
    return true;
  };

  AudioEngine.prototype.playPreview = function () {
    return this.play('preview');
  };

  AudioEngine.prototype.toggleMute = function () {
    this.muted = !this.muted;
    this._notify();
    return this.muted;
  };

  AudioEngine.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    this._notify();
    return this.muted;
  };

  AudioEngine.prototype.setInstrument = function (key) {
    if (!INSTRUMENTS[key]) return this.instrument;
    this.instrument = key;
    this._notify();
    return this.instrument;
  };

  AudioEngine.prototype.cycleInstrument = function (step) {
    var delta = typeof step === 'number' ? step : 1;
    var keys = INSTRUMENT_KEYS;
    var index = keys.indexOf(this.instrument);
    if (index < 0) index = 0;
    var next = keys[(index + delta + keys.length * 99) % keys.length];
    this.instrument = next;
    this._notify();
    return next;
  };

  BB.NOTE_TABLE = NOTE_TABLE;
  BB.INSTRUMENTS = INSTRUMENTS;
  BB.INSTRUMENT_KEYS = INSTRUMENT_KEYS;
  BB.AudioEngine = AudioEngine;
})(typeof window !== 'undefined' ? window : globalThis);
