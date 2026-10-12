// WebGPU fp32 is the default Kokoro path. Some driver/runtime combinations
// advertise shader-f16 but produce unusable fp16 PCM, so fp16 is not a candidate.
export function kokoroLoadPlan(preference = 'auto', webgpuAvailable = false) {
  const mode = ['auto', 'webgpu', 'wasm'].includes(preference) ? preference : 'auto';
  const plan = [];
  if (mode !== 'wasm' && webgpuAvailable) plan.push({ device: 'webgpu', dtype: 'fp32' });
  plan.push({ device: 'wasm', dtype: 'q8' });
  return plan;
}
