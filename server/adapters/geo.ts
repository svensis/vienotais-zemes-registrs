import { USER_AGENT } from '../brand.ts';
import { readCache, writeCache } from '../db.ts';
import type { LookupResult } from './types.ts';

const FETCH_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_SEC = Math.round(FETCH_TIMEOUT_MS / 1000);

export const OZOLS_PROOF = 'https://ozols.gov.lv/pub';
export const FLOOD_PROOF = 'https://geolatvija.lv/main?geoProductId=309';
export const ZG_PROOF = 'https://zemesgramata.lv/lv/Search/GetFolioDataByCadastre';
export const TAPIS_PROOF = 'https://tapis.gov.lv/';

/**
 * GeoServer workspace WFS. The global /ows catalogue lists
 * tapis_apvienotie:funkcionalais_zonejums, but GetFeature only
 * answers on the workspace path without the prefix.
 */
const TAPIS_WFS = 'https://tapis.gov.lv/izpl/geoserver/tapis_apvienotie/wfs';
const TAPIS_WMS = 'https://tapis.gov.lv/izpl/geoserver/tapis_apvienotie/wms';

/*
 * VZD INSPIRE parcel layer, reached through the VISS proxy.
 * grafws.kadastrs.lv itself does not accept a connection
 * from this host. The feature id is "CP" plus the 11-digit
 * land-unit designation. referencePoint is ETRS89
 * (EPSG:4258): latitude, then longitude.
 */
const PARCEL_WFS =
  'https://geo-dpps.viss.gov.lv/api/DPPSPackage/client/Zemes_vien_423_0p2RBZ/5cc09e19-a238-4a2e-8eac-3a05cefa050e';

/*
 * VZD INSPIRE "Ēkas" (geolatvija geoproduct 135), second
 * service package. The first one (…_219_…) answers
 * "Service WFS is disabled"; this one serves bu:Building.
 * Building id is "CB" plus the 14-digit building designation,
 * whose first 11 digits are the land unit it stands on.
 */
export const BUILDING_WFS =
  'https://geo-dpps.viss.gov.lv/api/DPPSPackage/client/Ekas_un_bu_419_kg61P8/37f45682-3bd3-4df2-9e81-76364ad7d05b';
export const BUILDING_PROOF = 'https://geolatvija.lv/main?geoProductId=135';

/*
 * Same attribute list 400s on apgrūtinājumi / NIO.
 * Zoning keeps it so we do not download the whole Rīga TR1 polygon.
 */
const TAPIS_PROPERTIES =
  'kods,nosaukums,veids,indekss,grupa_nos,piezimes,dok_nos,dok_datums_no,atvk_nos';

const OZOLS_FS =
  'https://ozols.gov.lv/arcgis/rest/services/OZOLS_DABASDATI_PUB_DATU_APMAINA/FeatureServer';
const OZOLS_HOSTED = 'https://ozols.gov.lv/kartes/rest/services/Hosted';
const FLOOD_FS =
  'https://geodata.lvgmc.lv/server/rest/services/Latvijas_pludu_riska_un_pludu_draudu_kartes_garumzimes/FeatureServer';

export interface GeoPoint {
  lat: number;
  lon: number;
  easting?: number;
  northing?: number;
}

interface ArcGisFeature {
  attributes?: Record<string, unknown>;
}

interface ArcGisResponse {
  features?: ArcGisFeature[];
  error?: { message?: string; code?: number };
}

/**
 * Point-in-polygon against an official ArcGIS FeatureServer.
 * Ozols is published in LKS-92 (3059); LVĢMC flood layers
 * accepted WGS84 in live checks. We send both when VARIS
 * gave us easting/northing.
 */
