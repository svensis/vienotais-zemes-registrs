/*
 * Shapes the browser shares with the API. Field keys stay plain
 * strings: the server owns the list and sends it with /api/fields.
 */
export type FactStatus = 'gaida' | 'apstiprinats' | 'labots' | 'konflikts' | 'nav_datu' | 'kluda';

export type SourceId =
  | 'ur'
  | 'vid'
  | 'fm'
  | 'bis'
  | 'varis'
  | 'nkmp'
  | 'ozols'
  | 'lvgmc'
  | 'zg'
  | 'tapis'
  | 'kadastrs'
  | 'es'
  | 'eis'
  | 'atis'
  | 'cfla'
  | 'liaa'
  | 'ekii';

export type FieldKey = string;

export interface FieldSpec {
  key: FieldKey;
  label: string;
  sourceId: SourceId;
  group: string;
}

export interface Fact {
  id: string;
  client_id: string;
  field_key: FieldKey;
  value: string;
  source_id: SourceId | '';
  /** The exact machine query (CKAN / WFS / ArcGIS) that produced the value. */
  source_url: string;
  /** A human page where the same record can be checked. */
  proof_url: string;
  fetched_at: string;
  status: FactStatus;
  corrected_value: string;
  conflict_note: string;
  previous_value: string;
}

/** One land unit, as the parcel service returns it. Rings are [lat, lon]. */
export interface Parcel {
  cadastre: string;
  areaM2: number | null;
  point: { lat: number; lon: number } | null;
  rings: number[][][];
  requestUrl: string;
  fetchedAt: string;
}

export interface ParcelOutline {
  cadastre: string;
  rings: number[][][];
}

/**
 * One building footprint from the VZD INSPIRE layer.
 * `code` is the 14-digit building designation: the parcel's
 * 11 digits plus a 3-digit building number.
 */
export interface BuildingOutline {
  code: string;
  name: string;
  /** Year of construction, empty when VZD has none. */
  built: string;
  rings: number[][][];
  /*
   * Footprint facts from the same WFS answer — instant on click.
   * Optional so a cached v2 payload never breaks the card.
   */
  use?: string;
  condition?: string;
  floors?: number | null;
  dwellings?: number | null;
  units?: number | null;
  /** VARIS address code. */
  varisRef?: string;
  /** YYYY-MM-DD of the cadastre record version. */
  recorded?: string;
}

/** GET /api/building/:code — what only BIS and the cadastre dump know. */
export interface BuildingDetail {
  code: string;
  bis: { name: string; address: string; caseNr: string; kind: string } | null;
  case: { stage: string; authority: string; created: string } | null;
  /** Status + person type, never a name. */
  statuses: string[];
  properties: string[];
  /** Building is a property apart from the land under it. */
  separate: boolean;
  address: string;
  encumbrances: string[];
  /** False while the cadastre dump is not indexed. */
  index: boolean;
  sources: { label: string; requestUrl: string; proof: string }[];
  fetchedAt: string;
  error?: string;
}

export interface ReportJob {
  id: string;
  status: 'running' | 'done' | 'error';
  done: number;
  total: number;
  label: string;
  error?: string;
}

export interface ReportTick {
  facts: Fact[];
  job?: ReportJob;
}

export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
}

export interface SourceRow {
  id: string;
  name: string;
  owner: string;
  api: string;
  resourceId: string;
  license: string;
  refresh: string;
  proof: string;
  reuse: string;
  limits: string;
  fields: string;
  lastModified?: string;
  healthNote?: string;
  healthOk?: number;
  checkedAt?: string;
}

export type LayerMode = 'vieta' | 'pludi' | 'zonejums' | 'daba' | 'kadastrs';
export type FloodYears = '10' | '100' | '200';

/** Base tiles under every overlay — street map or satellite imagery. */
export type Basemap = 'karte' | 'satelits';
