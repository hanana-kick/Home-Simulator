import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_BANDS } from '../source/broadband-audio.mjs';
import { parseBandCsv, formatBandCsv, parseBroadbandProject, serializeBroadbandProject } from '../source/broadband-io.mjs';

const values = AUDIO_BANDS.map((_, i) => 20 + i / 3);
const payload = () => ({ config: { transferMode: 'element' }, source: { x: 8.9, y: 1.5, z: 1.2, level: 60, pitch: 160 },
  settings: { doorStates: { 'opening-0': false } }, scenarioOverrides: {}, recordings: {}, selectedScenario: 'conversation' });

test('all 21 CSV bands roundtrip exactly and reordered frequency rows are assigned by frequency', () => {
  const csv = formatBandCsv(values);
  assert.deepEqual(parseBandCsv(csv), values);
  const rows = csv.trim().split('\n');
  assert.deepEqual(parseBandCsv([rows[0], ...rows.slice(1).reverse()].join('\n')), values);
});

test('missing, duplicate, empty and nonfinite spectrum values are rejected rather than filled', () => {
  const csv = formatBandCsv(values);
  assert.throws(() => parseBandCsv(csv.trim().split('\n').slice(0, -1).join('\n')), /누락/);
  assert.throws(() => parseBandCsv(csv + '50,20\n'), /중복/);
  assert.throws(() => parseBandCsv(formatBandCsv()), /빈/);
  assert.throws(() => parseBandCsv(csv.replace('50,20', '50,NaN')), /유한/);
});

test('project roundtrip retains measured transfer, source reference and opening state', () => {
  const value = payload();
  value.config = { transferMode: 'apparent', measuredTransferBandsDb: values, measuredSourceRoomBandsDb: values,
    measuredSourceRoomScenarioId: 'singing', measuredTransferProvenance: 'test field data' };
  assert.deepEqual(parseBroadbandProject(serializeBroadbandProject(value)), value);
});

test('foreign schemas, wrong bands, missing transfer and malicious object keys never reach project state', () => {
  const value = payload();
  assert.throws(() => parseBroadbandProject('{}'), /버전/);
  const json = JSON.parse(serializeBroadbandProject(value)); json.bandsHz[0] = 40;
  assert.throws(() => parseBroadbandProject(JSON.stringify(json)), /주파수/);
  value.config.transferMode = 'dnt';
  assert.throws(() => serializeBroadbandProject(value), /21개/);
  const malicious = JSON.parse(serializeBroadbandProject(payload())); malicious.payload.settings = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => parseBroadbandProject(JSON.stringify(malicious)), /허용하지/);
  assert.equal({}.polluted, undefined);
});

test('malformed recorded inputs and provenance cannot masquerade as measured spectra', () => {
  for (const recording of ['x', {}, { bandLevelsDb: values, frames: [] },
    { bandLevelsDb: values, durationSeconds: 2, frames: [{ durationSec: 1, bandLevelsDb: values }] }]) {
    const value = payload(); value.recordings.conversation = recording;
    assert.throws(() => serializeBroadbandProject(value));
  }
  for (const notes of ['field data', [], { R: 5 }]) {
    const value = payload(); value.measurementNotes = notes;
    assert.throws(() => serializeBroadbandProject(value), /메모/);
  }
  const value = payload();
  value.recordings.conversation = { bandLevelsDb: values, durationSeconds: 1,
    frames: [{ durationSec: 1, bandLevelsDb: values }] };
  value.measurementNotes = { R: 'User-supplied example only' };
  assert.deepEqual(parseBroadbandProject(serializeBroadbandProject(value)), value);
});
