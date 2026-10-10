import { chromium } from 'playwright';
const spots = { jelgava: [56.6511, 23.7213, 13], riga_daugava: [56.93, 24.22, 13], pavilosta: [56.8887, 21.1815, 14], salaspils: [56.86, 24.35, 13], liepaja: [56.51, 21.01, 13] };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
await page.goto('http://localhost:5173/#/?l=pludi&y=200');
await page.waitForTimeout(1500);
for (const [name, [lat, lon, z]] of Object.entries(spots)) {
  await page.evaluate(([la, lo, zz]) => window.dispatchEvent(new CustomEvent('zk:locate', { detail: { lat: la, lon: lo, zoom: zz } })), [lat, lon, z]);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `shots/fl-${name}.png` });
}
await browser.close();
