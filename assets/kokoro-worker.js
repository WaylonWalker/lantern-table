let tts = null;
let backend = null;
let dtype = null;
let loadPromise = null;
let lastProgress = -1;

function splitForKokoro(text, maxLength = 180) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["')\]}]*|[^.!?]+$/g) || [String(text)];
  const chunks = [];
  for (const sentence of sentences) {
    let remainder = sentence.trim();
    while (remainder.length > maxLength) {
      let splitAt = remainder.lastIndexOf(' ', maxLength);
      if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;
      chunks.push(remainder.slice(0, splitAt).trim());
      remainder = remainder.slice(splitAt).trim();
    }
    if (remainder) chunks.push(remainder);
  }
  return chunks;
}

function postError(id, error) {
  self.postMessage({ id, type: 'error', message: error?.message || String(error) });
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
  const { id, type } = data;
  try {
    if (type === 'load') {
      const result = await load(data.device, data.dtype);
      self.postMessage({ id, type: 'result', ...result });
      return;
    }
    if (type === 'generate') {
      if (!tts) throw Error('Kokoro is not loaded');
      const chunks = splitForKokoro(data.text);
      for (let index = 0; index < chunks.length; index++) {
        const text = chunks[index];
        self.postMessage({ id, type: 'progress', phase: 'generate', text: `Generating sentence ${index + 1} of ${chunks.length} (${backend})…` });
        const audio = await tts.generate(text, { voice: data.voice, speed: data.speed });
        if (!audio.audio || !audio.sampling_rate) throw Error('Kokoro returned no PCM audio');
        const samples = audio.audio instanceof Float32Array ? audio.audio.slice() : new Float32Array(audio.audio);
        const samplesBuffer = samples.buffer;
        self.postMessage({ id, type: 'chunk', text, index, total: chunks.length, backend, samples: samplesBuffer, samplingRate: audio.sampling_rate }, [samplesBuffer]);
      }
      self.postMessage({ id, type: 'result', backend, dtype, chunks: chunks.length });
      return;
    }
    throw Error(`Unknown Kokoro worker request: ${type}`);
  } catch (error) {
    postError(id, error);
  }
};
