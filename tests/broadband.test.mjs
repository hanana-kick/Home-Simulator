import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { THIRD_OCTAVE_BANDS, BROADBAND_PARTITIONS, broadbandSourceBands, createBroadbandModel } from '../source/broadband.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../cad/model.json', import.meta.url)));
const model = createBroadbandModel(data), N = THIRD_OCTAVE_BANDS.length;
const constant = value => Array(N).fill(value);
const source = { x: 9.05, y: 1.2, z: 1.15, level: 60, pitch: 160 };
const noBackground = { background: null };
// A2=.16*31.25/.5=10 m². Actual partition stays fixed at S=5.75 m².
const measuredBase = { receiverFloorAreaM2: 31.25 / 2.3, receiverHeightM: 2.3, receiverRt60: .5,
  measuredSourceRoomBandsDb: constant(70), background: null };
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('21 independent bands cover the required range and retain nonmonotonic input R', () => {
  assert.equal(N, 21); assert.equal(THIRD_OCTAVE_BANDS[0], 50); assert.equal(THIRD_OCTAVE_BANDS.at(-1), 5000);
  assert.equal(model.rooms.length, 7); assert.equal(model.boundary.areaM2, 5.75);
  const material = model.inputBands({ partitionProfile: 'nrcExample' });
  assert.deepEqual(material.partitionBandsDb, BROADBAND_PARTITIONS.nrcExample.values);
  const arbitraryR = THIRD_OCTAVE_BANDS.map((_, i) => i % 2 ? 20 : 50);
  const result = model.evaluate(source, {}, { ...measuredBase, transferMode: 'apparent', measuredTransferBandsDb: arbitraryR });
  result.receiverBandsDb.forEach((value, b) => near(value, 70 - arbitraryR[b] + 10 * Math.log10(5.75 / 10)));
  const low = model.inputBands({}).partitionBandsDb[0];
  near(low, 34 + 2 * Math.log(50 / 31) / Math.log(63 / 31));
});

test('measured R-prime uses source-room L1 and total absorption exactly once', () => {
  const config = { ...measuredBase, transferMode: 'apparent', measuredTransferBandsDb: constant(40) };
  const result = model.evaluate(source, {}, config);
  const expected = 70 - 40 + 10 * Math.log10(5.75 / 10);
  result.receiverBandsDb.forEach(value => near(value, expected));
  const longer = model.evaluate(source, {}, { ...config, receiverRt60: 1 });
  longer.receiverBandsDb.forEach((value, b) => near(value - result.receiverBandsDb[b], 10 * Math.log10(2)));
  assert.equal(result.routeContributions.length, 1);
  assert.equal(result.routeContributions[0].id, 'apparent');
  assert.equal(result.details.parallelPathsIncluded, false);
});

test('measured DnT has only T/.5 normalization and no S/A or volume factor', () => {
  const config = { ...measuredBase, transferMode: 'dnt', measuredTransferBandsDb: constant(40) };
  const result = model.evaluate(source, {}, config);
  result.receiverBandsDb.forEach(value => near(value, 30));
  const larger = model.evaluate(source, {}, { ...config, receiverFloorAreaM2: 100 });
  assert.deepEqual(larger.receiverBandsDb, result.receiverBandsDb);
  const longer = model.evaluate(source, {}, { ...config, receiverRt60: 1 });
  longer.receiverBandsDb.forEach(value => near(value, 30 + 10 * Math.log10(2)));
});

test('field R-prime and DnT never add leak or flanking paths again', () => {
  for (const transferMode of ['apparent', 'dnt']) {
    const base = { ...measuredBase, transferMode, measuredTransferBandsDb: constant(45), leakAreaCm2: 0, flankEnabled: false };
    const a = model.evaluate(source, {}, base);
    const b = model.evaluate(source, {}, { ...base, leakAreaCm2: 50000, flankEnabled: true, flankDnDb: 0, flankBandsDb: constant(0), tlOffsetDb: -40 });
    assert.deepEqual(a.receiverBandsDb, b.receiverBandsDb);
    assert.equal(b.sensitivity.length, 1);
  }
});

test('measured room L1 bypasses 1 m calibration, room location, and furnishing assumptions', () => {
  const config = { ...measuredBase, transferMode: 'apparent', measuredTransferBandsDb: constant(40) };
  const a = model.evaluate(source, {}, config);
  const b = model.evaluate({ x: -100, y: -20, z: 100, level: 130, pitch: 800, bandLevelsDb: constant(150) }, { furnished: false, wallProfile: 'lightweight' }, config);
  assert.deepEqual(a.sourceRoomBandsDb, constant(70));
  assert.deepEqual(a.receiverBandsDb, b.receiverBandsDb);
});

