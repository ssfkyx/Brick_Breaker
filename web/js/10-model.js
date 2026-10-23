/* Brick Breaker Web — M2 GEOMETRY + M3 MODEL.
 *
 * Classic script (no bundler): attaches the geometry and ERD entities to the
 * shared `BB` namespace declared by 00-config.js.
 *
 *   M2 GEOMETRY  BB.FieldLayout: the limited room (R1), the brick grid and the
 *                entity sizes derived from the window size.  Mirrors
 *                FieldLayout in bb_v1/brick_breaker.py (same clamps, margins,
 *                gaps and Python-style round-half-even rounding).
 *   M3 MODEL     BB.Brick, BB.Paddle, BB.Ball, BB.Record, BB.RunStats,
 *                BB.Settings, BB.Popup: the ERD entities plus their domain
 *                behaviour (brick fade state machine R7, paddle english R4,
 *                ball direction helpers R3/R5/I2).
 *
 * No DOM / window access here: this file runs unchanged inside Node (see
 * web/tests/helpers/load-core.mjs) and inside the browser.
 */
(function (global) {
  'use strict';

  var BB = global.BB = global.BB || {};

  var clamp = BB.clamp;

  /* Python's round() rounds halves to even; Math.round() rounds halves up.
   * Every grid coordinate above is a derived float, so mirror Python to keep
   * the port pixel-identical to bb_v1. */
  function roundHalfEven(value) {
    var lower = Math.floor(value);
    var fraction = value - lower;
    if (fraction > 0.5) return lower + 1;
    if (fraction < 0.5) return lower;
    return lower % 2 === 0 ? lower : lower + 1;   /* exact .5: round to even */
  }

  /* =========================================================================
   * M2 GEOMETRY — the limited room (R1) + brick grid
   * ========================================================================= */

  class FieldLayout {
    constructor(width, height, rows) {
      var w = Math.max(240, Math.trunc(width));
      var h = Math.max(200, Math.trunc(height));
      var r = Math.max(1, Math.trunc(rows));

      var hudHeight = Math.max(40.0, h * 0.085);
      var margin = w * 0.045;
      var gap = Math.max(3.0, w * 0.006);
      var brickW = (w - 2.0 * margin - gap * (BB.config.BRICK_COLUMNS - 1)) / BB.config.BRICK_COLUMNS;
      var brickH = clamp(brickW * 0.42, 12.0, h * 0.045);

      this.width = w;
      this.height = h;
      this.rows = r;
      this.hudHeight = hudHeight;
      this.topWall = hudHeight;
      this.brickX0 = margin;
      this.brickY0 = hudHeight + h * 0.055;
      this.brickW = brickW;
      this.brickH = brickH;
      this.brickGap = gap;
      this.baseSpeed = Math.max(240.0, h * 0.62);
    }

    /* Mirrors FieldLayout.compute(width, height, rows) in Python. */
    static compute(width, height, rows) {
      return new FieldLayout(width, height, rows);
    }

    /* -- derived entity sizes (ERD: PADDLE / BALL own these values) -------- */

    get paddleWidth() {
      return clamp(this.width * 0.155, 70.0, 180.0);
    }

    get paddleHeight() {
      return clamp(this.height * 0.021, 10.0, 18.0);
    }

    get paddleBottom() {
      return this.height - Math.max(36.0, this.height * 0.075);
    }

    get ballRadius() {
      return clamp(this.width * 0.0105, 6.0, 11.0);
    }

    /* -- grid helpers ------------------------------------------------------ */

    /** {x, y, w, h} in integer pixels, exactly like pygame.Rect. */
    brickRect(row, col) {
      return {
        x: roundHalfEven(this.brickX0 + col * (this.brickW + this.brickGap)),
        y: roundHalfEven(this.brickY0 + row * (this.brickH + this.brickGap)),
        w: Math.max(1, roundHalfEven(this.brickW)),
        h: Math.max(1, roundHalfEven(this.brickH))
      };
    }

    /** The playable room: everything below the HUD. */
    get roomRect() {
      var top = Math.trunc(this.topWall);
      return { x: 0, y: top, w: this.width, h: this.height - top };
    }
  }

  /* =========================================================================
   * M3 MODEL — ERD entities and their domain behaviour
   * ========================================================================= */

  /** BRICK: owns the INTACT -> CRACKED -> FADING -> GONE transition (R7). */
  class Brick {
    constructor(options) {
      var opts = options || {};
      this.id = opts.id === undefined ? '' : String(opts.id);
      this.row = opts.row === undefined ? 0 : Math.trunc(opts.row);
      this.col = opts.col === undefined ? 0 : Math.trunc(opts.col);
      this.points = opts.points === undefined ? 0 : Math.trunc(opts.points);
      this.hue = opts.hue === undefined ? 0 : opts.hue;
      this.maxHp = opts.maxHp === undefined ? 1 : Math.trunc(opts.maxHp);
      this.hp = opts.hp === undefined ? this.maxHp : Math.trunc(opts.hp);
      this.state = BB.BrickState.INTACT;
      this.fade = 0.0;
      this.rect = { x: 0, y: 0, w: 0, h: 0 };
    }

    /* Python compatibility alias: the Python model calls this `brick_id`. */
    get brickId() {
      return this.id;
    }

    /** Only INTACT/CRACKED bricks block the ball (I3). */
    get collidable() {
      return this.state === BB.BrickState.INTACT || this.state === BB.BrickState.CRACKED;
    }

    get damaged() {
      return this.hp < this.maxHp;
    }

    /** Apply one hit.  Returns true when the brick was destroyed. */
    hit() {
      this.hp -= 1;
      if (this.hp > 0) {
        this.state = BB.BrickState.CRACKED;
        return false;
      }
      this.state = BB.BrickState.FADING;
      this.fade = BB.config.BRICK_FADE_TIME;
      return true;
    }

    /** Advance the fade-out.  Returns true when the brick becomes GONE. */
    advanceFade(dt) {
      if (this.state !== BB.BrickState.FADING) return false;
      this.fade -= dt;
      if (this.fade <= 0.0) {
        this.fade = 0.0;
        this.state = BB.BrickState.GONE;
        return true;
      }
      return false;
    }
  }

  /** RECORD: best results of this process (in-memory). */
  class Record {
    constructor() {
      this.bestScore = 0;
      this.bestLevel = 1;
      this.bestCombo = 0;
    }

    update(score, level, combo) {
      this.bestScore = Math.max(this.bestScore, score);
      this.bestLevel = Math.max(this.bestLevel, level);
      this.bestCombo = Math.max(this.bestCombo, combo);
    }
  }

  /** SETTINGS: run-wide switches. */
  class Settings {
    constructor(options) {
      var opts = options || {};
      this.muted = opts.muted === true;
      this.fullscreen = opts.fullscreen === true;
      this.windowSize = {
        width: opts.width === undefined ? BB.config.DESIGN_WIDTH : Math.trunc(opts.width),
        height: opts.height === undefined ? BB.config.DESIGN_HEIGHT : Math.trunc(opts.height)
      };
      this.instrument = typeof opts.instrument === 'string'
        ? opts.instrument
        : BB.config.DEFAULT_INSTRUMENT;
    }
  }

  /** RUN: everything that describes the current play-through. */
  class RunStats {
    constructor() {
      this.score = 0;
      this.lives = BB.config.STARTING_LIVES;
      this.level = 1;
      this.combo = 0;
      this.bestCombo = 0;
      this.rallyMultiplier = 1.0;
      this.bricksDestroyed = 0;
      this.entries = [];
      this.record = new Record();
      this._entrySeq = 0;
    }

    /** Append a SCORE_ENTRY, keeping the log bounded (ring buffer). */
    addEntry(brickId, basePoints, multiplier, awarded) {
      this._entrySeq += 1;
      var entry = {
        id: this._entrySeq,
        brickId: brickId,
        basePoints: basePoints,
        multiplier: multiplier,
        awarded: awarded
      };
      this.entries.push(entry);
      var limit = BB.config.SCORE_LOG_LIMIT;
      if (this.entries.length > limit) {
        this.entries.splice(0, this.entries.length - limit);
      }
      return entry;
    }
  }

  /** POPUP: transient "+120" score marker (view model). */
  class Popup {
    constructor(x, y, text, colorHue, ttl) {
      var life = ttl === undefined ? BB.config.POPUP_LIFE : ttl;
      this.x = x;
      this.y = y;
      this.text = text;
      this.colorHue = colorHue;
      this.life = life;
      this.ttl = life;
    }
  }

  /** PADDLE: continuous entity; `velocity` (px/s) is the live input for R4. */
  class Paddle {
    constructor() {
      this.centerX = 0.0;
      this.width = 130.0;
      this.height = 14.0;
      this.bottom = 0.0;
      this.velocity = 0.0;
      this.flash = 0.0;
    }

    get top() {
      return this.bottom - this.height;
    }

    get left() {
      return this.centerX - this.width * 0.5;
    }

    get right() {
      return this.centerX + this.width * 0.5;
    }

    rect() {
      return {
        x: roundHalfEven(this.left),
        y: roundHalfEven(this.top),
        w: Math.max(1, roundHalfEven(this.width)),
        h: Math.max(1, roundHalfEven(this.height))
      };
    }

    /**
     * Move inside the room and record the *actual* instantaneous velocity.
     * Clamping at a wall therefore reports velocity 0, so pushing into a wall
     * cannot add spin to the ball.
     */
    move(direction, speed, dt, roomWidth) {
      var previous = this.centerX;
      if (direction) {
        this.centerX += direction * speed * dt;
      }
      var half = this.width * 0.5;
      this.centerX = clamp(this.centerX, half, roomWidth - half);
      this.velocity = dt > 0.0 ? (this.centerX - previous) / dt : 0.0;
    }
  }

  /** BALL: float pixel position/velocity plus ATTACHED/IN_FLIGHT/LOST state. */
  class Ball {
    constructor() {
      this.x = 0.0;
      this.y = 0.0;
      this.vx = 0.0;
      this.vy = 0.0;
      this.radius = 8.0;
      this.state = BB.BallState.ATTACHED;
    }

    get speed() {
      return Math.hypot(this.vx, this.vy);
    }

    /** Set the velocity from a speed and an angle (radians, 0 = straight up). */
    setDirection(speed, angleRad) {
      this.vx = speed * Math.sin(angleRad);
      this.vy = -speed * Math.cos(angleRad);
    }

    /** Rescale the velocity to *speed*, keeping the direction. */
    setMagnitude(speed) {
      var current = this.speed;
      if (current > 1e-9) {
        var factor = speed / current;
        this.vx *= factor;
        this.vy *= factor;
      }
    }

    scaleVelocity(factor) {
      this.vx *= factor;
      this.vy *= factor;
    }

    /** Guarantee a minimum horizontal component, preserving the speed (I2). */
    preventVerticalStall(minRatio) {
      var ratio = minRatio === undefined ? BB.config.MIN_HORIZONTAL_RATIO : minRatio;
      var speed = this.speed;
      if (speed <= 0.0) return;
      var minVx = speed * ratio;
      if (this.vx >= 0.0 && this.vx < minVx) {
        this.vx = minVx;
      } else if (this.vx > -minVx && this.vx < 0.0) {
        this.vx = -minVx;
      }
      this.setMagnitude(speed);
    }

    /** R3: sit on the paddle, ready to be launched. */
    attachTo(paddle) {
      this.state = BB.BallState.ATTACHED;
      this.vx = 0.0;
      this.vy = 0.0;
      this.x = paddle.centerX;
      this.y = paddle.top - this.radius - 1.0;
    }
  }

  BB.FieldLayout = FieldLayout;
  BB.Brick = Brick;
  BB.Record = Record;
  BB.Settings = Settings;
  BB.RunStats = RunStats;
  BB.Popup = Popup;
  BB.Paddle = Paddle;
  BB.Ball = Ball;
})(typeof window !== 'undefined' ? window : globalThis);
