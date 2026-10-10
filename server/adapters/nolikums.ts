import { inflateRawSync } from 'node:zlib';
import { USER_AGENT } from '../brand.ts';
import { readCache, writeCache } from '../db.ts';

/*
 * ┌────────────────────────────────────────────────────────────────┐
 * │ CFLA atlases publish their rules ("atlases nolikums") as DOCX. │
 * │ A DOCX is a ZIP; the prose sits in word/document.xml. Node     │
 * │ already ships raw inflate, so a ~60-line central-directory     │
 * │ walk is all we need. No new dependency, no PDF engine.         │
 * │ PDF-only atlases keep their link and simply get no parse.      │
 * └────────────────────────────────────────────────────────────────┘
 */

/** Rules files do not change between amendments; a week is plenty. */
const NOLIKUMS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
/* A nolikums is ~100 kB; anything near this cap is not the file we want. */
const MAX_BYTES = 5 * 1024 * 1024;

export interface NolikumsFacts {
  /** Where the file came from, so the card can link the source. */
  href: string;
  /** Highest "atbalsta intensitāte … N %" in the text, as "85 %". */
  intensity: string;
  /** "Maksimālais … finansējums … vienam projektam … N euro". */
  maxGrant: string;
  /** The applicant has to be a micro / small / medium company. */
  mvuOnly: boolean;
  /** Text mentions de minimis at all. */
  deMinimis: boolean;
  /** NACE codes the rules exclude / name as eligible, "95.31" style. */
  naceExcluded: string[];
  naceIncluded: string[];
  /** Total pot, as a fallback when the atlas page prints none. */
  money: string;
}

export function emptyNolikums(href = ''): NolikumsFacts {
  return {
    href,
    intensity: '',
    maxGrant: '',
    mvuOnly: false,
    deMinimis: false,
    naceExcluded: [],
    naceIncluded: [],
    money: '',
  };
}

/* ---------- ZIP → document.xml ---------- */

/**
 * One file out of a ZIP buffer, by exact name. Walks the central
 * directory at the end of the archive (the local headers can lie
 * about sizes when a data descriptor follows, the directory cannot).
 */
function unzipEntry(zip: Buffer, wanted: string): Buffer | null {
  /* End-of-central-directory record: signature 0x06054b50, scan back up to 64 kB of comment. */
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let at = zip.length - 22; at >= floor; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) {
    return null;
  }

  const entries = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);

  for (let index = 0; index < entries && cursor + 46 <= zip.length; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      return null;
    }
    const method = zip.readUInt16LE(cursor + 10);
    const packedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (name === wanted) {
      /* Local header has its own name / extra lengths; data starts after them. */
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
        return null;
      }
      const localName = zip.readUInt16LE(localOffset + 26);
      const localExtra = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const packed = zip.subarray(start, start + packedSize);
      if (method === 0) {
        return Buffer.from(packed);
      }
      if (method === 8) {
        return inflateRawSync(packed);
      }
      return null;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Paragraph-per-line plain text of a DOCX, or '' when it is not one. */
export function docxText(buffer: Buffer): string {
  let xml: Buffer | null = null;
  try {
    xml = unzipEntry(buffer, 'word/document.xml');
  } catch {
    return '';
  }
  if (!xml) {
    return '';
  }
  /*
   * Amended rules keep tracked changes. Deleted runs would glue
   * the old figure onto the new one ("19 409 820767 673"), so
   * drop deletions and moved-away text before flattening.
   */
  const lined = xml
    .toString('utf8')
    .replace(/<w:del\b[^>]*\/>/g, '')
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/g, '')
    .replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return unescapeXml(lined)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/* ---------- text → facts ---------- */

