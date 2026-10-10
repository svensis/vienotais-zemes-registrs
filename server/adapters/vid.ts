import { datastoreLookup } from './ckan.ts';
import type { LookupResult, SourceAdapter } from './types.ts';

const VID_RESOURCE_ID = '610910e9-e086-4c5b-a7ea-0a896a697672';

function vatNumber(regcode: string): string {
  return `LV${regcode}`;
}

function isVidActive(value: unknown): boolean {
  const lowered = String(value ?? '')
    .trim()
    .toLowerCase();
  return lowered === 'ir' || lowered === 'jā' || lowered === 'ja' || lowered === 'aktīvs';
}

function vidRegisteredAt(row: Record<string, unknown>): number {
  const match = String(row.Registrets ?? '')
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) {
    return 0;
  }
  return Date.parse(`${match[3]}-${match[2]}-${match[1]}`);
}

function newestVidRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!rows.length) {
    return null;
  }
  return [...rows].sort((left, right) => vidRegisteredAt(right) - vidRegisteredAt(left))[0];
}

/**
 * VID’s unpaid dump keeps every VAT spell, not just the current one.
 * Olpha is LV40003007246 twice: struck off 13.10.1996 (`Aktivs: nav`)
 * and live again from 14.10.1996 (`Aktivs: ir`). `find()` used to
 * keep the dead row, so the card said “nav aktīvs” while
 * www6.vid.gov.lv/PVN showed ir.
 */
function pickVidRecord(regcode: string, records: Record<string, unknown>[]): Record<string, unknown> | null {
  const wanted = vatNumber(regcode);
  const exact = records.filter((row) => String(row.Numurs ?? '').replace(/\s/g, '') === wanted);
  const pool = exact.length ? exact : records;
  const live = pool.filter((row) => isVidActive(row.Aktivs));
  return newestVidRow(live) ?? newestVidRow(pool);
}

export const vidAdapter: SourceAdapter = {
  id: 'vid',
  label: 'VID PVN maksātāji',

  async lookup(regcode, options): Promise<LookupResult> {
    const result = await datastoreLookup({
      sourceId: 'vid',
      resourceId: VID_RESOURCE_ID,
      filters: { Numurs: vatNumber(regcode) },
      query: vatNumber(regcode),
      pick: (records) => pickVidRecord(regcode, records),
      force: options?.force,
      limit: 40,
    });

    return {
      sourceId: 'vid',
      requestUrl: result.requestUrl,
      proofUrl: 'https://www6.vid.gov.lv/PVN',
      fetchedAt: result.fetchedAt,
      record: result.record,
      records: result.record ? [result.record] : [],
      error: result.error,
      fromCache: result.fromCache,
    };
  },
};
