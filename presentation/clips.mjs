// Ierakstu skripti pret live /hakatons/ (vai ZK_URL).
// Lietojums: ZK_URL=… node clips.mjs [klips …]
//
// Konkrēti piemēri (pārbaudīti uz live API 2026-10-09):
//   01000070142  Kaļķu iela 1, Rīga — pašvaldība, CFLA Atbilst, bagāts panelis
//   80880050264  Loki, Spuņciems — pašvaldība + plūdi 100g Jā + CFLA 2.1.1.6
//   54620100583  Ozoliņi — juridiska persona, CFLA Nē, EKII-6 Atbilst
//   01001142213  Vecāķi pie jūras — fiziska persona, plūdi Jā, EKII Atbilst
import { BASE, RAW, openRecorded, glide, clickAt, clickEl, smoothScroll, fly } from './lib.mjs';

/** Wait until the report panel has a cadastre heading or enough rows. */
async function waitPanel(page, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const ok = await page.locator('.panel').evaluate((el) => {
      const rows = el.querySelectorAll('.row').length;
      const title = el.querySelector('.panel-head, .cadastre, h2')?.textContent || '';
      return rows >= 4 || /\d{11}/.test(title);
    }).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(500);
  }
}

async function scrollToHeading(page, pattern, ms = 2200) {
  const top = await page.locator('.panel-scroll').evaluate((sc, pat) => {
    const re = new RegExp(pat, 'i');
    const h = [...sc.querySelectorAll('h3')].find((x) => re.test(x.textContent || ''));
    if (!h) return Math.min(sc.scrollHeight, 1200);
    return h.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 10;
  }, pattern);
  await smoothScroll(page, '.panel-scroll', top, ms);
}

/* ------------------------------------------------------------------
 * Stāstu klipiem: paraksts apakšā (lower third) un rindas izcēlums.
 * Abi dzīvo tikai lapas DOM — pēc navigācijas jāizsauc no jauna.
 * ---------------------------------------------------------------- */
async function caption(page, text, { top = false } = {}) {
  await page.evaluate(({ t, top }) => {
    let el = document.getElementById('zk-cap');
    if (!el) {
      const st = document.createElement('style');
      st.textContent = `#zk-cap{position:fixed;z-index:2147483640;left:50%;bottom:34px;transform:translate(-50%,16px);
        max-width:72vw;padding:14px 22px;border-radius:16px;background:rgba(28,28,28,.86);color:#fff;
        font:600 22px/1.3 -apple-system,BlinkMacSystemFont,"Ubuntu",sans-serif;letter-spacing:-.01em;
        box-shadow:0 10px 40px rgba(0,0,0,.25);opacity:0;pointer-events:none;
        transition:opacity .35s cubic-bezier(.22,1,.36,1),transform .6s cubic-bezier(.34,1.56,.64,1)}
        #zk-cap.on{opacity:1;transform:translate(-50%,0)}
        #zk-cap b{color:#ffb4c1}
        .zk-spot{outline:3px solid #a01b36!important;outline-offset:2px;border-radius:10px;
        box-shadow:0 0 0 8px rgba(160,27,54,.12)!important;transition:outline-color .3s,box-shadow .3s}`;
      document.head.appendChild(st);
      el = document.createElement('div');
      el.id = 'zk-cap';
      document.body.appendChild(el);
    }
    // Uz AI demo lapas apakšā ir galvenais skaitlis — tur parakstu liekam augšā.
    el.style.top = top ? '88px' : '';
    el.style.bottom = top ? 'auto' : '';
    el.classList.remove('on');
    setTimeout(() => {
      el.innerHTML = t;
      el.classList.add('on');
    }, 180);
  }, { t: text, top });
  await page.waitForTimeout(400);
}

/** Atrod rindu pēc etiķetes, ieritina to paneļa vidū un apvelk karmīnā. */
async function spot(page, label, ms = 1800) {
  const top = await page.locator('.panel-scroll').evaluate((sc, lab) => {
    document.querySelectorAll('.zk-spot').forEach((n) => n.classList.remove('zk-spot'));
    const row = [...sc.querySelectorAll('.row')].find((r) => (r.querySelector('.row-label')?.textContent || '').includes(lab));
    if (!row) return null;
    row.classList.add('zk-spot');
    const off = row.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    return Math.max(0, off - sc.clientHeight / 3);
  }, label);
  if (top !== null) await smoothScroll(page, '.panel-scroll', top, ms);
}

