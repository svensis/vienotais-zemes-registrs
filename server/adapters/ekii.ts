import { USER_AGENT } from '../brand.ts';
import { readCache, writeCache } from '../db.ts';
import type { LookupResult } from './types.ts';

/** Official open-calls table — no CKAN open-calls API for EKII. */
export const EKII_KONKURSI = 'https://ekii.lv/index.php?page=konkursi_lv';
/** LVIF household AER explainer (saules, siltumsūkņi, granulas, CSS). */
export const LVIF_AER =
  'https://lvif.gov.lv/valsts-atbalsts/iedzivotajiem/atjaunigo-energoresursu-iekartu-uzstadisana/';

/** Same cadence as CFLA HTML — open windows move; stale cache hurts. */
const CALLS_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export interface EkiiCall {
  code: string;
  title: string;
  href: string;
  status: string;
  starts: string;
  ends: string;
  /** saules / siltums / transport — drives household match wording. */
  theme: 'aer' | 'transport' | 'other';
  /** What the programme funds, when we could scrape it. */
  supports?: string;
  maxGrant?: string;
  intensity?: string;
  infoHref?: string;
  matched?: boolean;
  matchWhy?: string;
}

export interface EkiiHints {
  /** UR merchant on the address, or typed applicant regcode. */
  company: boolean;
  /** PersonStatus "fiziska persona" on a related ownership row. */
  natural: boolean;
  /** PersonStatus "juridiska persona". */
  legal: boolean;
  /** PersonStatus pašvaldība. */
  municipalTagged: boolean;
  /** PersonStatus valsts. */
  state: boolean;
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function unescapeHtml(html: string): string {
  return html
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)));
}

function decode(html: string): string {
  return unescapeHtml(html).replace(/\s+/g, ' ').trim();
}

