import { createNeighborModel } from './neighbors.mjs';

let model;
self.onmessage = ({data: message}) => {
  try {
    if (message.type === 'init') { model = createNeighborModel(message.data); return; }
    if (!model) throw new Error('이웃집 계산 모델이 준비되지 않았습니다.');
    const {id, source, settings, config, overrides} = message;
    const rows = model.compareScenarios(source, settings, config, overrides);
    self.postMessage({id, rows});
  } catch (error) { self.postMessage({id:message.id, error:error.message}); }
};
