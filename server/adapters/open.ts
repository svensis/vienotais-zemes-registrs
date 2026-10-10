import { datastoreSearch } from './ckan.ts';
import type { LookupResult, PlaceContext } from './types.ts';
import type { SourceId } from '../types.ts';

const UR_PROOF = 'https://info.ur.gov.lv/';
const VID_PROOF = 'https://www.vid.gov.lv/lv/vid-publiskojamo-datu-baze';
const FM_PROOF = 'https://deminimis.fm.gov.lv/';
const BIS_PROOF = 'https://bis.gov.lv/bisp/lv/planned_constructions';
const VARIS_PROOF = 'https://www.kadastrs.lv/graphical_data/show';
const NKMP_PROOF = 'https://mantojums.lv/';
const FLOOD_PROOF = 'https://geolatvija.lv/main?geoProductId=309';

export const OPEN_RESOURCES = {
  equity: '7910fef5-93eb-4d03-acf0-f45465d67414',
  liquidations: '59e7ec49-f1c6-4410-8ee6-e7737ac5eaee',
  insolvency: '8065ad80-1a4d-4afb-b1d1-d93b9a62b1cc',
  sanctions: 'fa10a73f-0a10-4ce7-b0f8-f9652d572a10',
  suspensions: '1a077ff6-4c4e-4cfe-b603-b7e40851e8a9',
  securing: 'a572e7a4-b23d-44b7-93d8-d09fc47729dd',
  reorg: '83cebcee-ba0c-4162-b061-a8a1fae84f63',
  special: '0c7e176b-a7bb-449e-b984-f4507fb38253',
  stockholders: '6adabd83-93f9-4d7f-bebd-fa109bbf794a',
  financials: '27fcc5ec-c63b-4bfd-bb08-01f073a52d04',
  rating: 'acd4c6f9-5123-46a5-80f6-1f44b4517f58',
  tax: '9117ca92-7858-41cc-8c78-d5241ae5fcec',
  deminimis: '6253edd2-17d1-4a9a-bd48-3dd5b9ce5ff4',
  varisBuildings: 'a510737a-18ce-400f-ad4b-04fce5228272',
  bis: 'f41f3ee3-5040-4c65-8c80-f71495c817d9',
  heritage: '25583e4e-ca54-430e-b275-b38057a5ee70',
  /* VID: tax totals for the last three years, with main NACE code. Partial coverage. */
  vidNace: 'a42d6e8c-1768-4939-ba9b-7700d4f1dd3a',
  /* UR annual reports: the statement id joins the two below. */
  incomeStatements: 'd5fd17ef-d32e-40cb-8399-82b780095af0',
  balanceSheets: '50ef4f26-f410-4007-b296-22043ca3dc43',
} as const;

function asText(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function numericOrRaw(regcode: string): string | number {
  const numeric = Number(regcode);
  return Number.isNaN(numeric) ? regcode : numeric;
}

function blankLookup(sourceId: SourceId, proofUrl: string): LookupResult {
  return {
    sourceId,
    requestUrl: '',
    proofUrl,
    fetchedAt: new Date().toISOString(),
    record: null,
    records: [],
    fromCache: false,
  };
}

async function queryRegcode(input: {
  sourceId: SourceId;
  resourceId: string;
  field: string;
  regcode: string;
  proofUrl: string;
  limit?: number;
  force?: boolean;
  asString?: boolean;
}): Promise<LookupResult> {
  const filterValue = input.asString ? input.regcode : numericOrRaw(input.regcode);
  const result = await datastoreSearch({
    cacheKey: `${input.sourceId}:${input.resourceId}:${input.regcode}`,
    resourceId: input.resourceId,
    filters: { [input.field]: filterValue },
    query: input.regcode,
    limit: input.limit ?? 20,
    force: input.force,
  });

  return {
    sourceId: input.sourceId,
    requestUrl: result.requestUrl,
    proofUrl:
      input.sourceId === 'ur'
        ? `https://info.ur.gov.lv/#/legal-entity/${input.regcode}`
        : input.sourceId === 'vid'
          ? 'https://www6.vid.gov.lv/STRV'
          : input.proofUrl,
    fetchedAt: result.fetchedAt,
    record: result.records[0] ?? null,
    records: result.records,
    error: result.error,
    fromCache: result.fromCache,
  };
}

export function lookupEquity(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.equity,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupLiquidations(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.liquidations,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupInsolvency(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.insolvency,
    field: 'debtor_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupSanctions(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.sanctions,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupSuspensions(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.suspensions,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupSecuring(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.securing,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupReorg(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.reorg,
    field: 'final_entity_regcode',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupSpecialStatus(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.special,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    force,
  });
}

export function lookupStockholders(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.stockholders,
    field: 'at_legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    limit: 40,
    force,
  });
}

