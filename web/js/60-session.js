/* Brick Breaker Web — M10 SESSION: the run state machine.
 *
 * Mirrors GameSession in bb_v1/brick_breaker.py.  This is the only module that
 * assigns BB.RunState: input becomes an Intent, physics becomes collision
 * facts, and the session turns those facts into score, audio calls, popups and
 * state transitions.
 *
 * The audio engine is injected (M7 in the Python build).  The session only
 * calls play(name), toggleMute() -> bool (the new muted state) and
 * cycleInstrument() -> str; the app/HUD reads muted and instrumentLabel from
 * the engine itself.  Names used: "wall", "paddle", "crack", "launch",
 * "life_lost", "level_clear", "game_over", "preview" and
 * "brick0".."brick7" (brick row % BRICK_TONES).
 *
 * This file never touches the DOM or localStorage; when no audio is supplied it
 * falls back to BB.NullAudio so the simulation runs headless (Node tests, muted
 * browsers).  Pointer/touch paddle control is exposed through
 * setPointerTarget(x), which the web input layer (M9) drives.
 */
(function (global) {
  'use strict';

  var BB = global.BB = global.BB || {};
  var config = BB.config;

  /* Silent audio sink: same surface as the real M7 SoundBank. */
  class NullAudio {
    play() {}

    toggleMute() {
      return false;
    }

    cycleInstrument() {
      return config.DEFAULT_INSTRUMENT;
    }

    get muted() {
      return false;
    }

    get instrumentLabel() {
      return config.DEFAULT_INSTRUMENT;
    }
  }

  /* Fixed hue for floating score popups: the renderer maps it to a colour.
   * Arbitrary but stable (tests must not depend on the exact value). */
  var POPUP_HUE = 190;

  class GameSession {
    constructor(width, height, audio) {
      this.settings = new BB.Settings({
        width: Math.trunc(width),
        height: Math.trunc(height)
      });
      this.stats = new BB.RunStats();
      this.audio = audio === undefined || audio === null ? new NullAudio() : audio;
      this.physics = new BB.CollisionEngine();

      this.layout = BB.FieldLayout.compute(width, height, BB.LevelFactory.rowsForLevel(1));
      this.paddle = new BB.Paddle();
      this.ball = new BB.Ball();
      this.bricks = [];
      this._brickIndex = new Map();
      this.bricksLeft = 0;
      this.popups = [];

      this.state = BB.RunState.READY;
      this.levelTimer = 0.0;
      this.bannerText = '';
      this.freshRun = true;
      this.moveAxis = 0;
      this.pointerTarget = null;

      this._applyLayout();
      this.newRun();
    }

    /* -- transitions ------------------------------------------------------- */

    /** Start a brand new run (also used by Intent.RESTART). */
    newRun() {
      this.stats = new BB.RunStats();
      this.popups.length = 0;
      this.freshRun = true;
      this.moveAxis = 0;
      this.pointerTarget = null;
      this.bannerText = '';
      this.levelTimer = 0.0;
      this.buildLevel();
      this.prepareBall();
    }

    /** Create the wall for `stats.level` and reset the level bookkeeping. */
    buildLevel() {
      var rows = BB.LevelFactory.rowsForLevel(this.stats.level);
      if (rows !== this.layout.rows) {
        this.layout = BB.FieldLayout.compute(this.layout.width, this.layout.height, rows);
        this._applyLayout();
      }
      this.bricks = BB.LevelFactory.build(this.stats.level, this.layout);
      this._brickIndex = new Map();
      for (var i = 0; i < this.bricks.length; i += 1) {
        this._brickIndex.set(this.bricks[i].id, this.bricks[i]);
      }
      this.bricksLeft = this.bricks.length;
      this.stats.rallyMultiplier = 1.0;
      this.stats.combo = 0;
    }

    /** R3: park the ball on the paddle (BallState.ATTACHED). */
    attachBall() {
      if (this.paddle.centerX <= 0.0) {
        this.paddle.centerX = this.layout.width * 0.5;
      }
      this.paddle.centerX = BB.clamp(
        this.paddle.centerX,
        this.paddle.width * 0.5,
        this.layout.width - this.paddle.width * 0.5
      );
      this.ball.attachTo(this.paddle);
    }

    /** Park the ball and enter READY, waiting for the launch key. */
    prepareBall() {
      this.attachBall();
      this.state = BB.RunState.READY;
    }

    /** READY -> PLAYING with a random launch angle. */
    launchBall() {
      var degrees = 28.0 + Math.random() * (55.0 - 28.0);
      var sign = Math.random() < 0.5 ? -1.0 : 1.0;
      var angle = (degrees * Math.PI / 180.0) * sign;
      var speed = BB.ScoringRules.launchSpeed(
        this.layout,
        this.stats.level,
        this.stats.rallyMultiplier
      );
      this.ball.setDirection(speed, angle);
      this.ball.state = BB.BallState.IN_FLIGHT;
      this.freshRun = false;
      this.state = BB.RunState.PLAYING;
      this.audio.play('launch');
    }

    nextLevel() {
      this.stats.level += 1;
      this.buildLevel();
      this.prepareBall();
    }

    finishLevel() {
      var bonus = BB.ScoringRules.levelBonus(this.stats.level);
      this.stats.score += bonus;
      this.bannerText = 'LEVEL ' + this.stats.level + ' CLEARED  +' + bonus;
      this.state = BB.RunState.LEVEL_CLEAR;
      this.levelTimer = config.LEVEL_CLEAR_DELAY;
      this.audio.play('level_clear');
    }

    /** R8: the ball reached the floor.  One life gone, or game over. */
    loseLife() {
      this.audio.play('life_lost');
      this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
      this.stats.combo = 0;
      this.stats.rallyMultiplier = 1.0;
      this.stats.lives -= 1;
      this.ball.state = BB.BallState.LOST;
      if (this.stats.lives <= 0) {
        this.gameOver();
      } else {
        this.prepareBall();
      }
    }

    gameOver() {
      this.stats.lives = 0;
      this.stats.record.update(this.stats.score, this.stats.level, this.stats.bestCombo);
      this.state = BB.RunState.GAME_OVER;
      this.moveAxis = 0;
      this.audio.play('game_over');
    }

    /* -- input ------------------------------------------------------------- */

    setMoveAxis(axis) {
      this.moveAxis = axis < 0 ? -1 : (axis > 0 ? 1 : 0);
    }

    /**
     * Web/touch extension: aim the paddle at an absolute x (canvas pixels).
     * Passing null (pointer up / touch end) returns control to the keyboard.
     * The paddle still moves through Paddle.move(), so its real instantaneous
     * velocity is recorded and feeds the english (spin) bounce (R4).
     */
    setPointerTarget(x) {
      if (x === null || x === undefined) {
        this.pointerTarget = null;
        return;
      }
      var value = Number(x);
      this.pointerTarget = Number.isFinite(value) ? value : null;
    }

    /** Apply a game-level intent inside the current state. */
    apply(intent) {
      if (intent === BB.Intent.RESTART) {
        this.newRun();

      } else if (intent === BB.Intent.TOGGLE_MUTE) {
        this.settings.muted = this.audio.toggleMute();

      } else if (intent === BB.Intent.CYCLE_INSTRUMENT) {
        /* M7 owns the timbre bank; the chosen preset name stays in the model
         * so the HUD and tests can read it back without touching the mixer. */
        this.settings.instrument = this.audio.cycleInstrument();
        this.audio.play('preview');

      } else if (intent === BB.Intent.FOCUS_LOST) {
        if (this.state === BB.RunState.PLAYING) {
          this.state = BB.RunState.PAUSED;
        }

      } else if (intent === BB.Intent.TOGGLE_PAUSE) {
        if (this.state === BB.RunState.PLAYING) {
          this.state = BB.RunState.PAUSED;
        } else if (this.state === BB.RunState.PAUSED) {
          this.state = BB.RunState.PLAYING;
        }

      } else if (intent === BB.Intent.PRIMARY) {
        if (this.state === BB.RunState.READY) {
          this.launchBall();
        } else if (this.state === BB.RunState.LEVEL_CLEAR) {
          this.levelTimer = 0.0;
        } else if (this.state === BB.RunState.GAME_OVER) {
          this.newRun();
        }
      }
    }

    /* -- simulation -------------------------------------------------------- */

    update(dt) {
      if (
        this.state === BB.RunState.PLAYING ||
        this.state === BB.RunState.READY ||
        this.state === BB.RunState.LEVEL_CLEAR
      ) {
        this._movePaddle(dt);
      }

      if (this.state === BB.RunState.PLAYING) {
        var events = this.physics.step(this.ball, this.paddle, this.bricks, this.layout, dt);
        for (var i = 0; i < events.length; i += 1) {
          if (this.state !== BB.RunState.PLAYING) {
            break;                       /* a transition already stopped play */
          }
          this._consume(events[i]);
        }
      } else if (this.state === BB.RunState.READY) {
        this.ball.attachTo(this.paddle);       /* keep riding the paddle (R3) */
      } else if (this.state === BB.RunState.LEVEL_CLEAR) {
        this.levelTimer -= dt;
        if (this.levelTimer <= 0.0) {
          this.nextLevel();
        }
      }

      if (this.state !== BB.RunState.PAUSED) {
        this._advanceAnimation(dt);      /* R7: fade-outs & pop-ups (frozen when paused) */
      }
      if (this.paddle.flash > 0.0) {
        this.paddle.flash = Math.max(0.0, this.paddle.flash - dt);
      }
    }

    /** R7 fade-outs and pop-ups; frozen while paused. */
    _advanceAnimation(dt) {
      this._advanceFades(dt);
      this._advancePopups(dt);
    }

    _movePaddle(dt) {
      var speed = Math.max(360.0, this.layout.width * 1.0);

      /* Keyboard wins over a stale pointer target, so both input methods keep
       * working when the player mixes them. */
      if (this.moveAxis !== 0) {
        this.pointerTarget = null;
        this.paddle.move(this.moveAxis, speed, dt, this.layout.width);
        return;
      }

      /* Web/touch aim: drive the paddle straight at the pointer x and record the
       * real instantaneous velocity (Paddle.move clamps at the walls). */
      if (this.pointerTarget !== null && dt > 0.0) {
        var delta = this.pointerTarget - this.paddle.centerX;
        if (delta !== 0.0) {
          this.paddle.move(delta > 0.0 ? 1 : -1, Math.abs(delta) / dt, dt, this.layout.width);
        } else {
          this.paddle.move(0, 0.0, dt, this.layout.width);
        }
        return;
      }

      this.paddle.move(this.moveAxis, speed, dt, this.layout.width);
    }

    /** Turn a physics fact into score, sound and state changes. */
    _consume(event) {
      if (event.kind === BB.HitKind.WALL) {
        this.audio.play('wall');

      } else if (event.kind === BB.HitKind.PADDLE) {
        this.audio.play('paddle');
        this.paddle.flash = 0.12;
        this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
        this.stats.combo = 0;
        this.stats.rallyMultiplier = BB.ScoringRules.nextRallyMultiplier(
          this.stats.rallyMultiplier
        );
        /* The engine chose the direction (offset + english); the rule set
         * decides how fast the rally has become. */
        this.ball.setMagnitude(
          BB.ScoringRules.launchSpeed(
            this.layout,
            this.stats.level,
            this.stats.rallyMultiplier
          )
        );

      } else if (event.kind === BB.HitKind.BRICK) {
        this._onBrickHit(event);

      } else if (event.kind === BB.HitKind.FLOOR) {
        this.loseLife();
      }
    }

    _onBrickHit(event) {
      if (!event.destroyed) {
        this.audio.play('crack');             /* cracked but still standing */
        return;
      }

      var brick = this._brickIndex.get(event.brickId ? event.brickId : '');
      if (brick === undefined) {
        return;
      }

      this.bricksLeft -= 1;
      this.stats.bricksDestroyed += 1;
      this.stats.combo += 1;
      var scored = BB.ScoringRules.brickPoints(brick, this.stats.combo);
      var multiplier = scored.multiplier;
      var awarded = scored.points;
      this.stats.score += awarded;
      this.stats.addEntry(brick.id, brick.points, multiplier, awarded);
      this.popups.push(new BB.Popup(
        brick.rect.x + brick.rect.w * 0.5,
        brick.rect.y + brick.rect.h * 0.5,
        '+' + awarded + (multiplier > 1 ? ' x' + multiplier : ''),
        POPUP_HUE
      ));
      this.audio.play('brick' + (brick.row % config.BRICK_TONES));

      if (this.bricksLeft <= 0) {
        this.finishLevel();
      }
    }

    _advanceFades(dt) {
      var removed = false;
      for (var i = 0; i < this.bricks.length; i += 1) {
        if (this.bricks[i].advanceFade(dt)) {
          removed = true;
        }
      }
      if (removed) {
        var alive = [];
        for (var j = 0; j < this.bricks.length; j += 1) {
          if (this.bricks[j].state !== BB.BrickState.GONE) {
            alive.push(this.bricks[j]);
          }
        }
        this.bricks = alive;
        this._brickIndex = new Map();
        for (var k = 0; k < this.bricks.length; k += 1) {
          this._brickIndex.set(this.bricks[k].id, this.bricks[k]);
        }
      }
    }

    _advancePopups(dt) {
      if (this.popups.length === 0) {
        return;
      }
      var alive = [];
      for (var i = 0; i < this.popups.length; i += 1) {
        var popup = this.popups[i];
        popup.life -= dt;
        popup.y -= config.POPUP_RISE * dt;
        if (popup.life > 0.0) {
          alive.push(popup);
        }
      }
      this.popups = alive;
    }

    /* -- window / geometry ------------------------------------------------- */

    /** Re-derive the room and keep everything in the same relative place. */
    resize(width, height) {
      var oldLayout = this.layout;
      var oldWidth = Math.max(1, oldLayout.width);
      var oldHeight = Math.max(1, oldLayout.height);
      var oldBase = Math.max(1e-6, oldLayout.baseSpeed);

      this.layout = BB.FieldLayout.compute(width, height, oldLayout.rows);
      this.settings.windowSize = { width: this.layout.width, height: this.layout.height };
      this._applyLayout();

      this.paddle.centerX = BB.clamp(
        this.paddle.centerX * this.layout.width / oldWidth,
        this.paddle.width * 0.5,
        this.layout.width - this.paddle.width * 0.5
      );
      this.ball.scaleVelocity(this.layout.baseSpeed / oldBase);
      this.ball.x = BB.clamp(
        this.ball.x * this.layout.width / oldWidth,
        this.ball.radius,
        this.layout.width - this.ball.radius
      );
      this.ball.y = this.layout.height * (this.ball.y / oldHeight);
      if (this.state === BB.RunState.READY) {
        this.ball.attachTo(this.paddle);
      }
    }

    /** Push derived sizes into the entities and re-position the wall (M3/M6). */
    _applyLayout() {
      var layout = this.layout;
      this.paddle.width = layout.paddleWidth;
      this.paddle.height = layout.paddleHeight;
      this.paddle.bottom = layout.paddleBottom;
      this.ball.radius = layout.ballRadius;
      BB.LevelFactory.reflow(this.bricks, layout);
    }

    /* -- queries ----------------------------------------------------------- */

    get comboMultiplier() {
      return BB.ScoringRules.comboMultiplier(this.stats.combo);
    }

    /** Bricks that are not GONE (fading ones included). */
    get activeBricks() {
      var active = [];
      for (var i = 0; i < this.bricks.length; i += 1) {
        if (this.bricks[i].state !== BB.BrickState.GONE) {
          active.push(this.bricks[i]);
        }
      }
      return active;
    }

    brickById(brickId) {
      return this._brickIndex.get(brickId);
    }
  }

  BB.NullAudio = NullAudio;
  BB.GameSession = GameSession;
})(typeof window !== 'undefined' ? window : globalThis);
