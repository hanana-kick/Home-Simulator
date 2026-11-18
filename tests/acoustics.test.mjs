import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BANDS, MATERIALS, createAcousticModel, sourceSpectrum, aWeightedLevel, freeFieldLevel, rectangleSolidAngle,
} from '../source/acoustics.mjs';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} to equal ${expected} within ${tolerance}`,
);

function twoRooms() {
  return {
    wallHeightM: 2.3, cutHeightM: 1.08,
    rooms: [
      { id: 'a', name: 'A', kind: 'interior', center: [2, 2], poly: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      { id: 'b', name: 'B', kind: 'interior', center: [6.2, 2], poly: [[4.2, 0], [8.2, 0], [8.2, 4], [4.2, 4]] },
    ],
    objects: [
      { id: 'wall-1', label: 'shared door', wall: true, shape: 'box', p: [4.1, 1.15, 0.75], s: [0.2, 2.3, 1.5] },
      { id: 'wall-2', label: 'shared door', wall: true, shape: 'box', p: [4.1, 1.15, 3.25], s: [0.2, 2.3, 1.5] },
      { id: 'wall-head', label: 'shared door', wall: true, shape: 'box', p: [4.1, 2.2, 2], s: [0.2, 0.2, 1] },
    ],
    openings: [{ axis: 'x', k: 4.1, lo: 1.5, hi: 2.5, sill: 0, head: 2.1, kind: 'door', label: 'shared door' }],
  };
}

const source = { x: 1, y: 1.2, z: 2, type: 'voice', level: 60, pitch: 160 };

test('all spectra are calibrated to selected dBA at 1 m, including pitch changes', () => {
  for (const type of ['voice', 'pink', 'white', 'tone']) {
    for (const pitch of [80, 125, 160, 250, 350, 400]) {
      for (const level of [35, 60, 85]) {
        const bands = sourceSpectrum({ type, pitch, level, frequency: 500 });
        assert.equal(bands.length, BANDS.length);
        assert.ok(bands.every(Number.isFinite));
        close(aWeightedLevel(bands), level);
      }
    }
  }
});

test('changing voice pitch changes spectral distribution without changing source dBA', () => {
  const low = sourceSpectrum({ ...source, pitch: 90 }), high = sourceSpectrum({ ...source, pitch: 330 });
  assert.ok(low.some((value, i) => Math.abs(value - high[i]) > 2));
  close(aWeightedLevel(low), aWeightedLevel(high));
});

test('free field follows inverse square pressure energy, losing 6.0206 dB per doubling', () => {
  close(freeFieldLevel(60, 1), 60);
  close(freeFieldLevel(60, 1) - freeFieldLevel(60, 2), 20 * Math.log10(2));
  const scene = createAcousticModel(twoRooms());
  const settings = { reverberation: false, background: null };
  const near = scene.evaluate(source, { x: 2, y: 1.2, z: 2 }, settings);
  const far = scene.evaluate(source, { x: 3, y: 1.2, z: 2 }, settings);
  close(near.sourceOnlyDbA, 60);
  close(near.sourceOnlyDbA - far.sourceOnlyDbA, 20 * Math.log10(2));
});

test('facade solid-angle integration remains bounded near large openings and matches far-field area projection', () => {
  const patch = { axis: 'z', k: 0, lo: -1, hi: 1, bottom: 0, top: 2 };
  const near = rectangleSolidAngle(patch, { x: 0, y: 1, z: 0.001 });
  assert.ok(near < 2 * Math.PI && near > 6.2);
  const far = rectangleSolidAngle(patch, { x: 0, y: 1, z: 100 });
  close(far, 4 / 100 ** 2, 5e-8);
  const subdivisions = [
    { ...patch, hi: 0 },
    { ...patch, lo: 0 },
  ];
  const point = { x: 0.2, y: 0.6, z: 0.1 };
  close(subdivisions.reduce((sum, part) => sum + rectangleSolidAngle(part, point), 0), rectangleSolidAngle(patch, point));
});

test('a 10 dB source increase produces 10 dB more source-only sound through coupled rooms', () => {
  const scene = createAcousticModel(twoRooms()), receiver = { x: 6, y: 1.2, z: 3.5 };
  const quiet = scene.evaluate(source, receiver, { background: 45 });
  const loud = scene.evaluate({ ...source, level: 70 }, receiver, { background: 45 });
  close(loud.sourceOnlyDbA - quiet.sourceOnlyDbA, 10);
  assert.ok(loud.levelDbA - quiet.levelDbA < 10, 'independent background does not scale with the source');
});

test('direct ray sees a closed door as its band transmission loss and an open door as aperture', () => {
  const scene = createAcousticModel(twoRooms()), receiver = { x: 5, y: 1.2, z: 2 };
  const tone = { ...source, type: 'tone', frequency: 500 };
  const closed = scene.evaluate(tone, receiver, { reverberation: false, background: null });
  const open = scene.evaluate(tone, receiver, { reverberation: false, background: null, doorStates: { 'opening-0': true } });
  close(open.directDbA - closed.directDbA, MATERIALS.door.transmissionLoss[2]);
  assert.equal(closed.crossings.length, 1);
  assert.equal(closed.crossings[0].type, 'door');
  close(open.sourceOnlyDbA, freeFieldLevel(60, 4));
});

test('opening a door raises sound in the next room even without direct sight through the door', () => {
  const scene = createAcousticModel(twoRooms());
  const offAxisSource = { ...source, z: 3.5 }, receiver = { x: 6, y: 1.2, z: 3.5 };
  const closed = scene.evaluate(offAxisSource, receiver, { background: null });
  const open = scene.evaluate(offAxisSource, receiver, { background: null, doorStates: { 'opening-0': true } });
  assert.equal(closed.crossings[0].type, 'wall');
  close(open.directDbA, closed.directDbA);
  assert.ok(open.sourceOnlyDbA > closed.sourceOnlyDbA + 8);
  assert.ok(open.reverberantDbA > closed.reverberantDbA + 8);
});

test('visual cut height cannot leak sound over acoustic walls or remove acoustic ceiling volume', () => {
  const data = twoRooms(), scene = createAcousticModel(data), receiver = { x: 6, y: 2.2, z: 3.5 };
  const before = scene.evaluate({ ...source, y: 2.2, z: 3.5 }, receiver);
  data.cutHeightM = 0.1;
  const after = createAcousticModel(data).evaluate({ ...source, y: 2.2, z: 3.5 }, receiver);
  assert.equal(before.crossings[0].type, 'wall');
  close(before.levelDbA, after.levelDbA);
  close(scene.rooms[0].volume, 16 * 2.3);
  assert.ok(before.rt60.every(t => t > 0));
});

test('furnishing absorption shortens the local reverberation estimate and lowers diffuse energy', () => {
  const scene = createAcousticModel(twoRooms()), receiver = { x: 3, y: 1.2, z: 3 };
  const empty = scene.evaluate(source, receiver, { furnished: false, background: null });
  const furnished = scene.evaluate(source, receiver, { furnished: true, background: null });
  assert.ok(furnished.reverberantDbA < empty.reverberantDbA);
  assert.ok(furnished.rt60[3] < empty.rt60[3]);
});

test('source and receiver cannot be placed inside wall thickness or above the ceiling', () => {
  const scene = createAcousticModel(twoRooms());
  assert.equal(scene.isPositionValid({ x: 4.1, y: 1.2, z: 3 }), false);
  assert.equal(scene.isPositionValid({ x: 1, y: 2.5, z: 2 }), false);
  assert.equal(scene.isPositionValid({ x: NaN, y: 1.2, z: 2 }), false);
  assert.throws(() => scene.evaluate({ ...source, x: 4.1 }, { x: 2, y: 1.2, z: 2 }), RangeError);
  assert.throws(() => scene.evaluate(source, { x: 2, y: 3, z: 2 }), RangeError);
});

test('coincident point source stays finite with explicitly flagged near-field limit', () => {
  const result = createAcousticModel(twoRooms()).evaluate(source, source);
  assert.equal(result.nearFieldLimited, true);
  assert.ok(Number.isFinite(result.levelDbA));
  close(result.directDbA, 60 - 20 * Math.log10(0.25));
});

test('noise floor adds in energy, with zero-dBA input kept at zero and not silently clamped to 20', () => {
  const scene = createAcousticModel(twoRooms()), receiver = { x: 2, y: 1.2, z: 2 };
  const noBackground = scene.evaluate({ ...source, level: 20 }, receiver, { reverberation: false, background: null });
  const zeroBackground = scene.evaluate({ ...source, level: 20 }, receiver, { reverberation: false, background: 0 });
  close(noBackground.levelDbA, 20);
  close(zeroBackground.levelDbA, 10 * Math.log10(100 + 1));
});

test('real dwelling topology identifies all doors and yields finite indoor/outdoor heatmap samples', async () => {
  const data = JSON.parse(await readFile(new URL('../cad/model.json', import.meta.url), 'utf8'));
  const scene = createAcousticModel(data);
  assert.equal(scene.openings.length, 11);
  assert.deepEqual(scene.openings[6].roomIds, ['room14', 'room17']);
  assert.deepEqual(scene.openings[9].roomIds, ['room6', 'room17']);
  const indoorSource = { ...source, x: 2.9, z: 3.2 };
  const grid = scene.sampleGrid(indoorSource, {}, { step: 0.4, height: 1.2 });
  assert.ok(grid.cells.length > 350);
  for (const cell of grid.cells) {
    assert.ok(Number.isFinite(cell.levelDbA));
    assert.ok(cell.levelDbA >= 30);
    assert.equal(scene.roomAt(cell.x, cell.z).id, cell.roomId);
  }
  const exterior = scene.evaluate(indoorSource, { x: 3.2, y: 1.2, z: 6.55 });
  assert.equal(exterior.rt60, null);
  const outdoorSource = { ...source, x: 6, z: 6.5 };
  const inside = scene.evaluate(outdoorSource, { x: 6.7, y: 1.2, z: 3.8 });
  assert.ok(Number.isFinite(inside.levelDbA));
  assert.equal(scene.roomSummary(indoorSource).length, data.rooms.length);
});
