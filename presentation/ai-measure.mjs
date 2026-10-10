// Mērījums slaidam „viens JSON pret 19 avotiem”.
//
// 1) Atver live lietotni, nospiež „Lejupielādēt JSON” un saglabā īsto eksportu.
// 2) Paņem visas eksportā minētās saites (query + proof + parcelRequest) un
//    novelk tās tāpat, kā cilvēks tās iekopētu čatbotā: neapstrādātu atbildi
//    un tīru tekstu bez HTML.
// 3) Tokenus skaita ai_tokens.py (tiktoken o200k_base) — te tikai savācam failus.
//
// Lietojums: node ai-measure.mjs [kadastrs]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { BASE } from './lib.mjs';

const CAD = process.argv[2] || '01001142213';
const OUT = new URL('./ai-sources/', import.meta.url).pathname;
mkdirSync(`${OUT}raw`, { recursive: true });
mkdirSync(`${OUT}text`, { recursive: true });

/* ------------------------------------------------------------------
 * Eksports no īstās lietotnes — nevis sintētisks fails.
 * ---------------------------------------------------------------- */
async function grabExport() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#/?cad=${CAD}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Gaidām, kamēr panelis piepildās (fakti nāk ar jobu, ne uzreiz).
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const rows = await page.locator('.panel .row').count().catch(() => 0);
    // .row-skeleton = rinda vēl ielādējas (FactRow.tsx)
    const busy = await page.locator('.panel .row-skeleton').count().catch(() => 0);
    if (rows >= 20 && busy === 0) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(4000);

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('button[title="Lejupielādēt JSON"]').click(),
  ]);
  const file = `${OUT}export-${CAD}.json`;
  await dl.saveAs(file);
  await browser.close();
  console.log('eksports →', file);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/* ------------------------------------------------------------------
 * HTML → teksts. Rupji, bet godīgi: noņem skriptus/stilus un tagus,
 * lai salīdzinājums nebūtu uzpūsts ar <div> trokšņiem.
 * ---------------------------------------------------------------- */
function toText(body) {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function main() {
  const exp = await grabExport();

  // Unikālās saites, no kurām eksports ir salikts.
  const urls = new Set();
  if (exp.parcelRequest) urls.add(exp.parcelRequest);
  for (const f of exp.facts) {
    if (f.query) urls.add(f.query);
    if (f.proof) urls.add(f.proof);
  }

  const manifest = [];
  let i = 0;
  for (const url of urls) {
    i += 1;
    const id = String(i).padStart(2, '0');
    let status = 0;
    let body = '';
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) VienotaisZemesRegistrs/measure', accept: '*/*' },
        signal: AbortSignal.timeout(30000),
      });
      status = res.status;
      body = await res.text();
    } catch (e) {
      body = '';
      status = -1;
    }
    // Cloudflare/403 lapas neskaitām — tās nav avota saturs.
    const ok = status >= 200 && status < 300 && !/cf-browser-verification|Just a moment/i.test(body);
    writeFileSync(`${OUT}raw/${id}.txt`, body);
    writeFileSync(`${OUT}text/${id}.txt`, ok ? toText(body) : '');
    manifest.push({ id, url, status, ok, bytes: body.length });
    console.log(id, status, ok ? 'ok' : '—', body.length, url.slice(0, 100));
  }

  // Cik dažādu iestāžu/portālu tas ir (pēc sourceId etiķetes).
  const sources = [...new Set(exp.facts.map((f) => f.source).filter(Boolean))];
  writeFileSync(`${OUT}manifest.json`, JSON.stringify({ cadastre: CAD, sources, urls: manifest }, null, 2));
  console.log(`saites: ${manifest.length}, ok: ${manifest.filter((m) => m.ok).length}, avoti: ${sources.length}`);
}

main();
