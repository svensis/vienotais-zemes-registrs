import {
  lookupCflaCalls,
  CFLA_HELP,
  CFLA_PROGRAMS,
  type HintCompany,
  type ParcelHints,
} from '../adapters/cflaCalls.ts';
import { lookupEkiiSupport, EKII_KONKURSI, LVIF_AER, type EkiiHints } from '../adapters/ekii.ts';
import { lookupAtisCode, lookupBuildingsByCadastre, lookupCasesByNumber, lookupEsByCadastre, lookupProcurement } from '../adapters/eval.ts';
import { lookupLiaaSupport, LIAA_PROOF } from '../adapters/liaa.ts';
import {
  BUILDING_PROOF,
  coordsFromVaris,
  lookupFloodScenarios,
  lookupOzols,
  lookupParcelBuildings,
  lookupParcelPoint,
  lookupTapis,
  zemesgramataLookup,
  type GeoPoint,
  type ParcelBuildings,
} from '../adapters/geo.ts';
import {
  lookupCompanyProfile,
  lookupDeminimis,
  lookupHeritage,
  lookupRating,
  lookupVaris,
  parseAddress,
} from '../adapters/open.ts';
import type { LookupResult, PlaceContext } from '../adapters/types.ts';
import { lookupAddressOccupants, resolveRegisteredName } from '../adapters/ur.ts';
import { addressesFor, cadastreReady, encumbrancesFor, linksFor, ownersFor } from '../cadastreDb.ts';
import { getClient, listFacts, logEvent, updateClientApplicant, updateClientName, updateClientSite, upsertFact } from '../db.ts';
import { cadastreDigits, FIELD_SPECS, formatCadastre } from '../fields.ts';
import type { Client, Fact, FactStatus, FieldKey, SourceId } from '../types.ts';

const KAD_PROOF = 'https://data.gov.lv/dati/lv/dataset/kadastra-informacijas-sistemas-atvertie-dati';

/*
 * De minimis ceiling for general aid, Regulation (EU) 2023/2831:
 * 300 000 EUR per single undertaking over any three years.
 * The old 1407/2013 grants (200 000 EUR) count into the same window.
 * Farming / fisheries / SGEI regulations have their own ceilings
 * and are shown apart, not subtracted from this one.
 */
const DE_MINIMIS_CEILING = 300_000;
const DE_MINIMIS_YEARS = 3;
const ATIS_PROOF = 'https://data.gov.lv/dati/lv/dataset/atis-datu-un-kadastra-objektu-apgrutinajumu-klasifikators';
const LURSOFT = 'https://www.lursoft.lv/adresu-katalogs';

const PERSON: Record<string, string> = {
  'fiziska persona': 'fiziska persona',
  'juridiska persona': 'juridiska persona',
  pasvaldiba: 'pašvaldība',
  valsts: 'valsts',
};

const STATUS: Record<string, string> = {
  Ipasnieks: 'īpašnieks',
  'Tiesiskais valditajs': 'tiesiskais valdītājs',
  Lietotajs: 'lietotājs',
  'Apbuves tiesigais (tiesiskais valditajs)': 'apbūves tiesīgais (tiesiskais valdītājs)',
  'Apbuves tiesigais (ipasnieks)': 'apbūves tiesīgais (īpašnieks)',
};

function text(value: unknown): string {
  if (value == null) {
    return '';
  }
  const flat = String(value).replace(/\s+/g, ' ').trim();
  /*
   * Some open-data exports were saved from Excel and keep its
   * text wrapper: ="AS 'Latvenergo' 2021/4". Strip it, keep the value.
   */
  const wrapped = flat.match(/^="(.*)"$/);
  return wrapped ? wrapped[1].trim() : flat;
}

function clip(value: string, max = 700): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function join(parts: string[]): string {
  return clip(parts.map((part) => part.trim()).filter(Boolean).join(' · '));
}

function euro(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return '';
  }
  return `${Math.round(amount).toLocaleString('lv-LV')} EUR ES`;
}

function yn(yes: boolean, detail = ''): string {
  if (!yes) {
    return 'Nē';
  }
  return detail ? `Jā — ${detail}` : 'Jā';
}

function write(
  client: Client,
  fieldKey: FieldKey,
  value: string,
  sourceId: SourceId,
  sourceUrl: string,
  proofUrl: string,
  status: FactStatus,
  note = '',
): void {
  upsertFact({
    clientId: client.id,
    fieldKey,
    value,
    sourceId,
    sourceUrl,
    proofUrl,
    fetchedAt: new Date().toISOString(),
    status,
    conflictNote: note,
  });
}