async function queryLayer(input: {
  cacheKey: string;
  url: string;
  point: GeoPoint;
  prefer3059: boolean;
  distanceMeters?: number;
  force?: boolean;
  outFields?: string;
  timeoutMs?: number;
}): Promise<{ requestUrl: string; fetchedAt: string; records: Record<string, unknown>[]; error?: string; fromCache: boolean }> {
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

  const use3059 = input.prefer3059 && Number.isFinite(input.point.easting) && Number.isFinite(input.point.northing);
  const geometry = use3059
    ? { x: input.point.easting, y: input.point.northing, spatialReference: { wkid: 3059 } }
    : { x: input.point.lon, y: input.point.lat, spatialReference: { wkid: 4326 } };

  const params = new URLSearchParams();
  params.set('f', 'json');
  params.set('geometry', JSON.stringify(geometry));
  params.set('geometryType', 'esriGeometryPoint');
  params.set('inSR', use3059 ? '3059' : '4326');
  params.set('spatialRel', 'esriSpatialRelIntersects');
  params.set('outFields', input.outFields || '*');
  params.set('returnGeometry', 'false');
  params.set('resultRecordCount', '8');
  if (input.distanceMeters) {
    params.set('distance', String(input.distanceMeters));
    params.set('units', 'esriSRUnit_Meter');
  }

  const requestUrl = `${input.url}/query?${params.toString()}`;
  const fetchedAt = new Date().toISOString();

  try {
    const records = await fetchJson(requestUrl, input.timeoutMs);
    writeCache(input.cacheKey, JSON.stringify({ requestUrl, records }), fetchedAt);
    return { requestUrl, fetchedAt, records, fromCache: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ģeotelpiskā vaicājuma kļūda';
    /*
     * Timeouts are transient. Caching them for a day would
     * freeze a red «kļūda» on the card after one slow LVĢMC day.
     */
    const transient = /abort|timeout|atcelts|neatbildēja|nav pieejams|does not exist/i.test(message);
    if (!transient) {
      writeCache(input.cacheKey, JSON.stringify({ requestUrl, records: [], error: message }), fetchedAt);
    }
    return { requestUrl, fetchedAt, records: [], error: message, fromCache: false };
  }
}

async function identifyLayerIds(url: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    const raw = (await response.text()).trim();
    if (!raw || raw.startsWith('<') || !response.ok) {
      throw new Error('Plūdu karte neatbildēja');
    }
    const body = JSON.parse(raw) as {
      error?: { message?: string };
      results?: Array<{ layerId?: number; attributes?: Record<string, string> }>;
    };
    if (body.error) {
      throw new Error(body.error.message || 'Plūdu karte neatbildēja');
    }
    /*
     * The coastal depth raster answers inland too, with
     * Classify.Pixel Value "NoData". That is not water.
     * A flooded cell carries a class such as "1".
     */
    return [
      ...new Set(
        (body.results ?? [])
          .filter((row) => {
            const pixel = row.attributes?.['Classify.Pixel Value'];
            return pixel == null || pixel.toLowerCase() !== 'nodata';
          })
          .map((row) => Number(row.layerId))
          .filter((id) => Number.isFinite(id)),
      ),
    ];
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      throw new Error('Ģeopakalpojums neatbildēja 25 s laikā');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    const raw = (await response.text()).trim();

    /*
     * Ozols sits behind ArcGIS Web Adaptor. When the GIS
     * machines are down it waits, then serves HTML
     * “Could not access any server machines” with HTTP 200.
     * Node’s AbortController otherwise wins first with
     * the English “This operation was aborted”.
     */
    if (!raw || raw.startsWith('<')) {
      throw new Error('ArcGIS šobrīd nav pieejams');
    }
    if (!response.ok) {
      throw new Error(`ArcGIS atbilde ${response.status}`);
    }

    let body: ArcGisResponse;
    try {
      body = JSON.parse(raw) as ArcGisResponse;
    } catch {
      throw new Error('ArcGIS šobrīd nav pieejams');
    }
    if (body.error) {
      throw new Error(body.error.message ?? `ArcGIS ${body.error.code}`);
    }
    return (body.features ?? []).map((feature) => feature.attributes ?? {});
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      throw new Error(`Ģeopakalpojums neatbildēja ${Math.round(timeoutMs / 1000)} s laikā`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function asText(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function inLatvia(lat: number, lon: number): boolean {
  return lat >= 55.5 && lat <= 58.2 && lon >= 20.8 && lon <= 28.5;
}

/**
 * Land-unit ids to ask the parcel service.
 * A building designation is longer than 11 digits; the
 * parcel id is its first 11.
 */
function parcelIds(numbers: string[]): string[] {
  const ids: string[] = [];
  for (const raw of numbers) {
    const digits = raw.replace(/\D/g, '');
    const id = digits.length >= 11 ? digits.slice(0, 11) : '';
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function pointFromParcelXml(xml: string): GeoPoint | null {
  const returned = xml.match(/numberReturned="(\d+)"/);
  if (returned && returned[1] === '0') {
    return null;
  }

  /*
   * The polygon posList comes first and is a whole ring.
   * The single reference point is the only pos we want.
   */
  const block = xml.match(/<(?:\w+:)?referencePoint[\s\S]*?<\/(?:\w+:)?referencePoint>/);
  const pos = block?.[0].match(/<(?:\w+:)?pos>([^<]+)<\/(?:\w+:)?pos>/);
  if (!pos) {
    return null;
  }
  const [lat, lon] = pos[1].trim().split(/\s+/).map(Number);
  if (!inLatvia(lat, lon)) {
    return null;
  }
  return { lat, lon };
}

/**
 * Exterior rings of one cadastral parcel.
 * posList is EPSG:4258, latitude then longitude — the
 * same order as the reference point above.
 */
function ringsFromParcelXml(xml: string): number[][][] {
  const returned = xml.match(/numberReturned="(\d+)"/);
  if (returned && returned[1] === '0') {
    return [];
  }

  const rings: number[][][] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?posList>([^<]+)<\/(?:\w+:)?posList>/g)) {
    const nums = match[1].trim().split(/\s+/).map(Number);
    const ring: number[][] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const lat = nums[i];
      const lon = nums[i + 1];
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        ring.push([lat, lon]);
      }
    }
    if (ring.length >= 4) {
      rings.push(ring);
    }
  }
  return rings;
}

/**
 * Centroid stand-in for a cadastre number that has no
 * BIS building and no address code. One feature id per
 * land unit; the first hit wins.
 */
export async function lookupParcelPoint(numbers: string[], force?: boolean): Promise<GeoPoint | null> {
  for (const id of parcelIds(numbers).slice(0, 4)) {
    const cacheKey = `vzd:parcel:v1:${id}`;
    if (!force) {
      const cached = readCache(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached.payload) as { lat?: number; lon?: number };
        if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) {
          return { lat: parsed.lat as number, lon: parsed.lon as number };
        }
        continue;
      }
    }

    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: 'cp:CadastralParcel',
      featureID: `CP${id}`,
    });
    const requestUrl = `${PARCEL_WFS}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(requestUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/xml',
          'User-Agent': USER_AGENT,
        },
      });
      const xml = await response.text();
      if (!response.ok) {
        continue;
      }
      const point = pointFromParcelXml(xml);
      const fetchedAt = new Date().toISOString();
      writeCache(cacheKey, JSON.stringify(point ?? {}), fetchedAt);
      if (point) {
        return point;
      }
    } catch {
      /* A slow parcel service must not blank the rest of the card. */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Boundary of one land unit, for the map outline.
 * Cached separately from the point so an old point
 * entry does not hide the ring.
 */
export async function lookupParcelRing(rawId: string): Promise<number[][][]> {
  const digits = rawId.replace(/\D/g, '');
  const id = digits.length >= 11 ? digits.slice(0, 11) : '';
  if (!id) {
    return [];
  }

  const cacheKey = `vzd:parcel:ring:v1:${id}`;
  const cached = readCache(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached.payload) as { rings?: number[][][] };
    return Array.isArray(parsed.rings) ? parsed.rings : [];
  }

  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'cp:CadastralParcel',
    featureID: `CP${id}`,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${PARCEL_WFS}?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/xml',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      return [];
    }
    const rings = ringsFromParcelXml(await response.text());
    writeCache(cacheKey, JSON.stringify({ rings }), new Date().toISOString());
    return rings;
  } catch {
    /* A slow parcel service leaves the pin in place. */
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One land unit as the map needs it: the 11-digit number,
 * the area in m², a reference point and the outline.
 * Everything comes from a single WFS feature.
 */
export interface ParcelShape {
  cadastre: string;
  areaM2: number | null;
  point: GeoPoint | null;
  rings: number[][][];
  /** The exact WFS request, so the panel can show where this came from. */
  requestUrl: string;
  fetchedAt: string;
}

function parcelShapeFromXml(xml: string, requestUrl: string, fetchedAt: string): ParcelShape | null {
  const returned = xml.match(/numberReturned="(\d+)"/);
  if (returned && returned[1] === '0') {
    return null;
  }

  /*
   * <cp:label> carries the plain 11-digit designation; the
   * gml:id is the same number with a "CP" prefix. Prefer the
   * label and fall back to the id.
   */
  const label = xml.match(/<(?:\w+:)?label>(\d{11})<\/(?:\w+:)?label>/)?.[1];
  const gmlId = xml.match(/gml:id="CP(\d{11})"/)?.[1];
  const cadastre = label || gmlId || '';
  if (!cadastre) {
    return null;
  }

  const area = Number(xml.match(/<(?:\w+:)?areaValue[^>]*>([\d.]+)</)?.[1]);
  return {
    cadastre,
    areaM2: Number.isFinite(area) ? area : null,
    point: pointFromParcelXml(xml),
    rings: ringsFromParcelXml(xml),
    requestUrl,
    fetchedAt,
  };
}

/**
 * Shared GET against the parcel WFS. Returns null on a
 * slow or failing service so the caller can say so in one line.
 */
async function fetchParcelXml(params: URLSearchParams): Promise<{ xml: string; requestUrl: string } | null> {
  const requestUrl = `${PARCEL_WFS}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(requestUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/xml', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      return null;
    }
    return { xml: await response.text(), requestUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seeds the older per-id caches from a fresh feature, so the
 * report that follows a click does not ask the parcel service again.
 */
function rememberParcel(shape: ParcelShape): void {
  writeCache(`vzd:parcel:ring:v1:${shape.cadastre}`, JSON.stringify({ rings: shape.rings }), shape.fetchedAt);
  writeCache(`vzd:parcel:v1:${shape.cadastre}`, JSON.stringify(shape.point ?? {}), shape.fetchedAt);
}

/**
 * Click on the map → the land unit under that point.
 *
 * The VISS proxy is GeoServer. A plain `bbox` filter returned
 * nothing in testing, a CQL INTERSECTS does. Axis order for
 * EPSG:4258 is latitude first, so the WKT point is "lat lon".
 * Returns null when the click lands on water, forest road or
 * anything the cadastre does not carry as a land unit.
 */
export async function lookupParcelAt(lat: number, lon: number): Promise<ParcelShape | null> {
  if (!inLatvia(lat, lon)) {
    return null;
  }

  /* ~1 m grid keeps repeat clicks on one parcel off the network. */
  const cacheKey = `vzd:parcel:at:v1:${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = readCache(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached.payload) as { shape?: ParcelShape | null };
    return parsed.shape ?? null;
  }

  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'cp:CadastralParcel',
    count: '1',
    cql_filter: `INTERSECTS(geometry,POINT(${lat.toFixed(7)} ${lon.toFixed(7)}))`,
  });
  const fetched = await fetchParcelXml(params);
  if (!fetched) {
    throw new Error('Zemes vienību serviss šobrīd neatbild. Mēģini vēlreiz.');
  }

  const fetchedAt = new Date().toISOString();
  const shape = parcelShapeFromXml(fetched.xml, fetched.requestUrl, fetchedAt);
  writeCache(cacheKey, JSON.stringify({ shape }), fetchedAt);
  if (shape) {
    rememberParcel(shape);
  }
  return shape;
}

/**
 * Every land unit inside a map window — the "Kadastrs" layer.
 *
 * Here the filter wants BBOX(geometry, west, south, east, north),
 * i.e. longitude first, unlike the INTERSECTS point above which
 * wants latitude first. Same service, two axis orders; this is
 * the quirk that sank the first bbox attempt.
 * Capped so a zoomed-out window cannot pull a whole county.
 */
export interface ParcelOutline {
  cadastre: string;
  rings: number[][][];
}

export async function lookupParcelsInBox(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<{ parcels: ParcelOutline[]; truncated: boolean }> {
  if (![south, west, north, east].every(Number.isFinite) || !inLatvia(south, west) || !inLatvia(north, east)) {
    return { parcels: [], truncated: false };
  }

  /*
   * The map asks per fixed grid tile (0.005° × 0.01°), so these
   * four rounded numbers repeat exactly across pans and users:
   * the key is effectively the tile id. A dense old-town tile
   * can hold a few hundred units, hence the higher cap.
   */
  const LIMIT = 600;
  const cacheKey = `vzd:parcel:box:v2:${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return JSON.parse(cached.payload) as { parcels: ParcelOutline[]; truncated: boolean };
  }

  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'cp:CadastralParcel',
    count: String(LIMIT),
    cql_filter: `BBOX(geometry,${west.toFixed(6)},${south.toFixed(6)},${east.toFixed(6)},${north.toFixed(6)})`,
  });
  const fetched = await fetchParcelXml(params);
  if (!fetched) {
    throw new Error('Zemes vienību serviss šobrīd neatbild. Mēģini vēlreiz.');
  }

  /* One <cp:CadastralParcel> block per land unit. */
  const parcels: ParcelOutline[] = [];
  for (const block of fetched.xml.split(/<(?:\w+:)?CadastralParcel\s/).slice(1)) {
    const id = block.match(/gml:id="CP(\d{11})"/)?.[1];
    const rings = ringsFromParcelXml(`<x numberReturned="1">${block}`);
    if (id && rings.length) {
      parcels.push({ cadastre: id, rings });
    }
  }

  const result = { parcels, truncated: parcels.length >= LIMIT };
  writeCache(cacheKey, JSON.stringify(result), new Date().toISOString());
  return result;
}