export function lookupFinancials(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'ur',
    resourceId: OPEN_RESOURCES.financials,
    field: 'legal_entity_registration_number',
    regcode,
    proofUrl: UR_PROOF,
    limit: 30,
    force,
  });
}

export function lookupRating(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'vid',
    resourceId: OPEN_RESOURCES.rating,
    field: 'Registracijas_kods',
    regcode,
    proofUrl: VID_PROOF,
    force,
  });
}

export function lookupTax(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'vid',
    resourceId: OPEN_RESOURCES.tax,
    field: 'Registracijas_kods',
    regcode,
    proofUrl: VID_PROOF,
    limit: 8,
    force,
  });
}

export function lookupDeminimis(regcode: string, force?: boolean): Promise<LookupResult> {
  return queryRegcode({
    sourceId: 'fm',
    resourceId: OPEN_RESOURCES.deminimis,
    field: 'person_reg_nr',
    regcode,
    proofUrl: FM_PROOF,
    limit: 50,
    force,
    asString: true,
  });
}

/**
 * What the matcher knows about one company.
 * `size` is our estimate, never the UR or VID verdict.
 */
export interface CompanyProfile {
  regcode: string;
  /** Main activity, "95.31" style, from VID. Empty when VID has no row. */
  nace: string;
  naceYear: string;
  employees: number | null;
  turnover: number | null;
  assets: number | null;
  /** Annual report year the numbers above come from. */
  year: string;
  size: 'mikro' | 'mazs' | 'vidējs' | 'liels' | '';
  /** Human line explaining which numbers drove `size`. */
  sizeBasis: string;
  requestUrl: string;
}

/** VID stores "9531  ": trim and dot it into the NACE 2 form "95.31". */
function dotNace(raw: unknown): string {
  const code = asText(raw).replace(/\D/g, '');
  if (code.length < 2) {
    return '';
  }
  return code.length > 2 ? `${code.slice(0, 2)}.${code.slice(2)}` : code;
}

/**
 * ┌──────────────────────────────────────────────────────────────┐
 * │ MVU per EU Recommendation 2003/361, on one company's own     │
 * │ numbers. Linked and partner companies are NOT added up —     │
 * │ open data does not say who owns whom by share — so this is   │
 * │ a first read, not the declaration CFLA asks for.             │
 * │   mikro:  < 10 staff  and (turnover or assets) ≤ 2 M EUR     │
 * │   mazs:   < 50 staff  and (turnover or assets) ≤ 10 M EUR    │
 * │   vidējs: < 250 staff and (turnover ≤ 50 M or assets ≤ 43 M) │
 * │ Missing money figures fall back to staff alone.              │
 * └──────────────────────────────────────────────────────────────┘
 */
export function estimateSize(
  employees: number | null,
  turnover: number | null,
  assets: number | null,
): CompanyProfile['size'] {
  if (employees == null && turnover == null && assets == null) {
    return '';
  }
  const staff = employees ?? 0;
  const money = (limitTurnover: number, limitAssets: number) =>
    (turnover == null && assets == null) ||
    (turnover != null && turnover <= limitTurnover) ||
    (assets != null && assets <= limitAssets);

  if (staff < 10 && money(2_000_000, 2_000_000)) {
    return 'mikro';
  }
  if (staff < 50 && money(10_000_000, 10_000_000)) {
    return 'mazs';
  }
  if (staff < 250 && money(50_000_000, 43_000_000)) {
    return 'vidējs';
  }
  return 'liels';
}

function amount(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function shortEuro(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('lv-LV', { maximumFractionDigits: 1 })} M EUR`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${Math.round(value / 1_000).toLocaleString('lv-LV')} k EUR`;
  }
  return `${Math.round(value)} EUR`;
}

/**
 * NACE from VID, staff / turnover / assets from the newest UR
 * annual report. Three small CKAN calls, each cached a day.
 * Any of them may come back empty; the profile just gets thinner.
 */