/** "2 965 151,00" / "1.000.000" / "500000" → 2965151 */
function readEuro(raw: string): number {
  const cleaned = raw.replace(/[\s\u00a0.]/g, '').replace(/,\d{1,2}$/, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function showEuro(value: number): string {
  return `${Math.round(value).toLocaleString('lv-LV')} EUR`;
}

/* Amount immediately followed by euro / EUR. Spaces, dots, nbsp as thousand separators. */
const EURO_AMOUNT = /(\d{1,3}(?:[ \u00a0.]\d{3})+(?:,\d{1,2})?|\d{4,}(?:,\d{1,2})?)\s*(?:euro|EUR)\b/gi;

/** Sentences — a nolikums is punctuated well enough for this. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.;])\s+(?=[A-ZĀČĒĢĪĶĻŅŠŪŽ0-9])|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** NACE 2 style codes in a snippet, "95.31" / "01" — no years, no percentages. */
function naceCodes(snippet: string): string[] {
  const codes = new Set<string>();
  for (const match of snippet.matchAll(/(?<![\d.,])(\d{2})(?:\.(\d{1,2}))?(?:\.\d)?(?![\d%,]|\s*%|\.\d{3})/g)) {
    const division = Number(match[1]);
    if (division < 1 || division > 99) {
      continue;
    }
    codes.add(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  }
  return [...codes];
}

/**
 * The handful of numbers a call's rules decide on. Every pattern
 * is deliberately narrow: a wrong "max grant" is worse than none.
 */
export function parseNolikums(text: string, href = ''): NolikumsFacts {
  const facts = emptyNolikums(href);
  if (!text) {
    return facts;
  }
  const lines = sentences(text);

  /*
   * Aid intensity. Prefer the sentence that says "maksimālā",
   * otherwise take the highest one mentioned (rules often list
   * a lower one for big companies first).
   */
  const intensities: number[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/atbalsta intensitāt\S*[^%]{0,60}?(\d{1,3}(?:[.,]\d+)?)\s*%/gi)) {
      const value = Number(match[1].replace(',', '.'));
      if (value > 0 && value <= 100) {
        intensities.push(/maksimāl/i.test(line) ? value + 1000 : value);
      }
    }
  }
  if (intensities.length) {
    const best = Math.max(...intensities);
    facts.intensity = `${(best > 1000 ? best - 1000 : best).toLocaleString('lv-LV')} %`;
  }

  /* Max grant per project: a "maksimāl…" sentence that is about one project and has a euro sum. */
  for (const line of lines) {
    if (!/maksimāl/i.test(line) || !/(vienam projekt|projekta iesniegum|vienam finansējuma saņēmēj|vienam projekta iesniedzēj)/i.test(line)) {
      continue;
    }
    const amounts = [...line.matchAll(EURO_AMOUNT)].map((match) => readEuro(match[1])).filter((value) => value >= 1000);
    if (amounts.length) {
      facts.maxGrant = showEuro(Math.max(...amounts));
      break;
    }
  }

  /*
   * MVU-only: the sentence names the applicant / recipient and
   * says it must be micro / small / medium. A mere mention of the
   * MVU declaration (very common) does not count.
   */
  facts.mvuOnly = lines.some(
    (line) =>
      /(projekta iesniedzējs|finansējuma saņēmējs|atbalsta saņēmējs)/i.test(line) &&
      /(ir|var būt|var pretendēt)[^.]{0,80}(MVU|mikro|mazais|mazā un vidējā|sīk)/i.test(line) &&
      !/(lielais komersants|lielie komersanti|neatkarīgi no lieluma)/i.test(line),
  );

  facts.deMinimis = /de minimis/i.test(text);

  /*
   * NACE: look in a window around every "NACE" mention. Words of
   * refusal flip the codes into the excluded list.
   */
  const excluded = new Set<string>();
  const included = new Set<string>();
  for (const match of text.matchAll(/NACE/g)) {
    const at = match.index ?? 0;
    const window = text.slice(Math.max(0, at - 250), at + 350);
    const codes = naceCodes(window.replace(/NACE\s*(2\.?\s*red\.?|Rev\.?\s*2)/gi, 'NACE'));
    if (!codes.length) {
      continue;
    }
    const refuse = /(neattiecin|izņemot|netiek atbalst|nav atbalst|neatbalsta|izslēgt|nevar pretendēt|nedrīkst|neatbilst)/i.test(window);
    for (const code of codes) {
      (refuse ? excluded : included).add(code);
    }
  }
  facts.naceExcluded = [...excluded].slice(0, 40);
  facts.naceIncluded = [...included].filter((code) => !excluded.has(code)).slice(0, 40);

  /* Total pot: "kopējais pieejamais finansējums … N euro". */
  for (const line of lines) {
    if (!/(kopējais|pieejamais)[^.]{0,40}finansējum/i.test(line)) {
      continue;
    }
    const amounts = [...line.matchAll(EURO_AMOUNT)].map((match) => readEuro(match[1])).filter((value) => value >= 10_000);
    if (amounts.length) {
      facts.money = `Pieejamais finansējums (nolikumā): ${showEuro(amounts[0])}`;
      break;
    }
  }

  return facts;
}

/* ---------- fetch + cache ---------- */

/**
 * The atlas page links its files as /lv/media/{id}/download?attachment
 * with the file name in `title`. The rules file is the one called
 * "nolikums" that is not an annex ("pielikums").
 */
export function findNolikumsLink(html: string): string {
  const anchors = [...html.matchAll(/<a\s[^>]*href="([^"]*\/media\/\d+\/download[^"]*)"[^>]*>/gi)];
  let fallback = '';
  for (const anchor of anchors) {
    const tag = anchor[0];
    const title = tag.match(/title="([^"]*)"/i)?.[1] ?? '';
    const type = tag.match(/type="([^"]*)"/i)?.[1] ?? '';
    if (!/nolikum/i.test(title)) {
      continue;
    }
    const href = anchor[1].replace(/&amp;/g, '&');
    const absolute = /^https?:/i.test(href) ? href : `https://www.cfla.gov.lv${href.startsWith('/') ? '' : '/'}${href}`;
    const docx = /wordprocessingml/i.test(type) || /\.docx\b/i.test(title);
    if (docx && !/pielikum/i.test(title)) {
      return absolute;
    }
    if (docx && !fallback) {
      fallback = absolute;
    }
  }
  return fallback;
}

/**
 * Download + parse one rules file, cached a week by media id.
 * Never throws: an unreadable file is just an empty fact set.
 */
export async function fetchNolikums(href: string, force?: boolean): Promise<NolikumsFacts> {
  if (!href) {
    return emptyNolikums();
  }
  const mediaId = href.match(/\/media\/(\d+)\//)?.[1] ?? href;
  const cacheKey = `cfla:nolikums:v1:${mediaId}`;
  if (!force) {
    const cached = readCache(cacheKey, NOLIKUMS_TTL_MS);
    if (cached) {
      try {
        return { ...emptyNolikums(href), ...(JSON.parse(cached.payload) as NolikumsFacts) };
      } catch {
        /* stale blob — fetch again */
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(href, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const declared = Number(response.headers.get('content-length') || 0);
    if (!response.ok || declared > MAX_BYTES) {
      return emptyNolikums(href);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return emptyNolikums(href);
    }
    const facts = parseNolikums(docxText(buffer), href);
    writeCache(cacheKey, JSON.stringify(facts), new Date().toISOString());
    return facts;
  } catch {
    return emptyNolikums(href);
  } finally {
    clearTimeout(timer);
  }
}
