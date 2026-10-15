import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

function harness() {
  const handlers = new Map();
  const cached = [];
  const url = 'https://dnd.waylonwalker.com';
  const self = {
    location: { origin: url },
    addEventListener(type, handler) { handlers.set(type, handler); },
  };
  const caches = {
    async open() {
      return { async put(key) { cached.push(key); } };
    },
  };
  runInNewContext(source, {
    self, caches, URL,
    async fetch() { return { ok: true, clone() { return this; } }; },
    Response: { error() { return { ok: false }; } },
  });
  function navigation(path) {
    let handled = false;
    let result = null;
    handlers.get('fetch')({
      request: { method: 'GET', mode: 'navigate', url: url + path },
      respondWith(promise) { handled = true; result = promise; },
    });
    return { handled, result };
  }
  return { navigation, cached };
}

test('installer and download paths bypass the service worker', () => {
  const h = harness();
  for (const path of ['/run', '/run.sh', '/download/bridge.py', '/download/companion.py']) {
    assert.equal(h.navigation(path).handled, false, path);
  }
});

test('only the app root navigation may replace the cached app shell', async () => {
  const h = harness();
  const campaign = h.navigation('/campaign');
  assert.equal(campaign.handled, true);
  await campaign.result;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.cached, []);

  const home = h.navigation('/');
  assert.equal(home.handled, true);
  await home.result;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.cached, ['/']);
});

test('installer fix invalidates the previous app-shell cache', () => {
  assert.match(source, /lantern-table-shell-v2/);
});