/**
 * Same shape, but asked for by number. Search box and
 * deep links use this to fly the map to a parcel.
 */
export async function lookupParcelShape(rawId: string): Promise<ParcelShape | null> {
  const digits = rawId.replace(/\D/g, '');
  const id = digits.length >= 11 ? digits.slice(0, 11) : '';
  if (!id) {
    return null;
  }

  const cacheKey = `vzd:parcel:shape:v1:${id}`;
  const cached = readCache(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached.payload) as { shape?: ParcelShape | null };
    return parsed.shape ?? null;
  }

  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'cp:CadastralParcel',
    featureID: `CP${id}`,
  });
  const fetched = await fetchParcelXml(params);
  if (!fetched) {
    throw new Error('Zemes vienību serviss šobrīd neatbild. Mēģini vēlreiz.');
  }

  const fetchedAt = new Date().toISOString();
  const shape = parcelShapeFromXml(fetched.xml, fetched.requestUrl, fetchedAt);
  writeCache(cacheKey, JSON.stringify({ shape }), fetchedAt);
  if (shape) {
    rememberParcel(shape);
  }
  return shape;
}

/**
 * One building footprint on a land unit. `code` is the
 * 14-digit building designation; `built` is the year from
 * dateOfConstruction when VZD has one.
 */
