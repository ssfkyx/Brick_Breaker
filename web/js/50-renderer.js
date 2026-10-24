/* Brick Breaker Web — M8 VIEW (canvas renderer, performance-tuned).
 *
 * The playfield is drawn on a canvas whose backing store is sized in device
 * pixels (HiDPI / Retina aware).  Two performance rules keep the frame time
 * low even on high-DPR screens:
 *
 *   1. Static scenery (gradient, perspective grid, scanlines, vignette) is
 *      rendered once into an offscreen canvas and blitted per frame.
 *   2. Bricks are drawn with flat fills + highlight/shade strips instead of
 *      per-brick gradients and shadowBlur (which are very expensive in Canvas2D);
 *      the combo light show comes from hue shifts, brightness and a cached
 *      glow sprite rather than per-brick blurs.
 *
 * The renderer is strictly read-only with respect to the game model.  The app
 * may lower `qualityScale` at runtime (adaptive resolution) via setQualityScale().
 */
(function (global) {
  'use strict';

  var BB = global.BB;
  var config = BB.config;
  var style = BB.style;

  var TAU = Math.PI * 2;

  function clamp(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  function hsl(hue, saturation, lightness) {
    var h = ((hue % 360) + 360) % 360;
    return 'hsl(' + h.toFixed(1) + ' ' + saturation.toFixed(1) + '% ' + lightness.toFixed(1) + '%)';
  }

  function roundRectPath(ctx, x, y, w, h, radius) {
    var r = Math.min(radius, w * 0.5, h * 0.5);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 0;
    this.height = 0;
    this.dpr = 1;               // CSS device pixel ratio
    this.effectiveDpr = 1;      // dpr * qualityScale (what the backing store uses)
    this.qualityScale = 1;      // 0.6 .. 1, set by the app's adaptive quality

    this.time = 0;
    this.beat = 0;
    this.comboGlow = 0;
    this.shake = 0;
    this.eqPhase = 0;
    this.reducedMotion = false;
    this.fxEnabled = true;

    this._bg = null;
    this._bgWidth = 0;
    this._bgHeight = 0;
    this._glowSprites = {};
    this._rowHueStrings = null;
    this._eqHue = null;

    try {
      this.reducedMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) { /* ignore */ }

    this._seenPopups = typeof WeakSet === 'function' ? new WeakSet() : null;
    this._particles = [];
    this._waves = [];
    this._trail = [];
    this._lastScore = 0;
    this._lastMultiplier = 1;
    this._lastBricksLeft = 0;
    this._shakeX = 0;
    this._shakeY = 0;
  }

  /* ---------------------------------------------------------------------
   * Sizing / quality
   * ------------------------------------------------------------------- */
  Renderer.prototype.setQualityScale = function (scale) {
    var next = clamp(Number(scale) || 1, 0.6, 1);
    if (Math.abs(next - this.qualityScale) < 0.01) return;
    this.qualityScale = next;
    this._bg = null;
  };

  Renderer.prototype.resize = function (cssWidth, cssHeight, dpr) {
    var width = Math.max(1, Math.round(cssWidth));
    var height = Math.max(1, Math.round(cssHeight));
    var deviceRatio = clamp(Number(dpr) || 1, 1, 4);
    var effective = clamp(deviceRatio * this.qualityScale, 0.75, 2.5);
    this.width = width;
    this.height = height;
    this.dpr = deviceRatio;
    this.effectiveDpr = effective;
    this.canvas.width = Math.round(width * effective);
    this.canvas.height = Math.round(height * effective);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(effective, 0, 0, effective, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this._glowSprites = {};
    this._buildBackground();
    this._trail.length = 0;
  };

  Renderer.prototype.setFxEnabled = function (enabled) {
    this.fxEnabled = !!enabled;
  };

  Renderer.prototype.setReducedMotion = function (reduced) {
    this.reducedMotion = !!reduced;
  };

  Renderer.prototype._comboMultiplier = function (session) {
    if (typeof session.comboMultiplier === 'number') return session.comboMultiplier;
    var combo = session.stats ? session.stats.combo : 0;
    return Math.min(config.COMBO_MAX, 1 + Math.floor(combo / config.COMBO_STEP));
  };

  /* ---------------------------------------------------------------------
   * Static background cache
   * ------------------------------------------------------------------- */
  Renderer.prototype._buildBackground = function () {
    if (!this.width || !this.height) return;
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(this.width * this.effectiveDpr);
    canvas.height = Math.round(this.height * this.effectiveDpr);
    var ctx = canvas.getContext('2d');
    ctx.scale(this.effectiveDpr, this.effectiveDpr);

    var width = this.width;
    var height = this.height;

    var gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#04050d');
    gradient.addColorStop(0.45, '#080d24');
    gradient.addColorStop(1, '#140b2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // soft stage lights (static)
    var topGlow = ctx.createRadialGradient(width * 0.5, height * 0.12, 0, width * 0.5, height * 0.12, Math.max(width, height) * 0.7);
    topGlow.addColorStop(0, 'rgba(80, 170, 255, 0.12)');
    topGlow.addColorStop(0.5, 'rgba(120, 70, 220, 0.05)');
    topGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = topGlow;
    ctx.fillRect(0, 0, width, height);

    // perspective grid floor
    var horizon = height * 0.62;
    ctx.save();
    ctx.strokeStyle = 'rgba(88, 166, 255, 0.08)';
    ctx.lineWidth = 1;
    var lines = 9;
    for (var i = 0; i <= lines; i += 1) {
      var x = (width / lines) * i;
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(width * 0.5 + (x - width * 0.5) * 0.12, horizon);
      ctx.stroke();
    }
    for (var row = 1; row <= 7; row += 1) {
      var t = row / 7;
      var y = horizon + (height - horizon) * t * t;
      ctx.globalAlpha = 0.10 * (1 - t * 0.4);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    // scanlines
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#000';
    for (var line = 0; line < height; line += 4) {
      ctx.fillRect(0, line, width, 1);
    }
    ctx.restore();

    // vignette
    var vignette = ctx.createRadialGradient(
      width * 0.5, height * 0.5, Math.min(width, height) * 0.35,
      width * 0.5, height * 0.5, Math.max(width, height) * 0.78
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    this._bg = canvas;
    this._bgWidth = width;
    this._bgHeight = height;
  };

  Renderer.prototype._glowSprite = function (hue) {
    var bucket = Math.round(((hue % 360) + 360) % 360 / 15) * 15 % 360;
    var cached = this._glowSprites[bucket];
    if (cached) return cached;
    var size = 256;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    var gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'hsla(' + bucket + ', 95%, 62%, 0.30)');
    gradient.addColorStop(0.55, 'hsla(' + bucket + ', 95%, 55%, 0.10)');
    gradient.addColorStop(1, 'hsla(' + bucket + ', 95%, 50%, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    this._glowSprites[bucket] = canvas;
    return canvas;
  };

  /* ---------------------------------------------------------------------
   * Effects sync (render-only; never writes to the session)
   * ------------------------------------------------------------------- */
  Renderer.prototype._spawnHitEffects = function (popup) {
    if (!this.fxEnabled || this.reducedMotion) return;
    var hue = typeof popup.colorHue === 'number' ? popup.colorHue : 190;
    var count = 7;
    for (var i = 0; i < count; i += 1) {
      var angle = Math.random() * TAU;
      var speed = 60 + Math.random() * 190;
      this._particles.push({
        x: popup.x, y: popup.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        life: 0,
        ttl: 0.35 + Math.random() * 0.3,
        hue: hue + (Math.random() * 60 - 30),
        size: 2 + Math.random() * 3.2
      });
    }
    if (this._particles.length > 140) this._particles.splice(0, this._particles.length - 140);
    this._waves.push({ x: popup.x, y: popup.y, life: 0, ttl: 0.4, hue: hue });
    if (this._waves.length > 6) this._waves.shift();
  };

  Renderer.prototype.sync = function (session, dt) {
    var frame = clamp(dt || 0, 0, 0.1);
    this.time += frame;
    this.beat *= Math.exp(-frame * 5.2);
    this.comboGlow *= Math.exp(-frame * 2.8);
    this.shake *= Math.exp(-frame * 6.5);
    this.eqPhase += frame * (1.6 + this._comboMultiplier(session) * 0.55);

    var multiplier = this._comboMultiplier(session);
    var score = session.stats ? session.stats.score : 0;
    var bricksLeft = typeof session.bricksLeft === 'number' ? session.bricksLeft : 0;

    if (session.popups && session.popups.length) {
      for (var i = 0; i < session.popups.length; i += 1) {
        var popup = session.popups[i];
        if (!popup) continue;
        var seen = this._seenPopups ? this._seenPopups.has(popup) : false;
        if (!seen) {
          if (this._seenPopups) this._seenPopups.add(popup);
          this.beat = 1;
          this._spawnHitEffects(popup);
          this.shake = Math.min(7, this.shake + (multiplier >= 3 ? 2.8 : 1.4));
        }
      }
    }

    if (multiplier > this._lastMultiplier) {
      this.comboGlow = 1;
      this.beat = 1;
      this.shake = Math.min(9, this.shake + 2.2);
    }
    this._lastMultiplier = multiplier;

    if (score > this._lastScore || bricksLeft < this._lastBricksLeft) this.beat = Math.max(this.beat, 0.75);
    this._lastScore = score;
    this._lastBricksLeft = bricksLeft;

    for (var p = this._particles.length - 1; p >= 0; p -= 1) {
      var particle = this._particles[p];
      particle.life += frame;
      if (particle.life >= particle.ttl) {
        this._particles.splice(p, 1);
        continue;
      }
      particle.x += particle.vx * frame;
      particle.y += particle.vy * frame;
      particle.vy += 520 * frame;
      particle.vx *= 0.985;
    }
    for (var w = this._waves.length - 1; w >= 0; w -= 1) {
      this._waves[w].life += frame;
      if (this._waves[w].life >= this._waves[w].ttl) this._waves.splice(w, 1);
    }

    var ball = session.ball;
    if (ball && ball.state === BB.BallState.IN_FLIGHT) {
      this._trail.push({ x: ball.x, y: ball.y });
      if (this._trail.length > 12) this._trail.shift();
    } else if (this._trail.length) {
      this._trail.shift();
    }

    var shakeAmount = this.shake * (this.fxEnabled && !this.reducedMotion ? 1 : 0);
    this._shakeX = (Math.random() * 2 - 1) * shakeAmount;
    this._shakeY = (Math.random() * 2 - 1) * shakeAmount;

    // dynamic stage glow: one cached sprite, one drawImage per frame
    var heat = clamp((multiplier - 1) / Math.max(1, config.COMBO_MAX - 1), 0, 1);
    this._glowHue = 190 + heat * 120 + this.beat * 22;
    this._glowAlpha = 0.10 + heat * 0.16 + this.beat * 0.06;
  };

  Renderer.prototype._drawBackground = function (session) {
    var ctx = this.ctx;
    if (this._bg) {
      ctx.drawImage(this._bg, 0, 0, this._bgWidth, this._bgHeight);
    } else {
      ctx.clearRect(0, 0, this.width, this.height);
    }

    // combo heat glow (cached hue sprite)
    if (this._glowAlpha > 0.02) {
      var sprite = this._glowSprite(this._glowHue);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this._glowAlpha;
      var scale = Math.max(this.width, this.height) * 1.25;
      ctx.drawImage(sprite, (this.width - scale) / 2, this.height * 0.12 - scale / 2, scale, scale);
      ctx.restore();
    }

    this._drawEqualizer(session);
  };

  Renderer.prototype._drawEqualizer = function (session) {
    var multiplier = this._comboMultiplier(session);
    var heat = clamp((multiplier - 1) / Math.max(1, config.COMBO_MAX - 1), 0, 1);
    var ctx = this.ctx;
    var bars = Math.max(14, Math.min(32, Math.round(this.width / 48)));
    if (!this._eqHue || this._eqHue.length !== bars) {
      this._eqHue = [];
      for (var k = 0; k < bars; k += 1) {
        this._eqHue.push(style.brickHues[k % style.brickHues.length]);
      }
    }
    var baseY = this.height * 0.99;
    var maxBar = this.height * (0.045 + heat * 0.14);
    var slot = this.width / bars;
    var barWidth = slot * 0.5;
    var alphaBase = 0.10 + heat * 0.18 + this.beat * 0.08;

    ctx.save();
    ctx.globalAlpha = alphaBase;
    for (var b = 0; b < bars; b += 1) {
      var phase = this.eqPhase * (1 + (b % 5) * 0.09) + b * 0.62;
      var wave = Math.abs(Math.sin(phase)) * 0.65 + Math.abs(Math.sin(phase * 2.7 + 1.3)) * 0.35;
      var height = (0.18 + wave * 0.82) * maxBar * (0.55 + heat * 0.9) * (0.7 + this.beat * 0.8);
      ctx.fillStyle = hsl(this._eqHue[b], 90, 58);
      ctx.fillRect(slot * b + (slot - barWidth) * 0.5, baseY - height, barWidth, height);
    }
    ctx.restore();
  };

  /* ---------------------------------------------------------------------
   * Bricks (flat fills; no per-brick gradients/shadowBlur)
   * ------------------------------------------------------------------- */
  Renderer.prototype._brickStyle = function (session, brick) {
    var multiplier = this._comboMultiplier(session);
    var heat = clamp((multiplier - 1) / Math.max(1, config.COMBO_MAX - 1), 0, 1);
    var baseHue = typeof brick.hue === 'number' ? brick.hue : style.brickHues[brick.row % style.brickHues.length];
    var hue = baseHue;
    if (multiplier > 1) {
      var wave = Math.sin(this.time * 4.6 + brick.col * 0.58 + brick.row * 0.34);
      hue += (multiplier - 1) * 17 + wave * (multiplier - 1) * 9 + this.comboGlow * 26;
      if (multiplier >= config.COMBO_MAX && this.fxEnabled && !this.reducedMotion) {
        hue += Math.sin(this.time * 2.2 + brick.col * 0.9) * 24;
      }
    }
    var lightness = style.brickLightness - 2 + heat * 3 + this.beat * (2 + heat * 6);
    var saturation = style.brickSaturation + heat * 6;
    return {
      hue: hue,
      saturation: saturation,
      lightness: lightness,
      heat: heat,
      fill: hsl(hue, saturation, lightness),
      top: hsl(hue, saturation, Math.min(78, lightness + 12)),
      bottom: hsl(hue + 12, saturation, Math.max(20, lightness - 14))
    };
  };

  Renderer.prototype._drawBricks = function (session) {
    var ctx = this.ctx;
    var bricks = session.bricks || [];
    var radius = Math.max(3, Math.min(9, (session.layout ? session.layout.brickH : 20) * 0.22));
    var round = typeof ctx.roundRect === 'function';

    for (var i = 0; i < bricks.length; i += 1) {
      var brick = bricks[i];
      if (brick.state === BB.BrickState.GONE) continue;
      var rect = brick.rect;
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;

      var alpha = brick.state === BB.BrickState.FADING
        ? clamp(brick.fade / config.BRICK_FADE_TIME, 0, 1)
        : 1;
      var look = this._brickStyle(session, brick);
      var x = rect.x;
      var y = rect.y;
      var w = rect.w;
      var h = rect.h;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = look.fill;
      if (round) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
        ctx.fill();
      } else {
        roundRectPath(ctx, x, y, w, h, radius);
        ctx.fill();
      }

      // cheap two-tone bevel (rectangular strips inside the rounded shape)
      var inset = Math.max(1.5, radius * 0.6);
      ctx.globalAlpha = alpha * 0.45;
      ctx.fillStyle = look.top;
      ctx.fillRect(x + inset, y + inset * 0.7, w - inset * 2, Math.max(1.5, h * 0.22));
      ctx.globalAlpha = alpha * 0.30;
      ctx.fillStyle = look.bottom;
      ctx.fillRect(x + inset, y + h - inset * 1.6, w - inset * 2, Math.max(1, h * 0.16));

      if (brick.state === BB.BrickState.CRACKED) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.strokeStyle = 'rgba(8, 10, 24, 0.85)';
        ctx.lineWidth = Math.max(1, h * 0.07);
        ctx.beginPath();
        ctx.moveTo(x + w * 0.36, y + h * 0.16);
        ctx.lineTo(x + w * 0.5, y + h * 0.54);
        ctx.lineTo(x + w * 0.42, y + h * 0.84);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  /* ---------------------------------------------------------------------
   * Paddle / ball / effects
   * ------------------------------------------------------------------- */
  Renderer.prototype._drawPaddle = function (session) {
    var ctx = this.ctx;
    var paddle = session.paddle;
    if (!paddle) return;
    var x = paddle.left;
    var y = paddle.top;
    var w = paddle.width;
    var h = paddle.height;
    var radius = h * 0.5;

    ctx.save();
    ctx.shadowColor = 'rgba(77, 243, 255, 0.75)';
    ctx.shadowBlur = paddle.flash > 0 ? 26 : 12;
    var fill = ctx.createLinearGradient(x, y, x, y + h);
    fill.addColorStop(0, '#f2ffff');
    fill.addColorStop(0.45, '#5df3ff');
    fill.addColorStop(1, '#1b7fa8');
    ctx.fillStyle = fill;
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x + w * 0.18, y + 1.2, w * 0.64, Math.max(1, h * 0.18));
    ctx.restore();
  };

  Renderer.prototype._drawBall = function (session) {
    var ctx = this.ctx;
    var ball = session.ball;
    if (!ball) return;

    if (this.fxEnabled && !this.reducedMotion && this._trail.length) {
      ctx.save();
      for (var i = 0; i < this._trail.length; i += 1) {
        var point = this._trail[i];
        var age = clamp(1 - i / this._trail.length, 0, 1);
        ctx.globalAlpha = age * 0.20;
        ctx.fillStyle = '#7ff4ff';
        ctx.beginPath();
        ctx.arc(point.x, point.y, ball.radius * (0.2 + age * 0.8), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = 'rgba(160, 250, 255, 0.95)';
    ctx.shadowBlur = 18;
    var glow = ctx.createRadialGradient(
      ball.x - ball.radius * 0.3, ball.y - ball.radius * 0.35, ball.radius * 0.15,
      ball.x, ball.y, ball.radius * 1.35
    );
    glow.addColorStop(0, '#ffffff');
    glow.addColorStop(0.55, '#d8fbff');
    glow.addColorStop(1, 'rgba(93, 243, 255, 0.15)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius * 1.25, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, Math.max(1.5, ball.radius * 0.72), 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._drawParticles = function () {
    if (!this._particles.length) return;
    var ctx = this.ctx;
    for (var i = 0; i < this._particles.length; i += 1) {
      var particle = this._particles[i];
      var progress = particle.life / particle.ttl;
      ctx.globalAlpha = (1 - progress) * 0.9;
      ctx.fillStyle = hsl(particle.hue, 100, 70);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (1 - progress * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawWaves = function () {
    if (!this._waves.length) return;
    var ctx = this.ctx;
    for (var i = 0; i < this._waves.length; i += 1) {
      var wave = this._waves[i];
      var progress = wave.life / wave.ttl;
      ctx.globalAlpha = (1 - progress) * 0.3;
      ctx.strokeStyle = hsl(wave.hue, 100, 68);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, 8 + progress * 64, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawPopups = function (session) {
    var ctx = this.ctx;
    var popups = session.popups || [];
    if (!popups.length) return;
    var fontSize = Math.max(13, Math.round((session.layout ? session.layout.height : this.height) * 0.032));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 ' + fontSize + 'px "Segoe UI Black", "Arial Black", Impact, sans-serif';
    for (var i = 0; i < popups.length; i += 1) {
      var popup = popups[i];
      var progress = 1 - clamp(popup.life / popup.ttl, 0, 1);
      var hue = typeof popup.colorHue === 'number' ? popup.colorHue : 190;
      ctx.globalAlpha = clamp(popup.life / popup.ttl, 0, 1);
      ctx.fillStyle = hsl(hue, 100, 78);
      ctx.fillText(popup.text, popup.x, popup.y - progress * config.POPUP_RISE);
    }
    ctx.restore();
  };

  Renderer.prototype.draw = function (session) {
    if (!this.width || !this.height) return;
    var ctx = this.ctx;
    ctx.setTransform(this.effectiveDpr, 0, 0, this.effectiveDpr, 0, 0);
    this._drawBackground(session);

    ctx.save();
    ctx.translate(this._shakeX, this._shakeY);
    this._drawBricks(session);
    this._drawWaves();
    this._drawParticles();
    this._drawPaddle(session);
    this._drawBall(session);
    this._drawPopups(session);
    ctx.restore();
  };

  BB.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
