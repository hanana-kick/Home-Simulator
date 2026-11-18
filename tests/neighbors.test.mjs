import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNeighborModel, NEIGHBOR_SCENARIOS } from '../source/neighbors.mjs';
import { createAcousticModel } from '../source/acoustics.mjs';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} ≈ ${expected} (tolerance ${tolerance})`);
const energy = db => 10 ** (db / 10);
const addLevels = (...levels) => 10 * Math.log10(levels.reduce((total, db) => total + energy(db), 0));

function dwelling() {
  return {
    wallHeightM: 2.3,
    rooms: [{ id: 'main', name: 'Source room', kind: 'interior', center: [2, 2],
      poly: [[0, 0], [4, 0], [4, 4], [0, 4]] }],
    objects: [
      { id: 'west', label: 'west', group: 'wallOuter', wall: true, shape: 'box', p: [-0.1, 1.15, 2], s: [0.2, 2.3, 4.4] },
      { id: 'north', label: 'north', group: 'wallOuter', wall: true, shape: 'box', p: [2, 1.15, -0.1], s: [4, 2.3, 0.2] },
      { id: 'south', label: 'south', group: 'wallOuter', wall: true, shape: 'box', p: [2, 1.15, 4.1], s: [4, 2.3, 0.2] },
      { id: 'east-a', label: 'window', group: 'wallOuter', wall: true, shape: 'box', p: [4.1, 1.15, 0.6], s: [0.2, 2.3, 1.2] },
      { id: 'east-b', label: 'window', group: 'wallOuter', wall: true, shape: 'box', p: [4.1, 0.4, 2], s: [0.2, 0.8, 1.6] },
      { id: 'east-c', label: 'window', group: 'wallOuter', wall: true, shape: 'box', p: [4.1, 2.15, 2], s: [0.2, 0.3, 1.6] },
      { id: 'east-d', label: 'window', group: 'wallOuter', wall: true, shape: 'box', p: [4.1, 1.15, 3.4], s: [0.2, 2.3, 1.2] },
    ],
    openings: [{ axis: 'x', k: 4.1, lo: 1.2, hi: 2.8, sill: 0.8, head: 2, kind: 'glass', label: 'window' }],
  };
}

const source = { x: 2, y: 1.15, z: 2, type: 'voice', level: 60, pitch: 160 };
const config = { route: 'shared-wall', boundaryRoomId: 'main', boundarySide: 'east', separatingAreaM2: 5,
  receiverFloorAreaM2: 14, receiverHeightM: 2.3, receiverRt60: 0.5, background: 30 };

test('shared boundary uses only real opaque wall area and clamps excess requested area', () => {
  const model = createNeighborModel(dwelling());
  const east = model.boundaries.find(boundary => boundary.side === 'east');
  close(east.facadeAreaM2, 4 * 2.3);
  close(east.opaqueAreaM2, 4 * 2.3 - 1.6 * 1.2);
  const result = model.evaluate(source, {}, { ...config, separatingAreaM2: 40 });
  close(result.details.separatingAreaM2, east.opaqueAreaM2);
  assert.ok(result.details.notices.some(notice => notice.includes('창·문을 제외')));
  assert.ok(result.details.sampleCount > 1);
});

test('linear +10dB source change produces +10dB in every neighbour route, not a second TL deduction', () => {
  const model = createNeighborModel(dwelling());
  for (const route of ['shared-wall', 'floor-above', 'floor-below', 'detached']) {
    const a = model.evaluate(source, {}, { ...config, route });
    const b = model.evaluate({ ...source, level: 70 }, {}, { ...config, route });
    close(b.sourceOnlyDbA - a.sourceOnlyDbA, 10);
    assert.ok(Number.isFinite(a.totalDbA));
    assert.ok(b.totalDbA - a.totalDbA < 10);
  }
});

test('floor routes default to concrete slab and are symmetric at half source-room height', () => {
  const model = createNeighborModel(dwelling());
  const upper = model.evaluate(source, {}, { ...config, route: 'floor-above' });
  const lower = model.evaluate(source, {}, { ...config, route: 'floor-below' });
  assert.equal(upper.details.partitionProfile, 'floor');
  close(upper.sourceOnlyDbA, lower.sourceOnlyDbA);
  assert.ok(upper.details.ignoredPaths.includes('충격음'));
  const smallReceiver = model.evaluate(source, {}, { ...config, route: 'floor-above', receiverFloorAreaM2: 4, separatingAreaM2: 12 });
  close(smallReceiver.details.separatingAreaM2, 4);
  close(smallReceiver.details.availableAreaM2, 4);
});

test('duty scales only source energy before adding steady background', () => {
  const model = createNeighborModel(dwelling());
  const row = model.compareScenarios(source, {}, config, { conversation: { duty: 0.25, loudFraction: 0, speakerEnabled: false } })[0];
  close(row.session.sourceOnlyDbA, row.active.sourceOnlyDbA + 10 * Math.log10(0.25));
  close(row.session.totalDbA, addLevels(row.session.sourceOnlyDbA, 30));
  close(row.session.aboveBackgroundDb, row.session.sourceOnlyDbA - 30);
  close(row.session.totalRiseDb, row.session.totalDbA - 30);
});

test('ten percent active time at +10dB adds 2.79dB before voice duty averaging', () => {
  const model = createNeighborModel(dwelling());
  const row = model.compareScenarios(source, {}, config, { conversation: { typicalLevel: 60, loudLevel: 70, loudFraction: 0.1, duty: 1 } })[0];
  close(row.loud.sourceOnlyDbA - row.active.sourceOnlyDbA, 10);
  close(row.session.sourceOnlyDbA - row.active.sourceOnlyDbA, 10 * Math.log10(0.9 + 0.1 * 10));
  assert.match(row.assumptions.loudDefinition, /LAFmax가 아님/);
});

test('continuous speaker remains active during voice pauses, including watching-only scenario', () => {
  const model = createNeighborModel(dwelling());
  const override = { voiceEnabled: false, speakerEnabled: true, speakerLevel: 65, speakerDuty: 1, duty: 0 };
  const row = model.compareScenarios(source, {}, config, { livestream: override })[1];
  close(row.active.sourceOnlyDbA, row.loud.sourceOnlyDbA);
  close(row.session.sourceOnlyDbA, row.active.sourceOnlyDbA);
  const occasional = model.compareScenarios(source, {}, config, { livestream: { ...override, speakerDuty: 0.5, duty: 1 } })[1];
  close(occasional.session.sourceOnlyDbA, row.active.sourceOnlyDbA + 10 * Math.log10(0.5));
});

test('mixed voice and speaker combine received octave energies rather than averaging dB', () => {
  const model = createNeighborModel(dwelling());
  const voice = model.evaluate({ ...source, type: 'voice', level: 60 }, {}, config);
  const speaker = model.evaluate({ ...source, type: 'pink', level: 60 }, {}, config);
  const mixed = model.compareScenarios(source, {}, config, { conversation: { typicalLevel: 60, pitch: 160, speakerEnabled: true, speakerLevel: 60 } })[0];
  close(mixed.active.sourceOnlyDbA, addLevels(voice.sourceOnlyDbA, speaker.sourceOnlyDbA));
});

test('detached gap lowers received level and neighbour open window increases it with bounded escape', () => {
  const model = createNeighborModel(dwelling()), route = { ...config, route: 'detached', neighborWindowAreaM2: 2 };
  const near = model.evaluate(source, {}, { ...route, gapM: 1 });
  const far = model.evaluate(source, {}, { ...route, gapM: 8 });
  assert.ok(far.sourceOnlyDbA < near.sourceOnlyDbA - 5);
  const closed = model.evaluate(source, {}, { ...route, gapM: 3, neighborWindowOpen: false });
  const opened = model.evaluate(source, {}, { ...route, gapM: 3, neighborWindowOpen: true });
  assert.ok(opened.sourceOnlyDbA > closed.sourceOnlyDbA + 10);
  assert.ok(opened.receiverAbsorptionM2.every(value => value >= opened.details.intrinsicAbsorptionM2 + 2));
  assert.ok(opened.transmissionLossDb.every(Number.isFinite));
});

test('±10dB cases are ordered assumption scenarios; an all-open aperture is unaffected by closed-wall TL', () => {
  const model = createNeighborModel(dwelling());
  const shared = model.evaluate(source, {}, config);
  assert.deepEqual(shared.sensitivity.map(item => item.offsetDb), [-10, 0, 10]);
  assert.ok(shared.sensitivity[0].sourceOnlyDbA > shared.sensitivity[1].sourceOnlyDbA);
  assert.ok(shared.sensitivity[1].sourceOnlyDbA > shared.sensitivity[2].sourceOnlyDbA);
  const opened = model.evaluate(source, {}, { ...config, route: 'detached', neighborWindowAreaM2: 10, neighborWindowOpen: true });
  close(opened.sensitivity[0].sourceOnlyDbA, opened.sensitivity[1].sourceOnlyDbA);
  close(opened.sensitivity[1].sourceOnlyDbA, opened.sensitivity[2].sourceOnlyDbA);
});

test('silent session and disabled sources report no contribution, leaving receiver background intact', () => {
  const model = createNeighborModel(dwelling());
  const off = model.compareScenarios(source, {}, config, { conversation: { voiceEnabled: false, speakerEnabled: false } })[0];
  assert.equal(off.active.silent, true);
  assert.equal(off.active.sourceOnlyDbA, null);
  close(off.active.totalDbA, 30);
  const paused = model.compareScenarios(source, {}, config, { conversation: { duty: 0, speakerEnabled: false } })[0];
  assert.equal(paused.session.silent, true);
  assert.equal(paused.active.silent, false);
});

test('exterior evaluation supports hypothetical neighbour locations without widening normal placement', () => {
  const scene = createAcousticModel(dwelling()), receiver = { x: 8, y: 1.2, z: 2 };
  assert.throws(() => scene.evaluate(source, receiver), RangeError);
  const exterior = scene.evaluateExterior(source, receiver);
  assert.equal(exterior.roomId, null);
  assert.equal(exterior.rt60, null);
  assert.ok(Number.isFinite(exterior.sourceOnlyDbA));
  assert.throws(() => scene.evaluateExterior(source, { x: 2, y: 1.2, z: 3 }), RangeError);
});

test('real house has finite scenario results, no internal junction facades, and accepts a garden source', async () => {
  const data = JSON.parse(await readFile(new URL('../cad/model.json', import.meta.url), 'utf8'));
  const model = createNeighborModel(data), actualSource = { ...source, x: 2.9, y: 1.5, z: 3.2 };
  assert.deepEqual(model.boundaries.filter(item => item.roomId === 'room17').map(item => item.side), ['south']);
  assert.deepEqual(model.boundaries.filter(item => item.roomId === 'room14').map(item => item.side), ['north', 'south']);
  for (const route of ['shared-wall', 'floor-above', 'floor-below', 'detached']) {
    const rows = model.compareScenarios(actualSource, {}, { route, boundaryRoomId: 'room14', boundarySide: 'north' });
    assert.deepEqual(rows.map(row => row.id), Object.keys(NEIGHBOR_SCENARIOS));
    for (const row of rows) {
      assert.ok([row.active.sourceOnlyDbA, row.loud.sourceOnlyDbA, row.session.sourceOnlyDbA].every(Number.isFinite));
      assert.ok(row.active.totalDbA >= 30);
      assert.ok(row.session.receivedBandsDb.every(Number.isFinite));
    }
  }
  const garden = model.evaluate({ ...actualSource, x: 3.2, z: 6.55 }, {}, { boundaryRoomId: 'room14', boundarySide: 'north' });
  assert.ok(Number.isFinite(garden.sourceOnlyDbA));
});