export interface BuildingOutline {
  code: string;
  name: string;
  built: string;
  rings: number[][][];
  /*
   * ┌─────────────────────────────────────────────────────────┐
   * │ The rest rides along in the same GML block for free,    │
   * │ so the building card can paint these before any second  │
   * │ request. Empty string / null means VZD left it blank.   │
   * └─────────────────────────────────────────────────────────┘
   */
  /** INSPIRE CurrentUseValue, already in Latvian. */
  use: string;
  /** INSPIRE ConditionOfConstruction, already in Latvian. */
  condition: string;
  floors: number | null;
  dwellings: number | null;
  units: number | null;
  /** VARIS address code from bu-base:externalReference. */
  varisRef: string;
  /** YYYY-MM-DD of the record version in the cadastre. */
  recorded: string;
}

/* INSPIRE code list tails → plain Latvian. Unknown codes fall through as-is. */
const BUILDING_USE: Record<string, string> = {
  residential: 'dzīvojamā',
  individualResidence: 'viena dzīvokļa māja',
  collectiveResidence: 'daudzdzīvokļu māja',
  twoDwellings: 'divu dzīvokļu māja',
  moreThanTwoDwellings: 'daudzdzīvokļu māja',
  residenceForCommunities: 'kopdzīvojamā (dienesta, aprūpes)',
  agriculture: 'lauksaimniecības',
  industrial: 'rūpniecības',
  commerceAndServices: 'komercdarbība un pakalpojumi',
  office: 'biroju',
  trade: 'tirdzniecības',
  publicServices: 'publisko pakalpojumu',
  ancillary: 'palīgēka',
};

const BUILDING_CONDITION: Record<string, string> = {
  functional: 'ekspluatācijā',
  underConstruction: 'būvniecībā',
  projected: 'projektēta',
  declined: 'nolietota',
  ruin: 'drupas',
  demolished: 'nojaukta',
};

/** Tail of an xlink:href on the named element, e.g. ".../CurrentUseValue/office" → "office". */
function hrefTail(block: string, element: string): string {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${element}\\s[^>]*xlink:href="[^"]*/([^"/]+)"`);
  return block.match(pattern)?.[1] ?? '';
}

/** Integer content of the named element, or null when it is nil or missing. */
function intOf(block: string, element: string): number | null {
  const raw = block.match(new RegExp(`<(?:[\\w-]+:)?${element}>(\\d+)<`))?.[1];
  return raw == null ? null : Number(raw);
}

export interface ParcelBuildings {
  buildings: BuildingOutline[];
  requestUrl: string;
  fetchedAt: string;
  error?: string;
}

/** Plain vertex average: good enough to tell "on this parcel" from "next door". */
function ringCentre(ring: number[][]): [number, number] {
  const sum = ring.reduce((acc, [lat, lon]) => [acc[0] + lat, acc[1] + lon], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

/** Even-odd ray cast over every ring, so holes stay holes. */
function insideRings([lat, lon]: [number, number], rings: number[][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [latI, lonI] = ring[i];
      const [latJ, lonJ] = ring[j];
      if (latI > lat !== latJ > lat && lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Buildings registered on one land unit.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ Same VZD INSPIRE family as parcels, same VISS proxy, but │
 * │ only bbox works here: a CQL INTERSECTS dies on the proxy  │
 * │ with "targetCRS should not be null". So: take the parcel  │
 * │ outline's bbox, pull every building inside it, then keep  │
 * │ the ones whose id starts with this parcel's 11 digits.    │
 * │ The bbox also catches the neighbours' sheds; the prefix   │
 * │ throws them out.                                          │
 * └──────────────────────────────────────────────────────────┘
 */
export async function lookupParcelBuildings(rawId: string, force?: boolean): Promise<ParcelBuildings> {
  const digits = rawId.replace(/\D/g, '');
  const id = digits.length >= 11 ? digits.slice(0, 11) : '';
  const fetchedAt = new Date().toISOString();
  if (!id) {
    return { buildings: [], requestUrl: '', fetchedAt, error: 'Nav kadastra numura.' };
  }

  /* v3: outlines now carry use, condition, floors, dwellings, units. */
  const cacheKey = `vzd:bu:v3:${id}`;
  if (!force) {
    const cached = readCache(cacheKey);
    if (cached) {
      return JSON.parse(cached.payload) as ParcelBuildings;
    }
  }

  /* The parcel's own outline gives the search window. */
  const rings = await lookupParcelRing(id);
  const points = rings.flat();
  if (!points.length) {
    return { buildings: [], requestUrl: '', fetchedAt, error: 'Zemes vienības robeža nav pieejama.' };
  }
  const lats = points.map(([lat]) => lat);
  const lons = points.map(([, lon]) => lon);
  const box = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];

  /* EPSG:4258 in URN form means latitude first, as everywhere on this proxy. */
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'bu:Building',
    count: '200',
    bbox: `${box.map((value) => value.toFixed(7)).join(',')},urn:ogc:def:crs:EPSG::4258`,
  });
  const requestUrl = `${BUILDING_WFS}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(requestUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/xml', 'User-Agent': USER_AGENT },
    });
    const xml = await response.text();
    if (!response.ok || /ExceptionReport/.test(xml.slice(0, 600))) {
      return { buildings: [], requestUrl, fetchedAt, error: 'Ēku serviss atbildēja ar kļūdu.' };
    }

    /* One <bu:Building gml:id="CB…"> block per footprint. */
    const buildings: BuildingOutline[] = [];
    for (const block of xml.split(/<(?:\w+:)?Building\s/).slice(1)) {
      const code = block.match(/gml:id="CB(\d{14})"/)?.[1] ?? block.match(/<(?:\w+:)?localId>CB(\d{14})</)?.[1];
      const footprint = ringsFromParcelXml(`<x numberReturned="1">${block}`);
      if (!code || !footprint.length) {
        continue;
      }

      /*
       * Prefix is the registry's own link. After a parcel split the
       * old prefix can linger, so a footprint whose centre sits
       * inside this outline counts too.
       */
      if (!code.startsWith(id) && !insideRings(ringCentre(footprint[0]), rings)) {
        continue;
      }
      buildings.push({
        code,
        /* Prefixes here carry hyphens (bu-base:, GN:), hence [\w-]. */
        name: block.match(/<(?:[\w-]+:)?text>([^<]+)</)?.[1]?.trim() ?? '',
        built: block.match(/<(?:[\w-]+:)?end>(\d{4})-/)?.[1] ?? '',
        rings: footprint,
        /* currentUse appears twice (wrapper + coded child); the coded one has the href. */
        use: ((code) => BUILDING_USE[code] ?? code)(hrefTail(block, 'currentUse')),
        condition: ((code) => BUILDING_CONDITION[code] ?? code)(hrefTail(block, 'conditionOfConstruction')),
        floors: intOf(block, 'numberOfFloorsAboveGround'),
        dwellings: intOf(block, 'numberOfDwellings'),
        units: intOf(block, 'numberOfBuildingUnits'),
        varisRef: block.match(/<(?:[\w-]+:)?reference>([^<]+)</)?.[1]?.trim() ?? '',
        recorded: block.match(/<(?:[\w-]+:)?beginLifespanVersion>(\d{4}-\d{2}-\d{2})/)?.[1] ?? '',
      });
    }

    const result: ParcelBuildings = { buildings, requestUrl, fetchedAt };
    writeCache(cacheKey, JSON.stringify(result), fetchedAt);
    return result;
  } catch {
    /* A slow building service only costs the glow, never the parcel. */
    return { buildings: [], requestUrl, fetchedAt, error: 'Ēku serviss neatbildēja 20 s laikā.' };
  } finally {
    clearTimeout(timer);
  }
}

