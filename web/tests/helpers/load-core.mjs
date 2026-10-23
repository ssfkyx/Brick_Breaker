/* Node test helper: run the browser's classic (non-module) scripts headlessly.
 *
 * The web build deliberately has no bundler and no ES modules: every file is a
 * classic <script> that attaches itself to the global `BB` namespace.  Node's
 * vm.runInThisContext() executes exactly those files, in the same order that
 * index.html loads them, against this process's globalThis.  `filename` is
 * passed through so stack traces point at the offending source file.
 *
 * The returned object is the live `globalThis.BB` namespace, so tests exercise
 * the same objects the browser would see.  Call loadCore() again (the default
 * `reset: true`) for a completely fresh namespace.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the `web/` root (the helper lives in web/tests/helpers). */
export const WEB_ROOT = join(HERE, '..', '..');

/** The simulation layer, in the exact order index.html must load it. */
export const CORE_SCRIPTS = Object.freeze([
  'js/00-config.js',
  'js/10-model.js',
  'js/20-rules.js',
  'js/21-levels.js',
  'js/22-physics.js',
  'js/60-session.js'
]);

/**
 * Execute the core scripts and return globalThis.BB.
 * @param {{reset?: boolean, scripts?: string[]}} [options]
 */
export function loadCore(options) {
  const opts = options || {};
  if (opts.reset !== false) {
    delete globalThis.BB;
  }
  const scripts = opts.scripts || CORE_SCRIPTS;
  for (const relativePath of scripts) {
    const filename = join(WEB_ROOT, relativePath);
    const source = readFileSync(filename, 'utf8');
    vm.runInThisContext(source, { filename });
  }
  if (!globalThis.BB) {
    throw new Error('load-core: the classic scripts did not create globalThis.BB');
  }
  return globalThis.BB;
}

/** Reload from scratch; handy for tests that must not see prior state. */
export function freshCore() {
  return loadCore({ reset: true });
}
