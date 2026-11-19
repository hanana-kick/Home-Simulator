import { AUDIO_BANDS } from './broadband-audio.mjs';

const SCENARIOS = ['conversation', 'livestream', 'singing'];
const MAX_FILE_CHARS = 4 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, name, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${name}: ${min}–${max} 범위의 유한한 숫자가 필요합니다.`);
};

function vector(value, name, min = -300, max = 150) {
  if (!Array.isArray(value) || value.length !== AUDIO_BANDS.length) fail(`${name}: 21개 대역 값이 모두 필요합니다.`);
  value.forEach((item, i) => number(item, `${name} · ${AUDIO_BANDS[i]}Hz`, min, max));
}

/** Two columns, frequencyHz and value. All 21 nominal centers are mandatory. */
export function parseBandCsv(text, { min = -120, max = 140, valueColumn } = {}) {
  if (typeof text !== 'string' || text.length > 100000) fail('대역 CSV는 100KB 이하의 텍스트여야 합니다.');
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const values = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const cells = row.split(/[\t,;]/).map(cell => cell.trim().replace(/^"(.*)"$/, '$1').trim());
    if (cells.length !== 2) fail(`${index + 1}행: 주파수와 값의 두 열을 쉼표 또는 탭으로 구분하세요.`);
    if (index === 0 && /^(frequency(?:hz)?|freq(?:hz)?|hz|주파수)$/i.test(cells[0])) {
      if (valueColumn && cells[1].toLowerCase() !== valueColumn.toLowerCase()) fail(`두 번째 열 이름은 ${valueColumn}이어야 합니다.`);
      continue;
    }
    if (!cells[0] || !cells[1]) fail(`${index + 1}행: 빈 주파수나 값은 사용할 수 없습니다.`);
    const frequency = Number(cells[0]), value = Number(cells[1]);
    if (!AUDIO_BANDS.includes(frequency)) fail(`${index + 1}행: 지원하지 않는 주파수 ${cells[0]}Hz입니다. 제공된 21대역 양식을 사용하세요.`);
    if (values.has(frequency)) fail(`${frequency}Hz 값이 중복되었습니다.`);
    number(value, `${frequency}Hz`, min, max);
    values.set(frequency, value);
  }
  const missing = AUDIO_BANDS.filter(frequency => !values.has(frequency));
  if (missing.length) fail(`대역 값 누락: ${missing.join(', ')}Hz. 누락값을 자동으로 추정하지 않습니다.`);
  return AUDIO_BANDS.map(frequency => values.get(frequency));
}

export function formatBandCsv(values, { valueColumn = 'value' } = {}) {
  if (values !== undefined && values !== null) vector(values, valueColumn, -300, 10000);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(valueColumn)) fail('CSV 값 열 이름은 영문자·숫자·밑줄만 사용할 수 있습니다.');
  return `frequencyHz,${valueColumn}\n` + AUDIO_BANDS.map((frequency, i) => `${frequency},${values?.[i] ?? ''}`).join('\n') + '\n';
}

function validateTree(value, path = 'project', depth = 0) {
  if (depth > 16) fail('프로젝트 데이터의 중첩 깊이가 너무 큽니다.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${path}: 유효하지 않은 숫자입니다.`); return; }
  if (typeof value === 'string') { if (value.length > 20000) fail(`${path}: 문자열이 너무 깁니다.`); return; }
  if (Array.isArray(value)) {
    if (value.length > 10000) fail(`${path}: 배열이 너무 큽니다.`);
    value.forEach((item, i) => validateTree(item, `${path}[${i}]`, depth + 1)); return;
  }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path}: JSON 값만 저장할 수 있습니다.`);
  if (Object.keys(value).length > 300) fail(`${path}: 필드가 너무 많습니다.`);
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${path}: 허용하지 않는 필드입니다.`);
    validateTree(item, `${path}.${key}`, depth + 1);
    if (item !== null && (/(?:BandsDb|bandLevelsDb|bandsDb)$/.test(key))) vector(item, `${path}.${key}`);
    if (key === 'frames' && Array.isArray(item)) {
      if (item.length > 600) fail('녹음의 시간 블록이 너무 많습니다.');
      let duration = 0;
      for (const frame of item) {
        number(frame.durationSec, '녹음 블록 길이', .000001, 60);
        vector(frame.bandLevelsDb, '녹음 블록 대역'); duration += frame.durationSec;
      }
      if (duration > 60.001) fail('저장된 녹음 분석 구간이 60초를 넘습니다.');
    }
    if (key === 'bandsHz' && JSON.stringify(item) !== JSON.stringify(AUDIO_BANDS)) fail('프로젝트의 주파수 대역이 현재 계산 대역과 다릅니다.');
  }
}

