import { createAcousticModel } from './acoustics.mjs';
let model;
self.onmessage = ({data: message}) => {
  try {
    if (message.type === 'init') { model = createAcousticModel(message.data); return; }
    if (!model) throw new Error('Acoustic model not initialized');
    const {id, source, receiver, settings} = message;
    const started = performance.now();
    const result = model.evaluate(source, receiver, settings);
    const grid = model.sampleGrid(source, settings, {step: 0.16, height: receiver.y});
    const rooms = model.rooms.map(room => ({id: room.id, name: room.name, ...model.evaluate(source, {x:room.center[0],z:room.center[1],y:receiver.y}, settings)}));
    self.postMessage({id, result, grid, rooms, elapsed: Math.round(performance.now()-started)});
  } catch (error) { self.postMessage({id: message.id, error: error.message}); }
};
