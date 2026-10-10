import { AsyncLocalStorage } from 'node:async_hooks';
import { lookupAddressOccupants, urAdapter } from '../adapters/ur.ts';
import { vidAdapter } from '../adapters/vid.ts';
import type { LookupResult, PlaceContext } from '../adapters/types.ts';
import {
  coordsFromVaris,
  lookupFlood,
  lookupOzols,
  lookupTapis,
  zemesgramataLookup,
  type GeoPoint,
} from '../adapters/geo.ts';
import {
  emptyPlaceContext,
  lookupBis,
  lookupDeminimis,
  lookupEquity,
  lookupFinancials,
  lookupHeritage,
  lookupInsolvency,
  lookupLiquidations,
  lookupRating,
  lookupReorg,
  lookupSanctions,
  lookupSecuring,
  lookupSpecialStatus,
  lookupStockholders,
  lookupSuspensions,
  lookupTax,
  lookupVaris,
} from '../adapters/open.ts';
import {
  getClient,
  listClients,
  listFacts,
  logEvent,
  updateClientName,
  upsertFact,
} from '../db.ts';
import { evaluateClient } from './evaluate.ts';
import { FIELD_SPECS, UR_REGISTER_KEYS, VID_VAT_KEYS } from '../fields.ts';
import type { Client, Fact, FactStatus, FieldKey, Kpis, SourceId } from '../types.ts';

/*
 * Per-request write filter so a single failed field can be
 * retried without overwriting the rest of the card.
 */
