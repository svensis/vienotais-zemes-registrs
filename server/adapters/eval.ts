import { datastoreSearch } from './ckan.ts';
import type { LookupResult } from './types.ts';
import { cadastreDigits } from '../fields.ts';

const BIS_BUILDINGS = 'f41f3ee3-5040-4c65-8c80-f71495c817d9';
const BIS_CASES = '4f5648b2-fed8-4722-987f-9a36dfa331dc';
const ES_PLACES = [
  { id: '35da9d99-7750-4be8-85d9-4aaa920d4583', period: '14–20' },
  { id: '27733f45-ef48-41bf-9a9c-cc818ed9f32f', period: '21–27' },
  { id: 'fec77132-7058-4e28-b4fc-0772454b8041', period: 'AF' },
] as const;
/*
 * Same CFLA packages, the project-list report. Places only
 * have a number; the list has the name, status, beneficiary
 * and the EU amount. Join is ProjektaNumurs.
 */
const ES_LISTS = [
  { id: '9c2d6bf2-41a4-4a58-a5ba-3a4ad6d7e79f', period: '14–20' },
  { id: '80aca232-54ad-4a9e-b1e3-c06623c1020b', period: '21–27' },
  { id: 'bfcae357-328c-423f-9835-215e7fd3db4e', period: 'AF' },
] as const;
/*
 * 2021 opens the current EU period. DNP 2022/82K is in
 * the 2022 file, so a 2023–2026 window reported it as Nē.
 */
const EIS_YEARS = [
  '6bd2e287-c494-4ddc-9525-802d88872edc',
  '0c4d15c4-cf59-4239-ba76-de4bbf48d824',
  'b8927a5d-1274-4262-bccc-16d21abcf4a3',
  'd7204b7f-0767-472e-b1c7-b85816992885',
  '42739f4f-d625-46a7-9668-ef2e0376e421',
  'f2a08974-d59a-4d83-92f2-4194cb2bd97d',
];
const ATIS = '072603f8-243f-4910-8994-8e8de8665bd7';

const BIS_PROOF = 'https://bis.gov.lv/bisp/lv/planned_constructions';
const ES_PROOF = 'https://data.gov.lv/dati/lv/dataset/es-lidzfinansetie-projekti';
const EIS_PROOF = 'https://www.eis.gov.lv/';
const ATIS_PROOF = 'https://data.gov.lv/dati/lv/dataset/atis-datu-un-kadastra-objektu-apgrutinajumu-klasifikators';

