/* Brick Breaker Web — global config (M1 CONFIG).
 *
 * Classic script (no bundler): every module attaches itself to the shared
 * `BB` namespace declared here.  Load order is fixed in index.html and mirrors
 * the dependency direction: config -> model/rules/levels/physics -> audio ->
 * session -> renderer/input -> app.
 */
(function (global) {
  'use strict';

  var BB = global.BB = global.BB || {};

  BB.VERSION = '1.0.0-web';

  BB.config = Object.freeze({
    DESIGN_WIDTH: 960,
    DESIGN_HEIGHT: 720,

    TARGET_FPS: 60,
    PHYSICS_STEP: 1 / 120,
    MAX_FRAME_TIME: 0.25,
    MAX_SUBSTEPS: 64,

    BRICK_COLUMNS: 11,
    BRICK_ROWS_BASE: 6,
    BRICK_ROWS_MAX: 8,
    BRICK_TONES: 8,

    PADDLE_MAX_BOUNCE_DEG: 55,
    PADDLE_SPIN_DEG: 22,
    PADDLE_SPIN_REF_SPEED: 900,
    PADDLE_MAX_TOTAL_DEG: 70,
    MIN_HORIZONTAL_RATIO: 0.22,
    PADDLE_RALLY_SPEEDUP: 0.012,
    MAX_RALLY_MULTIPLIER: 1.75,

    LEVEL_SPEED_GROWTH: 0.07,
    MAX_SPEED_FACTOR: 2.4,

    STARTING_LIVES: 3,
    COMBO_STEP: 4,
    COMBO_MAX: 5,
    LEVEL_BONUS_BASE: 250,
    LEVEL_CLEAR_DELAY: 1.6,
    BRICK_FADE_TIME: 0.30,
    SCORE_LOG_LIMIT: 64,
    POPUP_LIFE: 0.8,
    POPUP_RISE: 34,

    DEFAULT_INSTRUMENT: 'SINE',
    STORAGE_KEY: 'brick-breaker.web.v1'
  });

  /* Session / model enums (values are stable so tests and storage can use them). */
  BB.RunState = Object.freeze({
    READY: 'ready',
    PLAYING: 'playing',
    PAUSED: 'paused',
    LEVEL_CLEAR: 'level_clear',
    GAME_OVER: 'game_over'
  });

  BB.BallState = Object.freeze({
    ATTACHED: 'attached',
    IN_FLIGHT: 'in_flight',
    LOST: 'lost'
  });

  BB.BrickState = Object.freeze({
    INTACT: 'intact',
    CRACKED: 'cracked',
    FADING: 'fading',
    GONE: 'gone'
  });

  BB.HitKind = Object.freeze({
    WALL: 'wall',
    PADDLE: 'paddle',
    BRICK: 'brick',
    FLOOR: 'floor'
  });

  BB.Intent = Object.freeze({
    PRIMARY: 'primary',
    TOGGLE_PAUSE: 'toggle_pause',
    RESTART: 'restart',
    QUIT: 'quit',
    TOGGLE_MUTE: 'toggle_mute',
    CYCLE_INSTRUMENT: 'cycle_instrument',
    TOGGLE_FULLSCREEN: 'toggle_fullscreen',
    FOCUS_LOST: 'focus_lost'
  });

  BB.clamp = function (value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
  };

  /* Visual system: a fresh "club / neon arcade" look for the web build.
   * Canvas rendering reads these values; the DOM HUD mirrors them via CSS
   * custom properties in css/style.css. */
  BB.style = Object.freeze({
    colors: {
      bg0: '#04050d',
      bg1: '#0b1230',
      bg2: '#1a1040',
      grid: 'rgba(88, 166, 255, 0.07)',
      text: '#eaf1ff',
      dim: '#8b9bc9',
      accent: '#4df3ff',
      accent2: '#ff4fd8',
      lime: '#b8ff4d',
      amber: '#ffb347',
      danger: '#ff5a7a',
      paddle: '#5df3ff',
      paddleEdge: '#eafcff',
      ball: '#ffffff',
      panel: 'rgba(10, 16, 40, 0.78)',
      panelBorder: 'rgba(110, 220, 255, 0.24)',
      wallGlow: 'rgba(77, 243, 255, 0.45)'
    },
    /* Row 0 is the top row; hues feed the combo-driven color system. */
    brickHues: [318, 292, 262, 222, 190, 160, 124, 90],
    brickSaturation: 76,
    brickLightness: 57
  });

  /* Shared hooks for the DOM layer (set by app.js once the document is ready). */
  BB.dom = {};

  /* Stable list of game sound names; the renderer may use it for effects. */
  BB.SOUND_NAMES = Object.freeze([
    'launch', 'wall', 'paddle', 'crack', 'life_lost', 'level_clear',
    'game_over', 'preview'
  ]);
})(typeof window !== 'undefined' ? window : globalThis);