function validatePayload(payload) {
  validateTree(payload);
  if (!object(payload)) fail('프로젝트 본문이 올바르지 않습니다.');
  for (const key of ['config', 'scenarioOverrides', 'recordings', 'source', 'settings'])
    if (!object(payload[key])) fail(`프로젝트에 ${key} 객체가 필요합니다.`);
  if (!SCENARIOS.includes(payload.selectedScenario)) fail('선택한 활동 이름이 올바르지 않습니다.');
  for (const [key, value] of Object.entries(payload.scenarioOverrides)) {
    if (!SCENARIOS.includes(key)) fail(`지원하지 않는 활동: ${key}`);
    if (!object(value)) fail(`${key}: 활동 설정 객체가 필요합니다.`);
  }
  for (const [key, value] of Object.entries(payload.recordings)) {
    if (!SCENARIOS.includes(key)) fail(`지원하지 않는 녹음 활동: ${key}`);
    if (!object(value)) fail(`${key}: 녹음 분석 객체가 필요합니다.`);
    vector(value.bandLevelsDb, `${key} 녹음 평균 대역`);
    if (value.frames !== undefined) {
      if (!Array.isArray(value.frames) || !value.frames.length) fail(`${key}: 녹음 시간 블록이 필요합니다.`);
      number(value.durationSeconds, `${key} 녹음 구간 길이`, .000001, 60.001);
      const sumDuration = value.frames.reduce((sum, frame) => sum + frame.durationSec, 0);
      if (Math.abs(sumDuration - value.durationSeconds) > .001) fail(`${key}: 녹음 시간 블록과 전체 구간 길이가 다릅니다.`);
    }
  }
  if (payload.measurementNotes !== undefined) {
    if (!object(payload.measurementNotes)) fail('측정 출처 메모는 객체여야 합니다.');
    for (const value of Object.values(payload.measurementNotes)) if (typeof value !== 'string') fail('측정 출처 메모는 문자열이어야 합니다.');
  }
  for (const key of ['x', 'y', 'z']) number(payload.source[key], `소음원 ${key}`, -100, 100);
  if (payload.source.level !== undefined) number(payload.source.level, '소음원 크기', 0, 140);
  if (payload.source.pitch !== undefined) number(payload.source.pitch, '소음원 기본주파수', 20, 20000);
  for (const [key, value] of Object.entries(payload.settings.doorStates ?? {})) {
    if (!/^opening-\d+$/.test(key)) fail(`알 수 없는 개구부: ${key}`);
    if (typeof value !== 'boolean') number(value, `${key} 열림`, 0, 1);
  }
  const config = payload.config;
  if (config.transferMode !== undefined && !['element', 'apparent', 'dnt'].includes(config.transferMode)) fail('전달 데이터 종류가 올바르지 않습니다.');
  if (config.transferMode && config.transferMode !== 'element') vector(config.measuredTransferBandsDb, '현장 전달 곡선', -50, 140);
  if (config.measuredSourceRoomBandsDb != null && !SCENARIOS.includes(config.measuredSourceRoomScenarioId)) fail('실측 작업실 음압을 적용할 활동을 지정하세요.');
  if (config.receiverRt60Bands != null) vector(config.receiverRt60Bands, '잔향시간', .05, 10);
  if (config.receiverRt60BandsSec != null) vector(config.receiverRt60BandsSec, '잔향시간', .05, 10);
  return payload;
}

export function serializeBroadbandProject(payload) {
  validatePayload(payload);
  return JSON.stringify({ schema: 'home-simulator.broadband', version: 1, bandsHz: AUDIO_BANDS,
    savedAt: new Date().toISOString(), payload }, null, 2);
}

export function parseBroadbandProject(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) fail('프로젝트 파일은 4MB 이하의 JSON이어야 합니다.');
  let data;
  try { data = JSON.parse(text); } catch { fail('프로젝트 JSON 문법이 올바르지 않습니다.'); }
  if (!object(data) || data.schema !== 'home-simulator.broadband' || data.version !== 1) fail('지원하는 Home Simulator 광대역 프로젝트 버전이 아닙니다.');
  if (JSON.stringify(data.bandsHz) !== JSON.stringify(AUDIO_BANDS)) fail('프로젝트의 주파수 대역이 현재 계산 대역과 다릅니다.');
  return validatePayload(data.payload);
}