export function coordsFromVaris(record: Record<string, unknown> | null): GeoPoint | null {
  if (!record) {
    return null;
  }
  const lat = Number(record.DD_N);
  const lon = Number(record.DD_E);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  /*
   * VARIS names the columns backwards for LKS-92:
   * KOORD_X is northing, KOORD_Y is easting. Rīga sits
   * near 506000 E / 313000 N, which only fits that swap.
   */
  const northing = Number(record.KOORD_X);
  const easting = Number(record.KOORD_Y);
  return {
    lat,
    lon,
    easting: Number.isFinite(easting) ? easting : undefined,
    northing: Number.isFinite(northing) ? northing : undefined,
  };
}

function emptyGeo(sourceId: LookupResult['sourceId'], proofUrl: string, error?: string): LookupResult {
  return {
    sourceId,
    requestUrl: '',
    proofUrl,
    fetchedAt: new Date().toISOString(),
    record: null,
    records: [],
    error,
    fromCache: false,
  };
}

function hostedOzols(layerName: string): string {
  return `${OZOLS_HOSTED}/${encodeURIComponent(layerName)}/FeatureServer/0`;
}

function ozolsAttr(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = asText(row[key]) || asText(row[key.toLowerCase()]) || asText(row[key.toUpperCase()]);
    if (value) {
      return value;
    }
  }
  return '';
}

export async function lookupOzols(point: GeoPoint | null, force?: boolean): Promise<LookupResult> {
  if (!point) {
    return emptyGeo('ozols', OZOLS_PROOF);
  }

  const pin = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;

  /*
   * The public map at /kartes uses Portal Hosted layers.
   * OZOLS_DABASDATI_PUB_DATU_APMAINA is a separate GIS
   * server; when its machines are down the Web Adaptor
   * hangs, but Hosted ĪADT / biotopi still answer.
   */
  const [iadtPlain, iadtZoned, habitat] = await Promise.all([
    queryLayer({
      cacheKey: `ozols:hosted:iadt-plain:v2:${pin}`,
      url: hostedOzols('ĪADT_pamatteritorijas_bez_zonējuma'),
      point,
      prefer3059: false,
      force,
      outFields: 'name,category',
    }),
    queryLayer({
      cacheKey: `ozols:hosted:iadt-zone:v2:${pin}`,
      url: hostedOzols('ĪADT_ar_zonējumu'),
      point,
      prefer3059: false,
      force,
      outFields: 'name,site_name',
    }),
    queryLayer({
      cacheKey: `ozols:hosted:habitat:v2:${pin}`,
      url: hostedOzols('Īpaši_aizsargājamie_biotopi'),
      point,
      prefer3059: false,
      force,
      outFields: 'name_ec,code_ec',
    }),
  ]);

  /*
   * GNP mikroliegumi live on Hosted (same map as ĪADT).
   * National mikroliegumi still sit on the GIS FeatureServer —
   * try Hosted first so a down GIS box does not blank the field.
   */
  const microHosted = await queryLayer({
    cacheKey: `ozols:hosted:micro-gnp:v1:${pin}`,
    url: hostedOzols('Mikroliegumi_GNP'),
    point,
    prefer3059: false,
    force,
    outFields: 'mrname,globalid',
  });
  const microGis =
    microHosted.records.length > 0
      ? microHosted
      : await queryLayer({
          cacheKey: `ozols:micro:${pin}`,
          url: `${OZOLS_FS}/1`,
          point,
          prefer3059: true,
          force,
          outFields: 'MR_TYPE,MRCODE,ATIS_veids',
          timeoutMs: 12_000,
        });
  const micro = microHosted.records.length > 0 ? microHosted : microGis;

  const iadtRows = [...iadtPlain.records, ...iadtZoned.records];
  const iadtError = iadtPlain.error || iadtZoned.error;
  const record = {
    iadt: summarise(iadtRows, (row) => [
      ozolsAttr(row, 'site_name', 'NAME', 'name'),
      ozolsAttr(row, 'category', 'CATEGORY'),
    ]),
    mikroliegums: summarise(micro.records, (row) => [
      ozolsAttr(row, 'mrname', 'MR_TYPE'),
      ozolsAttr(row, 'MRCODE'),
      ozolsAttr(row, 'ATIS_veids'),
    ]),
    biotops: summarise(habitat.records, (row) => [
      ozolsAttr(row, 'NAME_EC', 'name_ec'),
      ozolsAttr(row, 'CODE_EC', 'code_ec'),
    ]),
    iadt_error: iadtError ?? '',
    micro_error: microHosted.error || microGis.error || '',
    habitat_error: habitat.error ?? '',
  };

  return {
    sourceId: 'ozols',
    requestUrl: iadtPlain.requestUrl || iadtZoned.requestUrl,
    proofUrl: OZOLS_PROOF,
    fetchedAt: iadtPlain.fetchedAt,
    record,
    records: [...iadtRows, ...micro.records, ...habitat.records],
    error: iadtError || habitat.error || micro.error,
    fromCache: iadtPlain.fromCache && iadtZoned.fromCache && habitat.fromCache && micro.fromCache,
  };
}