const writeGate = new AsyncLocalStorage<Set<FieldKey> | null>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asText(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function formatDate(value: unknown): string {
  const text = asText(value);
  if (!text) {
    return '';
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[3]}.${iso[2]}.${iso[1]}`;
  }

  return text;
}

function formatMoney(value: unknown, currency = 'EUR'): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return asText(value);
  }
  return `${new Intl.NumberFormat('lv-LV').format(numeric)} ${currency}`.trim();
}

function clip(value: string, max = 420): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1).trim()}…`;
}

function joinFacts(parts: string[]): string {
  return clip(parts.filter(Boolean).join(' · '));
}

function isClosed(record: Record<string, unknown>): boolean {
  // UR dumps put a blank/space in `closed` for live companies;
  // only letter codes (L/R/…) and a real `terminated` date mean gone.
  const terminated = asText(record.terminated);
  const closed = asText(record.closed).toUpperCase();
  if (terminated) {
    return true;
  }
  if (!closed || closed === '0' || closed === '-' || closed === 'N') {
    return false;
  }
  return true;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/["""«»]/g, '')
    .replace(/\bsabiedrība ar ierobežotu atbildību\b/g, '')
    .replace(/\bakciju sabiedrība\b/g, '')
    .replace(/\b(sia|as|ik|ks)\b/g, '')
    .replace(/[^a-z0-9āčēģīķļņšūž]+/gi, ' ')
    .trim();
}

function mapVidActive(value: string): string {
  const lowered = value.toLowerCase();
  if (!value) {
    return '';
  }
  if (lowered === 'nav' || lowered === 'nē' || lowered === 'ne') {
    return 'nav aktīvs';
  }
  if (lowered === 'jā' || lowered === 'ir' || lowered === 'aktīvs') {
    return 'aktīvs';
  }
  return value;
}

function emptyStatus(error?: string): FactStatus {
  return error ? 'kluda' : 'nav_datu';
}

function filledStatus(value: string, error?: string): FactStatus {
  if (error) {
    return 'kluda';
  }
  return value ? 'gaida' : 'nav_datu';
}

/**
 * Absence in a sanctions / insolvency dump is itself a fact:
 * the officer still sees a timestamped "nav" with the CKAN URL.
 */
function noneFoundStatus(error?: string): { value: string; status: FactStatus } {
  if (error) {
    return { value: '', status: 'kluda' };
  }
  return { value: 'nav', status: 'gaida' };
}

function writeField(
  client: Client,
  fieldKey: FieldKey,
  value: string,
  lookup: LookupResult,
  status: FactStatus,
  conflictNote = '',
): Fact {
  const gate = writeGate.getStore();
  if (gate && !gate.has(fieldKey)) {
    return (
      listFacts().find((fact) => fact.client_id === client.id && fact.field_key === fieldKey) ?? {
        id: '',
        client_id: client.id,
        field_key: fieldKey,
        value: '',
        source_id: '',
        source_url: '',
        proof_url: '',
        fetched_at: '',
        status: 'nav_datu',
        corrected_value: '',
        reviewed_at: '',
        reviewer: '',
        conflict_note: '',
        previous_value: '',
      }
    );
  }

  const spec = FIELD_SPECS.find((item) => item.key === fieldKey);
  return upsertFact({
    clientId: client.id,
    fieldKey,
    value,
    sourceId: (spec?.sourceId ?? lookup.sourceId) as SourceId,
    sourceUrl: lookup.requestUrl,
    proofUrl: lookup.proofUrl,
    fetchedAt: lookup.fetchedAt,
    status,
    conflictNote,
  });
}

function writeNoneOrList(
  client: Client,
  fieldKey: FieldKey,
  lookup: LookupResult,
  summarise: (records: Record<string, unknown>[]) => string,
): void {
  if (lookup.error) {
    writeField(client, fieldKey, '', lookup, 'kluda', lookup.error);
    logEvent('lookup_error', { sourceId: lookup.sourceId, field: fieldKey, regcode: client.regcode, error: lookup.error });
    return;
  }

  if (!lookup.records.length) {
    const none = noneFoundStatus();
    writeField(client, fieldKey, none.value, lookup, none.status);
    return;
  }

  const value = summarise(lookup.records);
  writeField(client, fieldKey, value, lookup, filledStatus(value, lookup.error));
}

function writeOzolsFact(
  client: Client,
  fieldKey: FieldKey,
  lookup: LookupResult,
  valueKey: string,
  errorKey: string,
): void {
  const layerError = asText(lookup.record?.[errorKey]);
  if (layerError) {
    writeField(client, fieldKey, '', lookup, 'kluda', layerError);
    logEvent('lookup_error', { sourceId: 'ozols', field: fieldKey, regcode: client.regcode, error: layerError });
    return;
  }

  const value = asText(lookup.record?.[valueKey]);
  writeField(client, fieldKey, value || noneFoundStatus().value, lookup, 'gaida');
}

function mapUrFields(client: Client, lookup: LookupResult): void {
  const record = lookup.record;
  const error = lookup.error;

  if (!record) {
    for (const key of UR_REGISTER_KEYS) {
      writeField(client, key, '', lookup, emptyStatus(error), error ?? '');
    }
    if (error) {
      logEvent('lookup_error', { sourceId: 'ur', regcode: client.regcode, error });
    }
    return;
  }

  const name = asText(record.name);
  const closed = isClosed(record);

  /*
   * The list title follows UR, not a typed label.
   * Keep the in-memory client in sync for this collect pass.
   */
  if (name && name !== client.name) {
    updateClientName(client.id, name);
    client.name = name;
  }

  writeField(client, 'nosaukums', name, lookup, filledStatus(name, error));
  writeField(client, 'registracijas_numurs', asText(record.regcode) || client.regcode, lookup, 'gaida');
  writeField(
    client,
    'juridiska_forma',
    asText(record.type_text) || asText(record.type),
    lookup,
    filledStatus(asText(record.type_text) || asText(record.type), error),
  );
  writeField(
    client,
    'juridiska_adrese',
    asText(record.address),
    lookup,
    filledStatus(asText(record.address), error),
  );
  writeField(
    client,
    'registracijas_datums',
    formatDate(record.registered),
    lookup,
    filledStatus(formatDate(record.registered), error),
  );
  writeField(client, 'registra_statuss', closed ? 'izslēgts' : 'aktīvs', lookup, 'gaida');
  writeField(
    client,
    'izslegsanas_datums',
    closed ? formatDate(record.terminated) : '',
    lookup,
    closed ? filledStatus(formatDate(record.terminated), error) : 'nav_datu',
  );
  writeField(client, 'pasta_indekss', asText(record.index), lookup, filledStatus(asText(record.index), error));
  writeField(client, 'sepa', asText(record.sepa), lookup, filledStatus(asText(record.sepa), error));
  writeField(client, 'adreses_kods', asText(record.addressid), lookup, filledStatus(asText(record.addressid), error));
}

function mapVidFields(client: Client, lookup: LookupResult): string {
  const record = lookup.record;
  const error = lookup.error;

  if (!record) {
    for (const key of VID_VAT_KEYS) {
      writeField(client, key, '', lookup, emptyStatus(error), error ?? '');
    }
    if (error) {
      logEvent('lookup_error', { sourceId: 'vid', regcode: client.regcode, error });
    } else {
      logEvent('lookup_empty', { sourceId: 'vid', regcode: client.regcode });
    }
    return '';
  }

  const vat = asText(record.Numurs);
  const status = mapVidActive(asText(record.Aktivs));
  const registered = formatDate(record.Registrets);

  writeField(client, 'pvn_numurs', vat, lookup, filledStatus(vat, error));
  writeField(client, 'pvn_statuss', status, lookup, filledStatus(status, error));
  writeField(client, 'pvn_registracijas_datums', registered, lookup, filledStatus(registered, error));
  return asText(record.Nosaukums);
}

function applyNameConflict(client: Client, urName: string, vidName: string): void {
  const gate = writeGate.getStore();
  if (gate && !gate.has('nosaukums')) {
    return;
  }
  if (!urName || !vidName) {
    return;
  }
  if (normalizeName(urName) === normalizeName(vidName)) {
    return;
  }

  const facts = listFacts().filter((fact) => fact.client_id === client.id && fact.field_key === 'nosaukums');
  const current = facts[0];
  if (!current) {
    return;
  }

  upsertFact({
    clientId: client.id,
    fieldKey: 'nosaukums',
    value: current.value,
    sourceId: 'ur',
    sourceUrl: current.source_url,
    proofUrl: current.proof_url,
    fetchedAt: current.fetched_at,
    status: 'konflikts',
    conflictNote: `VID nosaukums: ${vidName}`,
  });

  logEvent('name_conflict', {
    clientId: client.id,
    regcode: client.regcode,
    ur: urName,
    vid: vidName,
  });
}

function pickPaidEquity(records: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return (
    records.find((row) => asText(row.equity_capital_type) === 'PAID_UP_EQUITY') ??
    records[0]
  );
}

function isLegalShareholder(row: Record<string, unknown>): boolean {
  const type = asText(row.entity_type).toUpperCase();
  if (type === 'LEGAL_ENTITY' || type === 'FOREIGN_ENTITY') {
    return true;
  }
  /*
   * Anything with a personal code stays out of v1, even if
   * the type field is blank or unexpected.
   */
  return !asText(row.latvian_identity_number_masked) && !asText(row.birth_date) && Boolean(asText(row.legal_entity_registration_number));
}

function isNaturalShareholder(row: Record<string, unknown>): boolean {
  if (isLegalShareholder(row)) {
    return false;
  }
  const type = asText(row.entity_type).toUpperCase();
  return (
    type === 'NATURAL_PERSON' ||
    type === 'NATURAL_ENTITY' ||
    type === 'PERSON' ||
    Boolean(asText(row.latvian_identity_number_masked) || asText(row.birth_date))
  );
}

function pickTurnover(row: Record<string, unknown> | undefined): string {
  if (!row) {
    return '';
  }
  const keys = [
    'net_turnover',
    'turnover',
    'neto_apgrozijums',
    'Neto_apgrozijums',
    'netTurnover',
    'income',
    'revenue',
  ];
  for (const key of keys) {
    const value = asText(row[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

function latestFinancial(records: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return [...records].sort((left, right) => Number(right.year ?? 0) - Number(left.year ?? 0))[0];
}

function isFiliale(row: Record<string, unknown>): boolean {
  const type = asText(row.type).toUpperCase();
  return type === 'FIL' || /filiāl/i.test(asText(row.type_text) || asText(row.name));
}

/**
 * Associations and union cells sit on the same address too.
 * “Komersants” here is SIA/AS/IK and the like — not a biedrība.
 */
function isMerchantType(row: Record<string, unknown>): boolean {
  if (isFiliale(row)) {
    return false;
  }
  const type = asText(row.type).toUpperCase();
  // Commercial forms first — UR type_text says "Sabiedrība ar
  // ierobežotu atbildību", which must never be treated as biedrība.
  if (['SIA', 'AS', 'IK', 'KS', 'PS', 'IU', 'ZU', 'AK'].includes(type)) {
    return true;
  }
  if (['BDR', 'SAB', 'ARV', 'NOD', 'FOND'].includes(type)) {
    return false;
  }
  /*
   * Whole-word only. A substring /biedrīb/ also matches
   * "Sabiedrība …" and used to wipe every SIA at an address.
   */
  const label = `${asText(row.type_text)} ${asText(row.name)}`;
  if (/\b(arodbiedrība|biedrība|nodibinājums)\b/i.test(label)) {
    return false;
  }
  return Boolean(type);
}

function formatOccupant(row: Record<string, unknown>): string {
  return joinFacts([asText(row.name), asText(row.regcode), asText(row.type_text) || asText(row.type)]);
}

function mapAddressOccupants(client: Client, lookup: LookupResult): void {
  if (lookup.error) {
    writeField(client, 'adrese_citi_komersanti', '', lookup, 'kluda', lookup.error);
    writeField(client, 'adrese_filiales', '', lookup, 'kluda', lookup.error);
    writeField(client, 'adrese_saimnieciska_pazime', '', lookup, 'kluda', lookup.error);
    logEvent('lookup_error', { sourceId: 'ur', field: 'adrese_saimnieciska_pazime', regcode: client.regcode, error: lookup.error });
    return;
  }

  if (!lookup.requestUrl) {
    writeField(client, 'adrese_citi_komersanti', '', lookup, 'nav_datu');
    writeField(client, 'adrese_filiales', '', lookup, 'nav_datu');
    writeField(client, 'adrese_saimnieciska_pazime', '', lookup, 'nav_datu');
    return;
  }

  const others = lookup.records.filter((row) => asText(row.regcode) !== client.regcode);
  const active = others.filter((row) => !isClosed(row));
  const closed = others.filter((row) => isClosed(row));
  const merchants = active.filter(isMerchantType);
  const filiales = others.filter(isFiliale);
  const activeFiliales = filiales.filter((row) => !isClosed(row));
  const closedFiliales = filiales.filter((row) => isClosed(row));

  const merchantText = merchants.length
    ? `${merchants.length}: ${joinFacts(merchants.map(formatOccupant))}`
    : 'nav citu aktīvu komersantu šajā VARIS adresē';
  writeField(client, 'adrese_citi_komersanti', merchantText, lookup, 'gaida');

  let filialeText = 'nav filiāļu UR datos šajā adresē';
  if (activeFiliales.length) {
    filialeText = `${activeFiliales.length} aktīvas: ${joinFacts(activeFiliales.map(formatOccupant))}`;
    if (closedFiliales.length) {
      filialeText = `${filialeText}; ${closedFiliales.length} izslēgtas vēsturiski`;
    }
  } else if (closedFiliales.length) {
    filialeText = `aktīvu filiāļu nav; ${closedFiliales.length} izslēgtas vēsturiski`;
  }
  writeField(client, 'adrese_filiales', filialeText, lookup, 'gaida');

  /*
   * Counts only. Not a “there is / isn’t business here” verdict —
   * VID struktūrvienības PDB is a form, not this dump.
   */
  const pazime = joinFacts([
    `${active.length} citi aktīvi UR subjekti pie tās pašas VARIS adreses`,
    `${merchants.length} komersanti`,
    `${activeFiliales.length} aktīvas filiāles`,
    `${closed.length} izslēgti`,
    'UR juridiskā adrese, ne VID PDB struktūrvienības',
  ]);
  writeField(client, 'adrese_saimnieciska_pazime', pazime, lookup, 'gaida');
}

function mapTapisFields(client: Client, lookup: LookupResult): void {
  if (lookup.error) {
    writeField(client, 'tapis_zonejums', '', lookup, 'kluda', lookup.error);
    writeField(client, 'tapis_apgrutinajumi', '', lookup, 'kluda', lookup.error);
    writeField(client, 'tapis_ipasie_noteikumi', '', lookup, 'kluda', lookup.error);
    logEvent('lookup_error', { sourceId: 'tapis', regcode: client.regcode, error: lookup.error });
    return;
  }

  if (!lookup.requestUrl) {
    writeField(client, 'tapis_zonejums', '', lookup, 'nav_datu');
    writeField(client, 'tapis_apgrutinajumi', '', lookup, 'nav_datu');
    writeField(client, 'tapis_ipasie_noteikumi', '', lookup, 'nav_datu');
    return;
  }

  const zone = asText(lookup.record?.zonejums);
  const constraints = asText(lookup.record?.apgrutinajumi);
  const special = asText(lookup.record?.ipasie_noteikumi);
  writeField(client, 'tapis_zonejums', zone || noneFoundStatus().value, lookup, 'gaida');
  writeField(client, 'tapis_apgrutinajumi', constraints || noneFoundStatus().value, lookup, 'gaida');
  writeField(client, 'tapis_ipasie_noteikumi', special || noneFoundStatus().value, lookup, 'gaida');
}

function mapOpenLookups(
  client: Client,
  packs: {
    equity: LookupResult;
    liquidations: LookupResult;
    insolvency: LookupResult;
    sanctions: LookupResult;
    suspensions: LookupResult;
    securing: LookupResult;
    reorg: LookupResult;
    special: LookupResult;
    stockholders: LookupResult;
    financials: LookupResult;
    rating: LookupResult;
    tax: LookupResult;
    deminimis: LookupResult;
    varis: LookupResult;
    bis: LookupResult;
    heritage: LookupResult;
    occupants: LookupResult;
    tapis: LookupResult;
    ozols: LookupResult;
    flood: LookupResult;
    zemesgramata: LookupResult;
  },
): void {
  const paid = packs.equity.records.length ? pickPaidEquity(packs.equity.records) : undefined;
  if (packs.equity.error) {
    writeField(client, 'pamatkapitals', '', packs.equity, 'kluda', packs.equity.error);
  } else if (!paid) {
    writeField(client, 'pamatkapitals', noneFoundStatus().value, packs.equity, 'gaida');
  } else {
    const capital = joinFacts([
      asText(paid.equity_capital_type_text),
      formatMoney(paid.amount, asText(paid.currency) || 'EUR'),
      formatDate(paid.date_from),
    ]);
    writeField(client, 'pamatkapitals', capital, packs.equity, filledStatus(capital));
  }

  writeNoneOrList(client, 'likvidacija', packs.liquidations, (rows) =>
    joinFacts(
      rows.map((row) =>
        joinFacts([asText(row.liquidation_type_text), formatDate(row.date_from), asText(row.grounds_for_liquidation)]),
      ),
    ),
  );

  writeNoneOrList(client, 'maksatnespeja', packs.insolvency, (rows) =>
    joinFacts(
      rows.map((row) =>
        joinFacts([
          asText(row.proceeding_form) || asText(row.proceeding_type),
          asText(row.proceeding_resolution_name),
          formatDate(row.proceeding_started_on),
          formatDate(row.proceeding_ended_on),
        ]),
      ),
    ),
  );

  writeNoneOrList(client, 'sankcijas', packs.sanctions, (rows) =>
    joinFacts(
      rows.map((row) =>
        joinFacts([
          asText(row.list_text) || asText(row.list),
          asText(row.sanctions_subject_name) || asText(row.name),
          formatDate(row.registered_on),
        ]),
      ),
    ),
  );

  writeNoneOrList(client, 'darbibas_apturesana', packs.suspensions, (rows) =>
    joinFacts(
      rows.map((row) => joinFacts([asText(row.suspension_code_text), formatDate(row.date_from), asText(row.ground_for)])),
    ),
  );

  writeNoneOrList(client, 'nodrosinajuma_lidzekli', packs.securing, (rows) =>
    joinFacts(
      rows.map((row) =>
        joinFacts([
          asText(row.securing_measure_type_text),
          asText(row.type_details),
          asText(row.case_number),
          formatDate(row.date_from),
        ]),
      ),
    ),
  );

  writeNoneOrList(client, 'reorganizacija', packs.reorg, (rows) =>
    joinFacts(
      rows.map((row) =>
        joinFacts([
          asText(row.reorganization_type_text),
          formatDate(row.registered),
          asText(row.source_entity_regcode) ? `no ${asText(row.source_entity_regcode)}` : '',
        ]),
      ),
    ),
  );

  writeNoneOrList(client, 'nacionalas_nozimes_statuss', packs.special, (rows) =>
    joinFacts(rows.map((row) => `ir no ${formatDate(row.date_from)}`)),
  );

  const legalOwners = packs.stockholders.records.filter(isLegalShareholder);
  if (packs.stockholders.error) {
    writeField(client, 'dalibnieki_jp', '', packs.stockholders, 'kluda', packs.stockholders.error);
  } else if (!legalOwners.length) {
    writeField(client, 'dalibnieki_jp', noneFoundStatus().value, packs.stockholders, 'gaida');
  } else {
    const owners = joinFacts(
      legalOwners.map((row) =>
        joinFacts([
          asText(row.name),
          asText(row.legal_entity_registration_number),
          asText(row.votes) ? `${asText(row.votes)} balsis` : '',
        ]),
      ),
    );
    writeField(client, 'dalibnieki_jp', owners, packs.stockholders, filledStatus(owners));
  }

  const naturalOwners = packs.stockholders.records.filter(isNaturalShareholder);
  if (packs.stockholders.error) {
    writeField(client, 'dalibnieki_fp_skaits', '', packs.stockholders, 'kluda', packs.stockholders.error);
  } else if (!naturalOwners.length) {
    writeField(client, 'dalibnieki_fp_skaits', noneFoundStatus().value, packs.stockholders, 'gaida');
  } else {
    writeField(
      client,
      'dalibnieki_fp_skaits',
      `${naturalOwners.length} (identitāte nav atvērtajos datos)`,
      packs.stockholders,
      'gaida',
    );
  }

  const latest = packs.financials.records.length ? latestFinancial(packs.financials.records) : undefined;
  if (packs.financials.error) {
    writeField(client, 'darbinieku_skaits', '', packs.financials, 'kluda', packs.financials.error);
    writeField(client, 'finansu_gads', '', packs.financials, 'kluda', packs.financials.error);
    writeField(client, 'finansu_apgrozijums', '', packs.financials, 'kluda', packs.financials.error);
  } else if (!latest) {
    writeField(client, 'darbinieku_skaits', noneFoundStatus().value, packs.financials, 'gaida');
    writeField(client, 'finansu_gads', noneFoundStatus().value, packs.financials, 'gaida');
    writeField(client, 'finansu_apgrozijums', noneFoundStatus().value, packs.financials, 'gaida');
  } else {
    const employees = asText(latest.employees);
    const year = asText(latest.year);
    writeField(client, 'darbinieku_skaits', employees, packs.financials, filledStatus(employees));
    writeField(client, 'finansu_gads', year, packs.financials, filledStatus(year));
    const turnover = pickTurnover(latest);
    writeField(
      client,
      'finansu_apgrozijums',
      turnover ? formatMoney(turnover, 'EUR') : noneFoundStatus().value,
      packs.financials,
      turnover ? 'gaida' : 'gaida',
    );
  }

  if (packs.rating.error) {
    writeField(client, 'vid_reitings', '', packs.rating, 'kluda', packs.rating.error);
    writeField(client, 'vid_reitinga_skaidrojums', '', packs.rating, 'kluda', packs.rating.error);
  } else if (!packs.rating.record) {
    writeField(client, 'vid_reitings', '', packs.rating, 'nav_datu');
    writeField(client, 'vid_reitinga_skaidrojums', '', packs.rating, 'nav_datu');
  } else {
    const rating = asText(packs.rating.record.Reitings);
    const note = asText(packs.rating.record.Skaidrojums);
    writeField(client, 'vid_reitings', rating, packs.rating, filledStatus(rating));
    writeField(client, 'vid_reitinga_skaidrojums', note, packs.rating, filledStatus(note));
  }

  if (packs.tax.error) {
    writeField(client, 'samaksatie_nodokli', '', packs.tax, 'kluda', packs.tax.error);
  } else if (!packs.tax.record) {
    writeField(client, 'samaksatie_nodokli', '', packs.tax, 'nav_datu');
  } else {
    const tax = joinFacts([
      asText(packs.tax.record.Taksacijas_gads_ceturksnis),
      asText(packs.tax.record.Samaksato_VID_administreto_nodoklu_kopsumma_tukst_EUR)
        ? `${asText(packs.tax.record.Samaksato_VID_administreto_nodoklu_kopsumma_tukst_EUR)} tūkst. EUR`
        : '',
    ]);
    writeField(client, 'samaksatie_nodokli', tax, packs.tax, filledStatus(tax));
  }

  if (packs.deminimis.error) {
    writeField(client, 'de_minimis_skaits', '', packs.deminimis, 'kluda', packs.deminimis.error);
    writeField(client, 'de_minimis_summa', '', packs.deminimis, 'kluda', packs.deminimis.error);
    writeField(client, 'de_minimis_programmas', '', packs.deminimis, 'kluda', packs.deminimis.error);
  } else {
    const rows = packs.deminimis.records;
    const count = String(rows.length);
    const total = rows.reduce((sum, row) => sum + (Number(row.assigned_amount) || 0), 0);
    const programs = [...new Set(rows.map((row) => asText(row.program_title)).filter(Boolean))];
    writeField(client, 'de_minimis_skaits', count, packs.deminimis, 'gaida');
    writeField(client, 'de_minimis_summa', formatMoney(total, 'EUR'), packs.deminimis, 'gaida');
    writeField(
      client,
      'de_minimis_programmas',
      programs.length ? joinFacts(programs) : noneFoundStatus().value,
      packs.deminimis,
      'gaida',
    );
  }

  if (packs.varis.error) {
    writeField(client, 'adrese_oficiala', '', packs.varis, 'kluda', packs.varis.error);
    writeField(client, 'koordinates', '', packs.varis, 'kluda', packs.varis.error);
  } else if (!packs.varis.record) {
    writeField(client, 'adrese_oficiala', '', packs.varis, 'nav_datu');
    writeField(client, 'koordinates', '', packs.varis, 'nav_datu');
  } else {
    const official = asText(packs.varis.record.STD);
    const lat = asText(packs.varis.record.DD_N);
    const lon = asText(packs.varis.record.DD_E);
    const coords = lat && lon ? `${lat}, ${lon}` : '';
    writeField(client, 'adrese_oficiala', official, packs.varis, filledStatus(official));
    writeField(client, 'koordinates', coords, packs.varis, filledStatus(coords));
  }

  mapAddressOccupants(client, packs.occupants);

  if (packs.bis.error) {
    writeField(client, 'bis_objektu_skaits', '', packs.bis, 'kluda', packs.bis.error);
    writeField(client, 'bis_kadastrs', '', packs.bis, 'kluda', packs.bis.error);
    writeField(client, 'bis_buves', '', packs.bis, 'kluda', packs.bis.error);
  } else {
    const rows = packs.bis.records;
    writeField(client, 'bis_objektu_skaits', String(rows.length), packs.bis, 'gaida');
    const cadastre = [...new Set(rows.map((row) => asText(row.Buves_kadastra_apzimejums)).filter(Boolean))];
    const names = [...new Set(rows.map((row) => asText(row.Buves_nosaukums)).filter(Boolean))];
    writeField(
      client,
      'bis_kadastrs',
      cadastre.length ? joinFacts(cadastre) : noneFoundStatus().value,
      packs.bis,
      'gaida',
    );
    writeField(
      client,
      'bis_buves',
      names.length ? joinFacts(names) : noneFoundStatus().value,
      packs.bis,
      'gaida',
    );
  }

  writeNoneOrList(client, 'kulturas_piemineklis', packs.heritage, (rows) =>
    joinFacts(
      rows.map((row) =>
        joinFacts([
          asText(row.Objekta_Nr),
          asText(row.Nosaukums),
          asText(row.Atrasanas_vieta),
          asText(row.Kadastra_apzimejums),
        ]),
      ),
    ),
  );

  mapTapisFields(client, packs.tapis);

  if (!packs.ozols.requestUrl) {
    writeField(client, 'ozols_iadt', '', packs.ozols, 'nav_datu');
    writeField(client, 'ozols_mikroliegums', '', packs.ozols, 'nav_datu');
    writeField(client, 'ozols_biotops', '', packs.ozols, 'nav_datu');
  } else {
    writeOzolsFact(client, 'ozols_iadt', packs.ozols, 'iadt', 'iadt_error');
    writeOzolsFact(client, 'ozols_mikroliegums', packs.ozols, 'mikroliegums', 'micro_error');
    writeOzolsFact(client, 'ozols_biotops', packs.ozols, 'biotops', 'habitat_error');
  }

  if (packs.flood.error) {
    writeField(client, 'pludu_nnprt', '', packs.flood, 'kluda', packs.flood.error);
    writeField(client, 'pludu_apdraudetas_ekas', '', packs.flood, 'kluda', packs.flood.error);
  } else if (!packs.flood.requestUrl) {
    writeField(client, 'pludu_nnprt', '', packs.flood, 'nav_datu');
    writeField(client, 'pludu_apdraudetas_ekas', '', packs.flood, 'nav_datu');
  } else if (!packs.flood.record) {
    writeField(client, 'pludu_nnprt', noneFoundStatus().value, packs.flood, 'gaida');
    writeField(client, 'pludu_apdraudetas_ekas', noneFoundStatus().value, packs.flood, 'gaida');
  } else {
    const territory = asText(packs.flood.record.nnprt);
    const houses = asText(packs.flood.record.ekas);
    writeField(
      client,
      'pludu_nnprt',
      territory
        ? `${territory} — nacionālas nozīmes plūdu riska teritorija, ne ēkas applūšanas dziļums`
        : noneFoundStatus().value,
      packs.flood,
      'gaida',
    );
    writeField(
      client,
      'pludu_apdraudetas_ekas',
      houses || noneFoundStatus().value,
      packs.flood,
      'gaida',
    );
  }

  const zgCodes = asText(packs.zemesgramata.record?.kadastrs);
  if (zgCodes) {
    writeField(
      client,
      'zemesgramata',
      `īpašnieks nav atvērtā API; kadastrs ${zgCodes} — pārbaudīt zemesgrāmatā`,
      packs.zemesgramata,
      'gaida',
    );
  } else {
    writeField(
      client,
      'zemesgramata',
      'īpašnieks nav atvērtā API; nav kadastra no BIS — meklēt pēc adreses zemesgrāmatā',
      packs.zemesgramata,
      'gaida',
    );
  }

  writeGated(
    client,
    'amatpersonas',
    'nav atvērtā API — vajag UR/VDAA piekļuvi (SOAP / API pārvaldnieks)',
    packs.stockholders,
  );
  writeGated(
    client,
    'plg',
    'nav atvērtā API — PLG paliek ārpus CC0 dumpiem',
    packs.stockholders,
  );
  writeGated(
    client,
    'vid_paradi',
    'nav atvērtā API — VID parādu forma nav DataStore',
    packs.tax,
  );
}

async function runInBatches<T>(jobs: Array<() => Promise<T>>, size = 4): Promise<T[]> {
  const output: T[] = [];
  for (let index = 0; index < jobs.length; index += size) {
    const slice = jobs.slice(index, index + size);
    const batch = await Promise.all(slice.map((job) => job()));
    output.push(...batch);
    await sleep(90);
  }
  return output;
}

function writeGated(client: Client, fieldKey: FieldKey, value: string, lookup: LookupResult): void {
  writeField(client, fieldKey, value, lookup, 'nav_datu', 'prototips pirms līguma — nav mašīnlasāma atvērtā API');
}

function coordsFromProject(client: Client): GeoPoint | null {
  const lat = Number(String(client.project_lat || '').replace(',', '.'));
  const lon = Number(String(client.project_lon || '').replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (lat < 55.5 || lat > 58.2 || lon < 20.8 || lon > 28.5) {
    return null;
  }
  return { lat, lon };
}

function placeFromUr(client: Client, record: Record<string, unknown> | null): PlaceContext {
  if (!record) {
    const empty = emptyPlaceContext(client.regcode);
    empty.cadastre = asText(client.project_cadastre);
    empty.projectAddress = asText(client.project_address);
    return empty;
  }
  return {
    regcode: client.regcode,
    address: asText(record.address),
    addressId: asText(record.addressid),
    city: asText(record.city),
    cadastre: asText(client.project_cadastre),
    projectAddress: asText(client.project_address),
  };
}

export async function collectForClient(
  clientId: string,
  force = false,
  onlyKeys?: FieldKey[],
): Promise<Fact[]> {
  const gate = onlyKeys?.length ? new Set(onlyKeys) : null;
  return writeGate.run(gate, () => runCollectForClient(clientId, force));
}

async function runCollectForClient(clientId: string, force: boolean): Promise<Fact[]> {
  return evaluateClient(clientId, force);
}

export async function runCollectLegacy(clientId: string, force: boolean): Promise<Fact[]> {
  const client = getClient(clientId);
  if (!client) {
    throw new Error('Klients nav atrasts.');
  }

  logEvent('collect_start', { clientId: client.id, regcode: client.regcode, force });

  const ur = await urAdapter.lookup(client.regcode, { force });
  await sleep(80);
  const vid = await vidAdapter.lookup(client.regcode, { force });

  mapUrFields(client, ur);
  const vidName = mapVidFields(client, vid);
  applyNameConflict(client, asText(ur.record?.name), vidName);

  const place = placeFromUr(client, ur.record);
  const [
    equity,
    liquidations,
    insolvency,
    sanctions,
    suspensions,
    securing,
    reorg,
    special,
    stockholders,
    financials,
    rating,
    tax,
    deminimis,
    varis,
    bis,
    heritage,
    occupants,
  ] = await runInBatches([
    () => lookupEquity(client.regcode, force),
    () => lookupLiquidations(client.regcode, force),
    () => lookupInsolvency(client.regcode, force),
    () => lookupSanctions(client.regcode, force),
    () => lookupSuspensions(client.regcode, force),
    () => lookupSecuring(client.regcode, force),
    () => lookupReorg(client.regcode, force),
    () => lookupSpecialStatus(client.regcode, force),
    () => lookupStockholders(client.regcode, force),
    () => lookupFinancials(client.regcode, force),
    () => lookupRating(client.regcode, force),
    () => lookupTax(client.regcode, force),
    () => lookupDeminimis(client.regcode, force),
    () => lookupVaris(place, force),
    () => lookupBis(place, force),
    () => lookupHeritage(place, force),
    () => lookupAddressOccupants(place.addressId, force),
  ]);

  const projectPoint = coordsFromProject(client);
  const varisPoint = coordsFromVaris(varis.record);
  const point = projectPoint ?? varisPoint;
  const geoSource = projectPoint
    ? 'projekta vieta (koordinātas)'
    : varisPoint
      ? 'juridiskā adrese (VARIS)'
      : 'nav punkta';
  const [ozols, flood, tapis] = await Promise.all([
    lookupOzols(point, force),
    lookupFlood(point, force),
    lookupTapis(point, force, asText(client.project_cadastre)),
  ]);
  const cadastre = [
    asText(client.project_cadastre),
    ...bis.records.map((row) => asText(row.Buves_kadastra_apzimejums)),
  ].filter(Boolean);
  const uniqueCadastre = [...new Set(cadastre)];
  const zemesgramata = zemesgramataLookup(uniqueCadastre, bis.fetchedAt || varis.fetchedAt);

  mapOpenLookups(client, {
    equity,
    liquidations,
    insolvency,
    sanctions,
    suspensions,
    securing,
    reorg,
    special,
    stockholders,
    financials,
    rating,
    tax,
    deminimis,
    varis,
    bis,
    heritage,
    occupants,
    tapis,
    ozols,
    flood,
    zemesgramata,
  });

  writeField(
    client,
    'geo_punkts_avots',
    client.project_cadastre || client.project_address || projectPoint
      ? `${geoSource}${client.project_cadastre ? ` · kadastrs ${client.project_cadastre}` : ''}${
          projectPoint ? ` · ${projectPoint.lat}, ${projectPoint.lon}` : ''
        }`
      : geoSource,
    varis,
    'gaida',
  );

  logEvent('collect_done', {
    clientId: client.id,
    regcode: client.regcode,
    urCache: ur.fromCache,
    vidCache: vid.fromCache,
    extraCache: [
      equity,
      liquidations,
      insolvency,
      sanctions,
      suspensions,
      securing,
      reorg,
      special,
      stockholders,
      financials,
      rating,
      tax,
      deminimis,
      varis,
      bis,
      heritage,
      occupants,
      tapis,
      ozols,
      flood,
    ].filter((item) => item.fromCache).length,
    urError: ur.error ?? null,
    vidError: vid.error ?? null,
  });

  return listFacts().filter((fact) => fact.client_id === client.id);
}

export async function collectAll(
  force = false,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<void> {
  const clients = listClients().filter((client) => client.project_cadastre);
  let done = 0;
  onProgress?.(0, clients.length, clients[0]?.name || '—');
  for (const client of clients) {
    onProgress?.(done, clients.length, client.name);
    await collectForClient(client.id, force);
    done += 1;
    onProgress?.(done, clients.length, client.name);
    await sleep(120);
  }
}

export function computeKpis(facts: Fact[], clientCount: number): Kpis {
  const totalFields = clientCount * FIELD_SPECS.length;
  const filledFields = facts.filter((fact) => (fact.corrected_value || fact.value) && fact.status !== 'kluda').length;
  const withSource = facts.filter((fact) => fact.source_url).length;
  const pendingReviews = facts.filter((fact) => fact.status === 'gaida' || fact.status === 'konflikts').length;
  const confirmed = facts.filter((fact) => fact.status === 'apstiprinats' || fact.status === 'labots').length;
  const conflicts = facts.filter((fact) => fact.status === 'konflikts').length;
  const errors = facts.filter((fact) => fact.status === 'kluda').length;

  return {
    totalFields,
    filledFields,
    autoFillPct: totalFields === 0 ? 0 : Math.round((filledFields / totalFields) * 100),
    traceablePct: facts.length === 0 ? 0 : Math.round((withSource / facts.length) * 100),
    pendingReviews,
    confirmed,
    conflicts,
    errors,
  };
}
