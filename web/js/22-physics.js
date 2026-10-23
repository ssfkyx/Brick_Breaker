/* Brick Breaker Web — M4 PHYSICS: collision detection and response.
 *
 * Mirrors CollisionEngine in bb_v1/brick_breaker.py: sub-stepped ball advance
 * (anti-tunnelling), mirror reflections off the room walls (R5), the
 * offset + english paddle bounce (R4) and circle-versus-rectangle brick hits
 * (R6/R7).  The engine never scores, plays audio or renders: it only returns
 * plain collision facts for M10 (the session) to consume.
 *
 * Collision events are plain objects:
 *   { kind, x, y, speed, brickId, destroyed }
 * where `kind` is a BB.HitKind value and `brickId` is null except for BRICK.
 */
(function (global) {
  'use strict';

  var BB = global.BB = global.BB || {};
  var config = BB.config;

  /**
   * Circle versus axis-aligned rectangle test.
   *
   * Returns [normalX, normalY, penetration] when the circle overlaps the
   * rectangle, otherwise null.  The normal points from the rectangle towards
   * the circle, i.e. along the direction the circle must be pushed to separate
   * the two shapes.  Mirrors circle_rect_collision() in Python exactly.
   */
  function circleRectCollision(cx, cy, radius, rect) {
    var left = rect.x;
    var top = rect.y;
    var right = rect.x + rect.w;
    var bottom = rect.y + rect.h;

    var closestX = BB.clamp(cx, left, right);
    var closestY = BB.clamp(cy, top, bottom);
    var dx = cx - closestX;
    var dy = cy - closestY;
    var distSq = dx * dx + dy * dy;

    if (distSq > radius * radius) {
      return null;
    }

    if (distSq > 1e-9) {
      var dist = Math.sqrt(distSq);
      return [dx / dist, dy / dist, radius - dist];
    }

    /* Centre is inside the rectangle: push out along the shallowest face. */
    var toLeft = cx - left;
    var toRight = right - cx;
    var toTop = cy - top;
    var toBottom = bottom - cy;
    var smallest = Math.min(toLeft, toRight, toTop, toBottom);
    if (smallest === toLeft) {
      return [-1.0, 0.0, toLeft + radius];
    }
    if (smallest === toRight) {
      return [1.0, 0.0, toRight + radius];
    }
    if (smallest === toTop) {
      return [0.0, -1.0, toTop + radius];
    }
    return [0.0, 1.0, toBottom + radius];
  }

  function makeEvent(kind, x, y, speed, brickId, destroyed) {
    return {
      kind: kind,
      x: x,
      y: y,
      speed: speed,
      brickId: brickId === undefined ? null : brickId,
      destroyed: destroyed === true
    };
  }

  /* -- Ball versus room/paddle/bricks, resolved with sub-stepping --------- */

  class CollisionEngine {
    constructor(maxSubsteps) {
      var limit = maxSubsteps === undefined ? config.MAX_SUBSTEPS : maxSubsteps;
      this.maxSubsteps = Math.max(1, Math.trunc(limit));
    }

    /** Advance the ball by *dt* and return every collision that happened. */
    step(ball, paddle, bricks, layout, dt) {
      var events = [];
      if (dt <= 0.0) {
        return events;
      }

      var travel = ball.speed * dt;
      var maxStep = Math.max(2.0, ball.radius * 0.6);
      var steps = Math.trunc(
        Math.min(this.maxSubsteps, Math.max(1, Math.ceil(travel / maxStep)))
      );
      var subDt = dt / steps;

      for (var i = 0; i < steps; i += 1) {
        ball.x += ball.vx * subDt;
        ball.y += ball.vy * subDt;

        var event = this.walls(ball, layout);
        if (event !== null) {
          events.push(event);
        }

        if (ball.y - ball.radius > layout.height) {           /* R8 */
          ball.state = BB.BallState.LOST;
          events.push(makeEvent(BB.HitKind.FLOOR, ball.x, ball.y, ball.speed));
          return events;
        }

        event = this.paddleBounce(ball, paddle);             /* R4 */
        if (event !== null) {
          events.push(event);
        }

        event = this.bricksBounce(ball, bricks);             /* R6/R7 */
        if (event !== null) {
          events.push(event);
        }
      }

      ball.preventVerticalStall();
      return events;
    }

    /** R5: mirror reflection off the left/right walls and the ceiling. */
    walls(ball, layout) {
      var hit = false;
      if (ball.x - ball.radius < 0.0) {
        ball.x = ball.radius;
        ball.vx = Math.abs(ball.vx);
        hit = true;
      } else if (ball.x + ball.radius > layout.width) {
        ball.x = layout.width - ball.radius;
        ball.vx = -Math.abs(ball.vx);
        hit = true;
      }
      if (ball.y - ball.radius < layout.topWall) {
        ball.y = layout.topWall + ball.radius;
        ball.vy = Math.abs(ball.vy);
        hit = true;
      }
      if (!hit) {
        return null;
      }
      return makeEvent(BB.HitKind.WALL, ball.x, ball.y, ball.speed);
    }

    /**
     * R4: reflect off the paddle using the hit offset *and* its instant motion.
     *
     *   angle = clamp(PADDLE_MAX_BOUNCE_DEG * offset + PADDLE_SPIN_DEG * english)
     *
     * where `english` is the paddle's instantaneous velocity normalised by
     * PADDLE_SPIN_REF_SPEED.  Hitting the ball while sliding therefore changes
     * the outgoing angle, exactly as the use case requires.
     */
    paddleBounce(ball, paddle) {
      if (ball.vy <= 0.0) {
        return null;
      }
      if (!(
        ball.y + ball.radius >= paddle.top &&
        ball.y - ball.radius <= paddle.bottom &&
        ball.x + ball.radius >= paddle.left &&
        ball.x - ball.radius <= paddle.right
      )) {
        return null;
      }

      ball.y = paddle.top - ball.radius;
      var half = paddle.width * 0.5;
      var offset = half > 0 ? BB.clamp((ball.x - paddle.centerX) / half, -1.0, 1.0) : 0.0;
      var english = BB.clamp(paddle.velocity / config.PADDLE_SPIN_REF_SPEED, -1.0, 1.0);
      var angleDeg = BB.clamp(
        config.PADDLE_MAX_BOUNCE_DEG * offset + config.PADDLE_SPIN_DEG * english,
        -config.PADDLE_MAX_TOTAL_DEG,
        config.PADDLE_MAX_TOTAL_DEG
      );
      var speed = Math.max(1.0, ball.speed);
      ball.setDirection(speed, angleDeg * Math.PI / 180.0);
      ball.preventVerticalStall();
      return makeEvent(BB.HitKind.PADDLE, ball.x, ball.y, speed);
    }

    /** R6/R7: resolve at most one brick hit per sub-step (I6). */
    bricksBounce(ball, bricks) {
      for (var i = 0; i < bricks.length; i += 1) {
        var brick = bricks[i];
        if (!brick.collidable) {
          continue;
        }
        var contact = circleRectCollision(ball.x, ball.y, ball.radius, brick.rect);
        if (contact === null) {
          continue;
        }

        var nx = contact[0];
        var ny = contact[1];
        var penetration = contact[2];
        var approach = ball.vx * nx + ball.vy * ny;
        if (approach < 0.0) {                       /* only reflect when moving inwards */
          ball.vx -= 2.0 * approach * nx;
          ball.vy -= 2.0 * approach * ny;
        }
        /* Separate the shapes so the next sub-step cannot re-detect the hit. */
        ball.x += nx * (penetration + 0.01);
        ball.y += ny * (penetration + 0.01);

        var destroyed = brick.hit();
        return makeEvent(BB.HitKind.BRICK, ball.x, ball.y, ball.speed, brick.id, destroyed);
      }
      return null;
    }
  }

  BB.circleRectCollision = circleRectCollision;
  BB.CollisionEngine = CollisionEngine;
})(typeof window !== 'undefined' ? window : globalThis);