/**
 * Gaida, kamēr visas redzamās LVĢMC flīzes pašreizējā zoomā ir ielādētas.
 * Export serviss atbild ~0,2 s uz flīzi, bet pārlūks tās laiž pa 6 — bez
 * šī ierakstā redzama tukša karte, lai gan dati ir.
 */
async function floodTiles(page, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const done = await page.evaluate(() => {
      const view = document.querySelector('.leaflet-container')?.getBoundingClientRect();
      if (!view) return false;
      const tiles = [...document.querySelectorAll('img.leaflet-tile')].filter((img) => {
        if (!img.src.includes('lvgmc')) return false;
        const r = img.getBoundingClientRect();
        return r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom;
      });
      return tiles.length > 0 && tiles.every((img) => img.complete && img.classList.contains('leaflet-tile-loaded'));
    }).catch(() => false);
    if (done) return;
    await page.waitForTimeout(400);
  }
}

const overlay = (page, label) =>
  page.locator('.layers .segmented:not(.segmented-sub) button', { hasText: label });
const basemap = (page, label) =>
  page.locator('.basemap-switch button', { hasText: label });
const floodSub = (page, label) =>
  page.locator('.layers .segmented-sub button', { hasText: label });

const clips = {
  /* 1) Kaļķu 1 — satelīts + klikšķis nav vajadzīgs: deep link, panelis piepildās. */
  async klikskis() {
    const r = await openRecorded('klikskis');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=01000070142&b=sat`);
    await page.waitForTimeout(3000);
    r.mark();
    await waitPanel(page, 22000);
    await page.waitForTimeout(1500);
    await smoothScroll(page, '.panel-scroll', 500, 2800);
    await page.waitForTimeout(800);
    await scrollToHeading(page, 'Ierobežoj');
    await page.waitForTimeout(2000);
    await scrollToHeading(page, 'ES finans');
    await page.waitForTimeout(3500);
    await scrollToHeading(page, 'Uzņēmumi');
    await page.waitForTimeout(2000);
    await r.finish();
  },

  /* 2) Slāņi + Karte/Satelīts apakšā pa kreisi (jaunais UI). */
  async slani() {
    const r = await openRecorded('slani');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=01000070142`);
    await page.waitForTimeout(4000);
    r.mark();
    await waitPanel(page, 18000);

    await clickEl(page, basemap(page, 'Satelīts'), 800);
    await page.waitForTimeout(2800);
    await clickEl(page, basemap(page, 'Karte'), 700);
    await page.waitForTimeout(1800);

    await clickEl(page, overlay(page, 'Kadastrs'), 900);
    await page.waitForTimeout(3500);

    await clickEl(page, overlay(page, 'Plūdi'), 900);
    await page.waitForTimeout(2500);
    await fly(page, 57.033, 24.185, 15);
    await page.waitForTimeout(3000);
    await clickEl(page, floodSub(page, '100'), 700);
    await page.waitForTimeout(2200);
    await clickEl(page, floodSub(page, '200'), 700);
    await page.waitForTimeout(2000);

    await clickEl(page, overlay(page, 'Zonējums'), 900);
    await fly(page, 56.9496, 24.1052, 16);
    await page.waitForTimeout(4500);

    await clickEl(page, overlay(page, 'Daba'), 900);
    await fly(page, 56.9876, 23.5, 12);
    await page.waitForTimeout(5000);
    await r.finish();
  },

  /* 3) Meklēšana: Kaļķu iela 1 → tas pats bagātais panelis. */
  async meklesana() {
    const r = await openRecorded('meklesana');
    const { page } = r;
    await page.goto(`${BASE}/#/`);
    await page.waitForTimeout(2500);
    r.mark();
    const input = page.locator('.search-field input');
    await clickEl(page, input, 800);
    await input.pressSequentially('Kaļķu iela 1, Rīga', { delay: 100 });
    await page.waitForTimeout(2800);
    const suggestion = page.locator('.search-hits button, .suggest button, .search-results button').first();
    if (await suggestion.count()) {
      await clickEl(page, suggestion, 800);
    } else {
      await page.keyboard.press('Enter');
    }
    await waitPanel(page, 22000);
    await page.waitForTimeout(1500);
    await smoothScroll(page, '.panel-scroll', 700, 2800);
    await page.waitForTimeout(1500);
    await r.finish();
  },

  /* 4) Pierādījums uz Kaļķu 1 — Pieprasījums → data.gov.lv → atpakaļ. */
  async pieradijums() {
    const r = await openRecorded('pierad');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=01000070142`);
    await waitPanel(page, 22000);
    r.mark();
    await page.waitForTimeout(1000);
    const link = page.locator('a.row-query').first();
    await link.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await link.evaluate((a) => a.setAttribute('target', '_self'));
    await clickEl(page, link, 1000);
    await page.waitForTimeout(5000);
    await page.goBack();
    await waitPanel(page, 15000);
    await page.waitForTimeout(3500);
    await r.finish();
  },

  /* 5) Telefons — Kaļķu 1, loksne + detent. */
  async telefons() {
    const r = await openRecorded('telefons', { phone: true });
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=01000070142&b=sat`);
    await page.waitForTimeout(4000);
    r.mark();
    await waitPanel(page, 22000);
    await page.waitForTimeout(1500);
    const g = await page.locator('.grabber').boundingBox();
    if (g) {
      await glide(page, g.x + g.width / 2, g.y + 8, 500);
      await page.mouse.down();
      await glide(page, g.x + g.width / 2, g.y - 320, 900);
      await page.mouse.up();
      await page.waitForTimeout(2000);
    }
    await smoothScroll(page, '.panel-scroll', 900, 2800);
    await page.waitForTimeout(1500);
    await scrollToHeading(page, 'ES finans', 2000);
    await page.waitForTimeout(2500);
    await r.finish();
  },

  /* 6) Uzņēmums — Kaļķu 1 + Latvenergo reģ. nr. */
  async uznemums() {
    const r = await openRecorded('uznemums');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=01000070142`);
    await waitPanel(page, 22000);
    r.mark();
    await scrollToHeading(page, 'Uzņēmumi', 2000);
    await page.waitForTimeout(1000);
    const reg = page.locator('#company-reg');
    await clickEl(page, reg, 800);
    await reg.fill('');
    await reg.pressSequentially('40003032949', { delay: 100 });
    await page.waitForTimeout(400);
    await clickEl(page, page.locator('.company .btn'), 700);
    await page.waitForTimeout(10000);
    await scrollToHeading(page, 'Uzņēmumi', 1800);
    await page.waitForTimeout(4000);
    await r.finish();
  },

  /* 7) Plūdi — Spuņciems 80880050264: Jā jūras vējuzplūdi + CFLA. */
  async plusma() {
    const r = await openRecorded('plusma');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=80880050264&l=pludi&y=100&b=sat`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    r.mark();
    await waitPanel(page, 28000);
    await page.waitForTimeout(2000);
    await scrollToHeading(page, 'Ierobežoj', 2000);
    await page.waitForTimeout(3500);
    await scrollToHeading(page, 'ES finans', 2200);
    await page.waitForTimeout(4500);
    await r.finish();
  },

  /*
   * 8) Atbalsts — trīs gabali:
   *    pašvaldība CFLA Atbilst → juridisks EKII → fiziska plūdi+EKII.
   */
  async atbalsts() {
    const r = await openRecorded('atbalsts');
    const { page } = r;
    const go = (path) => page.goto(`${BASE}/#/${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await go('?cad=80880050264');
    await waitPanel(page, 28000);
    r.mark();
    await scrollToHeading(page, 'ES finans', 2200);
    await page.waitForTimeout(5000);

    await go('?cad=54620100583');
    await waitPanel(page, 28000);
    await scrollToHeading(page, 'ES finans', 2200);
    await page.waitForTimeout(5500);

    await go('?cad=01001142213&l=pludi&y=100');
    await waitPanel(page, 28000);
    await scrollToHeading(page, 'Ierobežoj', 2000);
    await page.waitForTimeout(2500);
    await scrollToHeading(page, 'ES finans', 2200);
    await page.waitForTimeout(4500);
    await r.finish();
  },

  /* ==================================================================
   * Hakatona v2 — stāsti ar parakstiem. Viens gabals, viena doma.
   * ================================================================== */

  /*
   * Pircējs: jūrmalas zeme Vecāķos (01001142213) izskatās pēc sapņa.
   * Panelis 20 sekundēs pasaka to, ko sludinājums nepateiks.
   */
  async pircejs() {
    const r = await openRecorded('pircejs');
    const { page } = r;
    await page.goto(`${BASE}/#/?b=sat`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    r.mark();
    await caption(page, 'Sludinājumā: <b>zeme pie jūras, Vecāķi</b>. Ievadām kadastru.');
    const input = page.locator('.search-field input');
    await clickEl(page, input, 800);
    await input.pressSequentially('01001142213', { delay: 110 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await waitPanel(page, 30000);
    await page.waitForTimeout(2500);

    await caption(page, 'Īpašnieks — <b>fiziska persona</b>. Būvju nav.');
    await spot(page, 'Īpašuma tiesības');
    await page.waitForTimeout(2600);

    await caption(page, 'Plūdi reizi 100 gados — <b>Jā, jūras vējuzplūdi</b>.');
    await spot(page, 'reizi 100 gados');
    await page.waitForTimeout(3000);

    await caption(page, 'ATIS: applūstoša teritorija, <b>dabas liegums</b>, aizsargjosla.');
    await spot(page, 'Apgrūtinājumi');
    await page.waitForTimeout(3200);

    await caption(page, 'Zonējums: <b>DA1 daba un apstādījumi</b>. Māju te nebūvēs.');
    await spot(page, 'Teritorijas izmantošana');
    await page.waitForTimeout(3600);
    await r.finish();
  },

  /*
   * Plūdi: Spuņciems (80880050264) — 10 → 100 → 200 gadu scenāriji
   * uz kartes, tad panelis apstiprina ar vārdiem.
   */
  async pludi() {
    const r = await openRecorded('pludi');
    const { page } = r;
    // Karte, ne satelīts: plūdu laukums gabala iekšā uz satelīta pazūd.
    // Plūdu režīmā lietotne pati rāda gabalu kā karmīna kontūru — zils = tikai ūdens.
    await page.goto(`${BASE}/#/?cad=80880050264&l=pludi&y=10`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitPanel(page, 30000);

    /*
     * Iesildīšana pirms ieraksta: flīzes nāk no servera keša
     * (node floodwarm.mjs), bet pārlūkam tās vēl jāielādē. Izejam
     * cauri visiem trim, lai ierakstā ūdens parādās uzreiz.
     */
    await floodTiles(page);
    // Pilnā etiķete: «10» kā apakšvirkne trāpītu arī «reizi 100 g.»
    for (const y of ['100', '200', '10']) {
      await floodSub(page, `reizi ${y} g.`).click();
      await floodTiles(page);
    }
    await page.waitForTimeout(800);
    r.mark();

    // 10 gadi — ūdens jau pie malām, bet gabala centrs sauss (panelī «Nē»)
    await caption(page, 'Spuņciems, pie Lielupes. <b>Reizi 10 gados</b> — ūdens skar malas.');
    await page.waitForTimeout(3600);

    // 100 gadi — gabals zem ūdens
    await clickEl(page, floodSub(page, '100'), 800);
    await floodTiles(page);
    await caption(page, '<b>Reizi 100 gados</b> — gabals zem ūdens.');
    await page.waitForTimeout(3600);

    // 200 gadi — vēl dziļāk
    await clickEl(page, floodSub(page, '200'), 800);
    await floodTiles(page);
    await caption(page, '<b>Reizi 200 gados</b> — vēl dziļāk.');
    await page.waitForTimeout(3200);

    // Panelis to pašu saka vārdiem — tas pats LVĢMC ūdens dziļuma slānis
    await caption(page, 'Panelis: <b>Jā — jūras vējuzplūdi</b>. Bez GIS diploma.');
    await spot(page, 'reizi 100 gados');
    await page.waitForTimeout(4000);
    await r.finish();
  },

  /*
   * Juridiska persona Līvbērzē (54620100583): CFLA atlases neder —
   * un sistēma pasaka kāpēc, bet EKII atbilst.
   */
  async juridiska() {
    const r = await openRecorded('juridiska');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=54620100583`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    r.mark();
    await waitPanel(page, 30000);
    await caption(page, '„Ozoliņi”, Līvbērze. Īpašnieks — <b>juridiska persona</b>.');
    await spot(page, 'Īpašuma tiesības');
    await page.waitForTimeout(2800);
    // „Tikai ar datiem” slēpj „Nē” rindas — izslēdzam, lai CFLA rinda redzama.
    await caption(page, 'Rādām arī <b>„Nē”</b> rindas.');
    await clickEl(page, page.locator('.filter-switch'), 800);
    await page.waitForTimeout(1400);
    await caption(page, 'CFLA atlases: <b>neatbilst</b> šim īpašniekam.');
    await spot(page, 'CFLA atvērtās atlases', 2200);
    await page.waitForTimeout(3400);
    await caption(page, 'LVIF / EKII: <b>atbilst</b> — termiņš, summa, intensitāte.');
    await spot(page, 'EKII');
    await page.waitForTimeout(4200);
    await r.finish();
  },

  /*
   * CFLA projektu atlase: Kaļķu iela 1 (01000070142) — pašvaldības
   * īpašums. Filtrs „ES finansējums”, atbilstība un pierādījums.
   */
  async cfla_atlase() {
    const r = await openRecorded('cfla_atlase');
    const { page } = r;
    await page.goto(`${BASE}/#/?cad=01000070142`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    r.mark();
    await waitPanel(page, 30000);
    await caption(page, 'Kaļķu iela 1, Rīga. Vērtētājs CFLA atver <b>vienu</b> saiti.');
    await page.waitForTimeout(2400);
    await caption(page, 'Filtrs: <b>ES finansējums</b>.');
    const sel = page.locator('.filter-select');
    await glide(page, ...(await sel.boundingBox().then((b) => [b.x + b.width / 2, b.y + b.height / 2])), 800);
    await sel.selectOption('es');
    await page.waitForTimeout(2200);
    await caption(page, 'Pašvaldība → <b>Atbilst 2.1.1.6</b>, ar termiņu un atlikumu.');
    await spot(page, 'CFLA atvērtās atlases', 1800);
    await page.waitForTimeout(4200);
    await caption(page, 'Katram faktam — <b>avots un precīzais pieprasījums</b>.');
    const meta = page.locator('.row.zk-spot .row-meta');
    if (await meta.count()) {
      const b = await meta.boundingBox();
      if (b) await glide(page, b.x + b.width - 40, b.y + b.height / 2, 900);
    }
    await page.waitForTimeout(3200);
    await r.finish();
  },

  /*
   * JSON → AI: eksports no live lietotnes, tad lokālā ai-demo lapa
   * (node ai-demo.mjs) — tokenu salīdzinājums un atbilde no viena faila.
   */
  async json_ai() {
    const { spawn } = await import('node:child_process');
    const server = spawn(process.execPath, [new URL('./ai-demo.mjs', import.meta.url).pathname], { stdio: 'ignore' });
    await new Promise((res) => setTimeout(res, 1200));

    const r = await openRecorded('json_ai');
    const { page } = r;
    try {
      await page.goto(`${BASE}/#/?cad=01001142213&b=sat`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3500);
      await waitPanel(page, 30000);
      await page.waitForTimeout(3000);
      r.mark();
      await caption(page, '25 rindas no <b>16 avotiem</b>. Viena poga — <b>JSON</b>.');
      await page.waitForTimeout(1600);
      const btn = page.locator('button[title="Lejupielādēt JSON"]');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), clickEl(page, btn, 900)]);
      const file = `${RAW}${dl.suggestedFilename()}`;
      await dl.saveAs(file);
      await page.waitForTimeout(1400);

      await page.goto('http://localhost:4177/');
      await page.waitForTimeout(2600);
      await caption(page, 'Bez eksporta: <b>25 dokumenti, ~958 000 tokenu</b> — neietilpst.', { top: true });
      await page.waitForTimeout(2600);
      await glide(page, 190, 420, 900);
      await page.setInputFiles('#file', file);
      await page.waitForTimeout(800);
      await caption(page, 'Ar eksportu: <b>viens fails, ~5 600 tokenu</b>.', { top: true });
      await page.waitForTimeout(3600);
      await clickEl(page, page.locator('#send'), 900);
      await caption(page, 'Jautājums par <b>visu</b> zemi vienā promptā.', { top: true });
      await page.waitForTimeout(9000);
      await caption(page, 'AI atrod pat <b>pretrunas starp avotiem</b>. Ar saitēm.', { top: true });
      await page.waitForTimeout(4200);
    } finally {
      await r.finish();
      server.kill();
    }
  },
};

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(clips)) {
  if (!clips[name]) {
    console.log('nav tāda klipa:', name);
    continue;
  }
  console.log('→', name, 'BASE=', BASE);
  await clips[name]();
}
