import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:5173/#/?cad=13000104001&l=pludi&y=200');
await page.waitForTimeout(9000);
// JSON export
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[aria-label="Lejupielādēt JSON"]')]);
await dl.saveAs('shots/export.json');
const json = JSON.parse(fs.readFileSync('shots/export.json', 'utf8'));
console.log('json facts:', json.facts.length, json.cadastre, json.facts.slice(0,3).map(f=>f.label+': '+f.value.slice(0,40)));
// Print layout
await page.pdf({ path: 'shots/print.pdf', format: 'A4', printBackground: true });
console.log('hash after load:', await page.evaluate(() => location.hash));
await browser.close();
