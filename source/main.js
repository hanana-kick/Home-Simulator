import { initViewer } from './viewer.js';
import { initNoiseUI } from './noise-ui.js';
async function readJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
try {
  const [data, references] = await Promise.all([readJSON('./cad/model.json'), readJSON('./references.json')]);
  const viewer = initViewer(data, references);
  const noise = initNoiseUI(data);
  const app = document.querySelector('#app');
  function setMode(mode) {
    const active = mode === 'noise';
    app.classList.toggle('mode-noise', active);
    for (const el of document.querySelectorAll('[data-mode]')) el.setAttribute('aria-pressed', String(el.dataset.mode === mode));
    document.querySelector('#stage').hidden = active;
    document.querySelector('#viewerSidebar').hidden = active;
    document.querySelector('#noiseStage').hidden = !active;
    document.querySelector('#noiseSidebar').hidden = !active;
    if (active) noise.activate(); else { noise.deactivate(); viewer.requestDraw(); }
  }
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  setMode(new URLSearchParams(location.search).get('mode') === 'viewer' ? 'viewer' : 'noise');
} catch (error) {
  console.error(error);
  const message = document.querySelector('#loadError');
  message.hidden = false;
  message.textContent = '모델을 불러오지 못했습니다. 새로고침해 주세요. ' + error.message;
}
