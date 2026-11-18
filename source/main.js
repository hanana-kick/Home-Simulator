import { initViewer } from './viewer.js';
import { initNoiseUI } from './noise-ui.js';
import { initNeighborUI } from './neighbor-ui.js';
import { initWaveUI } from './wave-ui.js';
async function readJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
try {
  const [data, references] = await Promise.all([readJSON('./cad/model.json'), readJSON('./references.json')]);
  const viewer = initViewer(data, references);
  let neighbor, wave;
  const noise = initNoiseUI(data, { onStateChange: () => { neighbor?.refresh(); wave?.refresh(); } });
  neighbor = initNeighborUI(data, {
    getAcousticState: () => noise.getState(),
    setSource: patch => noise.setSource(patch),
    onChooseSourcePosition: target => {
      setMode('noise');
      if (target === 'openings') noise.openDoorSettings();
      else noise.beginSourcePlacement();
    },
  });
  wave = initWaveUI(data, {
    getAcousticState: () => noise.getState(),
    setSource: patch => noise.setSource(patch),
    onChooseSourcePosition: target => {
      setMode('noise');
      if (target === 'openings') noise.openDoorSettings();
      else noise.beginSourcePlacement();
    },
  });
  const app = document.querySelector('#app');
  function setMode(mode) {
    mode = ['viewer', 'noise', 'neighbor', 'wave'].includes(mode) ? mode : 'wave';
    app.classList.toggle('mode-noise', mode === 'noise');
    app.classList.toggle('mode-neighbor', mode === 'neighbor');
    app.classList.toggle('mode-wave', mode === 'wave');
    for (const el of document.querySelectorAll('[data-mode]')) el.setAttribute('aria-pressed', String(el.dataset.mode === mode));
    for (const [name, ids] of Object.entries({viewer:['stage','viewerSidebar'], noise:['noiseStage','noiseSidebar'], neighbor:['neighborStage','neighborSidebar'], wave:['waveStage','waveSidebar']})) {
      for (const id of ids) document.getElementById(id).hidden = mode !== name;
    }
    if (mode === 'noise') noise.activate(); else noise.deactivate();
    if (mode === 'neighbor') neighbor.activate(); else neighbor.deactivate();
    if (mode === 'wave') wave.activate(); else wave.deactivate();
    if (mode === 'viewer') viewer.requestDraw();
  }
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  setMode(new URLSearchParams(location.search).get('mode') || 'wave');
} catch (error) {
  console.error(error);
  const message = document.querySelector('#loadError');
  message.hidden = false;
  message.textContent = '모델을 불러오지 못했습니다. 새로고침해 주세요. ' + error.message;
}
