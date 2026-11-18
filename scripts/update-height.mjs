import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reproducible revision 3 -> 4 migration. The source ref is immutable so running
// this twice never compresses a previously updated model a second time.
// Usage: node scripts/update-height.mjs [revision-3-git-ref]
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRef = process.argv[2] || '6760ef212a2259a90946effe7ee38550d3f9c70e';
const original = path => execFileSync('git', ['show', `${sourceRef}:${path}`], {
  cwd: root, maxBuffer: 20 * 1024 * 1024,
});
const save = (path, bytes) => writeFileSync(resolve(root, path), bytes);
const clean = value => Number(value.toFixed(9));
const height = value => clean(value <= 2.1 ? value : 2.1 + (value - 2.1) / 3);
const heightMm = value => clean(height(value / 1000) * 1000);
const model = JSON.parse(original('cad/model.json'));
assert.equal(model.wallHeightM, 2.7, 'Migration requires the revision 3 model.');

// Only architecture follows the new ceiling. In particular, the freestanding
// shower screen, shower fittings, shelves, furniture and garden are unchanged.
const followsCeiling = object => ['wallOuter', 'wallInner', 'bathroom'].includes(object.group)
  || (object.group === 'windows' && !object.label.startsWith('샤워 파티션'));
const changed = new Map();
for (const object of model.objects) {
  if (!followsCeiling(object)) continue;
  const bottom = object.p[1] - object.s[1] / 2;
  const top = object.p[1] + object.s[1] / 2;
  if (top <= 2.1 + 1e-9) continue;
  assert.equal(object.shape, 'box', `Unexpected architectural shape ${object.id}`);
  const low = height(bottom), high = height(top);
  object.p[1] = clean((low + high) / 2);
  object.s[1] = clean(high - low);
  changed.set(object.id, object);
}
for (const opening of model.openings) {
  opening.sill = height(opening.sill);
  opening.head = height(opening.head);
}
model.revision = 4;
model.wallHeightM = 2.3;
model.assumptions.wallHeightM = 2.3;
model.assumptions.wallHeightSource = 'user-specified';
model.assumptions.slidingDoorHeightM = height(model.assumptions.slidingDoorHeightM);
model.assumptions.verticalDimensionsSource = 'wall height user-specified; remaining heights assumed';
model.assumptions.interiorWallFinish = '일반 실크벽지 (종이 기재 + PVC 코팅), 욕실은 기존 타일';
model.assumptions.comment = '벽 높이 2,300mm는 사용자 지정. 2,100mm 이하 실내문·가구·평면 치수는 유지. 천장에 연결된 창호 및 벽 상부의 2,100~2,700mm 구간은 2,100~2,300mm로 조정한 가정값. 마당 담장·독립 샤워 파티션은 유지. 방위 미확인.';
model.materials.wallInside.finish = '일반 실크벽지 (종이 기재 + PVC 코팅)';
model.changes.push('Revision 4: 사용자 지정 벽 높이 2,300mm; 상부 창호·벽타일 정합 조정, 가구·평면 치수 유지');
model.sourcePolicy = '원본 평면 치수와 사용자 지정 벽 높이 2,300mm 우선. 기타 개구부 높이·가구 치수는 추정. 실내 건식 벽은 일반 PVC 코팅 실크벽지 마감으로 가정.';
save('cad/model.json', JSON.stringify(model) + '\n');

