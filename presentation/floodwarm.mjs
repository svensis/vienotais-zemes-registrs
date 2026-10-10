// Iesilda servera plūdu flīžu kešu demo vietām, lai pirmais skats ir uzreiz.
// Lietojums: node floodwarm.mjs   (BASE no lib.mjs / ZK_URL)
import { BASE } from './lib.mjs';

// Demo vietas — [nosaukums, lat, lon]
const SPOTS = [
  ['spunciems', 56.9251279999, 23.689051403],
  ['vecaki', 57.0334477363, 24.1849134722],
];
const LAYERS = ['14', '28', '42', '67', '81', '95'];
const ZOOMS = [12, 13, 14, 15, 16, 17, 18];
// 1600×1000 skats ≈ 7×5 flīzes; ±4 / ±3 ar rezervi
const DX = 4;
const DY = 3;
const PARALLEL = 8;

/** lat/lon → XYZ flīzes indekss (Web Mercator). */
function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}

const urls = [];
for (const [, lat, lon] of SPOTS) {
  for (const z of ZOOMS) {
    const c = tileOf(lat, lon, z);
    for (const layer of LAYERS) {
      for (let dx = -DX; dx <= DX; dx++) {
        for (let dy = -DY; dy <= DY; dy++) {
          urls.push(`${BASE}/api/tiles/lvgmc/${layer}/${z}/${c.x + dx}/${c.y + dy}.png`);
        }
      }
    }
  }
}

// Vienkāršs darba baseins — PARALLEL vienlaicīgi
let done = 0;
let failed = 0;
const started = Date.now();
async function worker() {
  while (urls.length) {
    const url = urls.pop();
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) failed++;
    await res?.arrayBuffer().catch(() => null);
    if (++done % 500 === 0) console.log(`${done} flīzes · ${failed} kļūdas · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
}
const total = urls.length;
await Promise.all(Array.from({ length: PARALLEL }, worker));
console.log(`gatavs: ${total} flīzes, ${failed} kļūdas, ${((Date.now() - started) / 1000).toFixed(0)} s`);
