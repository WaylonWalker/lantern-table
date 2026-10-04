export const AUDIO_CHANNELS = new Set(['sfx', 'ambience', 'music']);
export const AUDIO_ACTIONS = new Set(['play_sfx', 'set_ambience', 'set_music', 'stop_ambience', 'stop_music']);

export function validateAudioAction(action, catalog) {
  if (!action || typeof action !== 'object' || !AUDIO_ACTIONS.has(action.action)) return null;
  if (!['play_sfx', 'stop_ambience', 'stop_music'].includes(action.action)) {
    const channel = action.action === 'set_ambience' ? 'ambience' : 'music';
    const cue = catalog?.find(item => item.id === action.cue_id && item.channel === channel);
    return cue ? { action: action.action, cueId: cue.id, channel } : null;
  }
  if (action.action === 'play_sfx') {
    const cue = catalog?.find(item => item.id === action.cue_id && item.channel === 'sfx');
    return cue ? { action: action.action, cueId: cue.id, channel: 'sfx' } : null;
  }
  return { action: action.action, cueId: null, channel: action.action === 'stop_music' ? 'music' : 'ambience' };
}

export function isSafeCatalogPath(file) {
  return typeof file === 'string' && /^\/assets\/audio\/(?:sfx|ambience|music)\/[a-zA-Z0-9._-]+\.(?:ogg|mp3|m4a|webm)$/i.test(file);
}

export function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.sounds)) throw new Error('Audio catalog is missing sounds');
  const ids = new Set();
  for (const item of catalog.sounds) {
    if (!item.id || ids.has(item.id)) throw new Error(`Duplicate or missing audio ID: ${item.id || '(empty)'}`);
    ids.add(item.id);
    if (!AUDIO_CHANNELS.has(item.channel)) throw new Error(`Invalid channel for ${item.id}`);
    if (!isSafeCatalogPath(item.file)) throw new Error(`Unsafe audio file path for ${item.id}`);
    if (!['CC0-1.0', 'Public Domain'].includes(item.license) || !item.creator || !item.source || !item.sourceAsset) throw new Error(`Missing valid provenance for ${item.id}`);
    if (!/^[a-f0-9]{64}$/i.test(item.sha256 || '')) throw new Error(`Invalid SHA-256 for ${item.id}`);
  }
  return true;
}

export function sanitizeSharedAudioState(state, catalog) {
  const track = channel => {
    const raw = state?.[channel];
    const cueId = typeof raw?.cueId === 'string' && catalog?.some(item => item.id === raw.cueId && item.channel === channel) ? raw.cueId : null;
    return { cueId, fadeMs: Math.max(0, Math.min(8000, Number(raw?.fadeMs) || 900)) };
  };
  return { ambience: track('ambience'), music: track('music') };
}
