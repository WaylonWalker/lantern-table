// Smaller WebGPU weights reduce both download and memory pressure on phones.
// WASM q8 remains the compatibility fallback for devices with fragile WebGPU.
export function kokoroLoadPlan(preference = 'auto', webgpuAvailable = false) {
  const mode = ['auto', 'webgpu', 'wasm'].includes(preference) ? preference : 'auto';
  const plan = [];
  if (mode !== 'wasm' && webgpuAvailable) plan.push({ device: 'webgpu', dtype: 'fp16' });
  plan.push({ device: 'wasm', dtype: 'q8' });
  return plan;
}
