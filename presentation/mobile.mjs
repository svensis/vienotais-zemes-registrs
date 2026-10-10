import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:5173/#/?cad=01000070142');
await page.waitForTimeout(14000);
await page.screenshot({ path: 'shots/mob2.png' });
// drag the grabber up to the full detent
const g = await page.locator('.grabber').boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + 10);
await page.mouse.down();
await page.mouse.move(g.x + g.width / 2, g.y - 300, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/mob3.png' });
await browser.close();