// STEP contains an independent FACETED_BREP graph for each object. Restrict the
// coordinate migration to points reachable from the changed architecture.
let step = original('cad/floorplan_3d.step').toString('utf8');
const entities = new Map([...step.matchAll(/^#(\d+)=(.*);$/gm)].map(match => [match[1], match[2]]));
const pointIds = new Set();
const visit = (id, seen) => {
  if (seen.has(id)) return;
  seen.add(id);
  const entity = entities.get(id);
  assert.ok(entity, `Missing STEP reference #${id}`);
  if (entity.startsWith('CARTESIAN_POINT(')) pointIds.add(id);
  for (const reference of entity.matchAll(/#(\d+)/g)) visit(reference[1], seen);
};
let stepObjects = 0;
for (const [id, entity] of entities) {
  const objectId = /^FACETED_BREP\('(obj-\d+)/.exec(entity)?.[1];
  if (changed.has(objectId)) { visit(id, new Set()); stepObjects++; }
}
assert.equal(stepObjects, changed.size, 'Every changed architectural object must have a STEP solid.');
let stepPoints = 0;
step = step.replace(/^(#(\d+)=CARTESIAN_POINT\('',\()([^,]+),([^,]+),([^\)]+)(\)\);)$/gm,
  (line, prefix, id, x, y, z, suffix) => {
    if (!pointIds.has(id) || Number(z) <= 2100 + 1e-6) return line;
    stepPoints++;
    const value = heightMm(Number(z));
    return `${prefix}${x},${y},${Number.isInteger(value) ? value + '.' : value}${suffix}`;
  });
step = step.replace("PRODUCT('PLAN3D_V2'", "PRODUCT('PLAN3D_V4'")
  .replace("PRODUCT_DEFINITION_FORMATION('2'", "PRODUCT_DEFINITION_FORMATION('4'")
  .replace('Reference reconstruction; model units mm', 'Revision 4; user-specified walls 2300 mm; model units mm');
save('cad/floorplan_3d.step', step);

// The original DXF lists objects in model order, with six faces per box. Its
// cylinders use 32 segments; n-gon caps are exported as triangle fans. All
// architecture needing a height change precedes the first custom mesh.
let dxf = original('cad/floorplan_3d.dxf').toString('utf8');
const chunks = dxf.split('\n0\n3DFACE\n');
let cursor = 1, dxfFaces = 0;
const layerFor = { foundation: 'A_FOUNDATION', floors: 'B_FLOORS', garden: 'H_GARDEN',
  wallOuter: 'C_EXT_WALL', wallInner: 'D_INT_WALL', windows: 'F_WINDOWS', doors: 'E_DOORS',
  bathroom: 'J_BATHROOM' };
const oldModel = JSON.parse(original('cad/model.json'));
const remaining = new Set(changed.keys());
for (const object of oldModel.objects) {
  if (!remaining.size) break;
  assert.ok(['box', 'cylinder'].includes(object.shape), 'Unexpected DXF ordering before architecture.');
  const count = object.shape === 'box' ? 6 : 3 * (object.segments || 32) - 4;
  for (let n = 0; n < count; n++, cursor++) {
    const chunk = chunks[cursor];
    assert.equal(/^8\n([^\n]+)/.exec(chunk)?.[1], layerFor[object.group], `DXF layer mismatch at ${object.id}`);
    if (!changed.has(object.id)) continue;
    const originalBottom = (object.p[1] - object.s[1] / 2) * 1000;
    const originalTop = (object.p[1] + object.s[1] / 2) * 1000;
    chunks[cursor] = chunk.replace(/^(3[0-3])\n([^\n]+)/gm, (line, code, value) => {
      const z = Number(value);
      assert.ok(Math.abs(z - originalBottom) < 0.001 || Math.abs(z - originalTop) < 0.001,
        `DXF face bounds do not match ${object.id}: ${z}`);
      return z <= 2100 ? line : `${code}\n${heightMm(z)}`;
    });
    dxfFaces++;
  }
  remaining.delete(object.id);
}
assert.equal(remaining.size, 0);
save('cad/floorplan_3d.dxf', chunks.join('\n0\n3DFACE\n'));

// OpenSCAD's box transforms use X right, Y plan-up, Z vertical, in mm.
let scad = original('cad/floorplan_3d.scad').toString('utf8');
let scadObjects = 0;
scad = scad.replace(/(\/\/ (obj-\d+) \|[^\n]*\n)([^\n]+)/g, (block, comment, id, statement) => {
  const object = changed.get(id);
  if (!object) return block;
  assert.match(statement, /cube\(/);
  statement = statement.replace(/translate\(\[([^,]+),([^,]+),([^\]]+)\]\)/,
    (_, x, y) => `translate([${x},${y},${clean(object.p[1] * 1000)}])`);
  statement = statement.replace(/cube\(\[([^,]+),([^,]+),([^\]]+)\]/,
    (_, x, y) => `cube([${x},${y},${clean(object.s[1] * 1000)}]`);
  scadObjects++;
  return comment + statement;
});
assert.equal(scadObjects, changed.size);
scad = scad.replace('// Independent editable solids. Heights/opening details are image-derived assumptions.',
  '// Revision 4. Walls are user-specified at 2300 mm. Other heights/openings remain assumptions.\n// Ceiling-connected architecture above 2100 mm was compressed to fit; furniture and plan sizes are unchanged.');
save('cad/floorplan_3d.scad', scad);

// glTF uses shared local box geometry and node transforms. Changing these node
// transforms preserves local normals/accessor bounds and all binary geometry.
const glb = original('cad/floorplan_3d.glb');
assert.equal(glb.readUInt32LE(0), 0x46546c67);
const jsonLength = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
let glbObjects = 0;
for (const node of gltf.nodes) {
  const object = changed.get(node.extras.id);
  if (!object) continue;
  assert.equal(node.translation[0], object.p[0]);
  assert.equal(node.translation[2], object.p[2]);
  node.translation = [...object.p];
  node.scale = [...object.s];
  glbObjects++;
}
assert.equal(glbObjects, changed.size);
gltf.extras.assumptions = model.assumptions;
gltf.extras.revision = 4;
gltf.asset.generator = 'Plan3D reference reconstruction exporter; revision 4 height migration';
const json = Buffer.from(JSON.stringify(gltf));
const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
json.copy(padded);
const tail = glb.subarray(20 + jsonLength);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(header.length + padded.length + tail.length, 8);
header.writeUInt32LE(padded.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
save('cad/floorplan_3d.glb', Buffer.concat([header, padded, tail]));

console.log(JSON.stringify({ revision: 4, wallHeightM: 2.3, architecturalObjects: changed.size,
  stepPoints, dxfFaces, glbObjects, scadObjects, unchangedPlan: true, unchangedFurniture: true }));
