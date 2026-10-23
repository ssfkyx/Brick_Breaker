/* Brick Breaker Web — M8 VIEW (canvas renderer).
 *
 * The playfield is drawn on a canvas whose backing store is sized in device
 * pixels (HiDPI / Retina aware); all game coordinates are CSS pixels, so
 * geometry, collision math and text stay crisp on every screen.
 *
 * Visual signature of the web build: a neon club stage.  On top of the normal
 * (shadow) overlay, the "combo light show" reacts to every brick hit: bricks
 * shift hue as a group, a ripple travels along the columns and the equalizer
 * floor pulses with the combo, so the wall starts dancing like a DJ booth.
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
    return 'hsl(' + ((hue % 360) + 360) % 360 + ' ' + saturation + '% ' + lightness + '%)';
  }

  function roundRectPath(ctx, x, y, w, h, radius) {
    var r = Math.min(radius, w * 0.5, h * 0.5);
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
    this.dpr = 1;

    this.time = 0;
    this.beat = 0;              // 0..1 pulse after a brick hit
    this.comboGlow = 0;         // 0..1 extra glow when the multiplier climbs
    this.shake = 0;
    this.eqPhase = 0;
    this.reducedMotion = false;
    this.fxEnabled = true;
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
    this._background = null;
    this._shakeX = 0;
    this._shakeY = 0;
  }

  Renderer.prototype.resize = function (cssWidth, cssHeight, dpr) {
    var width = Math.max(1, Math.round(cssWidth));
    var height = Math.max(1, Math.round(cssHeight));
    var ratio = clamp(dpr || 1, 1, 4);
    this.width = width;
    this.height = height;
    this.dpr = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this._background = null;
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

  Renderer.prototype._spawnHitEffects = function (popup) {
    if (!this.fxEnabled || this.reducedMotion) return;
    var hue = typeof popup.colorHue === 'number' ? popup.colorHue : 190;
    var count = 9;
    for (var i = 0; i < count; i += 1) {
      var angle = Math.random() * TAU;
      var speed = 60 + Math.random() * 210;
      this._particles.push({
        x: popup.x,
        y: popup.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        life: 0,
        ttl: 0.38 + Math.random() * 0.32,
        hue: hue + (Math.random() * 60 - 30),
        size: 2 + Math.random() * 3.6
      });
    }
    if (this._particles.length > 220) this._particles.splice(0, this._particles.length - 220);
    this._waves.push({ x: popup.x, y: popup.y, life: 0, ttl: 0.42, hue: hue });
    if (this._waves.length > 8) this._waves.shift();
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

    if (score > this._lastScore || bricksLeft < this._lastBricksLeft) {
      this.beat = Math.max(this.beat, 0.75);
    }
    this._lastScore = score;
    this._lastBricksLeft = bricksLeft;

    // particles
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

    // ball trail
    var ball = session.ball;
    if (ball && ball.state === BB.BallState.IN_FLIGHT) {
      this._trail.push({ x: ball.x, y: ball.y, life: 0 });
      if (this._trail.length > 16) this._trail.shift();
    } else if (this._trail.length) {
      this._trail.shift();
    }
    for (var t = 0; t < this._trail.length; t += 1) this._trail[t].life += frame;

    var shakeAmount = this.shake * (this.fxEnabled && !this.reducedMotion ? 1 : 0);
    this._shakeX = (Math.random() * 2 - 1) * shakeAmount;
    this._shakeY = (Math.random() * 2 - 1) * shakeAmount;
  };

  Renderer.prototype._drawBackground = function (session) {
    var ctx = this.ctx;
    var width = this.width;
    var height = this.height;
    var multiplier = this._comboMultiplier(session);
    var heat = clamp((multiplier - 1) / Math.max(1, config.COMBO_MAX - 1), 0, 1);

    if (!this._background) {
      var gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#04050d');
      gradient.addColorStop(0.45, '#080d24');
      gradient.addColorStop(1, '#140b2e');
      this._background = gradient;
    }
    ctx.fillStyle = this._background;
    ctx.fillRect(0, 0, width, height);

    // stage glow that follows the combo heat
    var glow = ctx.createRadialGradient(
      width * 0.5, height * 0.18, 0,
      width * 0.5, height * 0.18, Math.max(width, height) * 0.72
    );
    var glowHue = 190 + heat * 120 + this.beat * 22;
    glow.addColorStop(0, 'hsla(' + ((glowHue % 360) + 360) % 360 + ', 90%, 58%, 0.18)');
    glow.addColorStop(0.42, 'hsla(' + (((glowHue + 120) % 360) + 360) % 360 + ', 90%, 55%, 0.07)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
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

    // equalizer floor: the "DJ booth" reacting to the combo
    var bars = Math.max(16, Math.min(40, Math.round(width / 34)));
    var baseY = height * 0.985;
    var maxBar = height * (0.05 + heat * 0.16);
    ctx.save();
    for (var b = 0; b < bars; b += 1) {
      var phase = this.eqPhase * (1 + (b % 5) * 0.09) + b * 0.62;
      var wave = Math.abs(Math.sin(phase)) * 0.65 + Math.abs(Math.sin(phase * 2.7 + 1.3)) * 0.35;
      var amplitude = (0.18 + wave * 0.82) * maxBar * (0.55 + heat * 0.9);
      amplitude *= 0.7 + this.beat * 0.8;
      var barWidth = width / bars * 0.52;
      var barX = (width / bars) * b + (width / bars - barWidth) * 0.5;
      var hue = (style.brickHues[b % style.brickHues.length] + this.time * (14 + heat * 30)) % 360;
      var alpha = 0.10 + heat * 0.22 + this.beat * 0.10;
      ctx.fillStyle = hsl(hue, 90, 60);
      ctx.globalAlpha = alpha;
      roundRectPath(ctx, barX, baseY - amplitude, barWidth, amplitude, 2);
      ctx.fill();
    }
    ctx.restore();

    // subtle scanlines / vignette
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#000';
    for (var line = 0; line < height; line += 4) {
      ctx.fillRect(0, line, width, 1);
    }
    ctx.restore();

    var vignette = ctx.createRadialGradient(
      width * 0.5, height * 0.5, Math.min(width, height) * 0.35,
      width * 0.5, height * 0.5, Math.max(width, height) * 0.78
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  };

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
    return { hue: hue, saturation: saturation, lightness: lightness, heat: heat };
  };

  Renderer.prototype._drawBricks = function (session) {
    var ctx = this.ctx;
    var bricks = session.bricks || [];
    var radius = Math.max(3, Math.min(9, (session.layout ? session.layout.brickH : 20) * 0.22));

    for (var i = 0; i < bricks.length; i += 1) {
      var brick = bricks[i];
      if (brick.state === BB.BrickState.GONE) continue;
      var rect = brick.rect;
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;

      var alpha = 1;
      if (brick.state === BB.BrickState.FADING) {
        alpha = clamp(brick.fade / config.BRICK_FADE_TIME, 0, 1);
      }
      var look = this._brickStyle(session, brick);
      var x = rect.x;
      var y = rect.y;
      var w = rect.w;
      var h = rect.h;

      ctx.save();
      ctx.globalAlpha = alpha;

      if (look.heat > 0.03) {
        ctx.shadowColor = hsl(look.hue, 100, 62);
        ctx.shadowBlur = 6 + look.heat * 14 + this.beat * 8;
      } else {
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
      }

      var fill = ctx.createLinearGradient(x, y, x, y + h);
      fill.addColorStop(0, hsl(look.hue, look.saturation, Math.min(76, look.lightness + 14)));
      fill.addColorStop(0.55, hsl(look.hue, look.saturation, look.lightness));
      fill.addColorStop(1, hsl(look.hue + 12, look.saturation, Math.max(20, look.lightness - 16)));
      ctx.fillStyle = fill;
      roundRectPath(ctx, x, y, w, h, radius);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      roundRectPath(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, Math.max(2, radius - 1));
      ctx.stroke();

      // top highlight
      ctx.globalAlpha = alpha * 0.28;
      ctx.fillStyle = '#ffffff';
      roundRectPath(ctx, x + 3, y + 2.5, w - 6, Math.max(1.5, h * 0.18), Math.max(1, radius * 0.6));
      ctx.fill();

      if (brick.state === BB.BrickState.CRACKED) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.strokeStyle = 'rgba(8, 10, 24, 0.85)';
        ctx.lineWidth = Math.max(1, h * 0.07);
        ctx.beginPath();
        ctx.moveTo(x + w * 0.36, y + h * 0.15);
        ctx.lineTo(x + w * 0.5, y + h * 0.55);
        ctx.lineTo(x + w * 0.42, y + h * 0.86);
        ctx.moveTo(x + w * 0.62, y + h * 0.18);
        ctx.lineTo(x + w * 0.55, y + h * 0.52);
        ctx.stroke();
      } else if (brick.maxHp > 1 && brick.hp === brick.maxHp) {
        // small double-hit pip
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x + w - h * 0.34, y + h * 0.5, Math.max(1, h * 0.09), 0, TAU);
        ctx.fill();
      }

      ctx.restore();
    }
  };

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
    ctx.shadowColor = 'rgba(77, 243, 255, 0.8)';
    ctx.shadowBlur = 16 + (paddle.flash > 0 ? 20 : 0);
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
    roundRectPath(ctx, x + w * 0.18, y + 1.5, w * 0.64, Math.max(1, h * 0.18), radius);
    ctx.fill();

    if (paddle.flash > 0) {
      ctx.globalAlpha = Math.min(1, paddle.flash / 0.12) * 0.5;
      ctx.strokeStyle = '#eafcff';
      ctx.lineWidth = 2;
      roundRectPath(ctx, x - 3, y - 3, w + 6, h + 6, radius + 3);
      ctx.stroke();
    }
    ctx.restore();
  };

  Renderer.prototype._drawBall = function (session) {
    var ctx = this.ctx;
    var ball = session.ball;
    if (!ball) return;

    // trail
    if (this.fxEnabled && !this.reducedMotion) {
      for (var i = 0; i < this._trail.length; i += 1) {
        var point = this._trail[i];
        var age = clamp(1 - i / this._trail.length, 0, 1);
        var radius = ball.radius * (0.2 + age * 0.85);
        ctx.beginPath();
        ctx.fillStyle = 'hsla(190, 100%, 70%, ' + (age * 0.22) + ')';
        ctx.arc(point.x, point.y, radius, 0, TAU);
        ctx.fill();
      }
    }

    ctx.save();
    ctx.shadowColor = 'rgba(160, 250, 255, 0.95)';
    ctx.shadowBlur = 22;
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
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this._particles.length; i += 1) {
      var particle = this._particles[i];
      var progress = particle.life / particle.ttl;
      var alpha = (1 - progress) * 0.9;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = hsl(particle.hue, 100, 70);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (1 - progress * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  };

  Renderer.prototype._drawWaves = function () {
    if (!this._waves.length) return;
    var ctx = this.ctx;
    ctx.save();
    for (var i = 0; i < this._waves.length; i += 1) {
      var wave = this._waves[i];
      var progress = wave.life / wave.ttl;
      ctx.globalAlpha = (1 - progress) * 0.35;
      ctx.strokeStyle = hsl(wave.hue, 100, 68);
      ctx.lineWidth = 2 + (1 - progress) * 3;
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, 8 + progress * 70, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
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
      ctx.shadowColor = hsl(hue, 100, 65);
      ctx.shadowBlur = 12;
      ctx.fillStyle = hsl(hue, 100, 78);
      ctx.fillText(popup.text, popup.x, popup.y - progress * config.POPUP_RISE);
    }
    ctx.restore();
  };

  Renderer.prototype.draw = function (session) {
    if (!this.width || !this.height) return;
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

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
