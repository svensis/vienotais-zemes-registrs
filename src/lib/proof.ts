import type { Fact, FieldKey } from '../types';

/**
 * The few site fields the proof links need. The map has no
 * "client"; it builds this from the selected land unit.
 */
export interface ProofSite {
  regcode: string;
  project_cadastre: string;
  project_lat: string;
  project_lon: string;
  project_address: string;
}

/**
 * Human “Avots” should land on the record we used, not the
 * institution’s homepage. CKAN stays the machine query.
 * Portal GET params that we have not verified stay off this list.
 */

function digits(value: string, min: number, max = 17): string {
  const compact = value.replace(/\D/g, '');
  if (compact.length >= min && compact.length <= max) {
    return compact;
  }
  const match = compact.match(new RegExp(`\\d{${min},${max}}`));
  return match?.[0] ?? '';
}

function firstCadastre(...chunks: Array<string | undefined>): string {
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    const hit = digits(chunk, 11, 17);
    if (hit) {
      return hit;
    }
  }
  return '';
}

function parsePair(value: string): { lat: string; lon: string } | null {
  const pair = value.trim().match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!pair) {
    return null;
  }
  return { lat: pair[1], lon: pair[2] };
}

function pin(client: ProofSite, fact?: Fact, coordsHint?: string): { lat: string; lon: string } | null {
  const projectLat = client.project_lat.trim();
  const projectLon = client.project_lon.trim();
  if (projectLat && projectLon) {
    return { lat: projectLat, lon: projectLon };
  }

  /* Sibling “Koordinātas” row, then this field’s own value. */
  return parsePair(coordsHint || '') || parsePair(fact?.value || '');
}

function urCard(regcode: string): string {
  return `https://info.ur.gov.lv/#/legal-entity/${regcode}`;
}

function vidPortal(fieldKey?: FieldKey): string {
  if (fieldKey?.startsWith('pvn_')) {
    return 'https://www6.vid.gov.lv/PVN';
  }
  /* Combined PDB search — rating / tax dumps have no permalink. */
  return 'https://www6.vid.gov.lv/STRV';
}

function kadastrsMap(cadastre: string): string {
  return `https://www.kadastrs.lv/graphical_data/show?cadastre=${encodeURIComponent(cadastre)}`;
}

function bisSearch(query: string): string {
  const params = new URLSearchParams();
  params.set('search', query);
  params.set('commit', 'Meklet');
  return `https://bis.gov.lv/bisp/lv/planned_constructions?${params.toString()}`;
}

function ozolsMap(lat: string, lon: string): string {
  return `https://ozols.gov.lv/kartes/home/webmap/viewer.html?center=${encodeURIComponent(`${lon},${lat},4326`)}&level=14`;
}

/**
 * GeoLatvija map API talks LKS-92 (EPSG:3059): x easting, y northing.
 * Same TM as VZD — 24° meridian, k0 0.9996, false northing −6 000 000.
 */
function wgs84ToLks92(latDeg: number, lonDeg: number): { x: number; y: number } | null {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return null;
  }
  if (latDeg < 55.5 || latDeg > 58.2 || lonDeg < 20.5 || lonDeg > 28.5) {
    return null;
  }

  const a = 6_378_137;
  const f = 1 / 298.257222101;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const lon0 = (24 * Math.PI) / 180;
  const k0 = 0.9996;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sin = Math.sin(lat);
  const n = a / Math.sqrt(1 - e2 * sin * sin);
  const t = Math.tan(lat) ** 2;
  const c = ep2 * Math.cos(lat) ** 2;
  const A = (lon - lon0) * Math.cos(lat);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const m =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * lat -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * lat) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * lat) -
      ((35 * e6) / 3072) * Math.sin(6 * lat));
  const x =
    500_000 +
    k0 *
      n *
      (A +
        ((1 - t + c) * A ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * A ** 5) / 120);
  const y =
    -6_000_000 +
    k0 *
      (m +
        n *
          Math.tan(lat) *
          (A ** 2 / 2 +
            ((5 - t + 9 * c + 4 * c * c) * A ** 4) / 24 +
            ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * A ** 6) / 720));
  return { x, y };
}

function geoLatvija(productId: number, coords: { lat: string; lon: string } | null): string {
  const base = `https://geolatvija.lv/main?geoProductId=${productId}`;
  if (!coords) {
    return base;
  }
  const lks = wgs84ToLks92(Number(coords.lat), Number(coords.lon));
  if (!lks) {
    return base;
  }
  const params = new URLSearchParams();
  params.set('geoProductId', String(productId));
  params.set('x', String(Math.round(lks.x)));
  params.set('y', String(Math.round(lks.y)));
  params.set('scale', '5000');
  return `https://geolatvija.lv/main?${params.toString()}`;
}

