// Kopīgie rīki ekrāna ierakstiem.
// Headless Chromium ierakstā nerāda peles kursoru, tāpēc zīmējam savu:
// mazu apli, kas seko pelei, un viļņveida pulsu uz klikšķa.
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/* Live demo by default; override with ZK_URL=http://localhost:5173 for local. */
export const BASE = process.env.ZK_URL || 'https://172.82.74.224.sslip.io/hakatons';
export const RAW = new URL('./clips/raw/', import.meta.url).pathname;
mkdirSync(RAW, { recursive: true });

// Kursora overlay: pievieno lapai pirms jebkura skripta.
const CURSOR_INIT = `
(() => {
  const mount = () => {
    if (document.getElementById('zk-cursor')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #zk-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;
        border-radius:50%;background:rgba(255,255,255,.92);border:2px solid rgba(0,0,0,.55);
        box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;transition:transform .12s ease-out}
      #zk-cursor.down{transform:scale(.72)}
      .zk-pulse{position:fixed;z-index:2147483646;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;
        border:3px solid rgba(10,132,255,.9);pointer-events:none;animation:zkp .7s ease-out forwards}
      @keyframes zkp{to{transform:scale(5);opacity:0}}\`;
    document.head.appendChild(style);
    const c = document.createElement('div');
    c.id = 'zk-cursor';
    c.style.transform = 'translate(-100px,-100px)';
    document.body.appendChild(c);
    let x = -100, y = -100, down = false;
    const paint = () => { c.style.transform = 'translate(' + x + 'px,' + y + 'px)' + (down ? ' scale(.72)' : ''); };
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; paint(); }, true);
    addEventListener('mousedown', (e) => {
      down = true; paint();
      const p = document.createElement('div');
      p.className = 'zk-pulse'; p.style.left = e.clientX + 'px'; p.style.top = e.clientY + 'px';
      document.body.appendChild(p); setTimeout(() => p.remove(), 800);
    }, true);
    addEventListener('mouseup', () => { down = false; paint(); }, true);
  };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();
`;

/**
 * Atver ierakstāmu lapu. `phone` ieslēdz iPhone profilu.
 * Atgriež { page, ctx, browser, finish } — finish() aizver kontekstu,
 * pārsauc video un ieraksta, cik sekundes jānogriež sākumā.
 */
export async function openRecorded(name, { phone = false, width = 1600, height = 1000 } = {}) {
  const browser = await chromium.launch();
  const t0 = Date.now();
  const opts = phone
    ? { ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, recordVideo: { dir: RAW, size: { width: 390, height: 844 } } }
    : { viewport: { width, height }, recordVideo: { dir: RAW, size: { width, height } } };
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(CURSOR_INIT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message));
  let trimFrom = 0;
  return {
    page,
    ctx,
    browser,
    /** Atzīmē brīdi, no kura video ir "tīrs" (pēc ielādes). */
    mark() {
      trimFrom = (Date.now() - t0) / 1000;
    },
    async finish() {
      const video = page.video();
      await ctx.close();
      const path = await video.path();
      writeFileSync(`${RAW}${name}.json`, JSON.stringify({ file: path, trimFrom }));
      await browser.close();
      console.log(`[${name}] ${path} trimFrom=${trimFrom.toFixed(1)}s`);
    },
  };
}

// Peles kustība ar vieglu ease — izskatās kā cilvēks, nevis robots.
let cur = { x: 800, y: 500 };
export async function glide(page, x, y, ms = 700) {
  const steps = Math.max(12, Math.round(ms / 16));
  const sx = cur.x;
  const sy = cur.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await page.waitForTimeout(ms / steps);
  }
  cur = { x, y };
}

export async function clickAt(page, x, y, ms = 700) {
  await glide(page, x, y, ms);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}

/** Klikšķis uz elementa centra. */
export async function clickEl(page, locator, ms = 700) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not visible');
  await clickAt(page, box.x + box.width / 2, box.y + box.height / 2, ms);
}

/** Lēna ritināšana paneļa iekšienē. */
export async function smoothScroll(page, selector, to, ms = 2500) {
  await page.locator(selector).evaluate(
    (el, args) =>
      new Promise((resolve) => {
        const from = el.scrollTop;
        const start = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - start) / args.ms);
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          el.scrollTop = from + (Math.min(args.to, el.scrollHeight) - from) * e;
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      }),
    { to, ms },
  );
}

/** Karte lido uz koordinātēm (app klausās `zk:locate`). */
export async function fly(page, lat, lon, zoom) {
  await page.evaluate((d) => window.dispatchEvent(new CustomEvent('zk:locate', { detail: d })), { lat, lon, zoom });
}
