import type { BuildingDetail, BuildingOutline, FieldSpec, GeocodeHit, Parcel, ParcelOutline, ReportTick, SourceRow } from './types';

/*
 * Vite `base` is `/` locally and `/hakatons/` on the VPS, so
 * the same `/api/...` paths stay same-origin in both places.
 */
export const API_ROOT = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

/*
 * Every call goes through one fetch wrapper so a dead server
 * reads the same way everywhere: one Latvian sentence.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${API_ROOT}${path}`, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    throw new Error('Serveri neizdevās sasniegt. Pārbaudiet interneta savienojumu un mēģiniet vēlreiz.');
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Pieprasījums neizdevās (${response.status})`);
  }
  return body;
}

/** Field order and labels, owned by the server so there is one list. */
export async function fetchFields(): Promise<FieldSpec[]> {
  const body = await parseJson<{ fields: FieldSpec[] }>(await apiFetch('/api/fields'));
  return body.fields;
}

export async function fetchSources(): Promise<SourceRow[]> {
  const body = await parseJson<{ sources: SourceRow[] }>(await apiFetch('/api/sources'));
  return body.sources;
}

/** The click: the land unit under a point, or null when there is none. */
export async function fetchParcelAt(lat: number, lon: number): Promise<Parcel | null> {
  const body = await parseJson<{ parcel: Parcel | null }>(
    await apiFetch(`/api/parcel/at?lat=${lat.toFixed(7)}&lon=${lon.toFixed(7)}`),
  );
  return body.parcel;
}

/** The search box and deep links: the same shape, by number. */
export async function fetchParcelByNumber(cadastre: string): Promise<Parcel | null> {
  const body = await parseJson<{ parcel: Parcel | null }>(
    await apiFetch(`/api/parcel/${encodeURIComponent(cadastre)}`),
  );
  return body.parcel;
}

/**
 * Outlines inside one box, for the "Kadastrs" layer.
 * The map asks per snapped tile, so the same four numbers
 * come back on every pan and both caches actually hit.
 * `signal` lets a newer pan cancel tiles nobody will see.
 */
export async function fetchParcelsInBox(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal,
): Promise<{ parcels: ParcelOutline[]; truncated: boolean; tooWide?: boolean }> {
  const query = new URLSearchParams({ s: String(south), w: String(west), n: String(north), e: String(east) });
  return parseJson(await apiFetch(`/api/parcels/box?${query.toString()}`, { signal }));
}

/**
 * Building footprints registered on one land unit (VZD INSPIRE
 * "Ēkas"). An empty list is a real answer: bare land.
 */
export async function fetchParcelBuildings(
  cadastre: string,
  signal?: AbortSignal,
): Promise<{ buildings: BuildingOutline[]; requestUrl: string; fetchedAt: string }> {
  return parseJson(await apiFetch(`/api/parcel/${encodeURIComponent(cadastre)}/buildings`, { signal }));
}

/** One building's register facts: BIS row and case, legal status, address, encumbrances. */
export async function fetchBuildingDetail(code: string, signal?: AbortSignal): Promise<BuildingDetail> {
  return parseJson(await apiFetch(`/api/building/${encodeURIComponent(code)}`, { signal }));
}

export async function geocode(query: string): Promise<GeocodeHit[]> {
  const body = await parseJson<{ hits: GeocodeHit[] }>(await apiFetch(`/api/geocode?q=${encodeURIComponent(query)}`));
  return body.hits;
}

/**
 * Queue the report for one cadastre number. `applicant` is an
 * optional 11-digit company number for the VID / de minimis /
 * procurement rows. Returns at once; poll the job for rows.
 */
export async function startReport(input: {
  cadastre: string;
  applicant?: string;
  force?: boolean;
}): Promise<{ jobId: string } & ReportTick> {
  return parseJson(
    await apiFetch('/api/parcel/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function pollReport(jobId: string): Promise<ReportTick> {
  return parseJson<ReportTick>(await apiFetch(`/api/jobs/${jobId}`));
}