test('element R, physical leak area, and normalized Dn,f sum as equivalent transmission areas', () => {
  const config = { ...measuredBase, transferMode: 'element', partitionBandsDb: constant(160), leakAreaCm2: 10, flankEnabled: false };
  const leak = model.evaluate(source, {}, config);
  leak.receiverBandsDb.forEach(value => near(value, 30, 1e-9));
  const flank = model.evaluate(source, {}, { ...config, leakAreaCm2: 0, flankEnabled: true, flankDnDb: 50 });
  flank.receiverBandsDb.forEach(value => near(value, 20, 1e-8));
  const R = 10 * Math.log10((5.75 - .001) / .001);
  const equal = model.evaluate(source, {}, { ...config, partitionBandsDb: constant(R) });
  equal.receiverBandsDb.forEach(value => near(value, 30 + 10 * Math.log10(2)));
  near(equal.routeContributions.find(path => path.id === 'wall').fraction, .5);
  near(equal.routeContributions.find(path => path.id === 'leak').fraction, .5);
  near(equal.details.opaqueAreaM2, 5.749);
});

test('total measured/assumed receiver RT is not given a second escape term', () => {
  const result = model.evaluate(source, {}, { ...measuredBase, partitionBandsDb: constant(160), leakAreaCm2: 10000, flankEnabled: false });
  result.receiverBandsDb.forEach(value => near(value, 60, 1e-9)); // E2=E1*1/10, not 1/11
  assert.throws(() => model.evaluate(source, {}, { ...measuredBase, receiverFloorAreaM2: 1, receiverHeightM: 2.3, receiverRt60: 10,
    partitionBandsDb: constant(160), leakAreaCm2: 10000, flankEnabled: false }), /에너지 수지/);
});

test('the per-band coupled network conserves the selected wall ratio and source scaling', () => {
  const a = model.evaluate(source, {}, noBackground);
  const b = model.evaluate({ ...source, level: 70 }, {}, noBackground);
  near(b.sourceOnlyDbA - a.sourceOnlyDbA, 10, 1e-9);
  a.receiverBandsDb.forEach((value, band) => {
    const area = a.routeContributions.reduce((sum, path) => sum + path.equivalentTransmissionAreaM2[band], 0);
    near(value, Math.max(-300, a.sourceRoomBandsDb[band] + 10 * Math.log10(area / a.details.receiverAbsorptionM2[band])), 1e-8);
  });
  assert.ok(a.details.coupledReceiver);
  const somewhereInWorkshop = model.evaluate({ ...source, x: 8.2, y: 1.8, z: .6 }, {}, noBackground);
  assert.deepEqual(somewhereInWorkshop.receiverBandsDb, a.receiverBandsDb); // explicit space-average scope
  const living = { ...source, x: 7, z: 3.5 };
  const closed = model.evaluate(living, {}, noBackground);
  const open = model.evaluate(living, { doorStates: { 'opening-9': true } }, noBackground);
  assert.ok(open.sourceOnlyDbA > closed.sourceOnlyDbA + 2);
  assert.equal(open.details.sourceRoomId, 'room17');
});

test('absolute source spectra are not renormalized to the level control', () => {
  const supplied = THIRD_OCTAVE_BANDS.map((_, i) => 35 + i);
  assert.deepEqual(broadbandSourceBands({ bandLevelsDb: supplied, level: 130 }), supplied);
  const a = model.evaluate({ ...source, bandLevelsDb: supplied, level: 20 }, {}, noBackground);
  const b = model.evaluate({ ...source, bandLevelsDb: supplied, level: 120 }, {}, noBackground);
  assert.deepEqual(a.receiverBandsDb, b.receiverBandsDb);
  const bad = [...supplied]; bad[8] = '';
  assert.throws(() => broadbandSourceBands({ bandLevelsDb: bad }), /결측/);
  bad[8] = null; assert.throws(() => broadbandSourceBands({ bandLevelsDb: bad }), /결측/);
  assert.throws(() => model.evaluate(source, {}, { transferMode: 'apparent', measuredTransferBandsDb: [50] }), /21개/);
});

