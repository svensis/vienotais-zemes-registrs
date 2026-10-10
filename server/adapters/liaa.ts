import { datastoreSearch } from './ckan.ts';
import type { LookupResult } from './types.ts';

const LIAA_SERVICES = '03f2b47a-67f7-4cc8-a899-8a4a09424756';
export const LIAA_PROOF = 'https://liaa.business.gov.lv/atbalsta-iespejas';
const LIAA_HOLDER = 'Latvijas Investīciju un attīstības aģentūra';

function text(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function stillOffered(until: string): boolean {
  if (!until || until === 'None' || until === '-') {
    return true;
  }
  const stamp = Date.parse(until);
  if (Number.isNaN(stamp)) {
    return true;
  }
  return stamp >= Date.now() - 24 * 60 * 60 * 1000;
}

/**
 * National LIAA catalogue on data.gov.lv. No cadastre column —
 * we only show it when a company sits on the parcel (or the
 * user typed a registration number). Holder filter keeps out
 * municipal room-hire rows that share the same dump.
 */
export async function lookupLiaaSupport(force?: boolean): Promise<LookupResult> {
  const result = await datastoreSearch({
    cacheKey: 'liaa:services:holder:v1',
    resourceId: LIAA_SERVICES,
    filters: { 'Pakalpojuma turētājs': LIAA_HOLDER, Valoda: 'lv' },
    query: 'LIAA',
    limit: 40,
    force,
  });

  const records = result.records.filter((row) => {
    if (text(row.Valoda) && text(row.Valoda).toLowerCase() !== 'lv') {
      return false;
    }
    const holder = text(row['Pakalpojuma turētājs']);
    if (holder && holder !== LIAA_HOLDER) {
      return false;
    }
    return stillOffered(text(row['Pieejams līdz']));
  });

  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const row of records) {
    const name = text(row.Nosaukums);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    unique.push(row);
    if (unique.length >= 8) {
      break;
    }
  }

  return {
    sourceId: 'liaa',
    requestUrl: result.requestUrl,
    proofUrl: LIAA_PROOF,
    fetchedAt: result.fetchedAt,
    record: unique[0] ?? null,
    records: unique,
    error: result.error,
    fromCache: result.fromCache,
  };
}