/**
 * NNPRT is a city-scale designation (Rīga is inside it).
 * Threatened buildings at the 1-in-100 scenario are the
 * local check — 250 m around the legal address.
 */
export async function lookupFlood(point: GeoPoint | null, force?: boolean): Promise<LookupResult> {
  if (!point) {
    return emptyGeo('lvgmc', FLOOD_PROOF);
  }

  const pin = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
  const nnprt = await queryLayer({
    cacheKey: `flood:nnprt:${pin}`,
    url: `${FLOOD_FS}/110`,
    point,
    prefer3059: false,
    force,
  });
  const buildings = await queryLayer({
    cacheKey: `flood:ekas100:${pin}`,
    url: `${FLOOD_FS}/18`,
    point,
    prefer3059: false,
    distanceMeters: 250,
    force,
  });

  const error = nnprt.error || buildings.error;
  const territory = nnprt.records.map((row) => asText(row.name) || asText(row.Nosaukums)).filter(Boolean);
  const houses = buildings.records.map((row) => asText(row.fname)).filter(Boolean);
  const record = {
    nnprt: territory.length ? [...new Set(territory)].join(' · ') : '',
    ekas: houses.length ? `${houses.length} ēkas 250 m (1/100 g.): ${[...new Set(houses)].join(' · ')}` : '',
  };

  return {
    sourceId: 'lvgmc',
    requestUrl: nnprt.requestUrl,
    proofUrl: FLOOD_PROOF,
    fetchedAt: nnprt.fetchedAt,
    record,
    records: [...nnprt.records, ...buildings.records],
    error,
    fromCache: nnprt.fromCache && buildings.fromCache,
  };
}

/*
 * Coloured water on the flood map. These are the depth
 * polygons for coastal wind surge, 10 / 100 / 200 years.
 * The building layers are not the flood itself: an empty
 * building query was coming back as "Nē" on a flooded quay.
 */
const COASTAL_DEPTH: Record<'10' | '100' | '200', number> = {
  '10': 67,
  '100': 81,
  '200': 95,
};

const FLOOD_MAP =
  'https://geodata.lvgmc.lv/server/rest/services/Latvijas_pludu_riska_un_pludu_draudu_kartes_garumzimes/MapServer';

export async function lookupFloodScenarios(point: GeoPoint | null, force?: boolean): Promise<LookupResult> {
  if (!point) {
    return emptyGeo('lvgmc', FLOOD_PROOF);
  }

  const pin = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
  const cacheKey = `flood:identify:v2:${pin}`;
  let layerIds: number[] | null = null;
  let requestUrl = '';
  let error: string | undefined;
  let fromCache = false;
  const fetchedAt = new Date().toISOString();

  if (!force) {
    const cached = readCache(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached.payload) as { requestUrl?: string; layerIds?: number[]; error?: string };
      if (!parsed.error && Array.isArray(parsed.layerIds)) {
        layerIds = parsed.layerIds;
        requestUrl = parsed.requestUrl || '';
        fromCache = true;
      }
    }
  }

  if (!layerIds) {
    const pad = 0.004;
    const params = new URLSearchParams({
      f: 'json',
      geometry: JSON.stringify({ x: point.lon, y: point.lat }),
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      layers: 'all',
      tolerance: '2',
      mapExtent: `${point.lon - pad},${point.lat - pad},${point.lon + pad},${point.lat + pad}`,
      imageDisplay: '800,800,96',
      returnGeometry: 'false',
    });
    requestUrl = `${FLOOD_MAP}/identify?${params.toString()}`;
    try {
      layerIds = await identifyLayerIds(requestUrl);
      writeCache(cacheKey, JSON.stringify({ requestUrl, layerIds }), fetchedAt);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Plūdu karte neatbildēja';
    }
  }

  const answers: Record<string, string> = {};
  for (const scenario of ['10', '100', '200'] as const) {
    if (!layerIds) {
      answers[`g${scenario}`] = '';
      answers[`g${scenario}_missing`] = '1';
      continue;
    }
    const flooded = layerIds.includes(COASTAL_DEPTH[scenario]);
    answers[`g${scenario}`] = flooded ? 'Jā — jūras vējuzplūdi' : 'Nē';
    answers[`g${scenario}_missing`] = '';
  }

  return {
    sourceId: 'lvgmc',
    requestUrl,
    proofUrl: FLOOD_PROOF,
    fetchedAt,
    record: answers,
    records: [],
    error: error && !layerIds ? error : undefined,
    fromCache,
  };
}

/**
 * TAPIS for one land unit.
 * Zoning is every functional zone the parcel outline enters.
 * The pin alone misses the second zone on a split parcel.
 * A plain bbox also keeps the field and the river next door.
 * Other layers stay a small box: constraints can stack on one point.
 */