test('session averages combine loud voice activity and independent speaker duty in energy', () => {
  const overrides = { conversation: { typicalLevel: 60, loudLevel: 70, duty: .4, loudFraction: .1, speakerEnabled: false } };
  const row = model.compareScenarios(source, {}, noBackground, overrides).scenarios[0];
  near(row.session.sourceOnlyDbA - row.active.sourceOnlyDbA, 10 * Math.log10(.4 * (.9 + .1 * 10)));
  const speaker = model.compareScenarios(source, {}, noBackground, { conversation: { voiceEnabled: false, duty: 0, speakerEnabled: true, speakerLevel: 65, speakerDuty: 1 } }).scenarios[0];
  near(speaker.active.sourceOnlyDbA, speaker.session.sourceOnlyDbA);
  near(speaker.loud.sourceOnlyDbA, speaker.session.sourceOnlyDbA);
});

test('recorded frames include pauses once and use the maximum received 1-second energy mean', () => {
  const frames = [50, 50, 70, 70].map(level => ({ durationSec: .5, bandLevelsDb: constant(level) }));
  const average = 10 * Math.log10((10 ** 5 + 10 ** 7) / 2);
  const overrides = { conversation: { frames, bandLevelsDb: constant(average), duty: 0, loudFraction: 1, loudLevel: 130, speakerEnabled: true, speakerLevel: 130 } };
  const row = model.compareScenarios(source, {}, noBackground, overrides).scenarios[0];
  const expectedAverage = model.evaluate({ ...source, bandLevelsDb: constant(average) }, {}, noBackground);
  const expectedLoud = model.evaluate({ ...source, bandLevelsDb: constant(70) }, {}, noBackground);
  near(row.session.sourceOnlyDbA, expectedAverage.sourceOnlyDbA);
  near(row.loud.sourceOnlyDbA, expectedLoud.sourceOnlyDbA);
  near(row.active.sourceOnlyDbA, row.session.sourceOnlyDbA);
  assert.equal(row.loud.details.loudWindowStartSeconds, 1);
  assert.equal(row.assumptions.activityControlsApplied, false);
  assert.equal(row.session.details.separateSpeakerApplied, false);
});

test('a loud final partial recording block is included by an end-aligned 1-second window', () => {
  const frames = [{ durationSec: .5, bandLevelsDb: constant(-300) }, { durationSec: .5, bandLevelsDb: constant(-300) }, { durationSec: .3, bandLevelsDb: constant(70) }];
  const row = model.compareScenarios(source, {}, noBackground, { conversation: { frames } }).scenarios[0];
  const expectedMean = model.evaluate({ ...source, bandLevelsDb: constant(70 + 10 * Math.log10(.3 / 1.3)) }, {}, noBackground);
  const expectedLoud = model.evaluate({ ...source, bandLevelsDb: constant(70 + 10 * Math.log10(.3)) }, {}, noBackground);
  near(row.session.sourceOnlyDbA, expectedMean.sourceOnlyDbA);
  near(row.loud.sourceOnlyDbA, expectedLoud.sourceOnlyDbA);
  near(row.loud.details.loudWindowStartSeconds, .3);
  assert.ok(row.loud.sourceOnlyDbA > row.session.sourceOnlyDbA);
});

test('measured L1 applies to its explicitly selected scenario only, without activity guesses', () => {
  const config = { ...measuredBase, transferMode: 'apparent', measuredTransferBandsDb: constant(40), measuredSourceRoomScenarioId: 'conversation' };
  const a = model.compareScenarios(source, {}, config);
  const b = model.compareScenarios(source, {}, config, { conversation: { typicalLevel: 10, loudLevel: 140, duty: 0 }, livestream: { typicalLevel: 76 } });
  near(a.scenarios[0].session.sourceOnlyDbA, b.scenarios[0].session.sourceOnlyDbA);
  near(a.scenarios[0].active.sourceOnlyDbA, a.scenarios[0].session.sourceOnlyDbA);
  near(b.scenarios[1].active.sourceOnlyDbA - a.scenarios[1].active.sourceOnlyDbA, 10);
  assert.equal(a.scenarios[0].assumptions.measuredSourceRoom, true);
  assert.equal(a.scenarios[1].assumptions.measuredSourceRoom, false);
  assert.equal(a.scenarios[0].loud.details.loudAvailable, false);
});

test('background addition and three explicit construction conditions retain energy meaning', () => {
  const rows = model.compareScenarios(source).scenarios;
  for (const row of rows) {
    assert.equal(row.conditions.length, 3);
    assert.deepEqual(row.conditions.map(condition => condition.id), ['lower', 'central', 'higher']);
    assert.ok(row.range.session.min <= row.session.sourceOnlyDbA && row.range.session.max >= row.session.sourceOnlyDbA);
    near(row.session.totalDbA, 10 * Math.log10(10 ** (row.session.sourceOnlyDbA / 10) + 10 ** (30 / 10)));
    near(row.session.routeContributions.reduce((sum, route) => sum + route.fraction, 0), 1);
  }
});
