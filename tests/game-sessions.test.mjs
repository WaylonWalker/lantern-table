import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateGameSessions, createGameSession, transitionGameSession } from '../assets/game-sessions.mjs';
import { buildGameSessionContext } from '../assets/game-session-context.mjs';

const campaign = (id, role = 'host') => ({ campaign: { id, session: 1 }, multiplayer: { role }, characters: [{ id: `pc_${id}`, ownerPlayerId: 'player' }], scene: { id: `scene_${id}`, location: 'Lantern Room' }, timeline: [], messages: [], gameSessions: [], currentGameSessionId: null, quests: [] });

test('host can carry canonical campaign state from session one into session two', () => {
  const state = campaign('a');
  const first = createGameSession(state, { now: '2026-01-01T00:00:00Z' });
  assert.equal(first.ok, true); assert.equal(first.session.sessionNumber, 1);
  state.scene.location = 'The Black Observatory'; state.messages.push({ text: 'Beacon found', gameSessionId: first.session.id });
  state.timeline.push({ summary: 'Found beacon', session: 1, gameSessionId: first.session.id });
  assert.equal(transitionGameSession(state, 'end', { now: '2026-01-02T00:00:00Z', recap: 'We found the beacon.' }).ok, true);
  const second = createGameSession(state, { now: '2026-01-08T00:00:00Z' });
  assert.equal(second.session.sessionNumber, 2);
  assert.equal(state.scene.location, 'The Black Observatory');
  assert.equal(state.messages[0].gameSessionId, first.session.id);
  assert.equal(state.gameSessions.find(s => s.id === first.session.id).summary.recap, 'We found the beacon.');
});

test('campaign state remains isolated and historical reads do not mutate it', () => {
  const a = campaign('a'), b = campaign('b');
  a.scene.location = 'A'; b.scene.location = 'B';
  const s = createGameSession(a).session;
  const original = structuredClone(a);
  const historical = a.gameSessions.find(x => x.id === s.id);
  assert.equal(historical.id, s.id);
  assert.deepEqual(a, original);
  assert.equal(b.scene.location, 'B'); assert.equal(b.gameSessions.length, 0);
});

test('player cannot create or change session lifecycle', () => {
  const state = campaign('player-campaign', 'player');
  assert.equal(createGameSession(state).ok, false);
  state.gameSessions.push({ id: 'live', status: 'live', sessionNumber: 1 }); state.currentGameSessionId = 'live';
  assert.equal(transitionGameSession(state, 'end').ok, false);
  assert.equal(state.gameSessions[0].status, 'live');
});

test('Session Zero is first class and does not consume play numbering', () => {
  const state = campaign('zero');
  const zero = createGameSession(state, { sessionType: 'session_zero' }).session;
  assert.equal(zero.sessionNumber, 0); assert.equal(zero.title, 'Session Zero');
  transitionGameSession(state, 'end');
  const play = createGameSession(state).session;
  assert.equal(play.sessionNumber, 1); assert.equal(play.sessionType, 'play');
});

test('migration preserves existing transcript and timeline under an imported session', () => {
  const state = campaign('legacy'); state.campaign.started = true; state.campaign.session = 4;
  state.messages.push({ text: 'Legacy transcript' }); state.timeline.push({ session: 4, summary: 'Legacy event' });
  migrateGameSessions(state, '2026-01-01T00:00:00Z');
  assert.equal(state.gameSessions[0].sessionNumber, 4);
  assert.equal(state.messages[0].gameSessionId, state.currentGameSessionId);
  assert.equal(state.timeline[0].gameSessionId, state.currentGameSessionId);
});

test('paused sessions survive serialization and resume without changing identity', () => {
  const state = campaign('restart');
  const started = createGameSession(state).session;
  assert.equal(transitionGameSession(state, 'pause').ok, true);
  const afterReload = JSON.parse(JSON.stringify(state));
  assert.equal(afterReload.gameSessions[0].status, 'paused');
  assert.equal(afterReload.currentGameSessionId, started.id);
  assert.equal(transitionGameSession(afterReload, 'resume').session.id, started.id);
});

test('AI session context is campaign scoped and limits transcript to the active session', () => {
  const a = campaign('campaign-a'), b = campaign('campaign-b');
  const activeA = createGameSession(a).session;
  const oldA = { id: 'old-a', sessionNumber: 0, sessionType: 'session_zero', status: 'ended', summary: { recap: 'A only' } };
  a.gameSessions.unshift(oldA);
  a.messages.push({ text: 'A live', gameSessionId: activeA.id }, { text: 'A old', gameSessionId: oldA.id });
  a.timeline.push({ summary: 'A current event', gameSessionId: activeA.id }, { summary: 'A old event', gameSessionId: oldA.id });
  const contextA = buildGameSessionContext(a), contextB = buildGameSessionContext(b);
  assert.equal(contextA.campaign_id, 'campaign-a');
  assert.deepEqual(contextA.messages.map(m => m.text), ['A live']);
  assert.deepEqual(contextA.timeline.map(e => e.summary), ['A current event']);
  assert.equal(contextA.campaign_context.recent_session_summaries[0].recap, 'A only');
  assert.equal(JSON.stringify(contextB).includes('A only'), false);
});
