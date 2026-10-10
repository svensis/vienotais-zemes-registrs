import { USER_AGENT } from '../brand.ts';
import { readCache, writeCache } from '../db.ts';
import { emptyNolikums, fetchNolikums, findNolikumsLink, type NolikumsFacts } from './nolikums.ts';
import type { CompanyProfile } from './open.ts';
import type { LookupResult } from './types.ts';

export const CFLA_PROGRAMS = 'https://www.cfla.gov.lv/lv/2021-2027-programmas';
export const CFLA_HELP = 'https://www.cfla.gov.lv/lv/paligs-projektu-iesniedzejiem';

/** Open-call pages change more often than the daily dumps — six hours. */
const CALLS_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export interface CflaCall {
  starts: string;
  ends: string;
  title: string;
  href: string;
  status: string;
  score: number;
  /** Iesniegšanas termiņš from the atlas page, when the fetch landed. */
  deadline?: string;
  evaluation?: string;
  /** atklāta / ierobežota */
  kind?: string;
  /** Who CFLA lists as iesniedzējs / saņēmējs. */
  who?: string;
  /** Remaining or available EUR, with the date CFLA printed next to it. */
  money?: string;
  /** True when who-can-apply lines up with this parcel's owner / company. */
  matched?: boolean;
  matchWhy?: string;
  /** Warnings that do not flip the match: de minimis room running out, etc. */
  matchWarn?: string;
  /** Read out of the atlas rules file (DOCX), when there is one. */
  nolikums?: NolikumsFacts;
}

/** The company the matcher reasons about: the applicant, or the first one on the address. */
export interface HintCompany {
  name: string;
  /** "95.31" style, empty when VID has no row. */
  nace: string;
  size: CompanyProfile['size'];
  sizeBasis: string;
}

export interface ParcelHints {
  municipal: boolean;
  state: boolean;
  legal: boolean;
  natural: boolean;
  nature: boolean;
  flood: boolean;
  company: boolean;
  /** UR / applicant names, already on the parcel. */
  names: string[];
  /** NACE + MVU estimate, when we could build one. */
  profile?: HintCompany | null;
  /** De minimis room left under the 300 000 EUR / 3-year ceiling; null when unknown. */
  deMinimisLeft?: number | null;
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
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+,/g, ',');
}

function firstHref(html: string): string {
  const match = html.match(/href="([^"]+)"/i);
  if (!match) {
    return CFLA_PROGRAMS;
  }
  const href = decode(match[1]);
  if (/^https?:\/\//i.test(href)) {
    return href;
  }
  return `https://www.cfla.gov.lv${href.startsWith('/') ? '' : '/'}${href}`;
}

