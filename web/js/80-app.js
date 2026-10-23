/* Brick Breaker Web — M11 APP / bootstrap.
 *
 * Owns the DOM shell (HUD, overlays, settings), the fixed-timestep loop, the
 * canvas sizing (devicePixelRatio aware), persistence, audio unlocking,
 * touch/keyboard wiring and a small demo-fixture hook used by screenshot tests.
 */
(function (global) {
  'use strict';

  var BB = global.BB;
  var config = BB.config;

  function el(id) {
    return document.getElementById(id);
  }

  function App() {
    this.started = false;
    this.settingsOpen = false;
    this.resumeAfterSettings = false;
    this.runBestBefore = 0;
    this.lastTime = 0;
    this.accumulator = 0;
    this.frameCount = 0;
    this.demoMode = null;
    this.demoTimer = null;

    this.storage = new BB.Storage();
    this.saved = this.storage.load();

    this.canvas = el('game');
    this.stage = el('stage');
    this.renderer = new BB.Renderer(this.canvas);
    this.renderer.setFxEnabled(this.saved.lightShow);

    this.audio = new BB.AudioEngine({
      muted: this.saved.muted,
      instrument: this.saved.instrument,
      onChange: this.onAudioChange.bind(this)
    });

    var initialWidth = Math.max(320, Math.floor(this.stage.clientWidth || 960));
    var initialHeight = Math.max(260, Math.floor(this.stage.clientHeight || 640));
    this.session = new BB.GameSession(initialWidth, initialHeight, this.audio);
    this.session.settings.instrument = this.saved.instrument;
    this.session.stats.record.bestScore = this.saved.bestScore;
    this.session.stats.record.bestLevel = this.saved.bestLevel;
    this.session.stats.record.bestCombo = this.saved.bestCombo;
    this.session.settings.muted = this.saved.muted;

    this.dom = this._collectDom();
    this._bindEvents();
    this._buildInstrumentCards();
    this.resize();

    var self = this;
    this.handle = requestAnimationFrame(function (time) { self.frame(time); });
    this._applyUrlDemo();
    this._syncPanels(true);
    this._syncHud(true);
  }

  /* ---------------------------------------------------------------------
   * DOM
   * ------------------------------------------------------------------- */
  App.prototype._collectDom = function () {
    var ids = [
      'hudScore', 'hudBest', 'hudLevel', 'hudLives',
      'chipSound', 'chipSoundText', 'chipCombo', 'chipComboValue',
      'overlay', 'panelTitle', 'panelReady', 'panelPause', 'panelLevel', 'panelOver',
      'settingsOverlay', 'instrumentGrid', 'btnPlay', 'btnResume', 'btnPauseRestart',
      'btnAgain', 'btnOverMenu', 'btnMute', 'btnPause', 'btnSettings',
      'btnCloseSettings', 'btnPreview', 'btnFullscreen', 'btnSoundToggle',
      'btnFxToggle', 'settingsBestCombo', 'titleBest', 'titleBestCombo', 'titleInstrument',
      'overScore', 'overBest', 'overLevel', 'overCombo', 'newRecord', 'readyLives',
      'levelTitle', 'levelBonus', 'toast', 'btnSettings', 'stage'
    ];
    var out = {};
    for (var i = 0; i < ids.length; i += 1) out[ids[i]] = el(ids[i]);
    return out;
  };

  App.prototype.toast = function (message) {
    var node = this.dom.toast;
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    var self = this;
    this._toastTimer = setTimeout(function () { node.classList.remove('is-visible'); }, 1600);
  };

  /* ---------------------------------------------------------------------
   * Persistence + audio state
   * ------------------------------------------------------------------- */
  App.prototype.onAudioChange = function (state) {
    this.storage.update({ instrument: state.instrument, muted: state.muted });
    this.saved.instrument = state.instrument;
    this.saved.muted = state.muted;
    this._syncHud(true);
    this._syncToggles();
    this._syncInstrumentCards();
  };

  App.prototype._saveRecords = function () {
    var stats = this.session.stats;
    var record = stats.record;
    var next = {
      bestScore: Math.max(this.saved.bestScore, record.bestScore, stats.score),
      bestCombo: Math.max(this.saved.bestCombo, record.bestCombo, stats.bestCombo),
      bestLevel: Math.max(this.saved.bestLevel, record.bestLevel, stats.level)
    };
    this.saved.bestScore = next.bestScore;
    this.saved.bestCombo = next.bestCombo;
    this.saved.bestLevel = next.bestLevel;
    this.storage.update(next);
  };

  /* ---------------------------------------------------------------------
   * Sizing (HiDPI)
   * ------------------------------------------------------------------- */
  App.prototype.resize = function () {
    var rect = this.stage.getBoundingClientRect();
    var width = Math.max(240, Math.round(rect.width));
    var height = Math.max(200, Math.round(rect.height));
    if (width === this.renderer.width && height === this.renderer.height &&
        this.renderer.dpr === Math.max(1, global.devicePixelRatio || 1)) {
      return;
    }
    var dpr = Math.max(1, Math.min(4, global.devicePixelRatio || 1));
    this.session.resize(width, height);
    this.renderer.resize(width, height, dpr);
  };

  /* ---------------------------------------------------------------------
   * Event wiring
   * ------------------------------------------------------------------- */
  App.prototype._bindEvents = function () {
    var self = this;

    this.input = new BB.InputController(this.canvas, {
      onFirstGesture: function () { self.audio.unlock(); },
      onIntent: function (intent) { self.handleIntent(intent); },
      onPointerDown: function (x) { self.handlePointerDown(x); },
      onPointerMove: function (x) { self.handlePointerMove(x); },
      onPointerUp: function () { self.handlePointerUp(); },
      onEscape: function () { self.handleEscape(); },
      onMenuRequested: function () { self.handleMenuRequest(); },
      onSettingsRequested: function () { self.openSettings(); },
      onFocusLost: function () { self.handleFocusLost(); }
    });

    var play = function () { self.startGame(); };
    if (this.dom.btnPlay) this.dom.btnPlay.addEventListener('click', play);
    if (this.dom.btnResume) this.dom.btnResume.addEventListener('click', function () { self.handleIntent(BB.Intent.TOGGLE_PAUSE); });
    if (this.dom.btnPauseRestart) this.dom.btnPauseRestart.addEventListener('click', function () { self.restartRun(true); });
    if (this.dom.btnAgain) this.dom.btnAgain.addEventListener('click', function () { self.startGame(); });
    if (this.dom.btnOverMenu) this.dom.btnOverMenu.addEventListener('click', function () { self.goMenu(); });

    if (this.dom.btnMute) this.dom.btnMute.addEventListener('click', function () { self.handleIntent(BB.Intent.TOGGLE_MUTE); });
    if (this.dom.btnPause) this.dom.btnPause.addEventListener('click', function () { self.togglePause(); });
    if (this.dom.btnSettings) this.dom.btnSettings.addEventListener('click', function () { self.openSettings(); });
    if (this.dom.btnCloseSettings) this.dom.btnCloseSettings.addEventListener('click', function () { self.closeSettings(); });
    if (this.dom.btnPreview) this.dom.btnPreview.addEventListener('click', function () {
      self.audio.unlock().then(function () { self.audio.playPreview(); });
    });
    if (this.dom.btnFullscreen) this.dom.btnFullscreen.addEventListener('click', function () { self.toggleFullscreen(); });
    if (this.dom.btnSoundToggle) this.dom.btnSoundToggle.addEventListener('click', function () {
      self.audio.unlock();
      self.audio.setMuted(!self.audio.muted);
      self.session.settings.muted = self.audio.muted;
      self.toast(self.audio.muted ? 'Sound off' : 'Sound on');
    });
    if (this.dom.btnFxToggle) this.dom.btnFxToggle.addEventListener('click', function () {
      self.renderer.setFxEnabled(!self.renderer.fxEnabled);
      self.saved.lightShow = self.renderer.fxEnabled;
      self.storage.update({ lightShow: self.saved.lightShow });
      self._syncToggles();
      self.toast(self.renderer.fxEnabled ? 'Combo light show on' : 'Combo light show off');
    });

    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(function () { self.resize(); });
      this._resizeObserver.observe(this.stage);
    }
    // Tapping the "ball lost" overlay (and the title backdrop) starts the run.
    if (this.dom.overlay) {
      this.dom.overlay.addEventListener('pointerdown', function (event) {
        if (self._currentPanel === 'ready') {
          self.startGame();
          return;
        }
        if (event.target && event.target.closest && event.target.closest('.panel')) {
          return;
        }
      });
    }
    if (this.dom.settingsOverlay) {
      this.dom.settingsOverlay.addEventListener('pointerdown', function (event) {
        if (event.target === self.dom.settingsOverlay) self.closeSettings();
      });
    }
    global.addEventListener('resize', function () { self.resize(); });
    global.addEventListener('orientationchange', function () { setTimeout(function () { self.resize(); }, 120); });
    document.addEventListener('fullscreenchange', function () { setTimeout(function () { self.resize(); }, 60); });
    global.addEventListener('pagehide', function () { self._saveRecords(); });
  };

  App.prototype._buildInstrumentCards = function () {
    var grid = this.dom.instrumentGrid;
    if (!grid) return;
    grid.innerHTML = '';
    var keys = this.audio.instrumentKeys();
    this._instrumentCards = {};
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var data = this.audio.instrumentData(key);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'inst-card';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.dataset.instrument = key;

      var name = document.createElement('span');
      name.className = 'inst-name';
      name.textContent = data.label;
      var desc = document.createElement('span');
      desc.className = 'inst-desc';
      desc.textContent = data.blurb;
      var bars = document.createElement('span');
      bars.className = 'inst-bars';
      bars.setAttribute('aria-hidden', 'true');
      var count = Math.max(2, Math.min(6, data.partials.length));
      for (var b = 0; b < count; b += 1) {
        var bar = document.createElement('i');
        bar.style.height = Math.round(4 + Math.random() * 8) + 'px';
        bars.appendChild(bar);
      }
      button.appendChild(name);
      button.appendChild(desc);
      button.appendChild(bars);

      var self = this;
      button.addEventListener('click', (function (instrumentKey) {
        return function () {
          self.selectInstrument(instrumentKey);
        };
      })(key));

      grid.appendChild(button);
      this._instrumentCards[key] = button;
    }
    this._syncInstrumentCards();
  };

  App.prototype._syncInstrumentCards = function () {
    if (!this._instrumentCards) return;
    var active = this.audio.instrument;
    for (var key in this._instrumentCards) {
      if (!Object.prototype.hasOwnProperty.call(this._instrumentCards, key)) continue;
      this._instrumentCards[key].setAttribute('aria-checked', key === active ? 'true' : 'false');
    }
    if (this.dom.titleInstrument) this.dom.titleInstrument.textContent = this.audio.instrumentLabel();
  };

  App.prototype.selectInstrument = function (key) {
    var self = this;
    this.audio.unlock().then(function () {
      self.audio.setInstrument(key);
      self.session.settings.instrument = key;
      self.audio.playPreview();
      self.toast('Instrument · ' + self.audio.instrumentLabel());
    });
  };

  /* ---------------------------------------------------------------------
   * Game flow actions
   * ------------------------------------------------------------------- */
  App.prototype.startGame = function () {
    this.audio.unlock();
    this.started = true;
    this.runBestBefore = this.saved.bestScore;
    var state = this.session.state;
    if (state === BB.RunState.GAME_OVER || state === BB.RunState.PAUSED) {
      this.session.apply(BB.Intent.RESTART);
      this.runBestBefore = this.saved.bestScore;
    }
    if (this.session.state === BB.RunState.READY) {
      this.session.apply(BB.Intent.PRIMARY);
    }
    this._syncPanels(true);
  };

  App.prototype.restartRun = function (autoLaunch) {
    this.audio.unlock();
    this.started = true;
    this.runBestBefore = this.saved.bestScore;
    this.session.apply(BB.Intent.RESTART);
    if (autoLaunch && this.session.state === BB.RunState.READY) {
      this.session.apply(BB.Intent.PRIMARY);
    }
    this._syncPanels(true);
  };

  App.prototype.goMenu = function () {
    this.started = false;
    this.session.apply(BB.Intent.RESTART);
    this._syncPanels(true);
    this._syncHud(true);
  };

  App.prototype.togglePause = function () {
    if (this.session.state === BB.RunState.PLAYING || this.session.state === BB.RunState.PAUSED) {
      this.session.apply(BB.Intent.TOGGLE_PAUSE);
      this._syncPanels(true);
    }
  };

  App.prototype.handleIntent = function (intent) {
    if (this.settingsOpen &&
        (intent === BB.Intent.PRIMARY || intent === BB.Intent.RESTART || intent === BB.Intent.TOGGLE_PAUSE)) {
      return;
    }
    switch (intent) {
      case BB.Intent.TOGGLE_FULLSCREEN:
        this.toggleFullscreen();
        return;
      case BB.Intent.QUIT:
        this.goMenu();
        return;
      default:
        break;
    }
    if (intent === BB.Intent.RESTART) {
      this.started = true;
      this.runBestBefore = this.saved.bestScore;
    }
    this.session.apply(intent);
    this.audio.unlock();
    this._syncPanels();
  };

  App.prototype.handlePointerDown = function (x) {
    if (this.settingsOpen) return;
    var state = this.session.state;
    if (state === BB.RunState.READY) {
      this.startGame();
      return;
    }
    if (state === BB.RunState.PLAYING) {
      this.session.setMoveAxis(0);
      if (typeof this.session.setPointerTarget === 'function') this.session.setPointerTarget(x);
    }
  };

  App.prototype.handlePointerMove = function (x) {
    if (this.settingsOpen || !this.started) return;
    var state = this.session.state;
    if (state === BB.RunState.PLAYING || state === BB.RunState.READY || state === BB.RunState.LEVEL_CLEAR) {
      if (typeof this.session.setPointerTarget === 'function') {
        this.session.setPointerTarget(x);
      }
    }
  };

  App.prototype.handlePointerUp = function () {
    // Let at least one simulation frame consume the last drag position before
    // releasing the target: quick tap-drags can otherwise start and end inside
    // a single animation frame and the paddle would never move.
    var session = this.session;
    requestAnimationFrame(function () {
      if (typeof session.setPointerTarget === 'function') session.setPointerTarget(null);
    });
  };

  App.prototype.handleEscape = function () {
    if (this.settingsOpen) {
      this.closeSettings();
      return;
    }
    if (this.session.state === BB.RunState.PLAYING || this.session.state === BB.RunState.PAUSED) {
      this.togglePause();
    } else if (this.session.state === BB.RunState.GAME_OVER) {
      this.goMenu();
    }
  };

  App.prototype.handleMenuRequest = function () {
    if (this.settingsOpen) {
      this.closeSettings();
      return;
    }
    if (this.session.state === BB.RunState.GAME_OVER || this.session.state === BB.RunState.PAUSED) {
      this.goMenu();
    }
  };

  App.prototype.handleFocusLost = function () {
    if (!this.settingsOpen && this.session.state === BB.RunState.PLAYING) {
      this.session.apply(BB.Intent.FOCUS_LOST);
      this._syncPanels(true);
    }
  };

  App.prototype.openSettings = function () {
    if (this.settingsOpen) return;
    this.audio.unlock();
    this.settingsOpen = true;
    this.resumeAfterSettings = this.session.state === BB.RunState.PLAYING;
    if (this.resumeAfterSettings) this.session.apply(BB.Intent.TOGGLE_PAUSE);
    this.dom.settingsOverlay.hidden = false;
    this._syncToggles();
    this._syncInstrumentCards();
    this._syncPanels(true);
  };

  App.prototype.closeSettings = function () {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    this.dom.settingsOverlay.hidden = true;
    if (this.resumeAfterSettings && this.session.state === BB.RunState.PAUSED) {
      this.session.apply(BB.Intent.TOGGLE_PAUSE);
    }
    this.resumeAfterSettings = false;
    this._syncPanels(true);
  };

  App.prototype.toggleFullscreen = function () {
    var doc = document;
    var root = doc.documentElement;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      return;
    }
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (request) {
      var result = request.call(root);
      if (result && typeof result.catch === 'function') result.catch(function () { /* denied */ });
    }
  };

  /* ---------------------------------------------------------------------
   * HUD / panels sync
   * ------------------------------------------------------------------- */
  App.prototype._comboMultiplier = function () {
    if (typeof this.session.comboMultiplier === 'number') return this.session.comboMultiplier;
    var combo = this.session.stats ? this.session.stats.combo : 0;
    return Math.min(config.COMBO_MAX, 1 + Math.floor(combo / config.COMBO_STEP));
  };

  App.prototype._syncHud = function (force) {
    var stats = this.session.stats;
    if (!stats) return;
    var best = Math.max(this.saved.bestScore, stats.record.bestScore, stats.score);
    var multiplier = this._comboMultiplier();
    var instrument = this.audio.instrumentLabel();
    var muted = this.audio.muted;
    var cache = this._hudCache || (this._hudCache = {});

    if (force || cache.score !== stats.score) {
      this.dom.hudScore.textContent = String(stats.score);
      cache.score = stats.score;
    }
    if (force || cache.best !== best) {
      this.dom.hudBest.textContent = String(best);
      cache.best = best;
    }
    if (force || cache.level !== stats.level) {
      this.dom.hudLevel.textContent = String(stats.level);
      cache.level = stats.level;
    }
    if (force || cache.lives !== stats.lives) {
      var holder = this.dom.hudLives;
      holder.innerHTML = '';
      var total = Math.max(config.STARTING_LIVES, stats.lives, this._maxLivesSeen || 0);
      this._maxLivesSeen = Math.max(total, stats.lives);
      for (var i = 0; i < total; i += 1) {
        var dot = document.createElement('span');
        dot.className = 'life-dot' + (i >= stats.lives ? ' is-lost' : '');
        holder.appendChild(dot);
      }
      holder.setAttribute('aria-label', stats.lives + ' lives');
      cache.lives = stats.lives;
    }
    if (force || cache.instrument !== instrument || cache.muted !== muted) {
      var label = instrument + (muted ? ' · MUTED' : '');
      if (this.dom.chipSoundText) this.dom.chipSoundText.textContent = label;
      if (this.dom.chipSound) this.dom.chipSound.classList.toggle('is-muted', muted);
      if (this.dom.btnMute) {
        this.dom.btnMute.classList.toggle('is-off', muted);
        this.dom.btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      }
      cache.instrument = instrument;
      cache.muted = muted;
    }
    if (force || cache.multiplier !== multiplier) {
      var live = multiplier > 1;
      this.dom.chipCombo.classList.toggle('is-live', live);
      this.dom.chipCombo.classList.toggle('hot', multiplier >= 4);
      if (this.dom.chipComboValue) this.dom.chipComboValue.textContent = String(multiplier);
      cache.multiplier = multiplier;
    }
  };

  App.prototype._syncToggles = function () {
    if (this.dom.btnSoundToggle) {
      this.dom.btnSoundToggle.setAttribute('aria-checked', this.audio.muted ? 'false' : 'true');
    }
    if (this.dom.btnFxToggle) {
      this.dom.btnFxToggle.setAttribute('aria-checked', this.renderer.fxEnabled ? 'true' : 'false');
    }
    if (this.dom.settingsBestCombo) {
      var bestCombo = Math.max(this.saved.bestCombo, this.session.stats.record.bestCombo,
        this.session.stats.bestCombo, 0);
      this.dom.settingsBestCombo.textContent = '×' + Math.max(1, bestCombo);
    }
    if (this.dom.titleBest) this.dom.titleBest.textContent = String(this.saved.bestScore);
    if (this.dom.titleBestCombo) this.dom.titleBestCombo.textContent = '×' + Math.max(1, this.saved.bestCombo);
    if (this.dom.titleInstrument) this.dom.titleInstrument.textContent = this.audio.instrumentLabel();
  };

  App.prototype._syncPanels = function (force) {
    var session = this.session;
    var state = session.state;
    var panel = null;

    if (this.settingsOpen) {
      panel = null;
    } else if (state === BB.RunState.READY) {
      panel = (this.started || !session.freshRun) ? 'ready' : 'title';
    } else if (state === BB.RunState.PAUSED) {
      panel = 'pause';
    } else if (state === BB.RunState.LEVEL_CLEAR) {
      panel = 'level';
    } else if (state === BB.RunState.GAME_OVER) {
      panel = 'over';
    }

    if (!force && panel === this._currentPanel) return;
    this._currentPanel = panel;

    this.dom.overlay.hidden = !panel;
    var panels = {
      title: this.dom.panelTitle,
      ready: this.dom.panelReady,
      pause: this.dom.panelPause,
      level: this.dom.panelLevel,
      over: this.dom.panelOver
    };
    for (var key in panels) {
      if (!Object.prototype.hasOwnProperty.call(panels, key)) continue;
      if (panels[key]) panels[key].hidden = key !== panel;
    }

    if (panel === 'title') this._fillTitle();
    if (panel === 'ready') this._fillReady();
    if (panel === 'level') this._fillLevel();
    if (panel === 'over') this._fillOver();
    this._syncToggles();
  };

  App.prototype._fillTitle = function () {
    if (this.dom.titleBest) this.dom.titleBest.textContent = String(this.saved.bestScore);
    if (this.dom.titleBestCombo) this.dom.titleBestCombo.textContent = '×' + Math.max(1, this.saved.bestCombo);
    if (this.dom.titleInstrument) this.dom.titleInstrument.textContent = this.audio.instrumentLabel();
  };

  App.prototype._fillReady = function () {
    if (this.dom.readyLives) {
      this.dom.readyLives.textContent = 'LIVES ' + this.session.stats.lives + ' · TAP OR PRESS SPACE';
    }
  };

  App.prototype._fillLevel = function () {
    var level = this.session.stats.level;
    if (this.dom.levelTitle) this.dom.levelTitle.textContent = 'LEVEL ' + level + ' CLEARED';
    if (this.dom.levelBonus) {
      this.dom.levelBonus.textContent = '+' + (config.LEVEL_BONUS_BASE * level);
    }
  };

  App.prototype._fillOver = function () {
    var stats = this.session.stats;
    var best = Math.max(this.saved.bestScore, stats.record.bestScore, stats.score);
    if (this.dom.overScore) this.dom.overScore.textContent = String(stats.score);
    if (this.dom.overBest) this.dom.overBest.textContent = String(best);
    if (this.dom.overLevel) this.dom.overLevel.textContent = String(stats.level);
    if (this.dom.overCombo) this.dom.overCombo.textContent = '×' + Math.max(1, stats.bestCombo);
    if (this.dom.newRecord) {
      this.dom.newRecord.hidden = !(stats.score > this.runBestBefore && stats.score > 0);
    }
    this._syncToggles();
  };

  /* ---------------------------------------------------------------------
   * Main loop
   * ------------------------------------------------------------------- */
  App.prototype.frame = function (time) {
    var self = this;
    this.handle = requestAnimationFrame(function (next) { self.frame(next); });

    if (!this.lastTime) this.lastTime = time;
    var dt = (time - this.lastTime) / 1000;
    this.lastTime = time;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, config.MAX_FRAME_TIME);

    var state = this.session.state;
    var wasOver = this._wasOver;
    this.session.setMoveAxis(this.input.getAxis());
    this.accumulator = Math.min(this.accumulator + dt, config.MAX_FRAME_TIME);
    var steps = 0;
    while (this.accumulator >= config.PHYSICS_STEP && steps < 12) {
      this.session.update(config.PHYSICS_STEP);
      this.accumulator -= config.PHYSICS_STEP;
      steps += 1;
      if (this.session.state === BB.RunState.GAME_OVER) break;
    }

    this.renderer.sync(this.session, dt);
    this.renderer.draw(this.session);
    this._syncHud();
    this._syncPanels();
    this.frameCount += 1;

    if (this.session.state === BB.RunState.GAME_OVER && !wasOver) {
      this._saveRecords();
      this._fillOver();
    }
    this._wasOver = this.session.state === BB.RunState.GAME_OVER;
    this._gameOverAt = this._wasOver ? (this._gameOverAt || time) : 0;
    if (state === BB.RunState.GAME_OVER && this._gameOverAt && time - this._gameOverAt > 1200) {
      // keep overlay stable; nothing else needed
    }
  };

  /* ---------------------------------------------------------------------
   * Demo fixtures for screenshot / E2E tests: index.html?demo=combo5
   * ------------------------------------------------------------------- */
  App.prototype._applyUrlDemo = function () {
    var params = new URLSearchParams(global.location.search || '');
    var mode = params.get('demo');
    if (!mode) return;
    this.startDemo(mode);
  };

  App.prototype.startDemo = function (mode) {
    this.demoMode = mode;
    this.started = true;
    var self = this;
    var session = this.session;
    this._demoMultiplier = 1;

    if (mode === 'playing' || mode === 'combo' || mode === 'combo5') {
      session.apply(BB.Intent.PRIMARY);
      if (mode === 'combo' || mode === 'combo5') {
        var multiplier = mode === 'combo5' ? config.COMBO_MAX : 3;
        this._demoMultiplier = multiplier;
        session.stats.combo = (multiplier - 1) * config.COMBO_STEP + 2;
        session.stats.score = 640 * multiplier;
        session.stats.level = mode === 'combo5' ? 5 : 3;
        session.stats.lives = 2;
        session.stats.bestCombo = (multiplier - 1) * config.COMBO_STEP;
        for (var i = 0; i < session.bricks.length; i += 1) {
          var brick = session.bricks[i];
          if (i % 3 === 0) {
            brick.state = BB.BrickState.GONE;
          } else if (i % 7 === 0) {
            brick.state = BB.BrickState.CRACKED;
            brick.hp = 1;
          }
        }
        session.bricksLeft = session.bricks.filter(function (item) {
          return item.state !== BB.BrickState.GONE;
        }).length;
        this.renderer.beat = 1;
        this.renderer.comboGlow = 1;
        this.renderer._lastMultiplier = multiplier;
        this._spawnDemoPopups(multiplier);
        this.demoTimer = setInterval(function () {
          self._spawnDemoPopups(self._demoMultiplier);
        }, 420);
      }
    } else if (mode === 'gameover') {
      session.stats.score = 4820;
      session.stats.level = 6;
      session.stats.bestCombo = 16;
      session.stats.lives = 0;
      session.stats.record.bestScore = 4820;
      if (typeof session.gameOver === 'function') session.gameOver();
      else session.state = BB.RunState.GAME_OVER;
      this.runBestBefore = 1200;
    } else if (mode === 'paused') {
      session.apply(BB.Intent.PRIMARY);
      session.apply(BB.Intent.TOGGLE_PAUSE);
    } else if (mode === 'ready') {
      session.prepareBall();
    } else if (mode === 'settings') {
      this.openSettings();
    } else if (mode === 'title') {
      this.started = false;
    }

    this._syncPanels(true);
    this._syncHud(true);
  };

  App.prototype._spawnDemoPopups = function (multiplier) {
    if (!this.session || !this.session.popups) return;
    var bricks = this.session.bricks || [];
    var candidates = bricks.filter(function (brick) { return brick.state !== BB.BrickState.GONE; });
    if (!candidates.length) return;
    var brick = candidates[Math.floor(Math.random() * candidates.length)];
    var points = Math.round((40 + Math.random() * 120) / 5) * 5;
    var hue = 180 + Math.random() * 160 + multiplier * 12;
    var popup = new BB.Popup(
      brick.rect.x + brick.rect.w * 0.5,
      brick.rect.y + brick.rect.h * 0.4,
      '+' + points,
      hue % 360
    );
    this.session.popups.push(popup);
    if (this.session.popups.length > 12) this.session.popups.shift();
  };

  /* ---------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------- */
  function boot() {
    try {
      var app = new App();
      global.__bb = {
        app: app,
        session: app.session,
        audio: app.audio,
        renderer: app.renderer,
        storage: app.storage,
        startDemo: function (mode) { app.startDemo(mode); }
      };
      global.__bb.ready = true;
    } catch (error) {
      global.__bb = global.__bb || {};
      global.__bb.error = String(error && error.stack ? error.stack : error);
      var node = document.getElementById('panelTitle');
      if (node) {
        node.hidden = false;
        node.innerHTML = '<h2 class="panel-title">启动失败</h2><p class="hint" style="white-space:pre-wrap">' +
          String(error && error.message ? error.message : error) + '</p>';
      }
      throw error;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