export async function lookupTapis(point: GeoPoint | null, force?: boolean, parcelId?: string): Promise<LookupResult> {
  if (!point) {
    return emptyGeo('tapis', TAPIS_PROOF);
  }

  const pin = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
  const layers = [
    'funkcionalais_zonejums',
    'apgrutinatas_teritorijas',
    'teritorijas_ar_ipasiem_noteikumiem',
    'riska_teritorijas',
    'nacionalo_interesu_objekti',
  ] as const;

  /*
   * One layer at a time. Five parallel GetFeatures got a 400
   * from GeoServer even though the same URL is fine alone.
   */
  const results = [];
  for (const layer of layers) {
    results.push(
      await queryTapisLayer({
        cacheKey:
          layer === 'funkcionalais_zonejums'
            ? parcelId
              ? `tapis:zoneparcel:v2:${parcelId}`
              : `tapis:zonepoint:v1:${pin}`
            : `tapis:${layer}:${pin}`,
        layer,
        point,
        force,
        parcelId: layer === 'funkcionalais_zonejums' ? parcelId : undefined,
      }),
    );
  }

  const byLayer = Object.fromEntries(results.map((item) => [item.layer, item]));
  const zoning = byLayer.funkcionalais_zonejums;
  const constraints = byLayer.apgrutinatas_teritorijas;
  const special = byLayer.teritorijas_ar_ipasiem_noteikumiem;
  const risk = byLayer.riska_teritorijas;
  const national = byLayer.nacionalo_interesu_objekti;
  const error = results.every((item) => item.error) ? results[0]?.error : undefined;

  const record = {
    izmantosana: summariseTapis(zoning?.records ?? [], (row) => [
      asText(row.indekss),
      asText(row.veids) || asText(row.grupa_nos),
    ]),
    dokuments: summariseTapis(zoning?.records ?? [], (row) => [asText(row.dok_nos), asText(row.dok_datums_no)]),
    zonejums: summariseTapis(zoning?.records ?? [], (row) => [
      asText(row.indekss),
      asText(row.veids) || asText(row.grupa_nos),
      asText(row.dok_nos),
    ]),
    apgrutinajumi: summariseTapis(constraints?.records ?? [], (row) => [
      asText(row.grupa_nos) || asText(row.veids),
    ]),
    ipasie_noteikumi: joinTapisBlocks([
      summariseTapis(special?.records ?? [], (row) => [
        asText(row.indekss),
        asText(row.nosaukums) || asText(row.veids),
      ]),
      summariseTapis(risk?.records ?? [], (row) => ['riska teritorija', asText(row.veids) || asText(row.nosaukums)]),
      summariseTapis(national?.records ?? [], (row) => [
        asText(row.veids),
        asText(row.dok_nos) || asText(row.nosaukums),
      ]),
    ]),
  };

  return {
    sourceId: 'tapis',
    requestUrl: zoning?.requestUrl ?? results[0]?.requestUrl ?? '',
    proofUrl: TAPIS_PROOF,
    fetchedAt: zoning?.fetchedAt ?? new Date().toISOString(),
    record,
    records: results.flatMap((item) => item.records),
    error,
    fromCache: results.every((item) => item.fromCache),
  };
}

async function queryTapisLayer(input: {
  cacheKey: string;
  layer: string;
  point: GeoPoint;
  force?: boolean;
  parcelId?: string;
}): Promise<{
  layer: string;
  requestUrl: string;
  fetchedAt: string;
  records: Record<string, unknown>[];
  error?: string;
  fromCache: boolean;
}> {
  if (!input.force) {
    const cached = readCache(input.cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached.payload) as {
        requestUrl: string;
        records: Record<string, unknown>[];
        error?: string;
      };
      /*
       * A 400 in cache is not a real “this polygon does not
       * exist”. Retry instead of freezing the card for a day.
       */
      if (!parsed.error) {
        return {
          layer: input.layer,
          requestUrl: parsed.requestUrl,
          fetchedAt: cached.fetched_at,
          records: parsed.records ?? [],
          fromCache: true,
        };
      }
    }
  }

  const fetchedAt = new Date().toISOString();

  /*
   * Zoning follows the parcel outline when we have one.
   * Points inset from the boundary stay off the neighbour,
   * and a road drawn around the block does not count.
   */
  if (input.layer === 'funkcionalais_zonejums' && input.parcelId) {
    const rings = await lookupParcelRing(input.parcelId);
    if (rings.length) {
      const box = parcelBbox(rings);
      const params = new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'funkcionalais_zonejums',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        bbox: box,
        count: '40',
      });
      const requestUrl = `${TAPIS_WFS}?${params.toString()}`;
      try {
        const records = await fetchZonesOnParcel(requestUrl, rings);
        if (records.length) {
          writeCache(input.cacheKey, JSON.stringify({ requestUrl, records }), fetchedAt);
          return {
            layer: input.layer,
            requestUrl,
            fetchedAt,
            records,
            fromCache: false,
          };
        }
      } catch {
        /* The pin query below still colours a card with no outline hit. */
      }
    }
  }

  /*
   * No outline. GetFeatureInfo at the pin returns the
   * polygon under that pixel, not the field beside it.
   */
  if (input.layer === 'funkcionalais_zonejums') {
    const pad = 0.002;
    const box = [input.point.lon - pad, input.point.lat - pad, input.point.lon + pad, input.point.lat + pad].join(',');
    const info = new URLSearchParams({
      service: 'WMS',
      version: '1.1.1',
      request: 'GetFeatureInfo',
      layers: 'funkcionalais_zonejums',
      query_layers: 'funkcionalais_zonejums',
      styles: '',
      bbox: box,
      width: '101',
      height: '101',
      x: '50',
      y: '50',
      srs: 'EPSG:4326',
      info_format: 'application/json',
      feature_count: '4',
    });
    const requestUrl = `${TAPIS_WMS}?${info.toString()}`;
    try {
      const records = await fetchZoneAtPoint(requestUrl, input.point.lon, input.point.lat);
      writeCache(input.cacheKey, JSON.stringify({ requestUrl, records }), fetchedAt);
      return {
        layer: input.layer,
        requestUrl,
        fetchedAt,
        records,
        fromCache: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'TAPIS vaicājuma kļūda';
      return {
        layer: input.layer,
        requestUrl,
        fetchedAt,
        records: [],
        error: message,
        fromCache: false,
      };
    }
  }

  /*
   * ~20 m bbox around the pin. WFS 2 bbox is
   * minLon,minLat,maxLon,maxLat,CRS — lon first.
   */
  const delta = 0.0002;
  const bbox = [
    input.point.lon - delta,
    input.point.lat - delta,
    input.point.lon + delta,
    input.point.lat + delta,
    'EPSG:4326',
  ].join(',');

  const params = new URLSearchParams();
  params.set('service', 'WFS');
  params.set('version', '2.0.0');
  params.set('request', 'GetFeature');
  params.set('typeNames', input.layer);
  params.set('outputFormat', 'application/json');
  params.set('srsName', 'EPSG:4326');
  params.set('bbox', bbox);
  params.set('count', '8');
  params.set('propertyName', TAPIS_PROPERTIES);

  const requestUrl = `${TAPIS_WFS}?${params.toString()}`;

  try {
    let records: Record<string, unknown>[];
    try {
      records = await fetchTapisJson(requestUrl);
    } catch (first) {
      const message = first instanceof Error ? first.message : '';
      if (!/\b400\b/.test(message)) {
        throw first;
      }
      params.delete('propertyName');
      records = await fetchTapisJson(`${TAPIS_WFS}?${params.toString()}`);
    }
    writeCache(input.cacheKey, JSON.stringify({ requestUrl, records }), fetchedAt);
    return {
      layer: input.layer,
      requestUrl,
      fetchedAt,
      records,
      fromCache: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TAPIS vaicājuma kļūda';
    const transient = /abort|timeout|atcelts|neatbildēja|nav pieejams|\b400\b|\b502\b|\b503\b|\b504\b/i.test(message);
    if (!transient) {
      writeCache(input.cacheKey, JSON.stringify({ requestUrl, records: [], error: message }), fetchedAt);
    }
    return {
      layer: input.layer,
      requestUrl,
      fetchedAt,
      records: [],
      error: message,
      fromCache: false,
    };
  }
}

async function fetchTapisJson(url: string): Promise<Record<string, unknown>[]> {
  const features = await fetchTapisFeatures(url);
  return features.map((feature) => feature.properties ?? {});
}

/**
 * The map colour is the polygon that contains the pin.
 * A neighbour that only clips the search box stays off the card.
 */
async function fetchZoneAtPoint(url: string, lon: number, lat: number): Promise<Record<string, unknown>[]> {
  const features = await fetchTapisFeatures(url);
  const underPin = features.filter((feature) => geometryContains(feature.geometry, lon, lat));
  const chosen = underPin.length ? underPin : features.slice(0, 1);
  return chosen.map((feature) => feature.properties ?? {});
}

async function fetchTapisFeatures(url: string): Promise<Array<{ properties?: Record<string, unknown>; geometry?: GeoJsonGeometry }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`TAPIS atbilde ${response.status}`);
    }
    const body = (await response.json()) as { features?: Array<{ properties?: Record<string, unknown>; geometry?: GeoJsonGeometry }> };
    return body.features ?? [];
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      throw new Error(`Ģeopakalpojums neatbildēja ${FETCH_TIMEOUT_SEC} s laikā`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface GeoJsonGeometry {
  type?: string;
  coordinates?: number[] | number[][] | number[][][] | number[][][][];
}

function geometryContains(geometry: GeoJsonGeometry | undefined, lon: number, lat: number): boolean {
  if (!geometry?.coordinates) {
    return false;
  }
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as number[][][][])
        : [];
  return polygons.some((polygon) => polygonContains(polygon, lon, lat));
}

