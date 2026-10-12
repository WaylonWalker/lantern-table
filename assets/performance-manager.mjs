const PRESETS = ['auto', 'low', 'medium', 'high', 'ultra', 'custom'];
const TIERS = ['low', 'medium', 'high', 'ultra'];
const CACHE_VERSION = 2;

const PROFILES = {
  low: { graphics: 'low', speech: 'low', ai: 'low', dprCap: 1, particles: 0.35, targetBufferSeconds: 2, maxPassageLength: 240 },
  medium: { graphics: 'medium', speech: 'medium', ai: 'medium', dprCap: 1.25, particles: 0.6, targetBufferSeconds: 1.2, maxPassageLength: 280 },
  high: { graphics: 'high', speech: 'high', ai: 'high', dprCap: 1.5, particles: 0.85, targetBufferSeconds: 0.7, maxPassageLength: 320 },
  ultra: { graphics: 'ultra', speech: 'ultra', ai: 'high', dprCap: 2, particles: 1, targetBufferSeconds: 0.45, maxPassageLength: 320 },
};

export function classifySpeechRtf(rtf) {
  if (!Number.isFinite(rtf) || rtf >= 1) return 'low';
  if (rtf < 0.55) return 'ultra';
  if (rtf <= 0.85) return 'high';
  return 'medium';
}

export function selectSpeechCandidate(candidates = []) {
  const viable = candidates.filter(item => item.valid !== false && Number.isFinite(item.rtf) && item.rtf < 1)
    .sort((a, b) => a.rtf - b.rtf);
  return viable[0] || candidates.find(item => item.engine === 'system') || null;
}

export function chooseTargetBuffer(rtf, requestedTier = 'medium') {
  const tier = TIERS.includes(requestedTier) ? requestedTier : 'medium';
  const base = { low: 2.4, medium: 1.2, high: 0.7, ultra: 0.45 }[tier];
  return Math.max(base, Number.isFinite(rtf) && rtf > 0.7 ? Math.min(3, rtf * 1.5) : base);
}

export class PerformanceManager {
  constructor({ storage = globalThis.localStorage, key = 'lantern.performance.v1' } = {}) {
    this.storage = storage;
    this.key = key;
    this.state = this.restore();
    this.listeners = new Set();
  }

  restore() {
    try {
      const saved = JSON.parse(this.storage?.getItem(this.key) || 'null');
      if (saved?.schema === CACHE_VERSION && PRESETS.includes(saved.preset)) return saved;
    } catch {}
    return { schema: CACHE_VERSION, preset: 'auto', detected: { graphics: 'medium', speech: 'medium', ai: 'medium' },
      graphics: { ...PROFILES.medium }, speech: { quality: 'medium', engine: 'kokoro', backend: 'auto', dtype: 'fp32', ...PROFILES.medium },
      ai: { quality: 'medium', model: 'auto', reasoning: 'medium' }, benchmarks: {}, runtime: { underruns: 0, downgradeAt: 0 } };
  }

  persist() { try { this.storage?.setItem(this.key, JSON.stringify(this.state)); } catch {} }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { this.persist(); for (const listener of this.listeners) listener(this.state); }

  setPreset(preset) {
    if (!PRESETS.includes(preset)) return;
    this.state.preset = preset;
    if (preset !== 'custom' && preset !== 'auto') this.applyProfile(PROFILES[preset]);
    this.emit();
  }

  applyProfile(profile) {
    this.state.graphics = { ...this.state.graphics, quality: profile.graphics, dprCap: profile.dprCap, particles: profile.particles };
    this.state.speech = { ...this.state.speech, quality: profile.speech, targetBufferSeconds: profile.targetBufferSeconds, maxPassageLength: profile.maxPassageLength };
    this.state.ai = { ...this.state.ai, quality: profile.ai };
  }

  setAutoRecommendations({ graphics, speech, ai, candidate } = {}) {
    if (this.state.preset !== 'auto') return;
    const detected = this.state.detected;
    if (TIERS.includes(graphics)) detected.graphics = graphics;
    if (TIERS.includes(speech)) detected.speech = speech;
    if (TIERS.includes(ai)) detected.ai = ai;
    this.applyProfile({ ...PROFILES.medium, graphics: detected.graphics, speech: detected.speech,
      dprCap: ({ low: 1, medium: 1.25, high: 1.5, ultra: 2 })[detected.graphics],
      particles: ({ low: 0.35, medium: 0.6, high: 0.85, ultra: 1 })[detected.graphics],
      targetBufferSeconds: chooseTargetBuffer(candidate?.rtf, detected.speech) });
    this.state.detected = detected;
    if (candidate) Object.assign(this.state.speech, { engine: candidate.engine, backend: candidate.backend || 'auto', dtype: candidate.dtype || '' });
    this.emit();
  }

  setSpeechCandidate(candidate, quality = this.state.speech.quality) {
    this.state.speech = { ...this.state.speech, engine: candidate?.engine || 'system',
      backend: candidate?.backend || 'browser', dtype: candidate?.dtype || '', quality };
    this.state.detected.speech = quality;
    this.emit();
  }

  setAdvanced(section, key, value) {
    if (this.state[section]) this.state[section][key] = value;
    this.state.preset = 'custom';
    this.emit();
  }

  recordBenchmark(id, result) {
    this.state.benchmarks[id] = { ...result, recordedAt: Date.now() };
    this.emit();
  }

  recordUnderrun(now = Date.now()) {
    const runtime = this.state.runtime;
    runtime.underruns++;
    if (runtime.underruns >= 3 && now - runtime.downgradeAt > 60000) {
      const tier = this.state.speech.quality;
      const lower = TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];
      if (this.state.preset === 'auto' && lower !== tier) {
        this.state.detected.speech = lower;
        this.state.speech.quality = lower;
        this.state.speech.targetBufferSeconds = Math.max(this.state.speech.targetBufferSeconds || 0, 1.5);
        this.state.speech.engine = 'system';
        this.state.speech.backend = 'browser';
        runtime.downgradeAt = now;
        runtime.underruns = 0;
        this.emit();
        return lower;
      }
    }
    this.persist();
    return null;
  }
}
