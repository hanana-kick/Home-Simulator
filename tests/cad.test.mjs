import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../cad/${file}`, import.meta.url));
const model = JSON.parse(read('model.json'));
const objects = new Map(model.objects.map(object => [object.id, object]));
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon,
  `${actual} differs from ${expected}`);
const corners = object => {
  const points = [], angle = object.ry || 0;
  for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) for (const c of [-0.5, 0.5]) {
    const x = a * object.s[0], y = b * object.s[1], z = c * object.s[2];
    points.push([(x * Math.cos(angle) + z * Math.sin(angle) + object.p[0]) * 1000,
      -(z * Math.cos(angle) - x * Math.sin(angle) + object.p[2]) * 1000,
      (y + object.p[1]) * 1000]);
  }
  return points;
};
const nearCorner = (point, expected, label) => assert.ok(expected.some(corner =>
  corner.every((value, axis) => Math.abs(value - point[axis]) <= 0.001)),
`Unexpected ${label} corner ${point}`);

test('model wall height, window heads and room floor areas agree', () => {
  assert.equal(model.revision, 4);
  assert.equal(model.wallHeightM, 2.3);
  assert.equal(model.assumptions.wallHeightM, 2.3);
  assert.equal(model.assumptions.wallHeightSource, 'user-specified');
  for (const object of model.objects.filter(object => object.wall)) {
    assert.ok(object.p[1] + object.s[1] / 2 <= 2.3 + 1e-8, object.id);
    if (object.s[1] > 2.2) near(object.p[1] + object.s[1] / 2, 2.3);
  }
  for (const opening of model.openings) {
    assert.ok(opening.head > opening.sill && opening.head <= 2.3);
    if (opening.kind === 'door') assert.equal(opening.head, 2.1);
  }
  for (const room of model.rooms) {
    const area = Math.abs(room.poly.reduce((sum, [x, z], i) => {
      const [nextX, nextZ] = room.poly[(i + 1) % room.poly.length];
      return sum + x * nextZ - nextX * z;
    }, 0)) / 2;
    near(area, room.modelAreaM2, 0.001);
  }
  near(objects.get('obj-0167').p[1], 2.11); // Fixed shower fitting is not lowered.
  near(objects.get('obj-0253').s[1], 2.09); // Freestanding shelf is not shortened.
  near(objects.get('obj-0160').s[1], 2.05); // Independent shower partition is unchanged.
  near(objects.get('obj-0016').p[1] + objects.get('obj-0016').s[1] / 2, 0.5);
});

test('all GLB nodes use the same transforms as the authoritative model', () => {
  const buffer = read('floorplan_3d.glb');
  assert.equal(buffer.readUInt32LE(0), 0x46546c67);
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  const length = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + length));
  assert.equal(gltf.nodes.length, model.objects.length);
  assert.equal(gltf.extras.assumptions.wallHeightM, 2.3);
  for (const node of gltf.nodes) {
    const object = objects.get(node.extras.id);
    assert.ok(object, node.name);
    assert.deepEqual(node.translation, object.p, object.id);
    assert.deepEqual(node.scale, object.s, object.id);
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      if (object.wall) near(node.translation[1] + accessor.max[1] * node.scale[1],
        object.p[1] + object.s[1] / 2);
    }
  }
  const binStart = 28 + length;
  for (const accessor of gltf.accessors) {
    assert.equal(accessor.componentType, 5126);
    const view = gltf.bufferViews[accessor.bufferView];
    const stride = view.byteStride || 12;
    for (let index = 0; index < accessor.count; index++) {
      const at = binStart + (view.byteOffset || 0) + (accessor.byteOffset || 0) + index * stride;
      for (let axis = 0; axis < 3; axis++) {
        const value = buffer.readFloatLE(at + axis * 4);
        assert.ok(Number.isFinite(value));
        if (accessor.min) assert.ok(value >= accessor.min[axis] - 1e-6);
        if (accessor.max) assert.ok(value <= accessor.max[axis] + 1e-6);
      }
    }
  }
});

test('STEP box solids match the model including their 2300 mm wall tops', () => {
  const step = read('floorplan_3d.step').toString('utf8');
  const entities = new Map([...step.matchAll(/^#(\d+)=(.*);$/gm)].map(match => [match[1], match[2]]));
  const visit = (id, seen = new Set(), result = []) => {
    if (seen.has(id)) return result;
    seen.add(id);
    const entity = entities.get(id);
    assert.ok(entity, id);
    const point = /^CARTESIAN_POINT\('',\(([^)]+)\)\)$/.exec(entity);
    if (point) result.push(point[1].split(',').map(Number));
    for (const match of entity.matchAll(/#(\d+)/g)) visit(match[1], seen, result);
    return result;
  };
  let count = 0;
  for (const [id, entity] of entities) {
    const object = objects.get(/^FACETED_BREP\('(obj-\d+)/.exec(entity)?.[1]);
    if (!object || object.shape !== 'box') continue;
    const points = visit(id), expected = corners(object);
    assert.equal(points.length, 8, object.id);
    for (const point of points) nearCorner(point, expected, object.id);
    count++;
  }
  assert.ok(count > 180);
  assert.equal([...step.matchAll(/FACETED_BREP\(/g)].length, 250);
});

test('DXF architectural face coordinates agree with the model', () => {
  const chunks = read('floorplan_3d.dxf').toString('utf8').split('\n0\n3DFACE\n').slice(1);
  assert.equal(chunks.length, 6821);
  let cursor = 0, boxes = 0;
  for (const object of model.objects) {
    if (object.shape === 'mesh') break;
    const count = object.shape === 'box' ? 6 : 3 * (object.segments || 32) - 4;
    if (object.shape === 'box') {
      const expected = corners(object);
      for (const chunk of chunks.slice(cursor, cursor + count)) {
        const fields = new Map([...chunk.matchAll(/^(\d+)\n([^\n]+)/gm)].map(match => [Number(match[1]), match[2]]));
        for (let vertex = 0; vertex < 4; vertex++) {
          const point = [10 + vertex, 20 + vertex, 30 + vertex].map(code => Number(fields.get(code)));
          nearCorner(point, expected, object.id);
        }
      }
      boxes++;
    }
    cursor += count;
  }
  assert.ok(boxes > 150);
});

test('OpenSCAD editable box sizes and positions agree with the model', () => {
  const scad = read('floorplan_3d.scad').toString('utf8');
  let boxes = 0;
  for (const match of scad.matchAll(/\/\/ (obj-\d+) \|[^\n]*\n([^\n]+)/g)) {
    const object = objects.get(match[1]);
    if (object.shape !== 'box') continue;
    const p = /translate\(\[([^\]]+)\]\)/.exec(match[2])[1].split(',').map(Number);
    const s = /cube\(\[([^\]]+)\]/.exec(match[2])[1].split(',').map(Number);
    const expectedP = [object.p[0], -object.p[2], object.p[1]].map(value => value * 1000);
    const expectedS = [object.s[0], object.s[2], object.s[1]].map(value => value * 1000);
    for (let axis = 0; axis < 3; axis++) {
      near(p[axis], expectedP[axis], 0.001);
      near(s[axis], expectedS[axis], 0.001);
    }
    boxes++;
  }
  assert.equal(boxes, model.objects.filter(object => object.shape === 'box').length);
});
