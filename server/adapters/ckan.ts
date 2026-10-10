import { readCache, writeCache } from '../db.ts';

const CKAN_URL = 'https://data.gov.lv/dati/lv/api/3/action/datastore_search';
const FETCH_TIMEOUT_MS = 15_000;

interface CkanResponse {
  success?: boolean;
  result?: {
    records?: Record<string, unknown>[];
    total?: number;
  };
  error?: { message?: string };
}

export interface DatastoreResult {
  requestUrl: string;
  fetchedAt: string;
  records: Record<string, unknown>[];
  error?: string;
  fromCache: boolean;
}

/**
 * Talks to the official CKAN DataStore.
 *
 * Cache key includes the resource id so UR extras do not
 * overwrite the main register dump. Filters first, then a
 * full-text fallback, because some columns are numeric and
 * some are text.
 */
export async function datastoreSearch(input: {
  cacheKey: string;
  resourceId: string;
  filters?: Record<string, unknown>;
  query?: string;
  limit?: number;
  force?: boolean;
}): Promise<DatastoreResult> {
  if (!input.force) {
    const cached = readCache(input.cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached.payload) as {
        requestUrl: string;
        records: Record<string, unknown>[];
        error?: string;
      };
      return {
        requestUrl: parsed.requestUrl,
        fetchedAt: cached.fetched_at,
        records: parsed.records ?? [],
        error: parsed.error,
        fromCache: true,
      };
    }
  }

  const limit = input.limit ?? 12;
  const filteredUrl = input.filters
    ? buildUrl(input.resourceId, input.filters, undefined, limit)
    : buildUrl(input.resourceId, undefined, input.query, limit);
  const fetchedAt = new Date().toISOString();

  try {
    let records = await fetchRecords(filteredUrl);
    let requestUrl = filteredUrl;

    /*
     * Numeric filters miss when CKAN stored the column as text,
     * and the other way around. The q= fallback is the same
     * trick the first UR/VID adapters used.
     */
    if (records.length === 0 && input.query && input.filters) {
      const queryUrl = buildUrl(input.resourceId, undefined, input.query, limit);
      records = await fetchRecords(queryUrl);
      requestUrl = queryUrl;
    }

    const payload = { requestUrl, records };
    writeCache(input.cacheKey, JSON.stringify(payload), fetchedAt);
    return { requestUrl, fetchedAt, records, fromCache: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nezināma avota kļūda';
    writeCache(
      input.cacheKey,
      JSON.stringify({ requestUrl: filteredUrl, records: [], error: message }),
      fetchedAt,
    );
    return {
      requestUrl: filteredUrl,
      fetchedAt,
      records: [],
      error: message,
      fromCache: false,
    };
  }
}

/**
 * First-hit helper for the original UR/VID adapters.
 * Extra feeds that need several rows call datastoreSearch instead.
 */
export async function datastoreLookup(input: {
  sourceId: string;
  resourceId: string;
  filters: Record<string, unknown>;
  query: string;
  pick: (records: Record<string, unknown>[]) => Record<string, unknown> | null;
  force?: boolean;
  limit?: number;
}): Promise<{
  requestUrl: string;
  fetchedAt: string;
  record: Record<string, unknown> | null;
  error?: string;
  fromCache: boolean;
}> {
  const result = await datastoreSearch({
    cacheKey: `${input.sourceId}:${input.resourceId}:${input.query}`,
    resourceId: input.resourceId,
    filters: input.filters,
    query: input.query,
    limit: input.limit,
    force: input.force,
  });

  return {
    requestUrl: result.requestUrl,
    fetchedAt: result.fetchedAt,
    record: input.pick(result.records),
    error: result.error,
    fromCache: result.fromCache,
  };
}

function buildUrl(
  resourceId: string,
  filters?: Record<string, unknown>,
  q?: string,
  limit = 12,
): string {
  const params = new URLSearchParams();
  params.set('resource_id', resourceId);
  params.set('limit', String(limit));
  if (filters) {
    params.set('filters', JSON.stringify(filters));
  }
  if (q) {
    params.set('q', q);
  }
  return `${CKAN_URL}?${params.toString()}`;
}

async function fetchRecords(url: string): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`CKAN atbilde ${response.status}`);
    }

    const body = (await response.json()) as CkanResponse;
    if (!body.success) {
      throw new Error(body.error?.message ?? 'CKAN pieprasījums neizdevās');
    }

    return body.result?.records ?? [];
  } finally {
    clearTimeout(timer);
  }
}
