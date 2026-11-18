import { createWaveSimulation } from './wave-engine.mjs';

let data, active, timer;

function sendFrame(type, job) {
  const frame = job.simulation.frame(job.sliceY);
  const transfer = [frame.slice.pressure.buffer, frame.slice.rms.buffer, frame.slice.mask.buffer];
  for (const probe of Object.values(frame.probes)) transfer.push(probe.times.buffer, probe.pressure.buffer);
  postMessage({ type, id: job.id, frame }, transfer);
}

function schedule(job) {
  if (active !== job || job.paused) return;
  timer = setTimeout(() => {
    if (active !== job || job.paused) return;
    try {
      const start = performance.now();
      // A short batch yields to pause/cancel/view messages even on a fine grid.
      do { job.simulation.step(8); } while (!job.simulation.finished && performance.now() - start < 35);
      if (job.simulation.finished) { sendFrame('done', job); job.done = true; return; }
      if (performance.now() - job.lastFrame >= 80) { sendFrame('frame', job); job.lastFrame = performance.now(); }
      schedule(job);
    } catch (error) {
      postMessage({ type: 'error', id: job.id, error: error.message || String(error) });
      active = null;
    }
  }, 0);
}

self.onmessage = ({ data: message }) => {
  try {
    if (message.type === 'init') { data = message.data; return; }
    if (message.type === 'start') {
      clearTimeout(timer);
      active = null;
      if (!data) throw new Error('평면 데이터가 아직 준비되지 않았습니다.');
      const simulation = createWaveSimulation(data, message);
      active = { id: message.id, simulation, paused: false, done: false, sliceY: message.config?.sliceY ?? 1.2, lastFrame: performance.now() };
      postMessage({ type: 'started', id: message.id, metadata: simulation.metadata });
      sendFrame('frame', active); schedule(active); return;
    }
    if (!active || active.id !== message.id) return;
    if ((message.type === 'pause' || message.type === 'resume') && active.done) {
      sendFrame('done', active); return;
    }
    if (message.type === 'cancel') {
      clearTimeout(timer); active.paused = true; active.cancelled = true;
      postMessage({ type: 'cancelled', id: message.id });
    } else if (message.type === 'pause') {
      clearTimeout(timer); active.paused = true; sendFrame('frame', active); postMessage({ type: 'paused', id: message.id });
    } else if (message.type === 'resume') {
      if (active.cancelled) { postMessage({ type: 'cancelled', id: message.id }); return; }
      active.paused = false; postMessage({ type: 'resumed', id: message.id }); if (!active.done) schedule(active);
    } else if (message.type === 'view') {
      active.sliceY = message.sliceY; sendFrame('frame', active);
    }
  } catch (error) {
    postMessage({ type: 'error', id: message.id, error: error.message || String(error) });
  }
};