function fromLookup(
  client: Client,
  fieldKey: FieldKey,
  value: string,
  lookup: LookupResult,
  status: FactStatus,
  note = '',
): void {
  const spec = FIELD_SPECS.find((item) => item.key === fieldKey);
  write(
    client,
    fieldKey,
    value,
    (spec?.sourceId ?? lookup.sourceId) as SourceId,
    lookup.requestUrl,
    lookup.proofUrl,
    lookup.error ? 'kluda' : status,
    lookup.error || note,
  );
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STREET_NOISE = new Set([
  'iela',
  'ielas',
  'bulvaris',
  'prospekts',
  'aleja',
  'laukums',
  'gatve',
  'nov',
  'novads',
  'pag',
  'pagasts',
  'lv',
  'pilseta',
  'ciems',
  'latvija',
]);

function houseOf(value: string): string {
  /*
   * A Latvian postcode is 4 digits, often glued on as LV5070.
   * Taking the last 1–3 digit run then reads that as house "0"
   * and a real house 17 comes back Neatbilst.
   */
  const withoutPostcode = fold(value)
    .replace(/\blv\s*\d{4}\b/g, ' ')
    .replace(/\b\d{4}\b/g, ' ');
  const matches = [...withoutPostcode.matchAll(/\b(\d{1,3}[a-z]?)\b/g)].map((match) => match[1]);
  return matches.length ? matches[matches.length - 1] : '';
}

function streetsOf(value: string): string[] {
  return fold(value)
    .split(' ')
    .filter((token) => token.length > 2 && !STREET_NOISE.has(token) && !/^\d/.test(token));
}

/**
 * Entered address vs the cadastre address.
 * Different house number, or no shared street token, is Neatbilst.
 */
function compareAddresses(entered: string, officials: string[]): 'Atbilst' | 'Neatbilst' | '' {
  const left = entered.trim();
  if (!left || !officials.length) {
    return '';
  }
  const leftHouse = houseOf(left);
  const leftStreets = streetsOf(left);
  for (const official of officials) {
    const rightHouse = houseOf(official);
    const rightStreets = streetsOf(official);
    if (leftHouse && rightHouse && leftHouse !== rightHouse) {
      continue;
    }
    const share = leftStreets.some((token) => rightStreets.includes(token));
    if (share || fold(official).includes(fold(left)) || fold(left).includes(fold(official))) {
      return 'Atbilst';
    }
  }
  return 'Neatbilst';
}

function pointFromBuilding(row: Record<string, unknown> | null): GeoPoint | null {
  if (!row) {
    return null;
  }
  let lat = Number(text(row.Buves_atrasanas_vieta_geografiskais_platums).replace(',', '.'));
  let lon = Number(text(row.Buves_atrasanas_vieta_geografiskais_garums).replace(',', '.'));
  if (lat > 20 && lat < 30 && lon > 55 && lon < 59) {
    const swap = lat;
    lat = lon;
    lon = swap;
  }
  if (lat < 55.5 || lat > 58.2 || lon < 20.8 || lon > 28.5) {
    return null;
  }
  return { lat, lon };
}

function isClosed(row: Record<string, unknown>): boolean {
  const terminated = text(row.terminated);
  const closed = text(row.closed).toUpperCase();
  if (terminated) {
    return true;
  }
  if (!closed || closed === '0' || closed === '-' || closed === 'N') {
    return false;
  }
  return true;
}

function isMerchant(row: Record<string, unknown>): boolean {
  const type = text(row.type).toUpperCase();
  return ['SIA', 'AS', 'IK', 'KS', 'PS', 'IU', 'ZU', 'AK', 'FIL'].includes(type);
}

function formatCompany(row: Record<string, unknown>): string {
  const type = text(row.type).toUpperCase();
  const kind = type === 'FIL' ? 'struktūrvienība' : 'uzņēmums';
  const form = text(row.type_text) || type;
  return `${kind} ${text(row.name)}, reģ.nr.: ${text(row.regcode)}, forma: ${form}. Darbības veids nav UR atvērtajā kopā`;
}

function relatedNumbers(cadastre: string): string[] {
  const set = new Set<string>([cadastre]);
  if (cadastre.length > 11) {
    set.add(cadastre.slice(0, 11));
  }
  if (!cadastreReady()) {
    return [...set];
  }
  for (const link of linksFor(cadastre)) {
    if (link.property_nr) {
      set.add(cadastreDigits(link.property_nr));
    }
    if (link.object_nr) {
      set.add(cadastreDigits(link.object_nr));
    }
  }
  return [...set].filter((value) => value.length >= 11);
}

/** Shared with the building card, so both read the same Latvian labels. */
export function labelStatus(status: string, person: string): string {
  const left = STATUS[status] || status;
  const right = PERSON[person] || person;
  return [left, right].filter(Boolean).join(' — ');
}

/**
 * One cadastre number in, the evaluation card out.
 * VID, de minimis and procurement follow the applicant's
 * registration number when one was entered. Otherwise they
 * follow the companies UR has on this cadastre's address.
 */
export async function evaluateClient(clientId: string, force = false): Promise<Fact[]> {
  const client = getClient(clientId);
  if (!client) {
    throw new Error('Ieraksts nav atrasts.');
  }

  const cadastre = cadastreDigits(client.project_cadastre || client.regcode);
  const enteredAddress = text(client.project_address);
  logEvent('collect_start', { clientId: client.id, cadastre, force });

  const numbers = relatedNumbers(cadastre);
  const buildings = await lookupBuildingsByCadastre(cadastre, force);
  const building = buildings.record;
  const caseNumbers = buildings.records.map((row) => text(row.Buvniecibas_lietas_numurs)).filter(Boolean);

  const indexedAddresses = addressesFor(numbers);
  const bisAddress = text(building?.Buves_objekta_adreses_teksts);
  const officialAddresses = [
    ...new Set([...indexedAddresses.map((row) => text(row.text)), bisAddress].filter(Boolean)),
  ];
  const arCode =
    text(indexedAddresses.find((row) => text(row.ar_code))?.ar_code) ||
    text(building?.Buves_objekta_adreses_kods);

  /*
   * Ownership, address and designation need nothing beyond
   * the local cadastre index and the BIS lookup above, so they
   * are written now. The panel polls the partial card and these
   * rows appear while the slower services are still answering.
   */
  writeOwnership(client, cadastre, numbers, officialAddresses, buildings);
  writeLandBook(client, cadastre, numbers);

  const place: PlaceContext = {
    regcode: '',
    address: officialAddresses[0] || '',
    addressId: cadastreDigits(arCode),
    city: '',
    cadastre,
    projectAddress: enteredAddress,
  };

  /*
   * VARIS full-text on a street name picks a random house.
   * Only the address code from the cadastre dump or BIS is safe.
   *
   * Each lookup is started at once but its rows are written the
   * moment *that* lookup lands, not when the slowest one does.
   * A slow Ozols answer then never hides the flood or zoning rows.
   */
  const casesPromise = lookupCasesByNumber(caseNumbers, force);
  const projectsPromise = lookupEsByCadastre(
    numbers,
    officialAddresses.length ? officialAddresses : [enteredAddress].filter(Boolean),
    force,
  );
  const varisPromise: Promise<LookupResult> = place.addressId
    ? lookupVaris(place, force)
    : Promise.resolve({
        sourceId: 'varis' as const,
        requestUrl: '',
        proofUrl: '',
        fetchedAt: '',
        record: null,
        records: [],
        fromCache: false,
      });
  const occupantsPromise = lookupAddressOccupants(place.addressId, force);

  /*
   * ┌──────────────────────────────────────────────────────────────┐
   * │ Who the matcher reasons about: the typed-in applicant, else  │
   * │ the first live company on the address. Its NACE / MVU /      │
   * │ de minimis room feed CFLA + LIAA matching. Started now so    │
   * │ it runs alongside the slow geo lookups, not after them.      │
   * └──────────────────────────────────────────────────────────────┘
   */
  const applicantPromise = applicantPerson(client);
  const profilePromise: Promise<CompanyFacts> = Promise.all([occupantsPromise, applicantPromise])
    .then(([occupants, applicant]) => {
      const first = occupants.records.find((row) => !isClosed(row) && isMerchant(row));
      const person = applicant ?? (first ? { regcode: text(first.regcode), name: text(first.name) || text(first.regcode) } : null);
      return companyFacts(person, force);
    })
    .catch(() => NO_COMPANY);

  /* Rows that depend on nothing but their own lookup. */
  const writers: Promise<unknown>[] = [
    casesPromise.then((cases) => writeConstruction(client, buildings, cases)),
    projectsPromise.then((projects) => writeProjects(client, projects)),
    /* Companies on the address, then the VID / de minimis / procurement rows that follow them. */
    occupantsPromise.then((occupants) =>
      writeParties(client, occupants, force, place.address || enteredAddress, applicantPromise, profilePromise),
    ),
    /* Footprints from the VZD buildings WFS — the same ones the map lights up. */
    lookupParcelBuildings(cadastre, force).then((found) => writeBuildingOutlines(client, found)),
    /* NKMP monuments are listed by address, so only the address we trust is used. */
    lookupHeritage(place, force).then((heritage) => writeHeritage(client, place.address, heritage)),
  ];
  /* A writer that fails before we await it must not crash the process. */
  writers.forEach((writer) => writer.catch(() => undefined));

  /*
   * BIS and VARIS both need a building or an address code.
   * A bare land unit still has a reference point on the
   * VZD parcel WFS, keyed by the 11-digit designation.
   */
  const varis = await varisPromise;
  let point = pointFromBuilding(building) || coordsFromVaris(varis.record);
  if (!point) {
    point = await lookupParcelPoint(numbers, force);
  }

  if (point) {
    updateClientSite(client.id, {
      project_cadastre: cadastre,
      project_lat: String(point.lat),
      project_lon: String(point.lon),
      project_address: enteredAddress,
    });
  }
  updateClientName(client.id, formatCadastre(cadastre));

  /* Geo lookups all need the point; each one writes its own rows. */
  const tapisPromise = lookupTapis(point, force, cadastre);
  const ozolsPromise = lookupOzols(point, force);
  const floodPromise = lookupFloodScenarios(point, force);

  writers.push(
    tapisPromise.then((tapis) => writeZoning(client, point, tapis)),
    ozolsPromise.then((ozols) => writeNature(client, point, ozols)),
    floodPromise.then((flood) => writeFlood(client, point, flood)),
    /*
     * Encumbrances come from the local index. Only without that
     * index do they fall back to the TAPIS text, so only then wait for TAPIS.
     */
    (async () => {
      const noTapis: LookupResult = {
        sourceId: 'tapis',
        requestUrl: '',
        proofUrl: '',
        fetchedAt: '',
        record: null,
        records: [],
        fromCache: false,
      };
      await writeEncumbrance(client, numbers, cadastreReady() ? noTapis : await tapisPromise, force);
    })(),
  );
  /*
   * Open CFLA calls are a national table. Ranking uses the
   * parcel's owner / flood / nature / company rows, so it
   * waits for those lookups — it does not hide the rest.
   */
  writers.push(
    Promise.all([occupantsPromise, ozolsPromise, floodPromise, profilePromise]).then(([occupants, ozols, flood, company]) =>
      writeCflaCalls(client, parcelHints(numbers, occupants, ozols, flood, client, company), company, force),
    ),
  );
  /* LVIF/EKII household AER — same owner/company wait as CFLA. */
  writers.push(
    Promise.all([occupantsPromise, profilePromise]).then(([occupants, company]) =>
      writeEkiiSupport(client, numbers, occupants, company, force),
    ),
  );
  writers.forEach((writer) => writer.catch(() => undefined));

  await Promise.all(writers);
  const occupants = await occupantsPromise;
  const companies = occupants.records.filter((row) => !isClosed(row) && isMerchant(row)).slice(0, 6).length;
  writeMatch(client, enteredAddress, officialAddresses, buildings.requestUrl);

  logEvent('collect_done', {
    clientId: client.id,
    cadastre,
    companies,
    point: Boolean(point),
    index: cadastreReady(),
  });

  return listFacts().filter((fact) => fact.client_id === client.id);
}

function writeOwnership(
  client: Client,
  cadastre: string,
  numbers: string[],
  officialAddresses: string[],
  buildings: LookupResult,
): void {
  const owners = ownersFor(numbers);
  const links = cadastreReady() ? linksFor(cadastre) : [];
  const propertyNrs = [...new Set(links.map((row) => cadastreDigits(row.property_nr)).filter(Boolean))];
  const objectNrs = [
    ...new Set([
      ...links.map((row) => cadastreDigits(row.object_nr)),
      ...buildings.records.map((row) => cadastreDigits(text(row.Buves_kadastra_apzimejums))),
    ].filter(Boolean)),
  ];
  const propertyFromOwners = owners.filter((row) => row.object_type === 'PROPERTY').map((row) => row.nr);
  const buildingFromOwners = owners.filter((row) => row.object_type === 'BUILDING').map((row) => row.nr);

  const propertyShown = [...new Set([...propertyNrs, ...propertyFromOwners])];
  const designationShown = [...new Set([...objectNrs, ...buildingFromOwners])];

  write(
    client,
    'ipasuma_kadastra_nr',
    propertyShown.length ? propertyShown.map(formatCadastre).join(' · ') : formatCadastre(cadastre),
    'kadastrs',
    '',
    KAD_PROOF,
    'gaida',
    propertyShown.length ? '' : 'meklētais numurs — īpašuma numurs no datnes nav atdalīts',
  );

  const designation = designationShown.filter((value) => value !== cadastre);
  write(
    client,
    'ipasuma_apzimejums',
    designation.length
      ? designation.map(formatCadastre).join(' · ')
      : objectNrs.length
        ? objectNrs.map(formatCadastre).join(' · ')
        : formatCadastre(cadastre),
    'kadastrs',
    buildings.requestUrl,
    KAD_PROOF,
    'gaida',
  );

  if (!cadastreReady() && !officialAddresses.length) {
    write(
      client,
      'ipasuma_adrese',
      '',
      'kadastrs',
      '',
      KAD_PROOF,
      'nav_datu',
      'kadastra adreses dumps vēl nav indeksēts un BIS būvē šī numura nav',
    );
  } else {
    write(
      client,
      'ipasuma_adrese',
      officialAddresses.length ? officialAddresses.join(' · ') : 'nav adreses šim numuram',
      'kadastrs',
      buildings.requestUrl,
      KAD_PROOF,
      'gaida',
    );
  }

  if (!cadastreReady()) {
    write(
      client,
      'ipasuma_tiesibas',
      '',
      'kadastrs',
      '',
      KAD_PROOF,
      'nav_datu',
      'īpašumtiesību XML vēl indeksējas. Atvērtajā kopā nav personas vārda',
    );
    return;
  }

  if (!owners.length) {
    write(
      client,
      'ipasuma_tiesibas',
      'nav ieraksta',
      'kadastrs',
      '',
      KAD_PROOF,
      'gaida',
      'atvērtajā kopā nav personas vārda — tikai statuss un personas veids',
    );
    return;
  }

  const lines = [...new Set(owners.map((row) => labelStatus(row.status, row.person)))];
  write(
    client,
    'ipasuma_tiesibas',
    lines.join(' · '),
    'kadastrs',
    '',
    KAD_PROOF,
    'gaida',
    'vārds un reģistrācijas numurs atvērtajā kopā nav publicēts',
  );
}

async function writeEncumbrance(
  client: Client,
  numbers: string[],
  tapis: LookupResult,
  force: boolean,
): Promise<void> {
  const rows = encumbrancesFor(numbers);
  if (!cadastreReady()) {
    const tapisText = text(tapis.record?.apgrutinajumi);
    write(
      client,
      'atis_apgrutinajumi',
      tapisText || '',
      tapisText ? 'tapis' : 'atis',
      tapis.requestUrl,
      ATIS_PROOF,
      tapisText ? 'gaida' : 'nav_datu',
      'kadastra apgrūtinājumu dumps vēl nav indeksēts. Klasifikators ir kodu grāmata, ne objekta saraksts',
    );
    return;
  }

  if (!rows.length) {
    write(client, 'atis_apgrutinajumi', 'Nē', 'atis', '', ATIS_PROOF, 'gaida');
    return;
  }

  const lines: string[] = [];
  for (const row of rows.slice(0, 12)) {
    let name = row.name;
    if (!name && row.code) {
      name = await lookupAtisCode(row.code, force);
    }
    lines.push([row.code, name].filter(Boolean).join(' — '));
  }
  write(client, 'atis_apgrutinajumi', yn(true, [...new Set(lines)].join(' · ')), 'atis', '', ATIS_PROOF, 'gaida');
}

/*
 * The three geo answers used to be written together. They now
 * land one by one, so each has its own writer; the wording and
 * statuses are the same as before.
 */
function writeZoning(client: Client, point: GeoPoint | null, tapis: LookupResult): void {
  if (!point) {
    const note = 'nav koordinātu šim kadastra numuram';
    fromLookup(client, 'tapis_izmantosana', '', tapis, 'nav_datu', note);
    fromLookup(client, 'tapis_dokuments', '', tapis, 'nav_datu', note);
    return;
  }

  const use = text(tapis.record?.izmantosana) || text(tapis.record?.zonejums);
  const doc = text(tapis.record?.dokuments);
  fromLookup(client, 'tapis_izmantosana', use || 'Nē', tapis, 'gaida');
  fromLookup(client, 'tapis_dokuments', doc || 'Nē', tapis, 'gaida');
}

function writeFlood(client: Client, point: GeoPoint | null, flood: LookupResult): void {
  if (!point) {
    const note = 'nav koordinātu šim kadastra numuram';
    fromLookup(client, 'pludi_10', '', flood, 'nav_datu', note);
    fromLookup(client, 'pludi_100', '', flood, 'nav_datu', note);
    fromLookup(client, 'pludi_200', '', flood, 'nav_datu', note);
    return;
  }

  fromLookup(client, 'pludi_10', text(flood.record?.g10), flood, flood.record?.g10_missing ? 'nav_datu' : 'gaida');
  fromLookup(client, 'pludi_100', text(flood.record?.g100), flood, flood.record?.g100_missing ? 'nav_datu' : 'gaida');
  fromLookup(client, 'pludi_200', text(flood.record?.g200), flood, flood.record?.g200_missing ? 'nav_datu' : 'gaida');
}

function writeNature(client: Client, point: GeoPoint | null, ozols: LookupResult): void {
  if (!point) {
    fromLookup(client, 'iadt', '', ozols, 'nav_datu', 'nav koordinātu šim kadastra numuram');
    return;
  }

  const iadt = text(ozols.record?.iadt);
  fromLookup(client, 'iadt', iadt ? yn(true, iadt) : 'Nē', ozols, 'gaida');

  /*
   * Mikroliegumi and biotopes were already in the Ozols answer.
   * Each carries its own error, so a dead GIS box behind the
   * mikroliegumi layer does not paint the biotope row red.
   */
  const micro = text(ozols.record?.mikroliegums);
  const microError = text(ozols.record?.micro_error);
  fromLookup(
    client,
    'ozols_mikroliegums',
    micro ? yn(true, micro) : 'Nē',
    { ...ozols, error: micro ? undefined : microError || undefined },
    'gaida',
  );

  const habitat = text(ozols.record?.biotops);
  const habitatError = text(ozols.record?.habitat_error);
  fromLookup(
    client,
    'ozols_biotops',
    habitat ? yn(true, habitat) : 'Nē',
    { ...ozols, error: habitat ? undefined : habitatError || undefined },
    'gaida',
    habitat ? 'ES nozīmes biotops punktā. Robeža un platība — Ozols kartē.' : '',
  );
}

/**
 * The Land Book row. Open cadastre data stops at "fiziska /
 * juridiska persona"; the owner's name lives in Zemesgrāmata,
 * which is a paid lookup. So: the number, and the door to it.
 */
function writeLandBook(client: Client, cadastre: string, numbers: string[]): void {
  const parcel = cadastre.slice(0, 11);
  const property = numbers.filter((nr) => nr.length === 11 && nr !== parcel);
  const lookup = zemesgramataLookup([parcel, ...property], new Date().toISOString());

  /*
   * An apartment block brings dozens of flat numbers along.
   * Lead with the land unit, name a couple, count the rest.
   */
  const shown = property.slice(0, 2);
  const more = property.length - shown.length;
  const extra = shown.length
    ? ` · saistītie īpašumi ${shown.join(', ')}${more > 0 ? ` un vēl ${more}` : ''}`
    : '';
  write(
    client,
    'zemesgramata',
    `Nodalījums pēc kadastra nr. ${parcel}${extra}`,
    'zg',
    '',
    `${lookup.proofUrl}?CadastreNumber=${encodeURIComponent(parcel)}`,
    'gaida',
    'Īpašnieka vārds atvērtajos datos nav — pārbaudi Zemesgrāmatā.',
  );
}

/** Building footprints on the land unit, newest designation first. */
function writeBuildingOutlines(client: Client, found: ParcelBuildings): void {
  if (found.error && !found.buildings.length) {
    write(client, 'buvju_konturas', '', 'kadastrs', found.requestUrl, BUILDING_PROOF, 'kluda', found.error);
    return;
  }
  if (!found.buildings.length) {
    write(client, 'buvju_konturas', 'Nē', 'kadastrs', found.requestUrl, BUILDING_PROOF, 'gaida', 'Kadastrā uz šīs zemes vienības būvju kontūru nav.');
    return;
  }

  const lines = found.buildings.map((building) =>
    join([building.code, building.name, building.built ? `būvēta ${building.built}` : '']),
  );
  write(
    client,
    'buvju_konturas',
    yn(true, `${found.buildings.length} ${found.buildings.length === 1 ? 'būve' : 'būves'}\n${lines.join('\n')}`),
    'kadastrs',
    found.requestUrl,
    BUILDING_PROOF,
    'gaida',
    'Tās pašas kontūras kartē iedegas oranžā. Avots: VZD INSPIRE „Ēkas”.',
  );
}

/**
 * NKMP monuments. The register's cadastre column was saved
 * through Excel ("1.30E+13"), so the join is the address:
 * same street as the lookup already required, plus the house
 * number, so "Smilšu iela 4" does not claim "Smilšu iela 10".
 */
function writeHeritage(client: Client, address: string, heritage: LookupResult): void {
  if (!address) {
    write(client, 'kulturas_piemineklis', '', 'nkmp', '', heritage.proofUrl, 'nav_datu', 'nav oficiālās adreses, ar ko meklēt NKMP sarakstā');
    return;
  }
  if (heritage.error && !heritage.records.length) {
    fromLookup(client, 'kulturas_piemineklis', '', heritage, 'kluda', heritage.error);
    return;
  }

  const house = fold(parseAddress(address).house);
  const hits = heritage.records.filter((row) => {
    if (!house) {
      return true;
    }
    return fold(text(row.Atrasanas_vieta)).split(' ').includes(house);
  });
  if (!hits.length) {
    fromLookup(client, 'kulturas_piemineklis', 'Nē', { ...heritage, proofUrl: 'https://mantojums.lv/cultural-objects' }, 'gaida');
    return;
  }

  /* Objekta_Nr first: the proof link builder reads it off the front. */
  const lines = hits.slice(0, 6).map((row) =>
    join([text(row.Objekta_Nr), text(row.Nosaukums), text(row.Vertibas_grupa), text(row.Datejums), text(row.Atrasanas_vieta)]),
  );
  fromLookup(
    client,
    'kulturas_piemineklis',
    yn(true, lines.join('\n')),
    heritage,
    'gaida',
    'Būvdarbiem piemineklī vai tā aizsardzības zonā vajag NKMP atļauju.',
  );
}

function writeConstruction(client: Client, buildings: LookupResult, cases: LookupResult): void {
  if (buildings.error && !buildings.records.length) {
    fromLookup(client, 'buvniecibas_lieta', '', buildings, 'kluda', buildings.error);
    return;
  }
  if (!buildings.records.length && !cases.records.length) {
    fromLookup(client, 'buvniecibas_lieta', 'Nē', buildings, 'gaida');
    return;
  }

  const lines = cases.records.length
    ? cases.records.map((row) =>
        join([
          text(row.Buvniecibas_lietas_numurs),
          text(row.Aktuala_stadija) ? `stadija ${text(row.Aktuala_stadija)}` : '',
          text(row.Objekta_nosaukums),
          text(row.Lietas_izveidosanas_datums).slice(0, 10),
        ]),
      )
    : buildings.records.slice(0, 6).map((row) =>
        join([
          text(row.Buvniecibas_lietas_numurs),
          text(row.Buves_nosaukums),
          text(row.Buves_kadastra_apzimejums),
        ]),
      );

  const lookup = cases.records.length ? cases : buildings;
  /* One entry per line: the fields inside an entry already use " · ". */
  fromLookup(client, 'buvniecibas_lieta', yn(true, lines.join('\n')), lookup, 'gaida');
}

function writeProjects(client: Client, projects: LookupResult): void {
  if (projects.error && !projects.records.length) {
    fromLookup(client, 'es_projekti', '', projects, 'kluda', projects.error);
    return;
  }
  if (!projects.records.length) {
    fromLookup(client, 'es_projekti', 'Nē', projects, 'gaida');
    return;
  }
  const lines = projects.records.slice(0, 8).map((row) =>
    join([
      text(row.ProjektaNumurs),
      text(row.ProjektaNosaukums),
      text(row.ProjektaStatuss),
      text(row.IesniedzejaNosaukums),
      euro(row.ProjektamPieskirtaisESFonduLidzfinansejums || row.EsFonduLidzfinansejums),
      text(row._periods),
      text(row._match) === 'adrese' ? 'pēc adreses, kadastrs tukšs' : '',
    ]),
  );
  fromLookup(
    client,
    'es_projekti',
    yn(true, [...new Set(lines)].join('\n')),
    projects,
    'gaida',
    'Īstenošanas vieta no CFLA atvērtajiem datiem, savienota ar projektu sarakstu. Nav CFLA iekšējais portāls.',
  );
}

/**
 * The one company the matcher reasons about, plus its de minimis
 * room. Built once per report and shared by CFLA and LIAA.
 */
interface CompanyFacts {
  profile: HintCompany | null;
  /** Ceiling minus general de minimis in the last 3 years; null when unknown. */
  deMinimisLeft: number | null;
  /** Ready-made line for the row note: who, NACE, size, de minimis room. */
  summary: string;
}

const NO_COMPANY: CompanyFacts = { profile: null, deMinimisLeft: null, summary: '' };

/**
 * De minimis grants split by the window that matters.
 *
 *   total      every grant FM has for this person, any year
 *   general3y  2023/2831 or 1407/2013 grants inside the last 3 years
 *   other3y    farming / fishery / SGEI grants in the same window
 *
 * A grant with no date is counted as recent: the cautious side.
 */
function deMinimisWindow(records: Record<string, unknown>[]): { total: number; general3y: number; other3y: number } {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - DE_MINIMIS_YEARS);
  let total = 0;
  let general3y = 0;
  let other3y = 0;
  for (const row of records) {
    const amount = Number(row.assigned_amount) || 0;
    total += amount;
    const when = Date.parse(text(row.assign_date));
    if (Number.isFinite(when) && when < cutoff.getTime()) {
      continue;
    }
    if (/2023\/2831|1407\/2013/.test(text(row.regul_title)) || !text(row.regul_title)) {
      general3y += amount;
    } else {
      other3y += amount;
    }
  }
  return { total, general3y, other3y };
}

