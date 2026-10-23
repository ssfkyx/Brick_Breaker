#!/usr/bin/env node
/*
 * Dev-only browser verification helper for the Brick Breaker web app.
 *
 * Zero dependencies: drives headless Chrome over the DevTools Protocol using
 * Node's built-in WebSocket/fetch (Node 22+).  It is not needed to play the
 * game or run the site; it exists so the maintainer can check layout metrics,
 * console errors, keyboard/touch input, persistence and take screenshots.
 *
 * Usage (from web/):
 *   node tests/browser-check.mjs --url 'file:///.../index.html?demo=playing' \
 *        --width 390 --height 844 --dpr 2 --mobile --screenshot out.png \
 *        --eval 'JSON.stringify({w: innerWidth, ...})'
 *
 * Chrome is located via CHROME_PATH or the usual Windows/Linux install paths.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const KEY_MAP = {
  Space: { key: ' ', code: 'Space', vk: 32 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  KeyP: { key: 'p', code: 'KeyP', vk: 80 },
  KeyM: { key: 'm', code: 'KeyM', vk: 77 },
  KeyT: { key: 't', code: 'KeyT', vk: 84 },
  KeyR: { key: 'r', code: 'KeyR', vk: 82 },
  KeyF: { key: 'f', code: 'KeyF', vk: 70 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome/Edge not found; set CHROME_PATH');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
        const list = this.handlers.get(message.method);
        if (list) for (const fn of list) fn(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  evaluate(expression) {
    return this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    }).then((result) => {
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'evaluate failed');
      }
      return result.result.value;
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromePath = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-chrome-'));
  const port = 9200 + Math.floor(Math.random() * 500);
  const width = Number(args.width || 1280);
  const height = Number(args.height || 800);
  const dpr = Number(args.dpr || 1);
  const mobile = !!args.mobile;
  const url = args.url;
  if (!url) throw new Error('--url is required');

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let list = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      list = await response.json();
      if (list && list.length) break;
    } catch (error) {
      // browser not ready yet
    }
    await sleep(250);
  }
  if (!list || !list.length) {
    chrome.kill();
    throw new Error('Chrome DevTools endpoint did not start');
  }

  const page = list.find((target) => target.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CDP(ws);

  const errors = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', (params) => {
    errors.push({ type: 'exception', text: params.exceptionDetails?.text });
  });
  cdp.on('Log.entryAdded', (params) => {
    if (params.entry && params.entry.level === 'error') {
      errors.push({ type: 'log', text: params.entry.text });
    }
  });
  cdp.on('page.loadEventFired', () => {});
  cdp.on('Page.loadEventFired', () => {});

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile
  });
  if (mobile) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  await cdp.send('Page.navigate', { url });
  await sleep(Number(args.wait || 2200));

  const metrics = await cdp.evaluate(`(() => {
    const stage = document.getElementById('stage');
    const canvas = document.getElementById('game');
    const hud = document.querySelector('.hud');
    const rect = (el) => el ? { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height } : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      stage: rect(stage),
      canvas: rect(canvas),
      canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
      hud: rect(hud),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      ready: !!(window.__bb && window.__bb.ready),
      error: window.__bb ? (window.__bb.error || null) : 'no __bb',
      state: window.__bb ? window.__bb.session.state : null,
      score: window.__bb ? window.__bb.session.stats.score : null,
      comboMultiplier: window.__bb ? window.__bb.session.comboMultiplier : null,
      instrument: window.__bb ? window.__bb.audio.instrument : null,
      audioMuted: window.__bb ? window.__bb.audio.muted : null
    };
  })()`);

  if (args.eval) {
    const extra = await cdp.evaluate(args.eval);
    metrics.eval = extra;
  }

  if (args.screenshot) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(args.screenshot, Buffer.from(shot.data, 'base64'));
  }

  if (args.key) {
    const keys = String(args.key).split(',');
    for (const code of keys) {
      const spec = KEY_MAP[code] || { key: code, code, vk: code.charCodeAt(0) };
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk,
        text: spec.key.length === 1 ? spec.key : undefined
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk
      });
      await sleep(350);
    }
    metrics.afterKeys = await cdp.evaluate(`(() => ({
      state: window.__bb.session.state,
      score: window.__bb.session.stats.score,
      lives: window.__bb.session.stats.lives,
      instrument: window.__bb.audio.instrument,
      hudSound: document.getElementById('chipSoundText') ? document.getElementById('chipSoundText').textContent : null,
      audioState: window.__bb.audio.ctx ? window.__bb.audio.ctx.state : 'no-context'
    }))()`);
    if (args.screenshotAfterKeys) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(args.screenshotAfterKeys, Buffer.from(shot.data, 'base64'));
    }
  }

  if (args.mouse) {
    const [mx, my] = String(args.mouse).split(',').map(Number);
    const before = await cdp.evaluate('window.__bb.session.paddle.centerX');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx + 60, y: my, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx + 60, y: my, button: 'left', clickCount: 1 });
    await sleep(300);
    const after = await cdp.evaluate('window.__bb.session.paddle.centerX');
    metrics.mouse = { before, after, moved: Math.abs(after - before) > 3 };
  }

  if (args.touch) {
    const [tx, ty] = String(args.touch).split(',').map(Number);
    const before = await cdp.evaluate('window.__bb.session.paddle.centerX');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx + 40, y: ty }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    metrics.afterTouch = await cdp.evaluate(`(() => ({ state: window.__bb.session.state, paddleCenterX: window.__bb.session.paddle.centerX }))()`);
    metrics.afterTouch.before = before;
    metrics.afterTouch.moved = Math.abs(metrics.afterTouch.paddleCenterX - before) > 3;
  }

  if (args.reload) {
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(Number(args.wait || 2200));
    metrics.afterReload = await cdp.evaluate(`(() => ({
      state: window.__bb.session.state,
      instrument: window.__bb.audio.instrument,
      hudSound: document.getElementById('chipSoundText') ? document.getElementById('chipSoundText').textContent : null,
      storage: (function () { try { return localStorage.getItem('brick-breaker.web.v1'); } catch (e) { return String(e); } })()
    }))()`);
  }

  metrics.consoleErrors = errors;
  console.log(JSON.stringify(metrics, null, 2));

  try { await cdp.send('Browser.close'); } catch (error) { chrome.kill(); }
  ws.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* ignore */ }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
