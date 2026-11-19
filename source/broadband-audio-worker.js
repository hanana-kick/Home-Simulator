import { analyzeBroadbandAudio } from './broadband-audio.mjs';

self.onmessage = ({ data }) => {
  if (data.type !== 'analyze') return;
  try {
    const result = analyzeBroadbandAudio(data.samples, data.sampleRate, data.options);
    postMessage({ type: 'result', id: data.id, result });
  } catch (error) {
    postMessage({ type: 'error', id: data.id, error: error.message || String(error) });
  }
};
