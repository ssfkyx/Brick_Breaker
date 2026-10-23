/* Brick Breaker Web — M6 LEVELS: level profile -> brick wall.
 *
 * Mirrors LevelFactory in bb_v1/brick_breaker.py: the level number parameterises
 * the wall (row count, top-row double HP from level 3, row points and hue), so
 * no level data needs to be persisted.  Brick ids are "L{level}R{row}C{col}".
 */
(function (global) {
  'use strict';

  var BB = global.BB = global.BB || {};
  var config = BB.config;

  BB.LevelFactory = {
    rowsForLevel(level) {
      return Math.trunc(
        Math.min(
          config.BRICK_ROWS_BASE + Math.floor((Math.max(1, level) - 1) / 2),
          config.BRICK_ROWS_MAX
        )
      );
    },

    /** Returns { points, maxHp, hue } for one brick of the wall. */
    brickStyle(row, rows, level) {
      var points = (rows - row) * 10;
      var maxHp = (level >= 3 && row === 0) ? 2 : 1;
      if (maxHp > 1) {
        points *= 2;
      }
      var hues = BB.style.brickHues;
      return { points: points, maxHp: maxHp, hue: hues[row % hues.length] };
    },

    /** Build the full wall for *level* using *layout*'s grid. */
    build(level, layout) {
      var rows = layout.rows;
      var bricks = [];
      for (var row = 0; row < rows; row += 1) {
        for (var col = 0; col < config.BRICK_COLUMNS; col += 1) {
          var style = BB.LevelFactory.brickStyle(row, rows, level);
          var brick = new BB.Brick({
            id: 'L' + level + 'R' + row + 'C' + col,
            row: row,
            col: col,
            points: style.points,
            hue: style.hue,
            maxHp: style.maxHp
          });
          brick.rect = layout.brickRect(row, col);
          bricks.push(brick);
        }
      }
      return bricks;
    },

    /** Re-position an existing wall after the window changed size. */
    reflow(bricks, layout) {
      for (var i = 0; i < bricks.length; i += 1) {
        bricks[i].rect = layout.brickRect(bricks[i].row, bricks[i].col);
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
