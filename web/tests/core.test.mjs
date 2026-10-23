/* Brick Breaker Web — headless Node tests for the simulation core.
 *
 * Run from the `web/` directory (no npm install, no dependencies):
 *
 *   node --test tests/core.test.mjs
 *
 * If the host sandbox blocks the test runner's child-process spawning (EPERM),
 * run the file in the same process instead (same tests, same assertions):
 *
 *   node --test --test-isolation=none tests/core.test.mjs
 *   node tests/core.test.mjs
 *
 * Every test is deterministic: no sleeps, no wall clock, and randomness is
 * stubbed where the launch angle matters.  The suite exercises the classic
 * scripts through the same `BB` namespace the browser uses (see
 * tests/helpers/load-core.mjs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadCore } from './helpers/load-core.mjs';

const BB = loadCore();
const config = BB.config;
const STEP = config.PHYSICS_STEP;

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

/* Same surface as the M7 SoundBank, but it only records what it was asked to
 * play so tests can assert on audio cues without a real mixer. */
class StubAudio {
  constructor() {
    this.calls = [];
    this.instrument = BB.config.DEFAULT_INSTRUMENT;
    this._muted = false;
    this._cycle = ['SINE', 'PIANO', 'CLASSICAL', 'ACOUSTIC'];
  }

  play(name) {
    this.calls.push(name);
  }

  toggleMute() {
    this._muted = !this._muted;
    return this._muted;
  }

  cycleInstrument() {
    const index = Math.max(0, this._cycle.indexOf(this.instrument));
    this.instrument = this._cycle[(index + 1) % this._cycle.length];
    return this.instrument;
  }

  get muted() {
    return this._muted;
  }

  get instrumentLabel() {
    return this.instrument;
  }
}

function createSession(width = 480, height = 360, audio = new StubAudio()) {
  return { session: new BB.GameSession(width, height, audio), audio };
}

/* Math.random is the only nondeterminism in the simulation: stub it while the
 * launch angle is chosen so the test can assert exact values. */
function withFixedRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function approx(actual, expected, tolerance = 1e-9, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label || 'value'} expected ~${expected}, got ${actual}`
  );
}

function angleFromVerticalDegrees(ball) {
  return (Math.atan2(Math.abs(ball.vx), -ball.vy) * 180) / Math.PI;
}

/* Put the in-flight ball past the room floor so physics reports FLOOR (R8). */
function dropBallBelowFloor(session) {
  const layout = session.layout;
  session.ball.state = BB.BallState.IN_FLIGHT;
  session.ball.x = layout.width * 0.5;
  session.ball.y = layout.height + session.ball.radius + 8.0;
  session.ball.vx = 0.0;
  session.ball.vy = layout.baseSpeed;
}

/* Create a fresh, fully configured paddle for direct physics tests. */
function createPaddle(layout) {
  const paddle = new BB.Paddle();
  paddle.width = layout.paddleWidth;
  paddle.height = layout.paddleHeight;
  paddle.bottom = layout.paddleBottom;
  paddle.centerX = layout.width * 0.5;
  return paddle;
}

/* --------------------------------------------------------------------------
 * Namespace / module wiring
 * ------------------------------------------------------------------------ */

describe('classic-script namespace', () => {
  it('exposes the whole simulation surface on BB', () => {
    assert.equal(typeof BB.FieldLayout, 'function');
    assert.equal(typeof BB.Brick, 'function');
    assert.equal(typeof BB.Paddle, 'function');
    assert.equal(typeof BB.Ball, 'function');
    assert.equal(typeof BB.Record, 'function');
    assert.equal(typeof BB.RunStats, 'function');
    assert.equal(typeof BB.Settings, 'function');
    assert.equal(typeof BB.Popup, 'function');
    assert.equal(typeof BB.LevelFactory, 'object');
    assert.equal(typeof BB.CollisionEngine, 'function');
    assert.equal(typeof BB.circleRectCollision, 'function');
    assert.equal(typeof BB.GameSession, 'function');
    assert.equal(typeof BB.NullAudio, 'function');
    for (const name of [
      'comboMultiplier', 'brickPoints', 'levelBonus',
      'levelSpeedFactor', 'launchSpeed', 'nextRallyMultiplier'
    ]) {
      assert.equal(typeof BB.ScoringRules[name], 'function', name);
    }
  });
});

/* --------------------------------------------------------------------------
 * M2 GEOMETRY
 * ------------------------------------------------------------------------ */

describe('M2 FieldLayout geometry', () => {
  it('derives the documented 960x720 room and entity sizes', () => {
    const layout = BB.FieldLayout.compute(960, 720, config.BRICK_ROWS_MAX);
    assert.equal(layout.width, 960);
    assert.equal(layout.height, 720);
    assert.equal(layout.rows, config.BRICK_ROWS_MAX);

    approx(layout.hudHeight, 61.2, 1e-9, 'hudHeight');
    approx(layout.topWall, layout.hudHeight, 1e-9, 'topWall');
    approx(layout.brickX0, 43.2, 1e-9, 'brickX0');
    approx(layout.brickY0, 100.8, 1e-9, 'brickY0');
    approx(layout.brickGap, 5.76, 1e-9, 'brickGap');
    approx(layout.brickW, 816 / 11, 1e-9, 'brickW');
    approx(layout.brickH, (816 / 11) * 0.42, 1e-9, 'brickH');
    approx(layout.baseSpeed, 446.4, 1e-9, 'baseSpeed');

    approx(layout.paddleWidth, 148.8, 1e-9, 'paddleWidth');
    approx(layout.paddleHeight, 15.12, 1e-9, 'paddleHeight');
    approx(layout.paddleBottom, 666, 1e-9, 'paddleBottom');
    approx(layout.ballRadius, 10.08, 1e-9, 'ballRadius');
  });

  it('keeps the brick grid inside the room and above the paddle', () => {
    const layout = BB.FieldLayout.compute(960, 720, config.BRICK_ROWS_MAX);

    /* Python-style rounding on the integer grid: known-good values. */
    assert.deepEqual(layout.brickRect(0, 0), { x: 43, y: 101, w: 74, h: 31 });
    assert.deepEqual(
      layout.brickRect(config.BRICK_ROWS_MAX - 1, config.BRICK_COLUMNS - 1),
      { x: 843, y: 359, w: 74, h: 31 }
    );

    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < config.BRICK_COLUMNS; col += 1) {
        const rect = layout.brickRect(row, col);
        assert.ok(rect.x >= 0, `row ${row} col ${col} x`);
        assert.ok(rect.y >= layout.topWall, `row ${row} col ${col} top`);
        assert.ok(rect.x + rect.w <= layout.width, `row ${row} col ${col} right`);
        assert.ok(rect.y + rect.h < layout.paddleBottom, `row ${row} col ${col} bottom`);
        assert.ok(rect.w >= 1 && rect.h >= 1);
      }
    }

    assert.deepEqual(layout.roomRect, {
      x: 0,
      y: Math.trunc(layout.topWall),
      w: 960,
      h: 720 - Math.trunc(layout.topWall)
    });
    assert.equal(layout.roomRect.y, 61);
    assert.equal(layout.roomRect.h, 659);
  });

  it('clamps a degenerate window to 240x200 with at least one row', () => {
    const tiny = BB.FieldLayout.compute(10, 10, 0);
    assert.ok(tiny.width >= 240);
    assert.ok(tiny.height >= 200);
    assert.ok(tiny.rows >= 1);
    approx(tiny.baseSpeed, 240, 1e-9, 'tiny baseSpeed');
    assert.ok(tiny.paddleBottom < tiny.height);
    assert.ok(tiny.brickRect(0, 0).x >= 0);
    assert.ok(tiny.brickRect(0, config.BRICK_COLUMNS - 1).x + 1 <= tiny.width);
  });
});

/* --------------------------------------------------------------------------
 * M3 MODEL — brick state machine (R7)
 * ------------------------------------------------------------------------ */

describe('M3 Brick state machine', () => {
  it('destroys a 1 HP brick on the first hit and fades it out', () => {
    const brick = new BB.Brick({
      id: 'L1R0C0', row: 0, col: 0, points: 60, hue: 318, maxHp: 1
    });
    assert.equal(brick.state, BB.BrickState.INTACT);
    assert.equal(brick.hp, 1);
    assert.equal(brick.collidable, true);
    assert.equal(brick.damaged, false);

    assert.equal(brick.hit(), true);                 /* destroyed on first hit */
    assert.equal(brick.state, BB.BrickState.FADING);
    assert.equal(brick.collidable, false);           /* I3: no second score */
    approx(brick.fade, config.BRICK_FADE_TIME, 1e-12, 'fade');

    assert.equal(brick.advanceFade(config.BRICK_FADE_TIME / 2.0), false);
    assert.equal(brick.state, BB.BrickState.FADING);
    assert.equal(brick.advanceFade(config.BRICK_FADE_TIME), true);
    assert.equal(brick.state, BB.BrickState.GONE);
    assert.equal(brick.fade, 0);
    assert.equal(brick.collidable, false);
  });

  it('cracks a 2 HP brick first, then destroys it; FADING never collides', () => {
    const tough = new BB.Brick({
      id: 'L3R0C0', row: 0, col: 0, points: 140, hue: 318, maxHp: 2
    });
    assert.equal(tough.hp, 2);
    assert.equal(tough.damaged, false);

    assert.equal(tough.hit(), false);                /* cracked, still standing */
    assert.equal(tough.state, BB.BrickState.CRACKED);
    assert.equal(tough.collidable, true);
    assert.equal(tough.damaged, true);
    assert.equal(tough.hp, 1);

    assert.equal(tough.hit(), true);                 /* second hit destroys it */
    assert.equal(tough.state, BB.BrickState.FADING);
    assert.equal(tough.collidable, false);
    assert.equal(tough.hp, 0);
  });
});

/* --------------------------------------------------------------------------
 * M5 RULES — scoring / combo / speed policy
 * ------------------------------------------------------------------------ */

describe('M5 ScoringRules', () => {
  it('builds the combo multiplier ladder from COMBO_STEP up to COMBO_MAX', () => {
    assert.equal(BB.ScoringRules.comboMultiplier(0), 1);
    assert.equal(BB.ScoringRules.comboMultiplier(config.COMBO_STEP - 1), 1);
    assert.equal(BB.ScoringRules.comboMultiplier(config.COMBO_STEP), 2);
    assert.equal(BB.ScoringRules.comboMultiplier(config.COMBO_STEP * 2), 3);
    assert.equal(
      BB.ScoringRules.comboMultiplier(config.COMBO_STEP * (config.COMBO_MAX - 1)),
      config.COMBO_MAX
    );
    assert.equal(BB.ScoringRules.comboMultiplier(10000), config.COMBO_MAX);

    const multipliers = [];
    for (let combo = 0; combo < 40; combo += 1) {
      multipliers.push(BB.ScoringRules.comboMultiplier(combo));
    }
    assert.deepEqual(multipliers, [...multipliers].sort((a, b) => a - b));
  });

  it('awards brick points scaled by the combo multiplier', () => {
    const brick = new BB.Brick({ id: 'L1R2C3', row: 2, col: 3, points: 40, hue: 262 });
    assert.deepEqual(BB.ScoringRules.brickPoints(brick, 0), { multiplier: 1, points: 40 });
    assert.deepEqual(
      BB.ScoringRules.brickPoints(brick, config.COMBO_STEP * 2),
      { multiplier: 3, points: 120 }
    );
    assert.deepEqual(
      BB.ScoringRules.brickPoints(brick, 10000),
      { multiplier: config.COMBO_MAX, points: 200 }
    );
  });

  it('applies the level bonus, the speed ramp and both caps', () => {
    assert.equal(BB.ScoringRules.levelBonus(1), config.LEVEL_BONUS_BASE);
    assert.equal(BB.ScoringRules.levelBonus(4), config.LEVEL_BONUS_BASE * 4);
    assert.equal(BB.ScoringRules.levelBonus(0), config.LEVEL_BONUS_BASE);   /* clamped */

    approx(BB.ScoringRules.levelSpeedFactor(1), 1.0, 1e-12, 'factor(1)');
    approx(
      BB.ScoringRules.levelSpeedFactor(3),
      1.0 + 2.0 * config.LEVEL_SPEED_GROWTH,
      1e-12,
      'factor(3)'
    );
    assert.ok(
      BB.ScoringRules.levelSpeedFactor(8) > BB.ScoringRules.levelSpeedFactor(2)
    );

    const layout = BB.FieldLayout.compute(960, 720, config.BRICK_ROWS_BASE);
    const base = layout.baseSpeed;
    approx(BB.ScoringRules.launchSpeed(layout, 1, 1.0), base, 1e-9, 'launch speed L1');
    approx(
      BB.ScoringRules.launchSpeed(layout, 10000, 10.0),
      base * config.MAX_SPEED_FACTOR,
      1e-9,
      'launch speed cap'
    );
  });

  it('caps the rally multiplier at MAX_RALLY_MULTIPLIER', () => {
    let rally = 1.0;
    for (let i = 0; i < 1000; i += 1) {
      rally = BB.ScoringRules.nextRallyMultiplier(rally);
    }
    approx(rally, config.MAX_RALLY_MULTIPLIER, 1e-9, 'rally cap');
    approx(BB.ScoringRules.nextRallyMultiplier(1.0), 1.0 + config.PADDLE_RALLY_SPEEDUP, 1e-12);
  });
});

/* --------------------------------------------------------------------------
 * M3 MODEL — ball helpers & bookkeeping
 * ------------------------------------------------------------------------ */

describe('M3 Ball helpers', () => {
  it('preserves the speed magnitude and prevents a vertical stall (I2)', () => {
    const ball = new BB.Ball();
    ball.setDirection(200, 0);                       /* straight up */
    approx(ball.speed, 200, 1e-9, 'speed');
    approx(ball.vx, 0, 1e-12, 'vx');
    approx(ball.vy, -200, 1e-9, 'vy');

    ball.preventVerticalStall();
    approx(ball.speed, 200, 1e-9, 'speed after stall guard');
    assert.ok(ball.vx > 0, 'a horizontal component is injected');
    assert.ok(ball.vy < 0, 'the ball still travels up');
    assert.ok(Math.abs(ball.vx) / ball.speed > 0.2, 'meaningful horizontal ratio');

    ball.setMagnitude(400);
    approx(ball.speed, 400, 1e-9, 'rescaled speed');
    const ratio = ball.vx / ball.speed;
    ball.scaleVelocity(0.5);
    approx(ball.speed, 200, 1e-9, 'scaled speed');
    approx(ball.vx / ball.speed, ratio, 1e-12, 'direction preserved');
  });

  it('attaches the ball to the paddle (R3)', () => {
    const paddle = new BB.Paddle();
    paddle.centerX = 500;
    paddle.width = 100;
    paddle.height = 10;
    paddle.bottom = 600;

    const ball = new BB.Ball();
    ball.radius = 8;
    ball.attachTo(paddle);
    assert.equal(ball.state, BB.BallState.ATTACHED);
    assert.equal(ball.vx, 0);
    assert.equal(ball.vy, 0);
    assert.equal(ball.x, 500);
    assert.equal(ball.y, paddle.top - 8 - 1);
    assert.equal(ball.y, 581);
  });
});

describe('M3 RunStats bookkeeping', () => {
  it('keeps a bounded score log with a monotonic entry id sequence', () => {
    const stats = new BB.RunStats();
    assert.equal(stats.score, 0);
    assert.equal(stats.lives, config.STARTING_LIVES);
    assert.equal(stats.level, 1);
    assert.equal(stats.rallyMultiplier, 1.0);

    const total = config.SCORE_LOG_LIMIT + 6;
    for (let i = 1; i <= total; i += 1) {
      stats.addEntry('B' + i, 10, 1, 10);
    }
    assert.equal(stats.entries.length, config.SCORE_LOG_LIMIT);
    assert.equal(stats.entries[0].id, total - config.SCORE_LOG_LIMIT + 1);
    assert.equal(stats.entries[0].brickId, 'B' + (total - config.SCORE_LOG_LIMIT + 1));
    assert.equal(stats.entries[stats.entries.length - 1].id, total);
    assert.equal(stats.entries[stats.entries.length - 1].awarded, 10);

    stats.record.update(1200, 5, 9);
    assert.equal(stats.record.bestScore, 1200);
    assert.equal(stats.record.bestLevel, 5);
    assert.equal(stats.record.bestCombo, 9);
    stats.record.update(10, 2, 3);                   /* never decreases */
    assert.equal(stats.record.bestScore, 1200);
    assert.equal(stats.record.bestLevel, 5);
    assert.equal(stats.record.bestCombo, 9);
  });
});

/* --------------------------------------------------------------------------
 * M6 LEVELS
 * ------------------------------------------------------------------------ */

describe('M6 LevelFactory', () => {
  it('computes the documented row-count ladder', () => {
    const expected = [6, 6, 7, 7, 8, 8, 8, 8, 8];
    const actual = expected.map((_, index) => BB.LevelFactory.rowsForLevel(index + 1));
    assert.deepEqual(actual, expected);
    /* Derived from the config, so a balance change cannot silently break it. */
    for (let level = 1; level <= 12; level += 1) {
      assert.ok(BB.LevelFactory.rowsForLevel(level) >= config.BRICK_ROWS_BASE);
      assert.ok(BB.LevelFactory.rowsForLevel(level) <= config.BRICK_ROWS_MAX);
    }
    assert.equal(BB.LevelFactory.rowsForLevel(0), config.BRICK_ROWS_BASE);
  });

  it('builds rows * BRICK_COLUMNS bricks with valid ids, rects and hues', () => {
    const layout = BB.FieldLayout.compute(960, 720, config.BRICK_ROWS_BASE);
    const bricks = BB.LevelFactory.build(1, layout);
    assert.equal(bricks.length, config.BRICK_ROWS_BASE * config.BRICK_COLUMNS);

    const ids = new Set();
    for (const brick of bricks) {
      assert.equal(brick.id, `L1R${brick.row}C${brick.col}`);
      assert.equal(ids.has(brick.id), false, 'brick ids are unique');
      ids.add(brick.id);
      assert.deepEqual(brick.rect, layout.brickRect(brick.row, brick.col));
      assert.equal(brick.hue, BB.style.brickHues[brick.row % BB.style.brickHues.length]);
      assert.equal(brick.points, (config.BRICK_ROWS_BASE - brick.row) * 10);
      assert.equal(brick.maxHp, 1);
      assert.equal(brick.hp, 1);
      assert.equal(brick.state, BB.BrickState.INTACT);
    }
  });

  it('gives the top row double HP and double points from level 3 on', () => {
    const layout = BB.FieldLayout.compute(960, 720, 7);

    const levelTwo = BB.LevelFactory.build(2, layout);
    assert.equal(levelTwo[0].maxHp, 1);
    assert.equal(levelTwo[0].points, 70);

    const levelThree = BB.LevelFactory.build(3, layout);
    assert.equal(levelThree[0].maxHp, 2);
    assert.equal(levelThree[0].hp, 2);
    assert.equal(levelThree[0].points, 140);          /* 7 rows * 10 * 2 */
    assert.equal(levelThree[0].id, 'L3R0C0');
    assert.equal(levelThree.find((brick) => brick.row === 1).maxHp, 1);
    assert.equal(levelThree.find((brick) => brick.row === 1).points, 60);
  });
});

/* --------------------------------------------------------------------------
 * M4 PHYSICS
 * ------------------------------------------------------------------------ */

describe('M4 CollisionEngine', () => {
  it('reports normals and penetration for circle/rectangle overlap', () => {
    const rect = { x: 100, y: 100, w: 50, h: 20 };

    assert.equal(BB.circleRectCollision(200, 110, 5, rect), null);

    const above = BB.circleRectCollision(125, 90, 15, rect);
    approx(above[0], 0, 1e-12, 'above nx');
    approx(above[1], -1, 1e-12, 'above ny');
    approx(above[2], 5, 1e-12, 'above penetration');

    /* Centre inside the rectangle: push out along the shallowest face. */
    const inside = BB.circleRectCollision(125, 115, 5, rect);
    approx(inside[0], 0, 1e-12, 'inside nx');
    approx(inside[1], 1, 1e-12, 'inside ny');
    approx(inside[2], 10, 1e-12, 'inside penetration');

    const corner = BB.circleRectCollision(155, 125, 10, rect);
    approx(corner[0], Math.SQRT1_2, 1e-12, 'corner nx');
    approx(corner[1], Math.SQRT1_2, 1e-12, 'corner ny');
    approx(corner[2], 10 - Math.hypot(5, 5), 1e-12, 'corner penetration');
  });

  it('mirror-reflects the ball off the left/right walls and the ceiling (R5)', () => {
    const layout = BB.FieldLayout.compute(960, 720, config.BRICK_ROWS_BASE);
    const engine = new BB.CollisionEngine();
    const ball = new BB.Ball();
    ball.radius = layout.ballRadius;

    ball.x = ball.radius - 5.0;
    ball.y = 300.0;
    ball.vx = -100.0;
    ball.vy = 0.0;
    let event = engine.walls(ball, layout);
    assert.ok(event !== null);
    assert.deepEqual(event, {
      kind: BB.HitKind.WALL,
      x: ball.x,
      y: ball.y,
      speed: ball.speed,
      brickId: null,
      destroyed: false
    });
    approx(ball.x, ball.radius, 1e-12, 'left wall x');
    assert.ok(ball.vx > 0, 'vx flips to the right');

    ball.x = layout.width - ball.radius + 5.0;
    ball.vx = 100.0;
    engine.walls(ball, layout);
    approx(ball.x, layout.width - ball.radius, 1e-12, 'right wall x');
    assert.ok(ball.vx < 0, 'vx flips to the left');

    ball.x = layout.width * 0.5;
    ball.y = layout.topWall + ball.radius - 1.0;
    ball.vx = 0.0;
    ball.vy = -50.0;
    event = engine.walls(ball, layout);
    approx(ball.y, layout.topWall + ball.radius, 1e-12, 'ceiling y');
    assert.ok(ball.vy > 0, 'vy flips down');
    assert.equal(event.kind, BB.HitKind.WALL);

    /* Deep inside the room nothing is reported. */
    ball.x = layout.width * 0.5;
    ball.y = layout.height * 0.5;
    ball.vx = 10.0;
    ball.vy = -10.0;
    assert.equal(engine.walls(ball, layout), null);
  });

  it('reports FLOOR and marks the ball LOST below the room (R8)', () => {
    const layout = BB.FieldLayout.compute(480, 360, config.BRICK_ROWS_BASE);
    const engine = new BB.CollisionEngine();
    const paddle = createPaddle(layout);
    const ball = new BB.Ball();
    ball.radius = layout.ballRadius;
    ball.state = BB.BallState.IN_FLIGHT;
    ball.x = layout.width * 0.5;
    ball.y = layout.height + ball.radius + 8.0;
    ball.vx = 0.0;
    ball.vy = layout.baseSpeed;

    const events = engine.step(ball, paddle, [], layout, STEP);
    const floor = events.filter((event) => event.kind === BB.HitKind.FLOOR);
    assert.equal(floor.length, 1);
    assert.equal(floor[0].brickId, null);
    assert.equal(floor[0].destroyed, false);
    approx(floor[0].speed, layout.baseSpeed, 1e-9, 'floor event speed');
    assert.equal(ball.state, BB.BallState.LOST);
  });

  it('bounces off the paddle and clamps the total outgoing angle (R4)', () => {
    const layout = BB.FieldLayout.compute(960, 720, config.BRICK_ROWS_BASE);
    const engine = new BB.CollisionEngine();

    /* Centre hit, still paddle: the ball goes up with the minimum english. */
    let paddle = createPaddle(layout);
    let ball = new BB.Ball();
    ball.radius = layout.ballRadius;
    ball.state = BB.BallState.IN_FLIGHT;
    ball.x = paddle.centerX;
    ball.y = paddle.top - ball.radius + 0.5;
    ball.vx = 0.0;
    ball.vy = 300.0;

    let event = engine.paddleBounce(ball, paddle);
    assert.ok(event !== null);
    assert.equal(event.kind, BB.HitKind.PADDLE);
    assert.ok(ball.vy < 0, 'vy reverses upwards');
    approx(ball.speed, 300, 1e-9, 'speed is conserved');
    approx(ball.y, paddle.top - ball.radius, 1e-12, 'separation');
    assert.ok(Number.isFinite(event.speed));

    /* Moving upwards already: no paddle bounce. */
    assert.equal(engine.paddleBounce(ball, paddle), null);

    /* Extreme right-offset + full english: clamped to PADDLE_MAX_TOTAL_DEG. */
    paddle = createPaddle(layout);
    paddle.velocity = 5000.0;                        /* english clamps to +1 */
    ball = new BB.Ball();
    ball.radius = layout.ballRadius;
    ball.state = BB.BallState.IN_FLIGHT;
    ball.x = paddle.right;
    ball.y = paddle.top - ball.radius + 0.5;
    ball.vx = 0.0;
    ball.vy = 300.0;

    event = engine.paddleBounce(ball, paddle);
    assert.ok(event !== null);
    approx(
      angleFromVerticalDegrees(ball),
      config.PADDLE_MAX_TOTAL_DEG,
      1e-6,
      'clamped bounce angle'
    );
    assert.ok(ball.vx > 0, 'offset steers the ball right');
    assert.ok(ball.vy < 0);
  });

  it('emits a BRICK event with the brick id and destroyed flag (R6/R7)', () => {
    const layout = BB.FieldLayout.compute(480, 360, config.BRICK_ROWS_BASE);
    const engine = new BB.CollisionEngine();
    const bricks = BB.LevelFactory.build(1, layout);
    const brick = bricks[0];

    const ball = new BB.Ball();
    ball.radius = layout.ballRadius;
    ball.state = BB.BallState.IN_FLIGHT;
    ball.x = brick.rect.x + brick.rect.w * 0.5;
    ball.y = brick.rect.y + brick.rect.h + ball.radius - 1.0;
    ball.vx = 0.0;
    ball.vy = -150.0;

    const event = engine.bricksBounce(ball, bricks);
    assert.ok(event !== null);
    assert.equal(event.kind, BB.HitKind.BRICK);
    assert.equal(event.brickId, brick.id);
    assert.equal(event.destroyed, true);
    assert.equal(brick.state, BB.BrickState.FADING);
    assert.equal(brick.collidable, false);
    assert.ok(ball.vy > 0, 'the ball reflects away from the brick');

    /* A 2 HP brick only cracks on the first hit. */
    const layout7 = BB.FieldLayout.compute(480, 360, 7);
    const toughWall = BB.LevelFactory.build(3, layout7);
    const tough = toughWall[0];
    const ball2 = new BB.Ball();
    ball2.radius = layout7.ballRadius;
    ball2.state = BB.BallState.IN_FLIGHT;
    ball2.x = tough.rect.x + tough.rect.w * 0.5;
    ball2.y = tough.rect.y + tough.rect.h + ball2.radius - 1.0;
    ball2.vx = 0.0;
    ball2.vy = -150.0;

    const crackEvent = engine.bricksBounce(ball2, toughWall);
    assert.equal(crackEvent.destroyed, false);
    assert.equal(tough.state, BB.BrickState.CRACKED);
    assert.equal(tough.collidable, true);
  });
});

/* --------------------------------------------------------------------------
 * M10 SESSION — the run state machine
 * ------------------------------------------------------------------------ */

describe('M10 GameSession lifecycle', () => {
  it('starts in READY with three lives and the ball attached', () => {
    const { session, audio } = createSession();
    assert.equal(session.state, BB.RunState.READY);
    assert.equal(session.ball.state, BB.BallState.ATTACHED);
    assert.equal(session.stats.lives, config.STARTING_LIVES);
    assert.equal(session.stats.score, 0);
    assert.equal(session.stats.level, 1);
    assert.equal(session.bricks.length, 66);
    assert.equal(session.bricksLeft, 66);
    assert.equal(session.layout.width, 480);
    assert.equal(session.layout.height, 360);
    assert.equal(session.layout.rows, 6);
    assert.equal(session.freshRun, true);

    approx(session.paddle.bottom, 324, 1e-9, 'paddle bottom');
    assert.equal(session.ball.x, session.paddle.centerX);
    approx(session.ball.y, session.paddle.top - session.ball.radius - 1.0, 1e-12);

    assert.equal(session.audio, audio);
    assert.deepEqual(audio.calls, []);
  });

  it('launches on PRIMARY into PLAYING/IN_FLIGHT with a deterministic angle', () => {
    const { session, audio } = createSession();
    withFixedRandom(0.5, () => session.apply(BB.Intent.PRIMARY));

    assert.equal(session.state, BB.RunState.PLAYING);
    assert.equal(session.ball.state, BB.BallState.IN_FLIGHT);
    assert.equal(session.freshRun, false);
    approx(session.ball.speed, session.layout.baseSpeed, 1e-9, 'launch speed');
    /* random=0.5 -> 41.5 degrees from vertical, positive direction. */
    approx(angleFromVerticalDegrees(session.ball), 41.5, 1e-9, 'launch angle');
    assert.ok(session.ball.vy < 0);
    assert.deepEqual(audio.calls, ['launch']);

    const startX = session.ball.x;
    const startY = session.ball.y;
    for (let i = 0; i < 5; i += 1) {
      session.update(STEP);
    }
    const travelled = Math.hypot(session.ball.x - startX, session.ball.y - startY);
    assert.ok(travelled > 0.5, `the ball moved (${travelled} px)`);
    assert.equal(session.state, BB.RunState.PLAYING);
    assert.ok(session.ball.x >= session.ball.radius);
    assert.ok(session.ball.x <= session.layout.width - session.ball.radius);
  });

  it('stubs the launch angle clamp for both random extremes', () => {
    for (const [randomValue, expectedSign] of [[0, -1], [1, 1]]) {
      const { session } = createSession();
      withFixedRandom(randomValue, () => session.apply(BB.Intent.PRIMARY));
      const degrees = angleFromVerticalDegrees(session.ball);
      approx(degrees, randomValue === 0 ? 28 : 55, 1e-9, 'angle range');
      assert.equal(Math.sign(session.ball.vx), expectedSign);
    }
  });

  it('decrements a life on FLOOR and returns READY; the last life ends the game', () => {
    const { session, audio } = createSession();
    assert.equal(session.stats.lives, 3);

    for (const remaining of [2, 1]) {
      withFixedRandom(0.5, () => session.apply(BB.Intent.PRIMARY));
      assert.equal(session.state, BB.RunState.PLAYING);
      dropBallBelowFloor(session);
      session.update(STEP);
      assert.equal(session.stats.lives, remaining);
      assert.equal(session.state, BB.RunState.READY);
      assert.equal(session.ball.state, BB.BallState.ATTACHED);
    }
    assert.equal(audio.calls.filter((name) => name === 'life_lost').length, 2);

    /* The last life is lost after another floor collision: GAME_OVER. */
    session.stats.score = 1234;
    withFixedRandom(0.5, () => session.apply(BB.Intent.PRIMARY));
    dropBallBelowFloor(session);
    session.update(STEP);
    assert.equal(session.stats.lives, 0);
    assert.equal(session.state, BB.RunState.GAME_OVER);
    assert.equal(session.ball.state, BB.BallState.LOST);
    assert.equal(session.stats.record.bestScore, 1234);
    assert.equal(session.stats.record.bestLevel, 1);
    assert.equal(audio.calls.filter((name) => name === 'game_over').length, 1);

    /* RESTART rebuilds the run (the record is re-created, mirroring Python). */
    session.apply(BB.Intent.RESTART);
    assert.equal(session.state, BB.RunState.READY);
    assert.equal(session.stats.lives, config.STARTING_LIVES);
    assert.equal(session.stats.score, 0);
    assert.equal(session.bricksLeft, 66);
    assert.equal(session.bricks.length, 66);
    assert.equal(session.freshRun, true);
  });

  it('freezes the simulation while PAUSED and resumes on the same intent', () => {
    const { session } = createSession();
    withFixedRandom(0.5, () => session.apply(BB.Intent.PRIMARY));
    session.apply(BB.Intent.TOGGLE_PAUSE);
    assert.equal(session.state, BB.RunState.PAUSED);

    const frozen = {
      x: session.ball.x,
      y: session.ball.y,
      vx: session.ball.vx,
      vy: session.ball.vy
    };
    for (let i = 0; i < 30; i += 1) {
      session.update(STEP);
    }
    assert.deepEqual(
      {
        x: session.ball.x,
        y: session.ball.y,
        vx: session.ball.vx,
        vy: session.ball.vy
      },
      frozen
    );
    assert.equal(session.state, BB.RunState.PAUSED);

    session.apply(BB.Intent.TOGGLE_PAUSE);
    assert.equal(session.state, BB.RunState.PLAYING);
    const before = { x: session.ball.x, y: session.ball.y };
    session.update(STEP);
    assert.ok(session.ball.x !== before.x || session.ball.y !== before.y);

    /* Losing the focus also pauses, so held keys cannot keep driving. */
    const second = createSession();
    withFixedRandom(0.5, () => second.session.apply(BB.Intent.PRIMARY));
    second.session.apply(BB.Intent.FOCUS_LOST);
    assert.equal(second.session.state, BB.RunState.PAUSED);
  });

  it('cycles the instrument through CYCLE_INSTRUMENT and previews the sound', () => {
    const { session, audio } = createSession();
    assert.equal(session.settings.instrument, config.DEFAULT_INSTRUMENT);

    session.apply(BB.Intent.CYCLE_INSTRUMENT);
    assert.equal(session.settings.instrument, 'PIANO');
    assert.equal(audio.instrument, 'PIANO');
    assert.deepEqual(audio.calls, ['preview']);

    for (let i = 0; i < 3; i += 1) {
      session.apply(BB.Intent.CYCLE_INSTRUMENT);
    }
    assert.equal(session.settings.instrument, config.DEFAULT_INSTRUMENT);
    assert.equal(audio.calls.filter((name) => name === 'preview').length, 4);

    session.apply(BB.Intent.TOGGLE_MUTE);
    assert.equal(session.settings.muted, true);
    assert.equal(audio.muted, true);
    session.apply(BB.Intent.TOGGLE_MUTE);
    assert.equal(session.settings.muted, false);
  });

  it('falls back to NullAudio when no audio engine is injected', () => {
    const session = new BB.GameSession(480, 360);
    assert.ok(session.audio instanceof BB.NullAudio);
    session.audio.play('wall');                      /* must stay silent, no throw */
    assert.equal(session.audio.muted, false);
    assert.equal(session.audio.toggleMute(), false);
    assert.equal(session.audio.instrumentLabel, config.DEFAULT_INSTRUMENT);
    session.apply(BB.Intent.CYCLE_INSTRUMENT);
    assert.equal(session.settings.instrument, config.DEFAULT_INSTRUMENT);
    session.apply(BB.Intent.TOGGLE_MUTE);
    assert.equal(session.settings.muted, false);
  });

  it('keeps the ball attached and follows the paddle while READY', () => {
    const { session } = createSession(960, 720);
    const layout = session.layout;
    const attachedY = session.paddle.top - session.ball.radius - 1.0;

    session.setMoveAxis(1);
    for (let i = 0; i < 120; i += 1) {
      session.update(STEP);
    }
    approx(session.paddle.centerX, layout.width - session.paddle.width * 0.5, 1e-9, 'right clamp');
    approx(session.ball.x, session.paddle.centerX, 1e-12, 'ball rides the paddle');
    approx(session.ball.y, attachedY, 1e-12);
    assert.equal(session.state, BB.RunState.READY);

    session.setMoveAxis(-1);
    for (let i = 0; i < 240; i += 1) {
      session.update(STEP);
    }
    approx(session.paddle.centerX, session.paddle.width * 0.5, 1e-9, 'left clamp');
    assert.equal(session.ball.x, session.paddle.centerX);
    assert.equal(session.ball.state, BB.BallState.ATTACHED);
    /* Pushing into the wall reports zero velocity, so it cannot add spin. */
    approx(session.paddle.velocity, 0, 1e-12, 'wall velocity');
  });

  it('tracks a pointer target, reports velocity, and yields to the keyboard', () => {
    const { session } = createSession(480, 360);
    const layout = session.layout;
    assert.equal(typeof session.setPointerTarget, 'function');
    assert.equal(session.pointerTarget, null);

    /* Touch/mouse aim: the paddle moves straight to the pointer x, the attached
     * ball follows, and the real paddle velocity is still recorded (R4). */
    session.setPointerTarget(300);
    session.update(STEP);
    approx(session.paddle.centerX, 300, 1e-9, 'paddle tracks the pointer');
    approx(session.ball.x, 300, 1e-12, 'attached ball follows');
    approx(session.paddle.velocity, (300 - 240) / STEP, 1e-6, 'real pointer velocity');

    /* Holding the pointer still reports zero velocity. */
    session.update(STEP);
    approx(session.paddle.velocity, 0, 1e-12, 'idle pointer velocity');

    /* Releasing the pointer returns control to the keyboard axis. */
    session.setPointerTarget(null);
    session.setMoveAxis(1);
    session.update(STEP);
    approx(
      session.paddle.centerX,
      300 + Math.max(360, layout.width) * STEP,
      1e-9,
      'keyboard resumes'
    );
    assert.equal(session.pointerTarget, null);

    /* The target is clamped by the room walls, never outside. */
    session.setMoveAxis(0);
    session.setPointerTarget(-500);
    session.update(STEP);
    approx(session.paddle.centerX, session.paddle.width * 0.5, 1e-9, 'pointer clamped left');
    session.setPointerTarget(10000);
    session.update(STEP);
    approx(
      session.paddle.centerX,
      layout.width - session.paddle.width * 0.5,
      1e-9,
      'pointer clamped right'
    );

    /* RESTART clears the pointer target. */
    session.setPointerTarget(100);
    session.apply(BB.Intent.RESTART);
    assert.equal(session.pointerTarget, null);
  });

  it('scores a destroyed brick, logs it, spawns a popup and clears the level', () => {
    const { session, audio } = createSession();
    const brick = session.bricks[0];
    assert.equal(brick.points, 60);

    /* A cracked-only hit plays the sound but awards nothing. */
    session._onBrickHit({ kind: BB.HitKind.BRICK, brickId: brick.id, destroyed: false });
    assert.equal(session.stats.score, 0);
    assert.equal(session.stats.combo, 0);
    assert.ok(audio.calls.includes('crack'));

    /* Reduce the wall to a single brick to exercise the real level-clear path. */
    session.bricks = [brick];
    session._brickIndex = new Map([[brick.id, brick]]);
    session.bricksLeft = 1;

    /* Drive the real engine so Brick.hit() owns the FADING transition, then let
     * the session consume its event exactly like update() does. */
    const ball = session.ball;
    ball.state = BB.BallState.IN_FLIGHT;
    ball.radius = session.layout.ballRadius;
    ball.x = brick.rect.x + brick.rect.w * 0.5;
    ball.y = brick.rect.y + brick.rect.h + ball.radius - 1.0;
    ball.vx = 0.0;
    ball.vy = -150.0;
    const hitEvent = new BB.CollisionEngine().bricksBounce(ball, [brick]);
    assert.equal(hitEvent.destroyed, true);
    session._consume(hitEvent);

    assert.equal(session.bricksLeft, 0);
    assert.equal(brick.state, BB.BrickState.FADING);
    assert.equal(session.stats.bricksDestroyed, 1);
    assert.equal(session.stats.combo, 1);
    assert.equal(session.stats.score, brick.points + config.LEVEL_BONUS_BASE);
    assert.equal(session.stats.entries.length, 1);
    const entry = session.stats.entries[0];
    assert.equal(entry.brickId, brick.id);
    assert.equal(entry.basePoints, 60);
    assert.equal(entry.multiplier, 1);
    assert.equal(entry.awarded, 60);

    assert.equal(session.popups.length, 1);
    assert.equal(session.popups[0].text, '+60');
    assert.equal(typeof session.popups[0].colorHue, 'number');
    approx(session.popups[0].ttl, config.POPUP_LIFE, 1e-12);

    assert.equal(session.state, BB.RunState.LEVEL_CLEAR);
    assert.ok(session.bannerText.includes('LEVEL 1 CLEARED'));
    assert.ok(session.bannerText.includes('+250'));
    assert.ok(audio.calls.includes('brick0'));
    assert.ok(audio.calls.includes('level_clear'));

    /* LEVEL_CLEAR still animates: the fading brick is removed after
     * BRICK_FADE_TIME, and the popup expires after POPUP_LIFE. */
    for (let i = 0; i < 40; i += 1) {
      session.update(STEP);
    }
    assert.equal(session.bricks.length, 0);
    assert.equal(session.brickById(brick.id), undefined);
    for (let i = 0; i < 100; i += 1) {
      session.update(STEP);
    }
    assert.equal(session.popups.length, 0);
    assert.equal(session.state, BB.RunState.LEVEL_CLEAR);
  });

  it('runs the LEVEL_CLEAR countdown and recomputes the layout on row changes', () => {
    const { session, audio } = createSession();
    session.finishLevel();
    assert.equal(session.state, BB.RunState.LEVEL_CLEAR);
    assert.equal(session.stats.score, config.LEVEL_BONUS_BASE);
    assert.ok(audio.calls.includes('level_clear'));

    let guard = 0;
    while (session.state === BB.RunState.LEVEL_CLEAR && guard < 600) {
      session.update(STEP);
      guard += 1;
    }
    assert.ok(guard < 600, 'the countdown terminated');
    assert.ok(guard >= Math.floor(config.LEVEL_CLEAR_DELAY / STEP) - 1, `countdown length ${guard}`);
    assert.equal(session.state, BB.RunState.READY);
    assert.equal(session.stats.level, 2);
    assert.equal(session.layout.rows, 6);
    assert.equal(session.bricksLeft, 66);
    assert.equal(session.ball.state, BB.BallState.ATTACHED);

    /* Level 2 -> 3 changes the row count: the layout must be recomputed. */
    session.finishLevel();
    assert.equal(session.state, BB.RunState.LEVEL_CLEAR);
    guard = 0;
    while (session.state === BB.RunState.LEVEL_CLEAR && guard < 600) {
      session.update(STEP);
      guard += 1;
    }
    assert.equal(session.state, BB.RunState.READY);
    assert.equal(session.stats.level, 3);
    assert.equal(session.layout.rows, 7);
    assert.equal(session.bricksLeft, 7 * config.BRICK_COLUMNS);
    approx(session.paddle.bottom, session.layout.paddleBottom, 1e-12, 'paddle re-applied');
    approx(session.ball.radius, session.layout.ballRadius, 1e-12, 'ball re-applied');
  });

  it('advances popups and removes them when their life runs out', () => {
    const { session } = createSession();
    session.popups.push(new BB.Popup(10, 20, '+50', 190));
    assert.equal(session.popups[0].ttl, config.POPUP_LIFE);
    const startY = session.popups[0].y;
    const startLife = session.popups[0].life;

    for (let i = 0; i < 12; i += 1) {
      session.update(STEP);
    }
    assert.equal(session.popups.length, 1);
    assert.ok(session.popups[0].y < startY, 'popups rise');
    assert.ok(session.popups[0].life < startLife, 'popups fade');

    for (let i = 0; i < 200; i += 1) {
      session.update(STEP);
    }
    assert.equal(session.popups.length, 0);
  });

  it('resizes the room and keeps every entity in bounds', () => {
    const { session } = createSession(480, 360);
    withFixedRandom(0.5, () => session.apply(BB.Intent.PRIMARY));
    session.resize(320, 240);

    assert.equal(session.layout.width, 320);
    assert.equal(session.layout.height, 240);
    assert.deepEqual(session.settings.windowSize, { width: 320, height: 240 });
    assert.ok(session.paddle.left >= -1e-9);
    assert.ok(session.paddle.right <= 320 + 1e-9);
    assert.ok(session.ball.x >= session.ball.radius);
    assert.ok(session.ball.x <= 320 - session.ball.radius);
    assert.ok(session.ball.y >= 0 && session.ball.y <= 240);

    for (const brick of session.bricks) {
      assert.ok(brick.rect.x >= 0);
      assert.ok(brick.rect.x + brick.rect.w <= 320);
      assert.ok(brick.rect.y >= session.layout.topWall);
      assert.ok(brick.rect.y + brick.rect.h < session.paddle.top);
    }

    session.resize(960, 720);
    assert.equal(session.layout.width, 960);
    assert.equal(session.layout.height, 720);
    approx(session.paddle.bottom, 666, 1e-9, 'paddle bottom after resize');
    assert.ok(session.ball.x >= session.ball.radius);
    assert.ok(session.ball.x <= 960 - session.ball.radius);

    /* READY re-attaches the ball to the resized paddle. */
    const ready = createSession(480, 360).session;
    ready.resize(320, 240);
    assert.equal(ready.state, BB.RunState.READY);
    assert.equal(ready.ball.x, ready.paddle.centerX);
    approx(ready.ball.y, ready.paddle.top - ready.ball.radius - 1.0, 1e-12);
    assert.ok(ready.ball.y >= ready.layout.topWall);
  });

  it('keeps the ball inside the room across hundreds of fixed physics steps (I1)', () => {
    const { session } = createSession(960, 720);
    withFixedRandom(0.5, () => session.apply(BB.Intent.PRIMARY));

    let steps = 0;
    while (session.state === BB.RunState.PLAYING && steps < 600) {
      session.update(STEP);
      const ball = session.ball;
      const layout = session.layout;
      assert.ok(ball.x >= -1e-6, `x below room at step ${steps}: ${ball.x}`);
      assert.ok(
        ball.x <= layout.width + 1e-6,
        `x above room at step ${steps}: ${ball.x}`
      );
      assert.ok(
        ball.y >= layout.topWall - 1e-6,
        `y above room at step ${steps}: ${ball.y}`
      );
      assert.ok(
        ball.y <= layout.height + ball.radius + 1e-6,
        `y below room at step ${steps}: ${ball.y}`
      );
      steps += 1;
    }
    assert.ok(steps > 0);
    /* If it ended early it must be a documented transition, never a crash. */
    if (session.state !== BB.RunState.PLAYING) {
      assert.ok(
        session.state === BB.RunState.READY ||
        session.state === BB.RunState.LEVEL_CLEAR ||
        session.state === BB.RunState.GAME_OVER,
        `unexpected state ${session.state}`
      );
    }
  });
});
