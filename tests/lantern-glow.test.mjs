import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const css = await readFile(new URL('../assets/app.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../assets/app.js', import.meta.url), 'utf8');

test('lantern glow covers the viewport without expanding the pointer coordinate space', () => {
  const glowRule = css.match(/\.lantern-glow\{([^}]*)\}/)?.[1];
  const lightRule = css.match(/:root\[data-theme-variant="light"\] \.lantern-glow\{([^}]*)\}/)?.[1];
  assert.ok(glowRule, 'base lantern glow rule exists');
  assert.ok(lightRule, 'light-mode lantern glow rule exists');
  assert.match(glowRule, /position:fixed;inset:0;/);
  for (const rule of [glowRule, lightRule]) {
    assert.match(rule, /radial-gradient\(circle at var\(--glow-x,50%\) var\(--glow-y,50%\)/);
  }
});

function setupPointerHandler() {
  // Execute only the actual pointer handler with a mocked browser environment.
  const source = app.match(/let glowPointerRaf=0,[\s\S]*?\},\{passive:true\}\);/)?.[0];
  assert.ok(source, 'lantern pointer handler exists');
  const styles = new Map();
  const pendingFrames = [];
  const effects = new Set(['lantern']);
  let pointerMove;
  runInNewContext(source, {
    activeEffects: effects,
    document: { documentElement: { style: { setProperty(key, value) { styles.set(key, value); } } } },
    requestAnimationFrame(callback) {
      pendingFrames.push(callback);
      return pendingFrames.length;
    },
    addEventListener(event, callback, options) {
      assert.equal(event, 'pointermove');
      assert.equal(options.passive, true);
      pointerMove = callback;
    },
  });
  assert.equal(typeof pointerMove, 'function');
  return { pointerMove, pendingFrames, styles, effects };
}

test('lantern follows pointer exactly at all viewport edges and center', () => {
  const { pointerMove, pendingFrames, styles } = setupPointerHandler();
  for (const [x, y] of [[0, 450], [1600, 450], [800, 0], [800, 900], [800, 450]]) {
    pointerMove({ clientX: x, clientY: y });
    assert.equal(pendingFrames.length, 1);
    pendingFrames.shift()();
    assert.equal(styles.get('--glow-x'), `${x}px`);
    assert.equal(styles.get('--glow-y'), `${y}px`);
  }
});

test('multiple pointer events in one frame use the latest event', () => {
  const { pointerMove, pendingFrames, styles, effects } = setupPointerHandler();
  pointerMove({ clientX: 100, clientY: 200 });
  pointerMove({ clientX: 700, clientY: 500 });
  assert.equal(pendingFrames.length, 1, 'one animation frame is queued');
  pendingFrames.shift()();
  assert.equal(styles.get('--glow-x'), '700px');
  assert.equal(styles.get('--glow-y'), '500px');

  effects.delete('lantern');
  pointerMove({ clientX: 900, clientY: 800 });
  assert.equal(pendingFrames.length, 0, 'inactive lantern does not schedule updates');
});
