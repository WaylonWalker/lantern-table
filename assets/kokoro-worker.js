import { splitKokoroText } from './kokoro-text.mjs';
import { inspectPcm } from './pcm-validation.mjs';

let tts = null;
let backend = null;
let dtype = null;
let loadPromise = null;
let lastProgress = -1;
const cancelledRequests = new Set();

function postError(id, error, correlationId = null) {
  self.postMessage({ id, correlationId, type: 'error', message: error?.message || String(error) });
}

async function load(device, modelDtype) {
  if (tts) return { backend, dtype };
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    self.postMessage({ type: 'progress', text: `Loading Kokoro runtime (${device}, ${modelDtype})…` });
    const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
    const model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      device,
      dtype: modelDtype,
      progress_callback(progress) {
        if (progress?.progress == null) {
          const file = progress?.file || progress?.name;
          self.postMessage({ type: 'progress', text: file ? `Downloading ${file}… size not reported; download is continuing.` : 'Downloading Kokoro model files… size not reported; download is continuing.' });
          return;
        }
        const percent = Math.floor(progress.progress);
        if (percent === lastProgress) return;
        lastProgress = percent;
        self.postMessage({ type: 'progress', text: `Downloading Kokoro model… ${percent}%` });
      },
    });
    tts = model;
    backend = device;
    dtype = modelDtype;
    return { backend, dtype };
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

self.onmessage = async ({ data }) => {
  const { id, type, correlationId = null } = data;
  if (type === 'cancel') { cancelledRequests.add(data.requestId); return; }
  try {
    if (type === 'load') {
      const loadStarted = performance.now();
      const result = await load(data.device, data.dtype);
      self.postMessage({ id, type: 'result', correlationId, loadMs: performance.now() - loadStarted, ...result });
      return;
    }
    if (type === 'generate') {
      if (!tts) throw Error('Kokoro is not loaded');
      const chunks = splitKokoroText(data.text, data.maxPassageLength || 320);
      for (let index = 0; index < chunks.length; index++) {
        if (cancelledRequests.has(id)) break;
        const text = chunks[index];
        self.postMessage({ id, type: 'progress', correlationId, phase: 'generate', text: `Generating passage ${index + 1} of ${chunks.length} (${backend})…` });
        const generationStarted = performance.now();
        const audio = await tts.generate(text, { voice: data.voice, speed: data.speed });
        const inferenceMs = performance.now() - generationStarted;
        if (cancelledRequests.has(id)) break;
        if (!audio.audio || !audio.sampling_rate) throw Error('Kokoro returned no PCM audio');
        const samples = audio.audio instanceof Float32Array ? audio.audio.slice() : new Float32Array(audio.audio);
        const pcm = inspectPcm(samples);
        if (!pcm.valid) throw Error(`PCM validation failed for passage ${index + 1}: finite ratio ${pcm.finiteRatio.toFixed(5)}, peak ${pcm.peak.toFixed(6)}, RMS ${pcm.rms.toFixed(6)}`);
        const samplesBuffer = samples.buffer;
        self.postMessage({ id, type: 'chunk', correlationId, text, index, total: chunks.length, backend, inferenceMs, audioDurationMs: samples.length / audio.sampling_rate * 1000, samples: samplesBuffer, samplingRate: audio.sampling_rate }, [samplesBuffer]);
      }
      if (cancelledRequests.delete(id)) return;
      self.postMessage({ id, type: 'result', correlationId, backend, dtype, chunks: chunks.length });
      return;
    }
    throw Error(`Unknown Kokoro worker request: ${type}`);
  } catch (error) {
    postError(id, error, correlationId);
  }
};
