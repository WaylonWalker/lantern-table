export const SESSION_STATUSES = ['planned', 'live', 'paused', 'ended', 'archived'];

export function migrateGameSessions(state, now = new Date().toISOString()) {
  state.gameSessions = Array.isArray(state.gameSessions) ? state.gameSessions : [];
  for (const event of state.timeline || []) {
    if (!event.gameSessionId) event.gameSessionId = state.gameSessions.find(s => s.sessionNumber === event.session)?.id || null;
  }
  for (const message of state.messages || []) {
    if (!message.gameSessionId) message.gameSessionId = state.gameSessions.find(s => s.sessionNumber === (message.sessionNumber || state.campaign.session))?.id || null;
  }
  if (!state.gameSessions.length && (state.campaign.started || state.messages?.length || (state.timeline || []).some(event => event.type !== 'campaign'))) {
    const sessionNumber = Math.max(1, Number(state.campaign.session) || 1);
    const id = `gamesession_imported_${state.campaign.id}`;
    state.gameSessions.push({ id, sessionNumber, sessionType: 'play', title: `Session ${sessionNumber}`, status: 'live', createdAt: now, startedAt: now, participants: [], summary: null, imported: true });
    for (const event of state.timeline || []) if (!event.gameSessionId && Number(event.session || 1) === sessionNumber) event.gameSessionId = id;
    for (const message of state.messages || []) if (!message.gameSessionId) message.gameSessionId = id;
    state.currentGameSessionId = id;
  }
  state.currentGameSessionId ||= state.gameSessions.find(s => ['live', 'paused'].includes(s.status))?.id || null;
  return state;
}

export function createGameSession(state, { sessionType = 'play', title, now = new Date().toISOString(), createdBy = null } = {}) {
  if (!['host', 'solo'].includes(state.multiplayer?.role || 'solo')) return { ok: false, reason: 'Only the host can create a session.' };
  sessionType = sessionType === 'session_zero' ? 'session_zero' : 'play';
  if (state.gameSessions.some(s => ['live', 'paused'].includes(s.status))) return { ok: false, reason: 'Resume or end the current session first.' };
  const sessionNumber = sessionType === 'session_zero' ? 0 : Math.max(0, ...state.gameSessions.filter(s => s.sessionType === 'play').map(s => Number(s.sessionNumber) || 0)) + 1;
  const id = `gamesession_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const item = { id, sessionNumber, sessionType, title: title?.trim() || (sessionType === 'session_zero' ? 'Session Zero' : `Session ${sessionNumber}`), status: 'live', createdAt: now, startedAt: now, endedAt: null, createdBy, participants: state.characters.map(c => ({ userId: c.ownerPlayerId || null, characterId: c.id, attendance: 'expected' })), summary: null, setup: sessionType === 'session_zero' ? { premise: state.campaign.description || '', playStyle: state.campaign.preset || '', difficulty: state.campaign.settings?.difficulty || '', dmStyle: state.campaign.settings?.dmStyle || '', characterCreationOptions: state.campaign.settings?.characterCreation || '', houseRules: state.campaign.settings?.houseRules || [], safetyExpectations: '', partyRelationships: '', startingLevel: Math.max(1, ...state.characters.map(c => Number(c.level) || 1)), startingLocation: state.scene?.location || '' } : null, startState: { sceneId: state.scene?.id || null, location: state.scene?.location || null, timelineEventId: state.timeline?.at(-1)?.id || null } };
  state.gameSessions.push(item); state.currentGameSessionId = id; state.campaign.session = sessionNumber;
  return { ok: true, session: item };
}

export function transitionGameSession(state, action, { now = new Date().toISOString(), recap = '' } = {}) {
  if (!['host', 'solo'].includes(state.multiplayer?.role || 'solo')) return { ok: false, reason: 'Only the host can change session lifecycle.' };
  const item = state.gameSessions.find(s => s.id === state.currentGameSessionId);
  if (!item) return { ok: false, reason: 'There is no current session.' };
  const transitions = { pause: { from: ['live'], to: 'paused' }, resume: { from: ['paused'], to: 'live' }, end: { from: ['live', 'paused'], to: 'ended' }, archive: { from: ['ended'], to: 'archived' } };
  const next = transitions[action];
  if (!next || !next.from.includes(item.status)) return { ok: false, reason: `Cannot ${action} a ${item.status} session.` };
  item.status = next.to; item.updatedAt = now;
  if (action === 'end') {
    item.endedAt = now;
    const events = (state.timeline || []).filter(e => e.gameSessionId === item.id);
    item.summary ||= { recap: '', keyEvents: events.slice(-12).map(e => e.summary), unresolvedThreads: [], rewards: [], notableNpcs: [], notableLocations: [], rulesNotes: [], nextSessionHooks: [] };
    item.summary.keyEvents ||= events.slice(-12).map(e => e.summary);
    item.summary.recap = recap.trim() || item.summary.recap || (item.summary.keyEvents.length ? item.summary.keyEvents.join(' ') : `${item.title} ended at ${state.scene?.location || 'the last known location'}.`);
    item.endState = { sceneId: state.scene?.id || null, location: state.scene?.location || null, timelineEventId: state.timeline?.at(-1)?.id || null };
    state.currentGameSessionId = null;
  }
  if (action === 'archive') state.currentGameSessionId = null;
  return { ok: true, session: item };
}

export function canManageGameSessions(role) { return role !== 'player'; }
