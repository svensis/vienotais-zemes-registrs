import { readCache, writeCache } from '../db.ts';
import { USER_AGENT } from '../brand.ts';

/**
 * Address → coordinates for the search box.
 *
 * OpenStreetMap's Nominatim is open data and needs no key.
 * Its usage policy asks for an identifying User-Agent and at
 * most one request a second — the UI debounces, and every
 * answer is cached for the usual TTL.
 */
export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export async function geocode(query: string): Promise<GeocodeHit[]> {
  const q = query.trim();
  if (q.length < 3) {
    return [];
  }

  const cacheKey = `geocode:v1:${q.toLowerCase()}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return JSON.parse(cached.payload) as GeocodeHit[];
  }

  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    countrycodes: 'lv',
    limit: '5',
    'accept-language': 'lv',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${NOMINATIM}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`Nominatim ${response.status}`);
    }
    const rows = (await response.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
    const hits = rows
      .map((row) => ({
        label: String(row.display_name ?? '').trim(),
        lat: Number(row.lat),
        lon: Number(row.lon),
      }))
      .filter((hit) => hit.label && Number.isFinite(hit.lat) && Number.isFinite(hit.lon));
    writeCache(cacheKey, JSON.stringify(hits), new Date().toISOString());
    return hits;
  } catch {
    throw new Error('Adrešu meklētājs šobrīd neatbild. Ievadi kadastra numuru vai uzklikšķini uz kartes.');
  } finally {
    clearTimeout(timer);
  }
}
