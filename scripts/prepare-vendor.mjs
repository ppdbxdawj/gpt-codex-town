import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const threeRoot = resolve(root, 'node_modules/three');
const packageInfo = JSON.parse(await readFile(resolve(threeRoot, 'package.json'), 'utf8'));

if (packageInfo.version !== '0.180.0') {
  throw new Error(`Expected three@0.180.0, found ${packageInfo.version}. Run npm ci before preparing vendor files.`);
}

const files = [
  ['build/three.module.js', 'public/vendor/three.module.js'],
  ['build/three.core.js', 'public/vendor/three.core.js'],
  ['examples/jsm/controls/OrbitControls.js', 'public/vendor/OrbitControls.js'],
  ['LICENSE', 'public/vendor/LICENSE-three.txt'],
];

for (const [from, to] of files) {
  const target = resolve(root, to);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(threeRoot, from), target);
}

console.log('Prepared local Three.js 0.180.0 runtime in public/vendor/.');
