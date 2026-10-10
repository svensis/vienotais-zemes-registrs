const CKAN = 'https://data.gov.lv/dati/lv/api/3/action/resource_show?id=25e80bf3-f107-4ab4-89ef-251b5b9374e9';
const OZOLS =
  'https://ozols.gov.lv/kartes/rest/services/Hosted/%C4%AADT_pamatteritorijas_bez_zon%C4%93juma/FeatureServer/0?f=json';
const TAPIS = 'https://tapis.gov.lv/izpl/geoserver/tapis_apvienotie/wfs?service=WFS&request=GetCapabilities';

export interface Probe {
  ok: boolean;
  ms: number;
  error?: string;
}

async function probe(url: string, timeoutMs = 6_000): Promise<Probe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json, application/xml, text/xml, */*' },
    });
    return {
      ok: response.ok,
      ms: Date.now() - started,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : 'nezināma kļūda',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness for the process plus a short ping of the three
 * feeds the card actually dies without. Rate-limit exempt.
 */
export async function sourceHealth() {
  const [ckan, ozols, tapis] = await Promise.all([probe(CKAN), probe(OZOLS, 8_000), probe(TAPIS, 8_000)]);
  const ok = ckan.ok;
  return {
    ok,
    checked_at: new Date().toISOString(),
    app: { ok: true, ms: 0 },
    ckan,
    ozols,
    tapis,
  };
}