function stripTags(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

/** LV dates look like 15.03.2022 or 31.12.2029 (ieskaitot). */
function parseLvDate(value: string): Date | null {
  const match = stripTags(value).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) {
    return null;
  }
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function stillAccepting(status: string, ends: string): boolean {
  if (!/iesniegumu pienemsana/i.test(fold(status))) {
    return false;
  }
  const until = parseLvDate(ends);
  if (!until) {
    return true;
  }
  const today = new Date();
  const startOfToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return until.getTime() >= startOfToday;
}

function absEkiiHref(href: string): string {
  const clean = decode(href);
  if (/^https?:\/\//i.test(clean)) {
    return clean;
  }
  if (clean.startsWith('/')) {
    return `https://ekii.lv${clean}`;
  }
  return `https://ekii.lv/${clean.replace(/^\.\//, '')}`;
}

function themeOf(code: string, title: string): EkiiCall['theme'] {
  const blob = fold(`${code} ${title}`);
  if (/ekii[- ]?6|majsaimniec|atjaunojam|aer|saules|siltumsuk|granul/.test(blob)) {
    return 'aer';
  }
  if (/ekii[- ]?10|transport|elektroauto|bezemis|mazemis/.test(blob)) {
    return 'transport';
  }
  return 'other';
}

/**
 * Household AER / iedzīvotāju calls: natural owner, or legal
 * without a merchant on the address. Pure pašvaldība / valsts
 * and UR komersants are out — those are not mājsaimniecība.
 */
export function fitEkiiCall(call: EkiiCall, hints: EkiiHints): Pick<EkiiCall, 'matched' | 'matchWhy'> {
  if (call.theme === 'other') {
    return { matched: false, matchWhy: 'nav mājsaimniecību AER / iedzīvotāju programma' };
  }

  if (hints.company) {
    return {
      matched: false,
      matchWhy: 'adresē ir UR komersants — mājsaimniecību EKII konkursi nav komersantiem',
    };
  }
  if (hints.municipalTagged || hints.state) {
    return {
      matched: false,
      matchWhy: 'īpašnieks ir pašvaldība / valsts — ne mājsaimniecība',
    };
  }
  if (hints.natural) {
    return {
      matched: true,
      matchWhy:
        call.theme === 'aer'
          ? 'īpašnieks ir fiziska persona — der EKII mājsaimniecību AER'
          : 'īpašnieks ir fiziska persona — der iedzīvotāju transporta atbalstam',
    };
  }
  if (hints.legal) {
    return {
      matched: true,
      matchWhy: 'juridiska persona bez UR komersanta adresē (mājsaimniecības tips)',
    };
  }
  return {
    matched: false,
    matchWhy: 'nav skaidra īpašnieka veida (fiziska persona / mājsaimniecība)',
  };
}

async function fetchHtml(url: string): Promise<{ html: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'lv,en;q=0.8',
        /* Identify the product; some hosts also want a browser-ish Accept set. */
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`EKII/LVIF lapa atbildēja ${response.status}`);
    }
    const html = await response.text();
    /* Cloudflare interstitial — treat as blocked, not as a konkursi table. */
    if (/cf-browser-verification|just a moment|cloudflare/i.test(html) && !/k_name/i.test(html)) {
      return { html: '', error: 'EKII lapa bloķē automatizētu piekļuvi (Cloudflare)' };
    }
    return { html };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : 'EKII/LVIF lapa neatbildēja';
    return { html: '', error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rows with status „Iesniegumu pieņemšana” and an end date
 * that has not passed. Closed / Plānots rounds stay out.
 */
function parseOpenTable(html: string): EkiiCall[] {
  const rows = [...html.matchAll(/<tr>\s*<td class="k_name"[\s\S]*?<\/tr>/gi)];
  const open: EkiiCall[] = [];

  for (const rowMatch of rows) {
    const row = rowMatch[0];
    const link = row.match(/href="([^"]+konkursi[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const codeMatch = row.match(/<(?:strong|span)[^>]*>\s*(EKII-[\d.]+|MF-[\d.]+)\s*<\/(?:strong|span)>/i)
      || row.match(/>\s*(EKII-[\d.]+|MF-[\d.]+)\s*</i);
    const statusBlock = row.match(/class="k_\d+"[\s\S]*$/i)?.[0] || row;
    const statusLabel = stripTags(
      (statusBlock.match(/<(?:strong|span)[^>]*>\s*([^<]+)\s*<\/(?:strong|span)>/i) || [])[1] || '',
    );
    const windowMatch = stripTags(statusBlock).match(
      /(\d{1,2}\.\d{1,2}\.\d{4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{4})/,
    );

    const title = link ? stripTags(link[2]) : '';
    const code = codeMatch ? stripTags(codeMatch[1]) : '';
    const starts = windowMatch?.[1] || '';
    const ends = windowMatch?.[2] || '';
    const status = statusLabel || stripTags(statusBlock).slice(0, 80);

    if (!title || !code) {
      continue;
    }
    if (!stillAccepting(status, ends)) {
      continue;
    }

    const href = absEkiiHref(link?.[1] || `index.php?page=konkursi_lv&konkursi=${code}`);
    open.push({
      code,
      title,
      href,
      status: 'Iesniegumu pieņemšana',
      starts,
      ends,
      theme: themeOf(code, title),
    });
  }

  return open;
}

/** Fallback facts when the LVIF / detail scrape misses a number. */
const AER_FALLBACK = {
  supports: 'saules/vēja elektrostacija, siltumsūkņi, granulu katli, CSS pieslēgums',
  maxGrant: '15 000 EUR',
  intensity: 'līdz 85 % (parasti līdz 70 %)',
  infoHref: LVIF_AER,
};

/**
 * When ekii.lv blocks the VPS (Cloudflare 403), still show the
 * household programmes LVIF advertises. Dates match the last
 * successful scrape; stillAccepting drops them when the window ends.
 */
const FALLBACK_OPEN: EkiiCall[] = [
  {
    code: 'EKII-6',
    title:
      'Siltumnīcefekta gāzu emisiju samazināšana mājsaimniecībās – atbalsts atjaunojamo energoresursu izmantošanai',
    href: `${EKII_KONKURSI}&konkursi=EKII-6`,
    status: 'Iesniegumu pieņemšana',
    starts: '15.03.2022',
    ends: '31.12.2029',
    theme: 'aer',
  },
  {
    code: 'EKII-10',
    title: 'Atbalsts bezemisiju un mazemisiju transportlīdzekļu iegādei',
    href: `${EKII_KONKURSI}&konkursi=EKII-10`,
    status: 'Iesniegumu pieņemšana',
    starts: '11.05.2026',
    ends: '31.12.2029',
    theme: 'transport',
  },
];

function plainFromHtml(html: string): string {
  return stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' '),
  );
}

/**
 * Pull max EUR / intensity / supported kit from the EKII-6
 * detail page and the LVIF AER explainer. One cache blob for both.
 */
async function fetchAerFacts(force?: boolean): Promise<typeof AER_FALLBACK> {
  const cacheKey = 'ekii:aer-facts:v1';
  if (!force) {
    const cached = readCache(cacheKey, CALLS_TTL_MS);
    if (cached) {
      try {
        return { ...AER_FALLBACK, ...(JSON.parse(cached.payload) as Partial<typeof AER_FALLBACK>) };
      } catch {
        /* refetch */
      }
    }
  }

  const [detail, lvif] = await Promise.all([
    fetchHtml(`${EKII_KONKURSI}&konkursi=EKII-6`),
    fetchHtml(LVIF_AER),
  ]);

  const blob = `${plainFromHtml(detail.html)} ${plainFromHtml(lvif.html)}`;
  const maxMatch = blob.match(/maksimālais atbalsts[^\d]{0,40}(\d[\d\s]{2,6})\s*euro/i);
  /* Page lists both 70 % (base) and 85 % (Goda ģimene) — keep the ceiling. */
  const intensityPcts = [...blob.matchAll(/intensitāte[^\d%]{0,60}(\d{2})\s*%/gi)].map((m) => Number(m[1]));
  const intensityMax = intensityPcts.length ? Math.max(...intensityPcts) : 0;
  const supportsBits = [
    /saules/i.test(blob) ? 'saules paneļi / elektrostacija' : '',
    /vēja/i.test(blob) ? 'vēja elektrostacija' : '',
    /siltumsūk/i.test(blob) ? 'siltumsūkņi' : '',
    /granul/i.test(blob) ? 'granulu katli' : '',
    /centralizētajai siltum|CSS|centralizēt/i.test(blob) ? 'CSS pieslēgums' : '',
  ].filter(Boolean);

  const facts = {
    supports: supportsBits.length ? supportsBits.join(', ') : AER_FALLBACK.supports,
    maxGrant: maxMatch
      ? `${maxMatch[1].replace(/\s+/g, ' ').trim()} EUR`
      : AER_FALLBACK.maxGrant,
    intensity: intensityMax ? `līdz ${intensityMax} %` : AER_FALLBACK.intensity,
    infoHref: LVIF_AER,
  };

  writeCache(cacheKey, JSON.stringify(facts), new Date().toISOString());
  return facts;
}

function enrichCall(call: EkiiCall, aer: typeof AER_FALLBACK): EkiiCall {
  if (call.theme !== 'aer') {
    return {
      ...call,
      supports: call.theme === 'transport' ? 'bezemisiju / mazemisiju transportlīdzekļi' : '',
      infoHref: call.href,
    };
  }
  return {
    ...call,
    supports: aer.supports,
    maxGrant: aer.maxGrant,
    intensity: aer.intensity,
    infoHref: aer.infoHref,
  };
}

async function fetchKonkursiHtml(
  force?: boolean,
): Promise<{ html: string; fetchedAt: string; error?: string; fromCache: boolean }> {
  const cacheKey = 'ekii:konkursi:html:v1';
  if (!force) {
    const cached = readCache(cacheKey, CALLS_TTL_MS);
    if (cached) {
      try {
        const parsed = JSON.parse(cached.payload) as { html?: string; error?: string };
        if (parsed.html && !parsed.error) {
          return { html: parsed.html, fetchedAt: cached.fetched_at, fromCache: true };
        }
      } catch {
        /* refetch */
      }
    }
  }

  const fetchedAt = new Date().toISOString();
  const page = await fetchHtml(EKII_KONKURSI);
  if (page.error || !page.html) {
    return { html: '', fetchedAt, error: page.error || 'tukša EKII lapa', fromCache: false };
  }

  writeCache(cacheKey, JSON.stringify({ html: page.html }), fetchedAt);
  return { html: page.html, fetchedAt, error: undefined, fromCache: false };
}

function rankCalls(calls: EkiiCall[]): EkiiCall[] {
  const themeRank = (theme: EkiiCall['theme']) => (theme === 'aer' ? 0 : theme === 'transport' ? 1 : 2);
  return [...calls].sort(
    (left, right) => themeRank(left.theme) - themeRank(right.theme) || left.code.localeCompare(right.code),
  );
}

function toRecords(calls: EkiiCall[]): Record<string, unknown>[] {
  return calls.map((call) => ({
    code: call.code,
    title: call.title,
    href: call.href,
    status: call.status,
    starts: call.starts,
    ends: call.ends,
    theme: call.theme,
    supports: call.supports || '',
    maxGrant: call.maxGrant || '',
    intensity: call.intensity || '',
    infoHref: call.infoHref || '',
    matched: call.matched ? '1' : '',
    matchWhy: call.matchWhy || '',
  }));
}

/**
 * Open EKII konkursi from ekii.lv HTML, matched to this parcel's
 * household profile. data.gov.lv KPFI/EKII XLSX is completed
 * projects only (last dump ~2020) — not used as an open-calls source.
 * If ekii.lv is Cloudflare-blocked (common on the VPS), fall back to
 * the known household programmes and enrich from lvif.gov.lv.
 */
export async function lookupEkiiSupport(hints: EkiiHints, force?: boolean): Promise<LookupResult> {
  const page = await fetchKonkursiHtml(force);
  const aer = await fetchAerFacts(force);

  let scraped = page.html ? parseOpenTable(page.html) : [];
  let tableNote = '';
  if (!scraped.length) {
    scraped = FALLBACK_OPEN.filter((call) => stillAccepting(call.status, call.ends));
    tableNote = page.error
      ? `ekii.lv tabula nav sasniedzama (${page.error}); rādam LVIF/EKII mājsaimniecību programmas ar zināmo termiņu.`
      : 'ekii.lv tabulā nav atvērtu rindu; rādam LVIF/EKII mājsaimniecību programmas ar zināmo termiņu.';
  }

  const calls = rankCalls(
    scraped.map((call) => enrichCall(call, aer)).map((call) => ({ ...call, ...fitEkiiCall(call, hints) })),
  );

  const top = calls[0];
  return {
    sourceId: 'ekii',
    requestUrl: EKII_KONKURSI,
    /* LVIF AER page is reachable from the VPS when ekii.lv is not. */
    proofUrl: top?.theme === 'aer' ? LVIF_AER : EKII_KONKURSI,
    fetchedAt: page.fetchedAt || new Date().toISOString(),
    record: top
      ? { title: top.title, href: top.href, code: top.code, tableNote }
      : tableNote
        ? { tableNote }
        : null,
    records: toRecords(calls),
    /* Soft note only — do not flip the fact to kluda when fallback works. */
    error: calls.length ? undefined : page.error || 'Nav atvērtu EKII konkursu',
    fromCache: page.fromCache,
  };
}
