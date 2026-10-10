// Quick screenshot helper for UI checks: node shot.mjs <name> <width> <height> <hash> [clickX clickY] [waitMs]
import { chromium } from 'playwright';
const [name, w, h, hash = '#/', cx, cy, wait = '9000'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:5173/' + hash);
await page.waitForTimeout(2500);
if (cx && cy) { await page.mouse.click(Number(cx), Number(cy)); }
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: `shots/${name}.png` });
await browser.close();
