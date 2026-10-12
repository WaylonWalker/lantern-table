import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPcm } from '../assets/pcm-validation.mjs';

test('PCM validator accepts finite speech samples and reports amplitude metrics', () => {
  const pcm = inspectPcm(Float32Array.from([0.2, -0.4, 0.1, -0.2]));
  assert.equal(pcm.valid, true);
  assert.equal(pcm.finiteRatio, 1);
  assert.ok(Math.abs(pcm.peak - 0.4) < 1e-6);
  assert.ok(pcm.rms > 0.2 && pcm.rms < 0.3);
});

test('PCM validator rejects silent or empty output', () => {
  assert.equal(inspectPcm(new Float32Array(32)).valid, false);
  assert.equal(inspectPcm(new Float32Array()).valid, false);
});

test('PCM validator rejects corrupt and clipped output', () => {
  assert.equal(inspectPcm(Float32Array.from([0.2, NaN, -0.3, 0.1])).valid, false);
  assert.equal(inspectPcm(Float32Array.from([2.5, -0.2, 0.4])).valid, false);
});
