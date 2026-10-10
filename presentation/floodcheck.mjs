// Pārbaude: vai LVĢMC plūdu flīzes pārlūkā tiešām ielādējas (statuss, izmērs).
// Lietojums: node floodcheck.mjs [kadastrs] [gadi]
import { chromium } from 'playwright';
import { BASE } from './lib.mjs';

const cad = process.argv[2] || '80880050264';
const years = process.argv[3] || '100';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// Krājam katru export pieprasījumu: statuss + baitu skaits
const tiles = [];
page.on('response', async (res) => {
  if (!res.url().includes('lvgmc') || !res.url().includes('/export')) return;
  const body = await res.body().catch(() => Buffer.alloc(0));
  tiles.push({ status: res.status(), bytes: body.length, type: res.headers()['content-type'] });
});
page.on('requestfailed', (req) => {
  if (req.url().includes('lvgmc')) tiles.push({ failed: req.failure()?.errorText });
});

await page.goto(`${BASE}/#/?cad=${cad}&l=pludi&y=${years}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(Number(process.env.WAIT_MS || 12000));
await page.screenshot({ path: `/tmp/floodcheck-${cad}-${years}.png` });

// Kas notiek ar LVĢMC flīžu <img> DOM: cik ielādēti, cik paslēpti, kāds slāņa z-index
const dom = await page.evaluate(() => {
  const layers = [...document.querySelectorAll('.leaflet-tile-pane > .leaflet-layer')];
  return layers.map((layer) => {
    const imgs = [...layer.querySelectorAll('img')];
    const lv = imgs.filter((i) => i.src.includes('lvgmc'));
    return {
      z: layer.style.zIndex,
      opacity: layer.style.opacity,
      imgs: imgs.length,
      lvgmc: lv.length,
      loaded: lv.filter((i) => i.classList.contains('leaflet-tile-loaded')).length,
      hidden: lv.filter((i) => i.style.opacity === '0').length,
      containers: [...layer.querySelectorAll('.leaflet-tile-container')].map((c) => `${c.style.zIndex}:${c.children.length}`),
      sample: lv[0]?.src.match(/layers=[^&]+/)?.[0],
    };
  });
});
console.log(JSON.stringify(dom, null, 1));

// Flīzes ekrāna vidū — pilnās URL, lai tās var lejupielādēt un apskatīt
const mid = await page.evaluate(() => {
  const cx = 600;
  const cy = 500;
  return [...document.querySelectorAll('img.leaflet-tile')]
    .filter((i) => i.src.includes('show%3A95') || i.src.includes('show%3A81') || i.src.includes('show%3A67'))
    .map((i) => ({ r: i.getBoundingClientRect(), src: i.src }))
    .filter(({ r }) => r.left < cx && r.right > cx - 300 && r.top < cy && r.bottom > cy - 200)
    .map(({ src }) => src);
});
console.log(mid.join('\n'));

// Kopsavilkums: cik flīžu, cik tukšu (caurspīdīgs PNG ir ~ <1 KB)
const summary = {};
for (const t of tiles) {
  const key = t.failed ? `failed:${t.failed}` : `${t.status}:${t.bytes > 1000 ? 'data' : 'empty'}`;
  summary[key] = (summary[key] || 0) + 1;
}
console.log(JSON.stringify({ count: tiles.length, summary }));
await browser.close();
