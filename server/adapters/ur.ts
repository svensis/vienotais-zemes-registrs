import { datastoreLookup, datastoreSearch } from './ckan.ts';
import type { LookupResult, SourceAdapter } from './types.ts';

const UR_RESOURCE_ID = '25e80bf3-f107-4ab4-89ef-251b5b9374e9';
const UR_PROOF = 'https://info.ur.gov.lv/';

function pickUrRecord(regcode: string, records: Record<string, unknown>[]): Record<string, unknown> | null {
  const exact = records.find((row) => String(row.regcode ?? '') === regcode);
  return exact ?? records[0] ?? null;
}

/**
 * Official legal name from the unpaid UR dump.
 * Add-client refuses a typed title: the register is the source,
 * not whatever someone typed in the form.
 */
export async function resolveRegisteredName(regcode: string): Promise<{ name: string; error?: string }> {
  const lookup = await urAdapter.lookup(regcode, { force: true });
  const name = String(lookup.record?.name ?? '').trim();

  if (name) {
    return { name };
  }

  return {
    name: '',
    error: lookup.error || 'Uzņēmums ar šo reģistrācijas numuru nav atrasts UR datos.',
  };
}

export const urAdapter: SourceAdapter = {
  id: 'ur',
  label: 'Uzņēmumu reģistrs',

  async lookup(regcode, options): Promise<LookupResult> {
    const numeric = Number(regcode);
    const result = await datastoreLookup({
      sourceId: 'ur',
      resourceId: UR_RESOURCE_ID,
      filters: { regcode: Number.isNaN(numeric) ? regcode : numeric },
      query: regcode,
      pick: (records) => pickUrRecord(regcode, records),
      force: options?.force,
    });

    /*
     * Same shape as vidAdapter: callers read lookup.record.name.
     * records[] alone left Pievienot thinking every firm was missing.
     */
    return {
      sourceId: 'ur',
      requestUrl: result.requestUrl,
      proofUrl: `https://info.ur.gov.lv/#/legal-entity/${regcode}`,
      fetchedAt: result.fetchedAt,
      record: result.record,
      records: result.record ? [result.record] : [],
      error: result.error,
      fromCache: result.fromCache,
    };
  },
};

/**
 * Everyone UR has parked on the same VARIS addressid —
 * other merchants plus filiāles. That is the unpaid proxy
 * for “is there economic activity at this property”.
 * VID PDB struktūrvienības stay out: the form is not an API.
 */
export async function lookupAddressOccupants(
  addressId: string,
  force?: boolean,
): Promise<LookupResult> {
  if (!addressId) {
    return {
      sourceId: 'ur',
      requestUrl: '',
      proofUrl: UR_PROOF,
      fetchedAt: new Date().toISOString(),
      record: null,
      records: [],
      fromCache: false,
    };
  }

  const numeric = Number(addressId);
  const result = await datastoreSearch({
    cacheKey: `ur:address-occupants:v2:${addressId}`,
    resourceId: UR_RESOURCE_ID,
    filters: { addressid: Number.isNaN(numeric) ? addressId : numeric },
    limit: 80,
    force,
  });
  const wanted = String(addressId).replace(/\D/g, '');
  const records = result.records.filter((row) => String(row.addressid ?? '').replace(/\D/g, '') === wanted);

  return {
    sourceId: 'ur',
    requestUrl: result.requestUrl,
    proofUrl: UR_PROOF,
    fetchedAt: result.fetchedAt,
    record: {
      addressId,
      skaits: records.length,
    },
    records,
    error: result.error,
    fromCache: result.fromCache,
  };
}