export async function lookupCompanyProfile(regcode: string, force?: boolean): Promise<CompanyProfile> {
  const blank: CompanyProfile = {
    regcode,
    nace: '',
    naceYear: '',
    employees: null,
    turnover: null,
    assets: null,
    year: '',
    size: '',
    sizeBasis: '',
    requestUrl: '',
  };
  if (!/^\d{11}$/.test(regcode)) {
    return blank;
  }

  /* VID first: one row per taxation year, newest wins. */
  const [vid, reports] = await Promise.all([
    datastoreSearch({
      cacheKey: `vid:${OPEN_RESOURCES.vidNace}:${regcode}`,
      resourceId: OPEN_RESOURCES.vidNace,
      filters: { Registracijas_kods: Number(regcode) },
      limit: 5,
      force,
    }),
    lookupFinancials(regcode, force),
  ]);
  const vidRow = [...vid.records].sort(
    (left, right) => Number(right.Taksacijas_gads) - Number(left.Taksacijas_gads),
  )[0];

  /* Newest annual report; its id is the statement_id in the money tables. */
  const report = [...reports.records].sort((left, right) => Number(right.year) - Number(left.year))[0];
  let turnover: number | null = null;
  let assets: number | null = null;
  if (report?.id != null) {
    const statement = Number(report.id);
    const [income, balance] = await Promise.all([
      datastoreSearch({
        cacheKey: `ur:${OPEN_RESOURCES.incomeStatements}:${statement}`,
        resourceId: OPEN_RESOURCES.incomeStatements,
        filters: { statement_id: statement },
        limit: 1,
        force,
      }),
      datastoreSearch({
        cacheKey: `ur:${OPEN_RESOURCES.balanceSheets}:${statement}`,
        resourceId: OPEN_RESOURCES.balanceSheets,
        filters: { statement_id: statement },
        limit: 1,
        force,
      }),
    ]);
    turnover = amount(income.records[0]?.net_turnover);
    assets = amount(balance.records[0]?.total_assets);
  }

  /* Staff: the annual report, else VID's average headcount. */
  const employees = amount(report?.employees) ?? amount(vidRow?.Videjais_nodarbinato_personu_skaits_cilv);
  const size = estimateSize(employees, turnover, assets);
  const basis = [
    employees != null ? `${employees} darb.` : '',
    turnover != null ? `apgrozījums ${shortEuro(turnover)}` : '',
    assets != null ? `bilance ${shortEuro(assets)}` : '',
    report?.year ? `${asText(report.year)}. g. pārskats` : '',
  ].filter(Boolean);

  return {
    regcode,
    nace: dotNace(vidRow?.Pamatdarbibas_NACE_kods),
    naceYear: asText(vidRow?.Taksacijas_gads),
    employees,
    turnover,
    assets,
    year: asText(report?.year),
    size,
    sizeBasis: basis.join(', '),
    requestUrl: reports.requestUrl || vid.requestUrl,
  };
}

export async function lookupVaris(ctx: PlaceContext, force?: boolean): Promise<LookupResult> {
  if (!ctx.addressId && !ctx.address) {
    return blankLookup('varis', VARIS_PROOF);
  }
  const query = ctx.addressId || ctx.address;
  const filters = ctx.addressId ? { KODS: numericOrRaw(ctx.addressId) } : undefined;
  const result = await datastoreSearch({
    cacheKey: `varis:${OPEN_RESOURCES.varisBuildings}:${query}`,
    resourceId: OPEN_RESOURCES.varisBuildings,
    filters,
    query,
    limit: 4,
    force,
  });

  const proof = (() => {
    const row = result.records[0];
    const lat = asText(row?.DD_N);
    const lon = asText(row?.DD_E);
    if (lat && lon) {
      return `${FLOOD_PROOF}`;
    }
    return VARIS_PROOF;
  })();

  return {
    sourceId: 'varis',
    requestUrl: result.requestUrl,
    proofUrl: proof,
    fetchedAt: result.fetchedAt,
    record: result.records[0] ?? null,
    records: result.records,
    error: result.error,
    fromCache: result.fromCache,
  };
}

/**
 * BIS is indexed by construction-site address, not company number.
 * We take the street + house from the UR card, then keep only rows
 * whose city matches, so Liepāja does not leak into a Rīga office.
 */