function eur(value: number): string {
  return `${Math.round(value).toLocaleString('lv-LV')} EUR`;
}

/** NACE + MVU estimate + de minimis room for one registration number. */
async function companyFacts(person: { regcode: string; name: string } | null, force: boolean): Promise<CompanyFacts> {
  if (!person || !/^\d{11}$/.test(person.regcode)) {
    return NO_COMPANY;
  }
  const [profile, support] = await Promise.all([
    lookupCompanyProfile(person.regcode, force),
    lookupDeminimis(person.regcode, force),
  ]);
  const window = deMinimisWindow(support.records);
  const deMinimisLeft = support.error ? null : Math.max(0, DE_MINIMIS_CEILING - window.general3y);

  const summary = [
    person.name,
    profile.nace ? `NACE ${profile.nace}` : 'NACE nav VID atvērtajā kopā',
    profile.size ? `~${profile.size} (${profile.sizeBasis})` : '',
    deMinimisLeft != null ? `de minimis brīvi ~${eur(deMinimisLeft)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    profile: { name: person.name, nace: profile.nace, size: profile.size, sizeBasis: profile.sizeBasis },
    deMinimisLeft,
    summary,
  };
}

function parcelHints(
  numbers: string[],
  occupants: LookupResult,
  ozols: LookupResult,
  flood: LookupResult,
  client: Client,
  company: CompanyFacts,
): ParcelHints {
  /*
   * Ownership rarely hangs off the 11-digit land unit itself.
   * Flat blocks and leased land put the person type on the
   * PROPERTY numbers that linksFor already folded into `numbers`
   * (via relatedNumbers). Matching only the parcel row made every
   * apartment house look ownerless — and "Nav atbilstošu atlašu"
   * fired even when a private company sat on the address.
   */
  const owners = ownersFor(numbers);
  const person = (row: { person: string }) => fold(row.person);
  const merchants = occupants.records.filter((row) => !isClosed(row) && isMerchant(row));
  const names = merchants.map((row) => text(row.name)).filter(Boolean);
  if (text(client.applicant_name)) {
    names.push(text(client.applicant_name));
  }
  const hasApplicant = Boolean(cadastreDigits(client.applicant_regcode || ''));
  const hasCompany = merchants.length > 0 || hasApplicant;
  const taggedMunicipal = owners.some((row) => person(row) === 'pasvaldiba');
  const taggedLegal = owners.some((row) => person(row) === 'juridiska persona');
  /*
   * Only PersonStatus "pasvaldiba" counts as municipal for CFLA.
   * Do not treat bare "juridiska persona" (no UR merchant) as a
   * municipality — private legal owners were falsely matching
   * pašvaldību ēku atlases (e.g. 2.1.1.6 on 54620100583).
   */
  return {
    municipal: taggedMunicipal,
    state: owners.some((row) => person(row) === 'valsts'),
    legal: taggedLegal,
    natural: owners.some((row) => person(row) === 'fiziska persona'),
    nature: Boolean(text(ozols.record?.iadt)),
    flood: ['g10', 'g100', 'g200'].some((key) => /^jā/i.test(text(flood.record?.[key]))),
    company: hasCompany,
    names,
    profile: company.profile,
    deMinimisLeft: company.deMinimisLeft,
  };
}

/**
 * Owner signals for EKII household match. Unlike CFLA, legal
 * without a merchant stays a household candidate — only a true
 * PersonStatus pašvaldība / valsts (or UR company) is out.
 */
function ekiiHints(
  numbers: string[],
  occupants: LookupResult,
  client: Client,
  company: CompanyFacts,
): EkiiHints {
  const owners = ownersFor(numbers);
  const person = (row: { person: string }) => fold(row.person);
  const merchants = occupants.records.filter((row) => !isClosed(row) && isMerchant(row));
  const hasApplicant = Boolean(cadastreDigits(client.applicant_regcode || ''));
  const hasCompany = merchants.length > 0 || hasApplicant || Boolean(company.profile);
  return {
    company: hasCompany,
    natural: owners.some((row) => person(row) === 'fiziska persona'),
    legal: owners.some((row) => person(row) === 'juridiska persona'),
    municipalTagged: owners.some((row) => person(row) === 'pasvaldiba'),
    state: owners.some((row) => person(row) === 'valsts'),
  };
}

function formatEkiiCard(row: Record<string, unknown>): string {
  const window =
    text(row.starts) && text(row.ends)
      ? `${text(row.starts)} – ${text(row.ends)}`
      : text(row.ends)
        ? `līdz ${text(row.ends)}`
        : '';
  const rules = [
    text(row.maxGrant) ? `max ${text(row.maxGrant)}` : '',
    text(row.intensity) ? `intensitāte ${text(row.intensity)}` : '',
  ].filter(Boolean);

  const verdict = text(row.matched)
    ? `Atbilst — ${text(row.matchWhy) || 'mājsaimniecības tips'}`
    : text(row.matchWhy)
      ? `Neatbilst — ${text(row.matchWhy)}`
      : '';

  const lines = [
    verdict,
    `${text(row.code)} · ${text(row.title)}`,
    window ? `Iesniegumi: ${window}` : text(row.status),
    text(row.supports) ? `Atbalsta: ${text(row.supports)}` : '',
    rules.length ? `Nolikumā: ${rules.join(' · ')}` : '',
  ];
  /* Keep the apply link intact — a clipped URL is a dead button. */
  const link = text(row.href) || text(row.infoHref);
  return [clip(lines.filter(Boolean).join('\n'), 1000), link].filter(Boolean).join('\n');
}

async function writeEkiiSupport(
  client: Client,
  numbers: string[],
  occupants: LookupResult,
  company: CompanyFacts,
  force: boolean,
): Promise<void> {
  const hints = ekiiHints(numbers, occupants, client, company);
  const lookup = await lookupEkiiSupport(hints, force);
  if (lookup.error && !lookup.records.length) {
    fromLookup(client, 'ekii_atbalsts', '', lookup, 'kluda', lookup.error);
    return;
  }
  if (!lookup.records.length) {
    fromLookup(
      client,
      'ekii_atbalsts',
      'Nē',
      lookup,
      'gaida',
      `ekii.lv šobrīd nav atvērtu konkursu ar iesniegumu pieņemšanu. Katalogs: ${EKII_KONKURSI}`,
    );
    return;
  }

  /* Only cards that fit this parcel — same rule as CFLA open calls. */
  const matched = lookup.records.filter((row) => text(row.matched));
  const openTotal = lookup.records.length;
  const hits = matched.length;
  const top = matched[0] ?? lookup.records[0];
  const proof = hits && text(top?.href) ? text(top.href) : lookup.proofUrl;

  const value = hits ? matched.map((row) => formatEkiiCard(row)).join('\n\n') : 'Nē';

  const tableNote = text(lookup.record?.tableNote);

  fromLookup(
    client,
    'ekii_atbalsts',
    value,
    { ...lookup, proofUrl: proof },
    'gaida',
    [
      tableNote,
      hits
        ? `${hits} atbilst no ${openTotal} atvērtajiem EKII · pārējās neredzam, jo neatbilst šim gabalam.`
        : [
            `Šobrīd ir ${openTotal} atvērti EKII konkursi; neviena neatbilst mājsaimniecībai šajā gabalā.`,
            hints.company
              ? 'Adresē ir UR komersants — EKII-6 / EKII-10 ir iedzīvotājiem, ne komersantiem.'
              : hints.municipalTagged || hints.state
                ? 'Īpašnieks ir pašvaldība / valsts.'
                : 'Nav fiziskas personas vai juridiskas personas bez komersanta.',
            `Atvērtie konkursi: ${EKII_KONKURSI}`,
            `LVIF AER skaidrojums: ${LVIF_AER}`,
          ].join(' '),
      'Atbilstība: fiziska persona vai juridiska bez UR komersanta → mājsaimniecību AER (EKII-6) un iedzīvotāju transports (EKII-10).',
      'data.gov.lv KPFI/EKII XLSX ir jau īstenotie projekti (pēdējais dumps ~2020), ne atvērtie konkursi — šeit nelasa.',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

async function writeCflaCalls(client: Client, hints: ParcelHints, company: CompanyFacts, force: boolean): Promise<void> {
  const lookup = await lookupCflaCalls(hints, force);
  if (lookup.error && !lookup.records.length) {
    fromLookup(client, 'cfla_atlases', '', lookup, 'kluda', lookup.error);
    return;
  }
  if (!lookup.records.length) {
    fromLookup(client, 'cfla_atlases', 'Nē', lookup, 'gaida', 'CFLA tabulā šobrīd nav izsludinātu atlašu ar nākotnes termiņu.');
    return;
  }

  /*
   * Only cards that fit this parcel. The national open catalogue
   * stays out of the panel — LVM-only rounds must not sit next to
   * a municipal hit and look “available for this gabals”.
   */
  const matched = lookup.records.filter((row) => text(row.matched));
  const openTotal = lookup.records.length;
  const hits = matched.length;
  const namedOnly = lookup.records.filter((row) => /ierobežota/i.test(text(row.kind))).length;
  const top = matched[0] ?? lookup.records[0];
  const proof = hits && text(top?.href) ? text(top.href) : lookup.proofUrl;

  const value = hits
    ? matched.map((row) => formatAtlasCard(row)).join('\n\n')
    : 'Nē';

  fromLookup(
    client,
    'cfla_atlases',
    value,
    { ...lookup, proofUrl: proof },
    'gaida',
    [
      company.summary ? `Profils: ${company.summary}.` : '',
      hits
        ? `${hits} atbilst no ${openTotal} atvērtajām · pārējās neredzam, jo neatbilst šim gabalam.`
        : [
            `Šobrīd CFLA ir ${openTotal} atvērtas atlases; neviena neatbilst šī gabala īpašnieka veidam vai komersantam adresē.`,
            namedOnly
              ? `${namedOnly} no tām ir ierobežotas — tikai nosauktām iestādēm (LVM, DAP, NVD u.c.), ne katram gabalam.`
              : '',
            'Atbilstība uzlec, kad adresē ir UR komersants, īpašnieks ir pašvaldība / valsts, vai ievadi reģ. nr. augšā.',
            `Visas atvērtās: ${CFLA_PROGRAMS}`,
          ]
            .filter(Boolean)
            .join(' '),
      'Atbilstība: īpašnieka veids un komersants adresē pret CFLA „kas var pieteikties”, tad nolikuma NACE, MVU un de minimis nosacījumi.',
      'MVU ir aplēse pēc viena uzņēmuma UR pārskata, bez saistītajiem uzņēmumiem.',
      `Palīgs: ${CFLA_HELP}`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * Title first (that is the “what”), then the public facts from
 * the atlas page: window, kind, who can file, leftover money.
 */
function formatAtlasCard(row: Record<string, unknown>): string {
  const deadline =
    text(row.deadline) ||
    (text(row.starts) && text(row.ends) ? `${text(row.starts)} – ${text(row.ends)}` : text(row.ends) ? `līdz ${text(row.ends)}` : '');
  const kind = text(row.kind);
  const window = [kind, deadline ? `termiņš ${deadline}` : ''].filter(Boolean).join(' · ');

  /* What the rules file says, in one line: intensity, cap, MVU-only, de minimis. */
  const rules = [
    text(row.intensity) ? `intensitāte līdz ${text(row.intensity)}` : '',
    text(row.maxGrant) ? `max ${text(row.maxGrant)} projektam` : '',
    text(row.mvuOnly) ? 'tikai MVU' : '',
    text(row.deMinimis) ? 'de minimis' : '',
    text(row.naceExcluded) ? `izslēgti NACE ${clip(text(row.naceExcluded), 80)}` : '',
  ].filter(Boolean);

  /* Lead line: the verdict, or the reason the rules said no. */
  const verdict = text(row.matched)
    ? `Atbilst — ${text(row.matchWhy) || 'pēc gabala faktiem'}`
    : text(row.matchWhy)
      ? `Neatbilst — ${text(row.matchWhy)}`
      : '';

  const lines = [
    verdict,
    text(row.matchWarn) ? `Uzmanību: ${text(row.matchWarn)}` : '',
    text(row.title),
    window,
    text(row.evaluation) ? `Vērtēšana: ${text(row.evaluation)}` : '',
    text(row.who) ? `Kas var pieteikties: ${text(row.who)}` : '',
    text(row.money) ? `Finansējums: ${text(row.money)}` : '',
    rules.length ? `Nolikumā: ${rules.join(' · ')}` : '',
  ];
  /* Clip the prose, never the link: a cut URL is a broken button. */
  return [clip(lines.filter(Boolean).join('\n'), 1000), text(row.href)].filter(Boolean).join('\n');
}

function writeOccupants(client: Client, occupants: LookupResult): number {
  if (!occupants.requestUrl) {
    write(client, 'uznemumi_adrese', 'Nē', 'ur', '', LURSOFT, 'gaida', 'nav VARIS adreses koda, ar ko meklēt UR');
    return 0;
  }

  const active = occupants.records.filter((row) => !isClosed(row) && isMerchant(row)).slice(0, 6);
  if (occupants.error && !active.length) {
    fromLookup(client, 'uznemumi_adrese', '', occupants, 'kluda', occupants.error);
    return 0;
  }
  if (!active.length) {
    fromLookup(client, 'uznemumi_adrese', 'Nē', { ...occupants, proofUrl: LURSOFT }, 'gaida');
    return 0;
  }

  fromLookup(
    client,
    'uznemumi_adrese',
    yn(true, active.map(formatCompany).join(' · ')),
    { ...occupants, proofUrl: LURSOFT },
    'gaida',
    'Lursoft ielas meklēšana jauc blakus mājas. Šis saraksts ir tikai UR ieraksti ar šo adreses kodu',
  );
  return active.length;
}

function blankApplicant(client: Client, note: string): void {
  write(client, 'vid_reitings', '', 'vid', '', 'https://data.gov.lv/dati/lv/dataset/nodoklu-maksataju-reitings', 'nav_datu', note);
  write(client, 'de_minimis', 'Nē', 'fm', '', 'https://data.gov.lv/dati/dataset/pieskirtais-de-minimis-atbalsts-latvija', 'gaida');
  write(client, 'iepirkumi', 'Nē', 'eis', '', 'https://www.eis.gov.lv/', 'gaida');
}

/**
 * VID rating, de minimis and procurement are about a person,
 * not the parcel. Each entry is a registration number plus a label.
 */
async function writePersonChecks(
  client: Client,
  people: { regcode: string; name: string }[],
  force: boolean,
  note: string,
  siteAddress: string,
): Promise<void> {
  const ratings: string[] = [];
  let ratingLookup: LookupResult | null = null;
  let deMinimisHit = false;
  let deMinimisSum = 0;
  let deLookup: LookupResult | null = null;
  /* Per person: the 3-year window and the room left, for the row text. */
  const windows: { name: string; general3y: number; other3y: number }[] = [];
  const regcodes: string[] = [];

  for (const person of people) {
    if (!/^\d{11}$/.test(person.regcode) || regcodes.includes(person.regcode)) {
      continue;
    }
    regcodes.push(person.regcode);
    const rating = await lookupRating(person.regcode, force);
    ratingLookup = rating;
    const letter = text(rating.record?.Reitings);
    ratings.push(letter ? `${person.name} — ${letter}` : `${person.name} — nav reitinga`);

    const support = await lookupDeminimis(person.regcode, force);
    deLookup = support;
    if (support.records.length) {
      deMinimisHit = true;
      const window = deMinimisWindow(support.records);
      deMinimisSum += window.total;
      windows.push({ name: person.name, general3y: window.general3y, other3y: window.other3y });
    }
  }

  if (!regcodes.length) {
    blankApplicant(client, note);
    return;
  }

  if (ratingLookup) {
    fromLookup(client, 'vid_reitings', ratings.join(' · '), ratingLookup, ratings.length ? 'gaida' : 'nav_datu', note);
  }
  if (deLookup) {
    const money = deMinimisSum ? `${Math.round(deMinimisSum).toLocaleString('lv-LV')} EUR` : '';
    /*
     * The all-time total stays first, as before. Then, per person,
     * what actually counts: the rolling 3-year window and the room
     * left under the 300 000 EUR general ceiling.
     */
    const windowLines = windows.map((item) =>
      join([
        windows.length > 1 ? item.name : '',
        `${DE_MINIMIS_YEARS} gados ${eur(item.general3y)}`,
        `brīvi ~${eur(Math.max(0, DE_MINIMIS_CEILING - item.general3y))} no ${eur(DE_MINIMIS_CEILING)}`,
        item.other3y ? `citas regulas (lauks., zivsaimn., VTNP) ${eur(item.other3y)}` : '',
      ]),
    );
    const detail = money ? [`${money} kopā`, ...windowLines].join(windowLines.length > 1 ? '\n' : ' · ') : '';
    fromLookup(
      client,
      'de_minimis',
      yn(deMinimisHit, detail),
      deLookup,
      'gaida',
      [note, deMinimisHit ? 'Griesti pēc Regulas 2023/2831; saistītie uzņēmumi nav saskaitīti.' : ''].filter(Boolean).join('. '),
    );
  }

  const procurement = await lookupProcurement(regcodes, force, siteAddress);
  if (!procurement.records.length) {
    fromLookup(client, 'iepirkumi', 'Nē', procurement, procurement.error ? 'kluda' : 'gaida', note);
  } else {
    const lines = procurement.records.map((row) =>
      join([
        text(row._match) === 'vieta' ? 'pēc objekta vietas' : '',
        text(row.Iepirkuma_identifikacijas_numurs),
        text(row.Iepirkuma_izsludinasanas_datums).slice(0, 10),
        text(row.Iepirkuma_statuss),
        text(row.Iepirkuma_nosaukums),
      ]),
    );
    /*
     * A large buyer has hundreds of tenders. Show the newest few
     * and say how many were left out; the proof link has them all.
     */
    const shown = lines.slice(0, 6);
    const more = lines.length - shown.length;
    if (more > 0) {
      shown.push(`… un vēl ${more} iepirkumi (skati avotā)`);
    }
    fromLookup(client, 'iepirkumi', yn(true, shown.join('\n')), procurement, 'gaida', note);
  }
}

async function applicantPerson(client: Client): Promise<{ regcode: string; name: string } | null> {
  const regcode = cadastreDigits(client.applicant_regcode || '');
  if (!/^\d{11}$/.test(regcode)) {
    return null;
  }

  let name = text(client.applicant_name);
  if (!name) {
    /*
     * The sheet may only have the number. UR open data
     * still has the registered name, and the card should show it.
     */
    const resolved = await resolveRegisteredName(regcode);
    name = text(resolved.name);
    if (name) {
      updateClientApplicant(client.id, regcode, name);
    }
  }
  return { regcode, name: name || regcode };
}

async function writeParties(
  client: Client,
  occupants: LookupResult,
  force: boolean,
  siteAddress: string,
  applicantPromise: Promise<{ regcode: string; name: string } | null>,
  profilePromise: Promise<CompanyFacts>,
): Promise<number> {
  const active = occupants.records.filter((row) => !isClosed(row) && isMerchant(row));
  const companies = writeOccupants(client, occupants);
  const applicant = await applicantPromise;

  /*
   * An entered applicant wins over whoever happens to sit
   * at the address. The address list stays on its own row.
   */
  if (applicant) {
    await writePersonChecks(client, [applicant], force, 'pēc iesniedzēja reģistrācijas numura', siteAddress);
    await writeLiaaRow(client, true, force, await profilePromise);
    return companies;
  }

  if (!companies) {
    const note = occupants.requestUrl ? 'nav uzņēmuma šajā adresē' : 'nav VARIS adreses koda un nav iesniedzēja numura';
    blankApplicant(client, note);
    await writeLiaaRow(client, false, force, NO_COMPANY);
    return 0;
  }

  await writePersonChecks(
    client,
    active.slice(0, 6).map((row) => ({ regcode: text(row.regcode), name: text(row.name) || text(row.regcode) })),
    force,
    '',
    siteAddress,
  );
  await writeLiaaRow(client, true, force, await profilePromise);
  return companies;
}

/**
 * LIAA's catalogue is about a person, not a land unit.
 * Without a company on the address we still write the row,
 * so the panel does not look like the feed is missing.
 */
async function writeLiaaRow(client: Client, hasCompany: boolean, force: boolean, company: CompanyFacts): Promise<void> {
  if (!hasCompany) {
    write(
      client,
      'liaa_atbalsts',
      '',
      'liaa',
      '',
      LIAA_PROOF,
      'nav_datu',
      'LIAA katalogs ir par uzņēmumu, ne par kadastru. Šajā adresē nav UR komersanta (un nav ievadīta reģ. nr.).',
    );
    return;
  }

  const lookup = await lookupLiaaSupport(force);
  if (lookup.error && !lookup.records.length) {
    fromLookup(client, 'liaa_atbalsts', '', lookup, 'kluda', lookup.error);
    return;
  }
  if (!lookup.records.length) {
    fromLookup(client, 'liaa_atbalsts', 'Nē', lookup, 'gaida');
    return;
  }

  const size = company.profile?.size || '';
  const ranked = lookup.records
    .map((row) => ({ row, fit: liaaFits(row, hasCompany, size) }))
    .sort((left, right) => Number(right.fit.matched) - Number(left.fit.matched));
  const cards = ranked.slice(0, 6).map((item) => formatLiaaCard(item.row, item.fit));
  fromLookup(
    client,
    'liaa_atbalsts',
    cards.join('\n\n'),
    lookup,
    'gaida',
    [
      company.summary ? `Profils: ${company.summary}.` : '',
      'Atbilstība pēc LIAA saņēmēju grupas pret komersantu šajā adresē (vai ievadīto reģ. nr.); MVU / jaunuzņēmumu grupas — pret UR pārskata aplēsi.',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * Group match first (komersants / juridiska / fiziska), then the
 * size gate: a group that only names MVU, mikro or jaunuzņēmumi
 * does not fit a company whose own UR report says "liels".
 */
function liaaFits(
  row: Record<string, unknown>,
  hasCompany: boolean,
  size: string,
): { matched: boolean; why: string } {
  const groups = fold(text(row['Saņēmēju grupas']));
  if (!groups) {
    return { matched: hasCompany, why: hasCompany ? 'adresē ir komersants' : '' };
  }
  if (!hasCompany) {
    const natural = /fizisk/.test(groups);
    return { matched: natural, why: natural ? 'saņēmēju grupā ir fiziska persona' : '' };
  }

  const sizeOnly = /(mvu|mikro|mazie|videjie|jaunuznemum)/.test(groups) && !/(lielie|visi komersanti|jebkur)/.test(groups);
  if (sizeOnly && size === 'liels') {
    return { matched: false, why: 'grupa ir MVU / jaunuzņēmumi, bet uzņēmums pēc UR pārskata ir liels' };
  }
  if (/komersant|juridisk/.test(groups)) {
    return {
      matched: true,
      why: sizeOnly && size ? `saņēmēju grupā ir MVU, uzņēmums ~${size}` : 'saņēmēju grupā ir komersants / juridiska persona',
    };
  }
  if (sizeOnly && size && size !== 'liels') {
    return { matched: true, why: `saņēmēju grupā ir MVU, uzņēmums ~${size}` };
  }
  return { matched: false, why: '' };
}

/**
 * Catalogue row: what it is, who it is for, until when.
 * The CKAN dump already carries the short description.
 */
function formatLiaaCard(row: Record<string, unknown>, fit: { matched: boolean; why: string }): string {
  const until = text(row['Pieejams līdz']);
  const untilBit = until && until !== 'None' ? `Pieejams līdz ${until.slice(0, 10)}` : '';
  const about = clip(text(row['Pakalpojuma īsais apraksts']), 220);
  const who = clip(text(row['Saņēmēju grupas']), 160);
  const lines = [
    fit.matched ? `Atbilst — ${fit.why}` : fit.why ? `Neatbilst — ${fit.why}` : '',
    text(row.Nosaukums),
    about,
    who ? `Kas var pieteikties: ${who}` : '',
    untilBit,
    text(row['Pieteikšanās saite']),
  ];
  return clip(lines.filter(Boolean).join('\n'), 900);
}

function writeMatch(
  client: Client,
  enteredAddress: string,
  officialAddresses: string[],
  sourceUrl: string,
): void {
  if (!enteredAddress) {
    write(
      client,
      'adreses_atbilstiba',
      '',
      'kadastrs',
      sourceUrl,
      KAD_PROOF,
      'nav_datu',
      'ievadi arī iesniegto adresi, lai salīdzinātu',
    );
    return;
  }
  if (!officialAddresses.length) {
    write(
      client,
      'adreses_atbilstiba',
      '',
      'kadastrs',
      sourceUrl,
      KAD_PROOF,
      'nav_datu',
      'kadastram nav oficiālās adreses, ar ko salīdzināt',
    );
    return;
  }
  const verdict = compareAddresses(enteredAddress, officialAddresses);
  write(
    client,
    'adreses_atbilstiba',
    verdict || 'Neatbilst',
    'kadastrs',
    sourceUrl,
    KAD_PROOF,
    'gaida',
    verdict === 'Neatbilst' ? `kadastra adrese: ${officialAddresses[0]}` : '',
  );
}