function text(value: unknown): string {
  if (value == null) {
    return '';
  }
  let raw = String(value).replace(/\s+/g, ' ').trim();
  /*
   * The 2022 EIS export stored cells as Excel formulas,
   * ="DNP 2022/82K". Later years are plain text.
   */
  const wrapped = raw.match(/^="([\s\S]*)"$/);
  if (wrapped) {
    raw = wrapped[1].trim();
  }
  return raw;
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** House token with the LV postcode removed, same rule as the address verdict. */
function houseToken(value: string): string {
  const withoutPostcode = fold(value)
    .replace(/\blv\s*\d{4}\b/g, ' ')
    .replace(/\b\d{4}\b/g, ' ');
  const matches = [...withoutPostcode.matchAll(/\b(\d{1,3}[a-z]?)\b/g)].map((match) => match[1]);
  return matches.length ? matches[matches.length - 1] : '';
}

const STREET_NOISE = new Set([
  'iela',
  'ielas',
  'bulvaris',
  'prospekts',
  'aleja',
  'laukums',
  'gatve',
  'nov',
  'novads',
  'pag',
  'pagasts',
  'lv',
  'pilseta',
  'ciems',
  'latvija',
]);

function streetToken(value: string): string {
  const tokens = fold(value)
    .split(' ')
    .filter((token) => token.length > 3 && !STREET_NOISE.has(token) && !/^\d/.test(token));
  return tokens[0] || '';
}

/** Same street and same house. A neighbouring house number stays out. */
function sameAddress(official: string, candidate: string): boolean {
  const house = houseToken(official);
  const street = streetToken(official);
  if (!house || !street || houseToken(candidate) !== house) {
    return false;
  }
  return fold(candidate).includes(street);
}

function blank(sourceId: LookupResult['sourceId'], proofUrl: string): LookupResult {
  return {
    sourceId,
    requestUrl: '',
    proofUrl,
    fetchedAt: new Date().toISOString(),
    record: null,
    records: [],
    fromCache: false,
  };
}

/**
 * Building rows whose cadastre designation is the searched
 * number, or a building sitting on that parcel (prefix).
 */
export async function lookupBuildingsByCadastre(cadastre: string, force?: boolean): Promise<LookupResult> {
  const digits = cadastreDigits(cadastre);
  if (digits.length < 11) {
    return blank('bis', BIS_PROOF);
  }

  const result = await datastoreSearch({
    cacheKey: `eval:bis-building:${digits}`,
    resourceId: BIS_BUILDINGS,
    query: digits,
    limit: 40,
    force,
  });

  const records = result.records.filter((row) => {
    const found = cadastreDigits(text(row.Buves_kadastra_apzimejums));
    if (!found) {
      return false;
    }
    /*
     * A parcel search keeps every building on that land unit.
     * A designation search keeps that object only — a shorter
     * prefix would pull a sibling building's case.
     */
    if (found === digits) {
      return true;
    }
    return digits.length === 11 && found.startsWith(digits);
  });

  return {
    sourceId: 'bis',
    requestUrl: result.requestUrl,
    proofUrl: BIS_PROOF,
    fetchedAt: result.fetchedAt,
    record: records[0] ?? null,
    records,
    error: result.error,
    fromCache: result.fromCache,
  };
}

/** Case list has no cadastre column. We join on the case number from the building row. */
export async function lookupCasesByNumber(caseNumbers: string[], force?: boolean): Promise<LookupResult> {
  const numbers = [...new Set(caseNumbers.map((value) => text(value)).filter(Boolean))].slice(0, 8);
  if (!numbers.length) {
    return blank('bis', BIS_PROOF);
  }

  const records: Record<string, unknown>[] = [];
  let requestUrl = '';
  let fetchedAt = new Date().toISOString();
  let error: string | undefined;
  let fromCache = true;

  for (const caseNumber of numbers) {
    const result = await datastoreSearch({
      cacheKey: `eval:bis-case:${caseNumber}`,
      resourceId: BIS_CASES,
      filters: { Buvniecibas_lietas_numurs: caseNumber },
      query: caseNumber,
      limit: 5,
      force,
    });
    requestUrl = result.requestUrl || requestUrl;
    fetchedAt = result.fetchedAt;
    fromCache = fromCache && result.fromCache;
    error = error || result.error;
    /*
     * Full-text returns a neighbouring case when the number
     * is only similar. That case is a different object.
     */
    const hit = result.records.find((row) => text(row.Buvniecibas_lietas_numurs) === caseNumber);
    if (hit) {
      records.push(hit);
    }
  }

  return {
    sourceId: 'bis',
    requestUrl,
    proofUrl: BIS_PROOF,
    fetchedAt,
    record: records[0] ?? null,
    records,
    error,
    fromCache,
  };
}

/**
 * Cadastre match first. Rows with an empty KadastraNumurs
 * still count when the address is the same house — the
 * 21–27 Dobele school row is stored that way.
 * A filled cadastre that is a different number stays out.
 */
export async function lookupEsByCadastre(
  numbers: string[],
  addresses: string[] = [],
  force?: boolean,
): Promise<LookupResult> {
  const needles = [...new Set(numbers.map(cadastreDigits).filter((value) => value.length >= 11))];
  if (!needles.length) {
    return blank('es', ES_PROOF);
  }

  const records: Record<string, unknown>[] = [];
  let requestUrl = '';
  let fetchedAt = new Date().toISOString();
  let error: string | undefined;
  let fromCache = true;

  for (const place of ES_PLACES) {
    for (const needle of needles.slice(0, 4)) {
      const result = await datastoreSearch({
        cacheKey: `eval:es:${place.period}:${needle}`,
        resourceId: place.id,
        filters: { KadastraNumurs: needle },
        query: needle,
        limit: 15,
        force,
      });
      requestUrl = result.requestUrl || requestUrl;
      fetchedAt = result.fetchedAt;
      fromCache = fromCache && result.fromCache;
      error = error || result.error;
      for (const row of result.records) {
        const found = cadastreDigits(text(row.KadastraNumurs));
        if (!found) {
          continue;
        }
        if (found === needle || found.startsWith(needle) || needle.startsWith(found)) {
          records.push({ ...row, _periods: place.period, _match: 'kadastrs' });
        }
      }
    }
  }

  const address = addresses.map((value) => text(value)).find((value) => streetToken(value) && houseToken(value)) || '';
  if (address) {
    const query = `${streetToken(address)} ${houseToken(address)}`;
    for (const place of ES_PLACES) {
      const result = await datastoreSearch({
        cacheKey: `eval:es:addr:v1:${place.period}:${query}`,
        resourceId: place.id,
        query,
        limit: 20,
        force,
      });
      requestUrl = result.requestUrl || requestUrl;
      fetchedAt = result.fetchedAt;
      fromCache = fromCache && result.fromCache;
      error = error || result.error;
      for (const row of result.records) {
        if (!sameAddress(address, text(row.Adrese))) {
          continue;
        }
        const found = cadastreDigits(text(row.KadastraNumurs));
        const onThisParcel = needles.some(
          (needle) => found === needle || found.startsWith(needle) || needle.startsWith(found),
        );
        if (found && !onThisParcel) {
          continue;
        }
        const key = `${place.period}|${text(row.ProjektaNumurs)}|${text(row.Adrese)}`;
        if (records.some((item) => `${text(item._periods)}|${text(item.ProjektaNumurs)}|${text(item.Adrese)}` === key)) {
          continue;
        }
        records.push({
          ...row,
          _periods: place.period,
          _match: found ? 'kadastrs' : 'adrese',
        });
      }
    }
  }

  /*
   * One list lookup per project. Eight is enough on the card;
   * the proof link still has the full place query.
   */
  const unique: Record<string, unknown>[] = [];
  const seenPlaces = new Set<string>();
  for (const row of records) {
    const key = `${text(row._periods)}|${text(row.ProjektaNumurs)}`;
    if (seenPlaces.has(key)) {
      continue;
    }
    seenPlaces.add(key);
    unique.push(row);
    if (unique.length >= 8) {
      break;
    }
  }

  const enriched = await enrichEsProjects(unique, force);
  return {
    sourceId: 'es',
    requestUrl: enriched.requestUrl || requestUrl,
    proofUrl: ES_PROOF,
    fetchedAt,
    record: enriched.records[0] ?? null,
    records: enriched.records,
    error: error || enriched.error,
    fromCache: fromCache && enriched.fromCache,
  };
}

/**
 * One CKAN hit per project number, against the list that
 * matches the place's period. A miss leaves the place row
 * as it was — the cadastre match is still true.
 */
async function enrichEsProjects(
  places: Record<string, unknown>[],
  force?: boolean,
): Promise<{ records: Record<string, unknown>[]; requestUrl: string; error?: string; fromCache: boolean }> {
  let requestUrl = '';
  let error: string | undefined;
  let fromCache = true;
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];

  for (const place of places) {
    const number = text(place.ProjektaNumurs);
    const period = text(place._periods);
    const key = `${period}|${number}`;
    if (!number || seen.has(key)) {
      if (!seen.has(key)) {
        merged.push(place);
      }
      continue;
    }
    seen.add(key);

    const list = ES_LISTS.find((item) => item.period === period);
    if (!list) {
      merged.push(place);
      continue;
    }

    const result = await datastoreSearch({
      cacheKey: `eval:es:list:${period}:${number}`,
      resourceId: list.id,
      filters: { ProjektaNumurs: number },
      query: number,
      limit: 3,
      force,
    });
    requestUrl = result.requestUrl || requestUrl;
    fromCache = fromCache && result.fromCache;
    error = error || result.error;
    const hit =
      result.records.find((row) => text(row.ProjektaNumurs) === number) ?? result.records[0] ?? null;
    merged.push(hit ? { ...place, ...hit, _periods: period, _match: place._match } : place);
  }

  return { records: merged, requestUrl, error, fromCache };
}

