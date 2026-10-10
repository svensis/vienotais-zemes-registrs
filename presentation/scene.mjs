// node scene.mjs <name> <w> <h> <hash> <lat> <lon> <zoom> [clickX clickY]
import { chromium } from 'playwright';
const [name, w, h, hash, lat, lon, zoom, cx, cy] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:5173/' + hash);
await page.waitForTimeout(2000);
await page.evaluate(([la, lo, z]) => window.dispatchEvent(new CustomEvent('zk:locate', { detail: { lat: +la, lon: +lo, zoom: +z } })), [lat, lon, zoom]);
await page.waitForTimeout(9000);
if (cx && cy) { await page.mouse.click(+cx, +cy); await page.waitForTimeout(9000); }
await page.screenshot({ path: `shots/${name}.png` });
await browser.close();
