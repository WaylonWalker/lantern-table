export function buildGameSessionContext(state, limits = { sessions: 12, events: 30, messages: 24 }) {
  const current = (state.gameSessions || []).find(s => s.id === state.currentGameSessionId) || null;
  const priorSessions = (state.gameSessions || []).filter(s => s.status === 'ended' && s.id !== current?.id).slice(-limits.sessions);
  return {
    campaign_id: state.campaign.id,
    game_session: current ? { id: current.id, session_number: current.sessionNumber, type: current.sessionType, title: current.title, status: current.status } : null,
    campaign_context: {
      settings: state.campaign.settings, premise: state.campaign.description || '', party: state.characters,
      location: state.scene.location, quests: state.quests, world_notes: state.journal,
      recent_session_summaries: priorSessions.map(s => ({ title: s.title, session_number: s.sessionNumber, recap: s.summary?.recap, key_events: s.summary?.keyEvents, unresolved_threads: s.summary?.unresolvedThreads, next_session_hooks: s.summary?.nextSessionHooks }))
    },
    timeline: (state.timeline || []).filter(e => e.gameSessionId === current?.id).slice(-limits.events),
    messages: (state.messages || []).filter(m => m.gameSessionId === current?.id).slice(-limits.messages)
  };
}
