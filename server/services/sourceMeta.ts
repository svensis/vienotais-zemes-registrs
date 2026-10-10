import { listSourceHealth, upsertSourceHealth, type SourceHealth } from '../db.ts';
import { SOURCE_MATRIX } from '../sources.ts';
import { logEvent } from '../db.ts';

const CKAN_RESOURCE = 'https://data.gov.lv/dati/lv/api/3/action/resource_show';

interface ResourceShow {
  success?: boolean;
  result?: {
    last_modified?: string;
    created?: string;
    datastore_active?: boolean;
    format?: string;
    name?: string;
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function fetchResource(id: string): Promise<SourceHealth | null> {
  const url = `${CKAN_RESOURCE}?id=${encodeURIComponent(id)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return {
        resource_id: id,
        last_modified: '',
        checked_at: new Date().toISOString(),
        ok: 0,
        note: `CKAN ${response.status}`,
      };
    }

    const body = (await response.json()) as ResourceShow;
    const modified = body.result?.last_modified || body.result?.created || '';
    return {
      resource_id: id,
      last_modified: modified,
      checked_at: new Date().toISOString(),
      ok: body.success ? 1 : 0,
      note: body.result?.datastore_active === false ? 'DataStore nav aktīvs' : body.result?.format || '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'resource_show neizdevās';
    return {
      resource_id: id,
      last_modified: '',
      checked_at: new Date().toISOString(),
      ok: 0,
      note: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Snapshots CKAN resource timestamps so a silent schema/dump
 * swap shows up on Avoti instead of as a mysterious empty card.
 */
export async function refreshSourceMeta(): Promise<SourceHealth[]> {
  const previous = new Map(listSourceHealth().map((row) => [row.resource_id, row]));
  const ids = [...new Set(SOURCE_MATRIX.map((row) => row.resourceId).filter(isUuid))];
  const next: SourceHealth[] = [];

  for (const id of ids) {
    const row = await fetchResource(id);
    if (!row) {
      continue;
    }
    const old = previous.get(id);
    if (old?.last_modified && row.last_modified && old.last_modified !== row.last_modified) {
      logEvent('source_refreshed', {
        resourceId: id,
        from: old.last_modified,
        to: row.last_modified,
      });
    }
    upsertSourceHealth(row);
    next.push(row);
  }

  return next;
}

export function sourceHealthMap(): Record<string, SourceHealth> {
  return Object.fromEntries(listSourceHealth().map((row) => [row.resource_id, row]));
}
