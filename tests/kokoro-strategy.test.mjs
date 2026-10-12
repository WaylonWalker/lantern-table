import test from 'node:test';
import assert from 'node:assert/strict';
import { kokoroLoadPlan } from '../assets/kokoro-strategy.mjs';

test('automatic mode selects full precision WebGPU first, then q8 WASM fallback', () => {
  assert.deepEqual(kokoroLoadPlan('auto', true), [
    { device: 'webgpu', dtype: 'fp32' },
    { device: 'wasm', dtype: 'q8' },
  ]);
});

test('automatic mode uses q8 WASM when WebGPU is unavailable', () => {
  assert.deepEqual(kokoroLoadPlan('auto', false), [{ device: 'wasm', dtype: 'q8' }]);
});

test('WASM preference avoids requesting a GPU model', () => {
  assert.deepEqual(kokoroLoadPlan('wasm', true), [{ device: 'wasm', dtype: 'q8' }]);
});

test('WebGPU preference retains the WASM compatibility fallback', () => {
  assert.deepEqual(kokoroLoadPlan('webgpu', true), [
    { device: 'webgpu', dtype: 'fp32' },
    { device: 'wasm', dtype: 'q8' },
  ]);
});

test('WebGPU fp32 does not require shader-f16 support', () => {
  assert.deepEqual(kokoroLoadPlan('auto', true), [
    { device: 'webgpu', dtype: 'fp32' },
    { device: 'wasm', dtype: 'q8' },
  ]);
});

test('invalid stored preferences safely return to automatic mode', () => {
  assert.deepEqual(kokoroLoadPlan('remote-url', false), [{ device: 'wasm', dtype: 'q8' }]);
});
