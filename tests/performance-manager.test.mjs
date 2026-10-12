import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceManager, classifySpeechRtf, selectSpeechCandidate } from '../assets/performance-manager.mjs';
import { nextAudioStart, audioBufferAhead } from '../assets/audio-scheduler.mjs';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

test('audio chunks schedule after the prior end without waiting for playback callbacks', () => {
  assert.equal(nextAudioStart(10, 12, 0.06), 12);
  assert.equal(nextAudioStart(10, 0, 0.06), 10.06);
  assert.equal(audioBufferAhead(12.5, 10), 2.5);
});

test('Auto chooses a sustainable candidate instead of faster-than-playback failure', () => {
  const picked = selectSpeechCandidate([
    { engine: 'kokoro', backend: 'webgpu', dtype: 'fp32', rtf: 1.21 },
    { engine: 'kokoro', backend: 'wasm', dtype: 'q8', rtf: 1.04 },
    { engine: 'system', rtf: 0 },
  ]);
  assert.equal(picked.engine, 'system');
  assert.equal(selectSpeechCandidate([
    { engine: 'kokoro', backend: 'webgpu', dtype: 'fp32', rtf: 0.4, valid: false },
    { engine: 'system', rtf: 0 },
  ]).engine, 'system');
  assert.equal(classifySpeechRtf(0.72), 'high');
  assert.equal(classifySpeechRtf(1.2), 'low');
});

test('old benchmark schemas are discarded', () => {
  const storage = memoryStorage();
  storage.setItem('lantern.performance.v1', JSON.stringify({ schema: 1, preset: 'auto', benchmarks: { broken: true } }));
  const manager = new PerformanceManager({ storage });
  assert.equal(manager.state.schema, 2);
  assert.deepEqual(manager.state.benchmarks, {});
});

test('preset updates are persisted, restored, and advanced changes activate Custom', () => {
  const storage = memoryStorage();
  const manager = new PerformanceManager({ storage });
  manager.setPreset('high');
  assert.equal(manager.state.graphics.quality, 'high');
  manager.setAdvanced('graphics', 'dprCap', 1.1);
  assert.equal(manager.state.preset, 'custom');
  manager.recordBenchmark('kokoro:webgpu:fp16', { rtf: 0.72, ttfaMs: 460 });

  const restored = new PerformanceManager({ storage });
  assert.equal(restored.state.preset, 'custom');
  assert.equal(restored.state.graphics.dprCap, 1.1);
  assert.equal(restored.state.benchmarks['kokoro:webgpu:fp16'].rtf, 0.72);
});

test('Auto degrades once after repeated underruns and observes a cooldown', () => {
  const manager = new PerformanceManager({ storage: memoryStorage() });
  manager.setAutoRecommendations({ speech: 'high', candidate: { engine: 'kokoro', rtf: 0.7 } });
  assert.equal(manager.recordUnderrun(100000), null);
  assert.equal(manager.recordUnderrun(100001), null);
  assert.equal(manager.recordUnderrun(100002), 'medium');
  assert.equal(manager.recordUnderrun(100003), null);
  assert.equal(manager.state.speech.quality, 'medium');
  assert.equal(manager.state.speech.engine, 'system');
});