/**
 * Outer ring in, holes out. A transport zone often
 * stores the block in the middle as a hole.
 */
function polygonContains(polygon: number[][][], lon: number, lat: number): boolean {
  if (!ringContains(polygon[0] ?? [], lon, lat)) {
    return false;
  }
  return !polygon.slice(1).some((hole) => ringContains(hole, lon, lat));
}

function parcelBbox(rings: number[][][]): string {
  const flat = rings.flat();
  const lats = flat.map((point) => point[0]);
  const lons = flat.map((point) => point[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), 'EPSG:4326'].join(',');
}

/**
 * Centroid, plus a point toward each corner.
 * The corner itself sits on the neighbour and is skipped.
 */
function interiorSamples(rings: number[][][]): Array<[number, number]> {
  const flat = rings.flat();
  const lat = flat.reduce((sum, point) => sum + point[0], 0) / flat.length;
  const lon = flat.reduce((sum, point) => sum + point[1], 0) / flat.length;
  const samples: Array<[number, number]> = [[lat, lon]];
  for (const vertex of flat) {
    samples.push([lat + (vertex[0] - lat) * 0.7, lon + (vertex[1] - lon) * 0.7]);
  }
  return samples;
}

async function fetchZonesOnParcel(url: string, rings: number[][][]): Promise<Record<string, unknown>[]> {
  const features = await fetchTapisFeatures(url);
  const samples = interiorSamples(rings);
  const kept: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    const props = feature.properties ?? {};
    const inside = samples.some(([lat, lon]) => geometryContains(feature.geometry, lon, lat));
    if (!inside) {
      continue;
    }
    const key = [asText(props.indekss), asText(props.veids), asText(props.grupa_nos)].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(props);
  }
  return kept;
}

function ringContains(ring: number[][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0];
    const yi = ring[i]?.[1];
    const xj = ring[j]?.[0];
    const yj = ring[j]?.[1];
    if (xi == null || yi == null || xj == null || yj == null || yj === yi) {
      continue;
    }
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) {
      inside = !inside;
    }
  }
  return inside;
}

function summariseTapis(
  records: Record<string, unknown>[],
  pick: (row: Record<string, unknown>) => string[],
): string {
  return summarise(records, pick);
}

function joinTapisBlocks(parts: string[]): string {
  return parts.filter(Boolean).join(' · ');
}

export function zemesgramataLookup(cadastre: string[], fetchedAt: string): LookupResult {
  const unique = [...new Set(cadastre.filter(Boolean))];
  return {
    sourceId: 'zg',
    requestUrl: ZG_PROOF,
    proofUrl: ZG_PROOF,
    fetchedAt,
    record: {
      kadastrs: unique.join(' · '),
      skaits: unique.length,
    },
    records: unique.map((code) => ({ kadastrs: code })),
    fromCache: false,
  };
}

function summarise(
  records: Record<string, unknown>[],
  pick: (row: Record<string, unknown>) => string[],
): string {
  const parts = records
    .map((row) => pick(row).filter(Boolean).join(', '))
    .filter(Boolean);
  return [...new Set(parts)].join(' · ');
}
