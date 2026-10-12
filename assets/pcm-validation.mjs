export function inspectPcm(samples) {
  let finiteCount = 0, peak = 0, squareSum = 0;
  const length = samples?.length || 0;
  for (let i = 0; i < length; i++) {
    const value = samples[i];
    if (!Number.isFinite(value)) continue;
    finiteCount++;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    squareSum += value * value;
  }
  const finiteRatio = length ? finiteCount / length : 0;
  const rms = finiteCount ? Math.sqrt(squareSum / finiteCount) : 0;
  const valid = length > 0 && finiteRatio >= 0.999 && peak >= 0.0001 && peak <= 2 && rms >= 0.00001;
  return { finiteRatio, peak, rms, valid };
}