function mantojumsHref(fact: Fact, cadastre: string): string {
  /* The map panel leads with "Jā — "; the monument number follows it. */
  const value = (fact.value || '').trim().replace(/^Jā\s*—\s*/i, '');
  if (/^nē$/i.test(value)) {
    return 'https://mantojums.lv/cultural-objects';
  }
  if (!value || value === 'nav' || value === '—') {
    return cadastre
      ? `https://mantojums.lv/cultural-objects?search=${encodeURIComponent(cadastre)}`
      : 'https://mantojums.lv/cultural-objects';
  }

  /* Collect now prefixes Objekta_Nr; old rows start with the name. */
  const numbered = value.match(/^(\d{1,6})\b/);
  if (numbered) {
    return `https://mantojums.lv/cultural-objects/${numbered[1]}`;
  }

  const name = value.split('·')[0]?.trim() || value;
  return `https://mantojums.lv/cultural-objects?search=${encodeURIComponent(name.slice(0, 80))}`;
}

function zgFolio(cadastre: string): string {
  const params = new URLSearchParams();
  params.set('CadastreNumber', cadastre);
  return `https://zemesgramata.lv/lv/Search/GetFolioDataByCadastre?${params.toString()}`;
}

/**
 * Best human URL for this fact. Empty string = hide Avots.
 */
export function avotsHref(client: ProofSite, fact?: Fact, coordsHint?: string): string {
  if (!fact) {
    return '';
  }

  const regcode = digits(client.regcode, 11, 11) || client.regcode;
  const cadastre = firstCadastre(client.project_cadastre, fact.value);
  const coords = pin(client, fact, coordsHint);
  const source = fact.source_id;

  if (fact.field_key === 'uznemumi_adrese') {
    return fact.proof_url || 'https://www.lursoft.lv/adresu-katalogs';
  }

  if (source === 'kadastrs') {
    if (fact.field_key === 'ipasuma_tiesibas' && cadastre) {
      return zgFolio(cadastre);
    }
    return cadastre ? kadastrsMap(cadastre) : fact.proof_url;
  }

  if (source === 'es') {
    return fact.proof_url || 'https://data.gov.lv/dati/lv/dataset/es-lidzfinansetie-projekti';
  }

  if (source === 'cfla') {
    return fact.proof_url || 'https://www.cfla.gov.lv/lv/2021-2027-programmas';
  }

  if (source === 'liaa') {
    return fact.proof_url || 'https://liaa.business.gov.lv/atbalsta-iespejas';
  }

  if (source === 'ekii') {
    return fact.proof_url || 'https://ekii.lv/index.php?page=konkursi_lv';
  }

  if (source === 'eis') {
    return fact.proof_url || 'https://www.eis.gov.lv/';
  }

  if (source === 'atis') {
    return fact.proof_url || 'https://data.gov.lv/dati/lv/dataset/atis-datu-un-kadastra-objektu-apgrutinajumu-klasifikators';
  }

  if (source === 'ur' && regcode.length === 11 && !client.project_cadastre) {
    return urCard(regcode);
  }

  if (source === 'vid') {
    return vidPortal(fact.field_key);
  }

  if (source === 'fm') {
    return 'https://deminimis.fm.gov.lv/';
  }

  if (source === 'varis') {
    if (cadastre) {
      return kadastrsMap(cadastre);
    }
    return 'https://www.kadastrs.lv/graphical_data/show';
  }

  if (source === 'bis') {
    const query = cadastre || client.project_address.trim();
    if (query) {
      return bisSearch(query);
    }
    return 'https://bis.gov.lv/bisp/lv/planned_constructions';
  }

  if (source === 'nkmp') {
    return mantojumsHref(fact, cadastre);
  }

  if (source === 'ozols') {
    return coords ? ozolsMap(coords.lat, coords.lon) : 'https://ozols.gov.lv/pub';
  }

  if (source === 'lvgmc') {
    return geoLatvija(309, coords);
  }

  if (source === 'tapis') {
    if (!coords) {
      return 'https://geolatvija.lv/geo';
    }
    const lks = wgs84ToLks92(Number(coords.lat), Number(coords.lon));
    if (!lks) {
      return 'https://geolatvija.lv/geo';
    }
    return `https://geolatvija.lv/geo?x=${Math.round(lks.x)}&y=${Math.round(lks.y)}`;
  }

  if (source === 'zg') {
    if (cadastre) {
      return zgFolio(cadastre);
    }
    return 'https://zemesgramata.lv/lv/Search/GetFolioDataByCadastre';
  }

  return fact.proof_url || '';
}

/** Hide the CKAN twin when Avots already is that query. */
export function ckanHref(fact: Fact | undefined, avots: string): string {
  const raw = fact?.source_url || '';
  if (!raw || raw === avots) {
    return '';
  }
  return raw;
}
