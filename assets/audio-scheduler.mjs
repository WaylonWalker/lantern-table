export function nextAudioStart(currentTime, scheduledEnd, safetyLead = 0.06) {
  return Math.max(Number(scheduledEnd) || 0, (Number(currentTime) || 0) + safetyLead);
}

export function audioBufferAhead(nextPlaybackTime, currentTime) {
  return Math.max(0, (Number(nextPlaybackTime) || 0) - (Number(currentTime) || 0));
}
