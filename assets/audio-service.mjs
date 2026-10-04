import { validateAudioAction } from './audio-core.mjs';

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));

export class TableAudio {
  constructor(catalog, getPreferences, onUnlockNeeded = () => {}) {
    this.catalog = catalog;
    this.getPreferences = getPreferences;
    this.onUnlockNeeded = onUnlockNeeded;
    this.unlocked = false;
    this.pending = [];
    this.sfx = new Set();
    this.preloaded = new Map();
    this.lastCue = new Map();
    this.tracks = { ambience: null, music: null };
    this.audioContext = null;
  }

  async unlock() {
    this.unlocked = true;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context && !this.audioContext) {
      try { this.audioContext = new Context(); } catch {}
    }
    try { await this.audioContext?.resume(); } catch {}
    const pending = this.pending.splice(0);
    for (const item of pending) await this.playCue(item.cueId, item.eventId, true);
    return true;
  }

  gain(channel, cue) {
    const prefs = this.getPreferences() || {};
    if (prefs.muted) return 0;
    return clamp(prefs.master ?? 1) * clamp(prefs[channel] ?? 1) * clamp(cue.defaultGain ?? 1);
  }

  preloadSfx(cueIds) {
    for (const cueId of cueIds || []) {
      const cue = this.catalog.find(item => item.id === cueId && item.channel === 'sfx');
      if (!cue || this.preloaded.has(cue.id)) continue;
      const audio = new Audio(cue.file);
      audio.preload = 'auto';
      audio.volume = this.gain('sfx', cue);
      this.preloaded.set(cue.id, audio);
    }
  }

  async playCue(cueId, eventId = '', fromQueue = false) {
    const cue = this.catalog.find(item => item.id === cueId && item.channel === 'sfx');
    if (!cue) return false;
    if (!this.unlocked) {
      if (!fromQueue && this.pending.length < 4) this.pending.push({ cueId, eventId });
      this.onUnlockNeeded(true);
      return false;
    }
    const key = cue.id;
    const now = Date.now();
    if (now - (this.lastCue.get(key) || 0) < 180 || [...this.lastCue.values()].filter(at => now - at < 5000).length >= 12) return false;
    this.lastCue.set(key, now);
    const element = this.preloaded.get(cue.id)?.cloneNode() || new Audio(cue.file);
    element._lanternCue = cue;
    element.preload = 'auto';
    element.volume = this.gain('sfx', cue);
    this.sfx.add(element);
    while (this.sfx.size > 10) { const oldest = this.sfx.values().next().value; oldest.pause(); this.sfx.delete(oldest); }
    element.onended = () => this.sfx.delete(element);
    try { await element.play(); return true; }
    catch { this.sfx.delete(element); this.unlocked = false; this.onUnlockNeeded(true); return false; }
  }

  async setTrack(channel, cueId, fadeMs = 900) {
    if (!['ambience', 'music'].includes(channel)) return false;
    const cue = cueId ? this.catalog.find(item => item.id === cueId && item.channel === channel) : null;
    if (cueId && !cue) return false;
    const old = this.tracks[channel];
    if (old?.cue?.id === cue?.id) return true;
    if (cue && !this.unlocked) { this.onUnlockNeeded(true); return false; }
    let next = null;
    if (cue) {
      const element = new Audio(cue.file);
      element.loop = true;
      element.preload = 'none';
      element.volume = 0;
      next = { cue, element };
      try { await element.play(); }
      catch { this.unlocked = false; this.onUnlockNeeded(true); return false; }
    }
    this.tracks[channel] = next;
    await this.crossfade(old, next, Math.max(0, Math.min(8000, Number(fadeMs) || 900)));
    return true;
  }

  crossfade(old, next, duration) {
    const start = performance.now();
    const oldStart = old?.element.volume || 0;
    return new Promise(resolve => {
      const step = now => {
        const t = duration ? Math.min(1, (now - start) / duration) : 1;
        if (old) old.element.volume = oldStart * (1 - t);
        if (next) next.element.volume = this.gain(next.cue.channel, next.cue) * t;
        if (t < 1) requestAnimationFrame(step);
        else { if (old) { old.element.pause(); old.element.src = ''; } resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  updateVolumes() {
    for (const item of this.tracks.ambience ? [this.tracks.ambience] : []) item.element.volume = this.gain('ambience', item.cue);
    for (const item of this.tracks.music ? [this.tracks.music] : []) item.element.volume = this.gain('music', item.cue);
    for (const item of this.sfx) {
      const cue = item._lanternCue;
      if (cue) item.volume = this.gain('sfx', cue);
    }
    for (const [id, element] of this.preloaded) {
      const cue = this.catalog.find(entry => entry.id === id);
      if (cue) element.volume = this.gain('sfx', cue);
    }
  }

  async applyAction(raw) {
    const action = validateAudioAction(raw, this.catalog);
    if (!action) return false;
    if (action.channel === 'sfx') return this.playCue(action.cueId, raw.eventId);
    return this.setTrack(action.channel, action.cueId, raw.fadeMs);
  }

  async syncState(shared = {}) {
    for (const channel of ['ambience', 'music']) {
      const cue = shared[channel]?.cueId || null;
      if (cue !== (this.tracks[channel]?.cue.id || null)) await this.setTrack(channel, cue, shared[channel]?.fadeMs ?? 900);
    }
  }

  async stopAll() {
    await Promise.all(['ambience', 'music'].map(channel => this.setTrack(channel, null, 250)));
    for (const element of this.sfx) element.pause();
    this.sfx.clear();
  }
}
