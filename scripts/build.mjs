import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '_site');
const modelText = await readFile(resolve(root, 'cad/model.json'), 'utf8');
const model = JSON.parse(modelText);
if (model.wallHeightM !== 2.3) throw new Error('Wall height must be 2.3 m.');
const sourceNames = (await readdir(resolve(root, 'source'))).filter(name => /\.(html|css|js|mjs|json)$/.test(name)).sort();
const sources = await Promise.all(sourceNames.map(async name => [name, await readFile(resolve(root, 'source', name), 'utf8')]));
const versionHash = createHash('sha256').update(modelText).update(await readFile(fileURLToPath(import.meta.url)));
for (const [name, content] of sources) versionHash.update(name).update(content);
const assetVersion = versionHash.digest('hex').slice(0, 12);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [name, content] of sources) {
  const versioned = /\.(html|js|mjs)$/.test(name)
    ? content.replace(/(["'])\.\/([^"'?#]+\.(?:css|m?js|json|step|dxf|glb|scad))\1/g, (_match, quote, path) => `${quote}./${path}?v=${assetVersion}${quote}`)
    : content;
  await writeFile(resolve(out, name), versioned);
}
for (const name of ['cad', 'references']) await cp(resolve(root, name), resolve(out, name), { recursive: true });
await writeFile(resolve(out, '.nojekyll'), '');
const files = ['index.html', 'acoustic-notes.html', 'main.js', 'viewer.js', 'acoustics.mjs', 'noise-ui.js', 'acoustics-worker.js', 'neighbors.mjs', 'neighbor-ui.js', 'neighbor-worker.js', 'wave-engine.mjs', 'wave-audio.mjs', 'wave-worker.js', 'wave-ui.js', 'wave.css', 'broadband.mjs', 'broadband-ui.js', 'broadband.css', 'broadband-audio.mjs', 'broadband-audio-worker.js', 'broadband-io.mjs', 'styles.css', 'noise.css', 'neighbor.css', 'app-modes.css', 'references.json', 'cad/model.json', 'cad/floorplan_3d.step', 'cad/floorplan_3d.glb', 'cad/floorplan_3d.dxf', 'cad/floorplan_3d.scad'];
const hashes = {};
for (const name of files) {
  const data = await readFile(resolve(out, name));
  if (!data.length) throw new Error('Empty build file: ' + name);
  hashes[name] = createHash('sha256').update(data).digest('hex');
}
await writeFile(resolve(out, 'build-manifest.json'), JSON.stringify({ revision: model.revision, wallHeightM: model.wallHeightM, assetVersion, sha256: hashes }, null, 2) + '\n');
console.log(`Built ${files.length} verified assets; wall height ${model.wallHeightM * 1000} mm.`);
