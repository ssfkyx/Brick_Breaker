/* Brick Breaker Web — M9 INPUT.
 *
 * Keyboard, mouse and touch are translated into the same Intent values the
 * desktop session understands.  Touch/mouse dragging sets a direct paddle
 * target through GameSession.setPointerTarget() (added for the web build), which
 * keeps touch play responsive while still reporting real paddle velocity for
 * the "english" bounce.
 */
(function (global) {
  'use strict';

  var BB = global.BB;
  var config = BB.config;

  var KEY_INTENTS = {
    Space: BB.Intent.PRIMARY,
    ArrowUp: BB.Intent.PRIMARY,
    Enter: BB.Intent.PRIMARY,
    KeyP: BB.Intent.TOGGLE_PAUSE,
    KeyM: BB.Intent.TOGGLE_MUTE,
    KeyT: BB.Intent.CYCLE_INSTRUMENT,
    KeyR: BB.Intent.RESTART,
    KeyF: BB.Intent.TOGGLE_FULLSCREEN
  };

  var LEFT_KEYS = { ArrowLeft: true, KeyA: true };
  var RIGHT_KEYS = { ArrowRight: true, KeyD: true };

  function InputController(canvas, handlers) {
    this.canvas = canvas;
    this.handlers = handlers || {};
    this.held = {};
    this.pointerActive = false;
    this.pointerId = null;
    this._firstGestureDone = false;
    this._bind();
  }

  InputController.prototype._firstGesture = function () {
    if (this._firstGestureDone) return;
    this._firstGestureDone = true;
    if (this.handlers.onFirstGesture) this.handlers.onFirstGesture();
  };

  InputController.prototype._emit = function (intent) {
    if (this.handlers.onIntent) this.handlers.onIntent(intent);
  };

  InputController.prototype.getAxis = function () {
    var left = false;
    var right = false;
    for (var key in this.held) {
      if (!Object.prototype.hasOwnProperty.call(this.held, key) || !this.held[key]) continue;
      if (LEFT_KEYS[key]) left = true;
      if (RIGHT_KEYS[key]) right = true;
    }
    if (left === right) return 0;
    return right ? 1 : -1;
  };

  InputController.prototype._canvasX = function (clientX) {
    var rect = this.canvas.getBoundingClientRect();
    return clientX - rect.left;
  };

  InputController.prototype._bind = function () {
    var self = this;

    global.addEventListener('keydown', function (event) {
      var code = event.code || event.key;
      var isAction = KEY_INTENTS[code] || code === 'Escape' || code === 'KeyQ' || code === 'KeyS';
      if (isAction || LEFT_KEYS[code] || RIGHT_KEYS[code]) {
        // Stop the browser from scrolling / activating controls while playing.
        if (code === 'Space' || code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight') {
          event.preventDefault();
        }
      }
      if (event.repeat) return;
      self._firstGesture();
      if (LEFT_KEYS[code] || RIGHT_KEYS[code]) {
        self.held[code] = true;
        return;
      }
      if (code === 'Escape') {
        if (self.handlers.onEscape) self.handlers.onEscape();
        return;
      }
      if (code === 'KeyQ') {
        if (self.handlers.onMenuRequested) self.handlers.onMenuRequested();
        return;
      }
      if (code === 'KeyS') {
        if (self.handlers.onSettingsRequested) self.handlers.onSettingsRequested();
        return;
      }
      var intent = KEY_INTENTS[code];
      if (intent) {
        event.preventDefault();
        self._emit(intent);
      }
    });

    global.addEventListener('keyup', function (event) {
      var code = event.code || event.key;
      if (LEFT_KEYS[code] || RIGHT_KEYS[code]) self.held[code] = false;
    });

    global.addEventListener('blur', function () {
      self.held = {};
      if (self.handlers.onFocusLost) self.handlers.onFocusLost();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && self.handlers.onFocusLost) self.handlers.onFocusLost();
    });

    this.canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      self._firstGesture();
      self.pointerActive = true;
      self.pointerId = event.pointerId;
      try { self.canvas.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
      var x = self._canvasX(event.clientX);
      if (self.handlers.onPointerDown) self.handlers.onPointerDown(x, event.pointerType);
      if (self.handlers.onPointerMove) self.handlers.onPointerMove(x);
    });

    this.canvas.addEventListener('pointermove', function (event) {
      var x = self._canvasX(event.clientX);
      if (self.pointerActive) {
        event.preventDefault();
        if (self.handlers.onPointerMove) self.handlers.onPointerMove(x);
      } else if (event.pointerType === 'mouse') {
        if (self.handlers.onPointerMove) self.handlers.onPointerMove(x);
      }
    });

    function endPointer(event) {
      if (!self.pointerActive) return;
      self.pointerActive = false;
      self.pointerId = null;
      if (self.handlers.onPointerUp) self.handlers.onPointerUp();
    }
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', endPointer);
    this.canvas.addEventListener('lostpointercapture', endPointer);
    this.canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });

    // Prevent iOS double-tap zoom / rubber banding on the playfield.
    this.canvas.addEventListener('touchstart', function (event) {
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
  };

  BB.InputController = InputController;
  BB.KEY_INTENTS = KEY_INTENTS;
})(typeof window !== 'undefined' ? window : globalThis);
