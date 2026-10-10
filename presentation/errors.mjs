import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:5173/#/');
await page.waitForTimeout(1500);
// 1) click on the Gulf of Riga: no parcel
await page.evaluate(() => window.dispatchEvent(new CustomEvent('zk:locate', { detail: { lat: 57.2, lon: 23.6, zoom: 12 } })));
await page.waitForTimeout(3500);
await page.mouse.click(600, 450);
await page.waitForTimeout(3000);
console.log('toast sea:', await page.locator('.toast').textContent().catch(() => 'NONE'));
await page.screenshot({ path: 'shots/err-sea.png' });
// 2) API down
await page.route('**/api/**', (r) => r.abort());
await page.evaluate(() => window.dispatchEvent(new CustomEvent('zk:locate', { detail: { lat: 56.95, lon: 24.1, zoom: 17 } })));
await page.waitForTimeout(3500);
await page.mouse.click(600, 450);
await page.waitForTimeout(2500);
console.log('toast offline:', await page.locator('.toast').textContent().catch(() => 'NONE'));
// 3) search a number that doesn't exist
await page.unroute('**/api/**');
await page.fill('.search-field input', '99999999999');
await page.press('.search-field input', 'Enter');
await page.waitForTimeout(3500);
console.log('search note:', await page.locator('.search-note').textContent().catch(() => 'NONE'));
await page.screenshot({ path: 'shots/err-search.png' });
await browser.close();