/** CFLA writes 15.07.2026. — day first, with a trailing dot. */
function parseLvDate(value: string): Date | null {
  const match = stripTags(value).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function stillOpen(ends: string, status: string): boolean {
  if (!/izsludinat/i.test(fold(status))) {
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

/**
 * Type match first (who CFLA named vs owner / company), then a
 * small theme bump for sort. A peat call on a municipal parcel
 * does not become a match just because the land is ĪADT.
 */
function fitCall(call: CflaCall, hints: ParcelHints): Pick<CflaCall, 'score' | 'matched' | 'matchWhy' | 'matchWarn'> {
  const who = fold(call.who || '');
  const title = fold(call.title);
  const reasons: string[] = [];
  let typeHits = 0;

  const named = namedOnParcel(who, hints.names || []);
  if (named) {
    typeHits += 5;
    reasons.push(`adresē ir ${named}`);
  }
  if (/pasvaldib/.test(who) && hints.municipal) {
    typeHits += 4;
    /* Only VZD PersonStatus "pasvaldiba" — not bare juridiska persona. */
    reasons.push('īpašnieks ir pašvaldība');
  }
  /*
   * "pašvaldības kapitālsabiedrība" / "publiski privātā kapitālsabiedrība"
   * are municipal vehicles, not any company: take them out before
   * asking whether a private company on the address can file.
   */
  const privateWho = who.replace(/(pasvaldibas|publiski privata|valsts) kapitalsabiedrib\w*/g, ' ');
  if (/(komersant|kapitalsabiedr|mvu)/.test(privateWho) && hints.company) {
    typeHits += 4;
    reasons.push('adresē ir komersants');
  }
  if (/fizisk/.test(who) && hints.natural) {
    typeHits += 3;
    reasons.push('īpašnieks ir fiziska persona');
  }
  if (/\bvalsts\b/.test(who) && hints.state) {
    typeHits += 3;
    reasons.push('īpašnieks ir valsts');
  }
  if (/juridisk/.test(who) && (hints.legal || hints.company) && !/(komersant|kapitalsabiedr)/.test(who)) {
    typeHits += 2;
    reasons.push('īpašnieks ir juridiska persona');
  }

  let theme = 0;
  if (hints.municipal && /pasvaldibu eku|pasvaldibu pielagosanas|infrastruktura uznemejdarbibas atbalstam/.test(title)) {
    theme += 2;
  }
  if (hints.nature && /biodaudzveidib|biotop|purvu|dabas/.test(title)) {
    theme += 2;
  }
  if (hints.flood && /pludu|krasta eroz|klimata parmain/.test(title)) {
    theme += 2;
  }
  if (hints.company && /ikt |kapitala tirg|uznemuma atbalsts|mvu|inovac|digitaliz/.test(title)) {
    theme += 2;
  }

  /*
   * A closed list of named bodies (LVM, DAP, NVD…) only matches
   * when that name sits on the parcel. Categories like pašvaldība
   * still match by owner type even if the round is ierobežota.
   */
  const category = /pasvaldib|komersant|kapitalsabiedr|fizisk|juridisk/.test(who);
  let matched = typeHits > 0 && !(looksNamedList(who) && !named && !category);

  /*
   * ┌─────────────────────────────────────────────────────────────┐
   * │ Second pass: the rules file. Owner type says "you may be in │
   * │ the room"; the nolikums can still show you the door:        │
   * │   NACE on the excluded list     → not a match               │
   * │   MVU-only call, company "liels" → not a match              │
   * │   de minimis room < 10 000 EUR  → still a match, with flag  │
   * │ A NACE the rules name outright earns a small bump.          │
   * └─────────────────────────────────────────────────────────────┘
   */
  const rules = call.nolikums;
  const profile = hints.profile;
  let gate = '';
  const warnings: string[] = [];
  if (rules && profile && hints.company) {
    const nace = profile.nace;
    if (matched && nace && naceIn(nace, rules.naceExcluded)) {
      matched = false;
      gate = `NACE ${nace} nolikumā izslēgts`;
    } else if (nace && naceIn(nace, rules.naceIncluded)) {
      typeHits += 3;
      reasons.push(`NACE ${nace} nosaukts nolikumā`);
    }
    if (matched && rules.mvuOnly && profile.size === 'liels') {
      matched = false;
      gate = `nolikums prasa MVU, bet ${profile.name || 'uzņēmums'} pēc UR pārskata ir liels`;
    }
  }
  if (rules?.deMinimis && hints.deMinimisLeft != null && hints.deMinimisLeft < 10_000) {
    warnings.push(`de minimis atlikums tikai ~${Math.round(hints.deMinimisLeft).toLocaleString('lv-LV')} EUR`);
  }

  return {
    matched,
    matchWhy: matched ? reasons[0] || '' : gate,
    matchWarn: warnings.join(' · '),
    score: (matched ? 10 : 0) + typeHits + theme,
  };
}

/** "95.31" is inside a list that says "95" or "95.3" or "95.31". */
function naceIn(code: string, list: string[]): boolean {
  return list.some((item) => code === item || code.startsWith(item));
}

function looksNamedList(who: string): boolean {
  return /akciju sabiedrib|\bsia\b|parvald|dienest|inspekcij|centrs|padome/.test(who);
}

function namedOnParcel(who: string, names: string[]): string {
  if (!who) {
    return '';
  }
  for (const raw of names) {
    const name = fold(raw);
    if (name.length < 8) {
      continue;
    }
    if (who.includes(name) || (name.length >= 12 && name.includes(who.slice(0, 32)))) {
      return raw;
    }
  }
  return '';
}

function parseOpenTable(html: string): CflaCall[] {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  const open = tables.find((table) => /Projektu atlases statuss/i.test(table) && /Izsludināts/i.test(table));
  if (!open) {
    return [];
  }

  const rows = [...open.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  const calls: CflaCall[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[\s\S]*?<\/td>/gi)].map((match) => match[0]);
    if (cells.length < 4) {
      continue;
    }
    const starts = stripTags(cells[0]);
    const ends = stripTags(cells[1]);
    const title = stripTags(cells[2]);
    const status = stripTags(cells[3]);
    if (!title || !stillOpen(ends, status)) {
      continue;
    }
    calls.push({
      starts,
      ends,
      title,
      href: firstHref(cells[2]),
      status,
      score: 0,
    });
  }
  return calls;
}

/**
 * Field labels that close a value on the atlas page.
 * Longer names first so “Projekta iesniedzējs” wins over “Iesniedzējs”.
 * No `\b` here: JS word-boundaries are ASCII and break on š / ņ.
 */
const FIELD_HEADS = [
  'Iesniegšanas termiņš',
  'Vērtēšanas termiņš',
  'Atlases veids',
  'Projekta iesniedzējs',
  'Finansējuma saņēmējs',
  'Atbalsta saņēmējs',
  'Projekta iesnieguma iesniegšana priekšizskatīšanā',
  'Atlikušais finansējums',
  'Pieejamais finansējums',
  'Projektu atlases dokumentācija',
  'Nolikuma pielikumi',
  'Iesniedzējs',
  'Lejupielādēt',
];

const ATLAS_STOP = FIELD_HEADS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

type AtlasDetail = Pick<CflaCall, 'deadline' | 'evaluation' | 'kind' | 'who' | 'money'> & {
  /** Link to the rules DOCX on the same page, '' when there is none. */
  nolikumsHref: string;
};

function emptyDetail(): AtlasDetail {
  return { deadline: '', evaluation: '', kind: '', who: '', money: '', nolikumsHref: '' };
}

/**
 * First `.content` block on a CFLA node page, as line-broken
 * plain text. Nested Drupal divs make a real HTML parse noisy;
 * the labels we want sit in that first block before the PDFs.
 */
function contentPlain(html: string): string {
  const idx = html.toLowerCase().indexOf('class="content"');
  const slice = idx >= 0 ? html.slice(idx, idx + 12_000) : html.slice(0, 8_000);
  const stripped = slice.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const lined = stripped
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const flat = unescapeHtml(lined)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
  /*
   * Drupal sometimes parks two labels in one <p>. Force each
   * known heading onto its own line before we slice values.
   */
  let broken = flat;
  for (const label of FIELD_HEADS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* Remaining-funds labels carry a date in parentheses before the colon. */
    const headed = `${escaped}(?:\\s*\\([^)]+\\))?`;
    const guarded = label === 'Iesniedzējs' ? `(?<!Projekta )(${headed}\\s*[:–-])` : `(${headed}\\s*[:–-])`;
    broken = broken.replace(new RegExp(guarded, 'gi'), '\n$1');
  }
  return broken.replace(/\n{2,}/g, '\n').trim();
}

function tidyValue(value: string): string {
  return value
    .replace(/^[•\s]+/gm, '')
    .replace(/\s*•\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .replace(/^;+\s*/, '')
    .trim();
}

function stripLeakedHeadings(value: string): string {
  return value
    .replace(/\s*Projektu atlases dokumentācija.*$/i, '')
    .replace(/\s*Atlikušais finansējums.*$/i, '')
    .replace(/\s*Pieejamais finansējums.*$/i, '')
    .trim();
}

function grabLabeled(plain: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* Stop at the next labelled row, not at a word inside the value. */
  const re = new RegExp(
    `(?:^|\\n)\\s*${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${ATLAS_STOP})(?:\\s*\\([^)]+\\))?(?:\\s*:|\\s*$)|$)`,
    'i',
  );
  const match = plain.match(re);
  return match ? stripLeakedHeadings(tidyValue(match[1])) : '';
}

function grabMoney(plain: string): string {
  const match = plain.match(/((?:Atlikušais|Pieejamais)\s+finansējums(?:\s*\([^)]+\))?)\s*[:–-]\s*([^\n]+)/i);
  if (!match) {
    return '';
  }
  return `${tidyValue(match[1])}: ${tidyValue(match[2])}`;
}

function clipBit(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

/** Deadline, who, leftover EUR, rules link — public HTML, never ELRG. */
function parseAtlasPage(html: string): AtlasDetail {
  const plain = contentPlain(html);
  const who =
    grabLabeled(plain, 'Projekta iesniedzējs') ||
    grabLabeled(plain, 'Finansējuma saņēmējs') ||
    grabLabeled(plain, 'Atbalsta saņēmējs') ||
    grabLabeled(plain, 'Iesniedzējs');
  return {
    deadline: grabLabeled(plain, 'Iesniegšanas termiņš'),
    evaluation: grabLabeled(plain, 'Vērtēšanas termiņš'),
    kind: grabLabeled(plain, 'Atlases veids'),
    who: clipBit(who, 280),
    money: grabMoney(plain),
    /* The file list sits outside the first .content block, so search the whole page. */
    nolikumsHref: findNolikumsLink(html),
  };
}

async function fetchHtml(url: string): Promise<{ html: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`CFLA lapa atbildēja ${response.status}`);
    }
    return { html: await response.text() };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : 'CFLA lapa neatbildēja';
    return { html: '', error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One atlas node, cached on its own so a programmes-table
 * refresh does not refetch every SAM page the same hour.
 */
async function fetchAtlasDetail(href: string, force?: boolean): Promise<AtlasDetail> {
  const empty = emptyDetail();
  if (!href || href === CFLA_PROGRAMS) {
    return empty;
  }

  /* v5: the cached detail now carries the rules link too. */
  const cacheKey = `cfla:atlas:v5:${href}`;
  if (!force) {
    const cached = readCache(cacheKey, CALLS_TTL_MS);
    if (cached) {
      try {
        return { ...empty, ...(JSON.parse(cached.payload) as typeof empty) };
      } catch {
        /* stale blob — fetch again */
      }
    }
  }

  const page = await fetchHtml(href);
  if (page.error || !page.html) {
    return empty;
  }

  const detail = parseAtlasPage(page.html);
  writeCache(cacheKey, JSON.stringify(detail), new Date().toISOString());
  return detail;
}

async function enrichCalls(calls: CflaCall[], force?: boolean): Promise<CflaCall[]> {
  /* Cap so a busy programmes table cannot fan out into dozens of GETs. */
  const slice = calls.slice(0, 10);
  const details = await Promise.all(slice.map((call) => fetchAtlasDetail(call.href, force)));

  /*
   * Then the rules file of each atlas. Cached a week per media id,
   * so after the first report this is ten cache reads.
   */
  const rules = await Promise.all(
    details.map((detail) => (detail.nolikumsHref ? fetchNolikums(detail.nolikumsHref, force) : Promise.resolve(emptyNolikums()))),
  );

  return slice.map((call, index) => {
    const { nolikumsHref: _href, ...detail } = details[index];
    const facts = rules[index];
    return {
      ...call,
      ...detail,
      /* Leftover EUR from the page wins; the rules' total pot is the fallback. */
      money: detail.money || facts.money,
      nolikums: facts.href ? facts : undefined,
    };
  });
}

async function fetchProgramsHtml(force?: boolean): Promise<{ html: string; fetchedAt: string; error?: string; fromCache: boolean }> {
  const cacheKey = 'cfla:calls:html:v1';
  if (!force) {
    const cached = readCache(cacheKey, CALLS_TTL_MS);
    if (cached) {
      const parsed = JSON.parse(cached.payload) as { html?: string; error?: string };
      if (parsed.html && !parsed.error) {
        return { html: parsed.html, fetchedAt: cached.fetched_at, fromCache: true };
      }
    }
  }

  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CFLA_PROGRAMS, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`CFLA lapa atbildēja ${response.status}`);
    }
    const html = await response.text();
    writeCache(cacheKey, JSON.stringify({ html }), fetchedAt);
    return { html, fetchedAt, fromCache: false };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : 'CFLA programmu lapa neatbildēja';
    return { html: '', fetchedAt, error, fromCache: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Currently advertised 2021–2027 selections. CKAN does not
 * publish this table; the official HTML page is the source.
 */
export async function lookupCflaCalls(hints: ParcelHints, force?: boolean): Promise<LookupResult> {
  const page = await fetchProgramsHtml(force);
  if (page.error) {
    return {
      sourceId: 'cfla',
      requestUrl: CFLA_PROGRAMS,
      proofUrl: CFLA_PROGRAMS,
      fetchedAt: page.fetchedAt,
      record: null,
      records: [],
      error: page.error,
      fromCache: page.fromCache,
    };
  }

  /*
   * Table only has title + dates. Who lives on each SAM page —
   * fetch that first, then match against this parcel.
   */
  const enriched = await enrichCalls(parseOpenTable(page.html), force);
  const calls = enriched.map((call) => ({ ...call, ...fitCall(call, hints) }));
  calls.sort((left, right) => right.score - left.score || left.ends.localeCompare(right.ends));

  return {
    sourceId: 'cfla',
    requestUrl: CFLA_PROGRAMS,
    proofUrl: CFLA_PROGRAMS,
    fetchedAt: page.fetchedAt,
    record: calls[0] ? { title: calls[0].title, href: calls[0].href } : null,
    records: calls.map((call) => ({
      title: call.title,
      href: call.href,
      ends: call.ends,
      starts: call.starts,
      score: call.score,
      status: call.status,
      deadline: call.deadline || '',
      evaluation: call.evaluation || '',
      kind: call.kind || '',
      who: call.who || '',
      money: call.money || '',
      matched: call.matched ? '1' : '',
      matchWhy: call.matchWhy || '',
      matchWarn: call.matchWarn || '',
      /* Flattened rules facts; the card builder reads these by name. */
      intensity: call.nolikums?.intensity || '',
      maxGrant: call.nolikums?.maxGrant || '',
      mvuOnly: call.nolikums?.mvuOnly ? '1' : '',
      deMinimis: call.nolikums?.deMinimis ? '1' : '',
      naceExcluded: (call.nolikums?.naceExcluded || []).join(', '),
      nolikumsHref: call.nolikums?.href || '',
    })),
    fromCache: page.fromCache,
  };
}
