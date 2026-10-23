/* Brick Breaker Web — M5 RULES: scoring / combo / ball-speed policy.
 *
 * Pure functions only (no state, no DOM): mirrors ScoringRules in
 * bb_v1/brick_breaker.py, including every cap.  Safe to unit-test in isolation.
 */
(function (global) {
  'use strict';

  var BB = global.BB = global.BB || {};
  var config = BB.config;

  BB.ScoringRules = {
    /** Combo ladder: one multiplier step every COMBO_STEP bricks, capped. */
    comboMultiplier(combo) {
      return Math.trunc(
        Math.min(1 + Math.floor(Math.max(0, combo) / config.COMBO_STEP), config.COMBO_MAX)
      );
    },

    /** Returns { multiplier, points } for destroying *brick* at *combo*. */
    brickPoints(brick, combo) {
      var multiplier = BB.ScoringRules.comboMultiplier(combo);
      return { multiplier: multiplier, points: brick.points * multiplier };
    },

    levelBonus(level) {
      return config.LEVEL_BONUS_BASE * Math.max(1, level);
    },

    levelSpeedFactor(level) {
      return 1.0 + config.LEVEL_SPEED_GROWTH * Math.max(0, level - 1);
    },

    /** Ball speed for the current level and rally length (capped). */
    launchSpeed(layout, level, rallyMultiplier) {
      var speed = layout.baseSpeed * BB.ScoringRules.levelSpeedFactor(level) * rallyMultiplier;
      return Math.min(speed, layout.baseSpeed * config.MAX_SPEED_FACTOR);
    },

    nextRallyMultiplier(current) {
      return Math.min(current * (1.0 + config.PADDLE_RALLY_SPEEDUP), config.MAX_RALLY_MULTIPLIER);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
