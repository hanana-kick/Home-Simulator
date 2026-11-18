import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '_site');
const model = JSON.parse(await readFile(resolve(root, 'cad/model.json'), 'utf8'));
if (model.wallHeightM !== 2.3) throw new Error('Wall height must be 2.3 m.');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of await readdir(resolve(root, 'source'))) {
  if (/\.(html|css|js|mjs|json)$/.test(name)) await cp(resolve(root, 'source', name), resolve(out, name));
}
for (const name of ['cad', 'references']) await cp(resolve(root, name), resolve(out, name), { recursive: true });
await writeFile(resolve(out, '.nojekyll'), '');
const files = ['index.html', 'main.js', 'viewer.js', 'acoustics.mjs', 'noise-ui.js', 'acoustics-worker.js', 'styles.css', 'noise.css', 'cad/model.json', 'cad/floorplan_3d.step', 'cad/floorplan_3d.glb', 'cad/floorplan_3d.dxf', 'cad/floorplan_3d.scad'];
const hashes = {};
for (const name of files) {
  const data = await readFile(resolve(out, name));
  if (!data.length) throw new Error('Empty build file: ' + name);
  hashes[name] = createHash('sha256').update(data).digest('hex');
}
await writeFile(resolve(out, 'build-manifest.json'), JSON.stringify({ revision: model.revision, wallHeightM: model.wallHeightM, sha256: hashes }, null, 2) + '\n');
console.log(`Built ${files.length} verified assets; wall height ${model.wallHeightM * 1000} mm.`);