export async function lookupBis(ctx: PlaceContext, force?: boolean): Promise<LookupResult> {
  const cadastre = asText(ctx.cadastre);
  if (cadastre) {
    const byCadastre = await datastoreSearch({
      cacheKey: `bis:${OPEN_RESOURCES.bis}:cad:${cadastre}`,
      resourceId: OPEN_RESOURCES.bis,
      query: cadastre,
      limit: 40,
      force,
    });
    const matched = byCadastre.records.filter((row) =>
      asText(row.Buves_kadastra_apzimejums).includes(cadastre.replace(/\s+/g, '')),
    );
    if (matched.length || byCadastre.error) {
      return {
        sourceId: 'bis',
        requestUrl: byCadastre.requestUrl,
        proofUrl: BIS_PROOF,
        fetchedAt: byCadastre.fetchedAt,
        record: matched[0] ?? null,
        records: matched,
        error: byCadastre.error,
        fromCache: byCadastre.fromCache,
      };
    }
  }

  const address = ctx.projectAddress || ctx.address;
  if (!address) {
    return blankLookup('bis', BIS_PROOF);
  }
  const parsed = parseAddress(address);
  const query = [parsed.street, parsed.house, parsed.city].filter(Boolean).join(' ') || address;
  const result = await datastoreSearch({
    cacheKey: `bis:${OPEN_RESOURCES.bis}:${query}`,
    resourceId: OPEN_RESOURCES.bis,
    query,
    limit: 40,
    force,
  });

  const cityNeedle = parsed.city.toLowerCase();
  const houseNeedle = parsed.house;
  const matched = result.records.filter((row) => {
    const text = asText(row.Buves_objekta_adreses_teksts).toLowerCase();
    if (cityNeedle && !text.includes(cityNeedle.toLowerCase())) {
      return false;
    }
    if (houseNeedle && !text.includes(houseNeedle.toLowerCase())) {
      return false;
    }
    return true;
  });

  const records = matched.length ? matched : [];
  return {
    sourceId: 'bis',
    requestUrl: result.requestUrl,
    proofUrl: BIS_PROOF,
    fetchedAt: result.fetchedAt,
    record: records[0] ?? null,
    records,
    error: result.error,
    fromCache: result.fromCache,
  };
}

export async function lookupHeritage(ctx: PlaceContext, force?: boolean): Promise<LookupResult> {
  const address = ctx.projectAddress || ctx.address;
  if (!address) {
    return blankLookup('nkmp', NKMP_PROOF);
  }
  const parsed = parseAddress(address);
  const query = [parsed.street, parsed.house, parsed.city].filter(Boolean).join(' ') || address;
  const result = await datastoreSearch({
    cacheKey: `nkmp:${OPEN_RESOURCES.heritage}:${query}`,
    resourceId: OPEN_RESOURCES.heritage,
    query,
    limit: 20,
    force,
  });

  const cityNeedle = parsed.city.toLowerCase();
  const streetNeedle = parsed.street.toLowerCase();
  const matched = result.records.filter((row) => {
    const text = asText(row.Atrasanas_vieta).toLowerCase();
    if (cityNeedle && !text.includes(cityNeedle)) {
      return false;
    }
    if (streetNeedle && !text.includes(streetNeedle)) {
      return false;
    }
    return true;
  });

  const records = matched.length ? matched : [];
  const monumentId = asText(records[0]?.Objekta_Nr || records[0]?._id);
  return {
    sourceId: 'nkmp',
    requestUrl: result.requestUrl,
    proofUrl: monumentId
      ? `https://mantojums.lv/cultural-objects/${encodeURIComponent(monumentId)}`
      : 'https://mantojums.lv/cultural-objects',
    fetchedAt: result.fetchedAt,
    record: records[0] ?? null,
    records,
    error: result.error,
    fromCache: result.fromCache,
  };
}

export function parseAddress(address: string): { city: string; street: string; house: string } {
  const cleaned = asText(address);
  if (!cleaned) {
    return { city: '', street: '', house: '' };
  }

  const chunks = cleaned.split(',').map((part) => part.trim()).filter(Boolean);
  const first = chunks[0] ?? '';
  const second = chunks[1] ?? '';

  /*
   * UR dump is usually "Rīga, Pulkveža Brieža iela 12".
   * VARIS STD is "Pulkveža Brieža iela 12, Rīga, LV-1010".
   */
  const looksLikeCity = /^(rīga|riga|daugavpils|jelgava|jūrmala|jurmala|liepāja|liepaja|vēntspils|ventspils|rēzekne|rezekne|jēkabpils|jekabpils|valmiera|ogre)/i.test(first);

  const streetLine = looksLikeCity ? second : first;
  const city = looksLikeCity ? first : chunks.find((part) => !/^lv-?\d+/i.test(part) && part !== streetLine) ?? '';
  const houseMatch = streetLine.match(/(\d+\s*[a-zāčēģīķļņšūž]?)\s*$/i);

  return {
    city,
    street: streetLine.replace(/\s+\d+\s*[a-zāčēģīķļņšūž]?\s*$/i, '').trim(),
    house: houseMatch ? houseMatch[1].replace(/\s+/g, '') : '',
  };
}

export function emptyPlaceContext(regcode: string): PlaceContext {
  return { regcode, address: '', addressId: '', city: '', cadastre: '', projectAddress: '' };
}