/**
 * Buyer registration number, 2021–2026.
 * A second pass keeps a notice whose place or title is this house,
 * even when the buyer is not the applicant.
 */
export async function lookupProcurement(
  regcodes: string[],
  force?: boolean,
  placeText?: string,
): Promise<LookupResult> {
  const codes = [...new Set(regcodes.map((value) => value.replace(/\D/g, '')).filter((value) => value.length === 11))].slice(0, 4);
  const site = text(placeText || '');
  const siteQuery = streetToken(site) && houseToken(site) ? `${streetToken(site)} ${houseToken(site)}` : '';
  if (!codes.length && !siteQuery) {
    return blank('eis', EIS_PROOF);
  }

  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let requestUrl = '';
  let fetchedAt = new Date().toISOString();
  let error: string | undefined;
  let fromCache = true;

  const push = (row: Record<string, unknown>, match: string) => {
    const key = text(row.Iepirkuma_identifikacijas_numurs) || text(row.Iepirkuma_ID);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    records.push({ ...row, _match: match });
  };

  for (const resourceId of EIS_YEARS) {
    for (const regcode of codes) {
      const result = await datastoreSearch({
        cacheKey: `eval:eis:v2:${resourceId}:${regcode}`,
        resourceId,
        filters: { Pasutitaja_registracijas_numurs: regcode },
        query: regcode,
        limit: 40,
        force,
      });
      requestUrl = result.requestUrl || requestUrl;
      fetchedAt = result.fetchedAt;
      fromCache = fromCache && result.fromCache;
      error = error || result.error;
      for (const row of result.records) {
        const buyer = text(row.Pasutitaja_registracijas_numurs).replace(/\D/g, '');
        if (buyer && buyer !== regcode) {
          continue;
        }
        push(row, 'pasutitajs');
      }
    }

    /*
     * Object place, not the buyer. House number has to match,
     * so "Dzirnavu iela 2" does not satisfy "Dzirnavu iela 4".
     */
    if (!siteQuery) {
      continue;
    }
    const result = await datastoreSearch({
      cacheKey: `eval:eis:place:v1:${resourceId}:${siteQuery}`,
      resourceId,
      query: siteQuery,
      limit: 15,
      force,
    });
    requestUrl = result.requestUrl || requestUrl;
    fetchedAt = result.fetchedAt;
    fromCache = fromCache && result.fromCache;
    error = error || result.error;
    for (const row of result.records) {
      const blob = `${text(row.Iepirkuma_nosaukums)} ${text(row.Precu_vai_pakalpojumu_sniegsanas_vieta)}`;
      if (!sameAddress(site, blob)) {
        continue;
      }
      push(row, 'vieta');
    }
  }

  const ranked = [...records].sort((left, right) => {
    const leftHere = site && sameAddress(site, `${text(left.Iepirkuma_nosaukums)} ${text(left.Precu_vai_pakalpojumu_sniegsanas_vieta)}`) ? 0 : 1;
    const rightHere = site && sameAddress(site, `${text(right.Iepirkuma_nosaukums)} ${text(right.Precu_vai_pakalpojumu_sniegsanas_vieta)}`) ? 0 : 1;
    return leftHere - rightHere;
  });

  return {
    sourceId: 'eis',
    requestUrl,
    proofUrl: EIS_PROOF,
    fetchedAt,
    record: ranked[0] ?? null,
    records: ranked.slice(0, 8),
    error,
    fromCache,
  };
}

/** Classifier text for an encumbrance code, when the dump only stored the code. */
export async function lookupAtisCode(code: string, force?: boolean): Promise<string> {
  const clean = text(code);
  if (!clean) {
    return '';
  }
  const result = await datastoreSearch({
    cacheKey: `eval:atis:${clean}`,
    resourceId: ATIS,
    filters: { Kods: clean },
    query: clean,
    limit: 3,
    force,
  });
  const row = result.records.find((item) => text(item.Kods) === clean) ?? result.records[0];
  return text(row?.Apraksts);
}

export const ATIS_DATASET = ATIS_PROOF;
