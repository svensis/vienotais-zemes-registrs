import { lookupAtisCode, lookupBuildingsByCadastre, lookupCasesByNumber } from '../adapters/eval.ts';
import { addressesFor, cadastreReady, encumbrancesFor, linksFor, ownersFor } from '../cadastreDb.ts';
import { readCache, writeCache } from '../db.ts';
import { cadastreDigits } from '../fields.ts';
import { labelStatus } from './evaluate.ts';

/*
 * ┌────────────────────────────────────────────────────────────┐
 * │ One building, by its 14-digit designation.                 │
 * │                                                            │
 * │ The map already knows the footprint facts (use, floors,    │
 * │ year…) from the WFS. This fills in what only the other     │
 * │ registers know: the BIS building row and its case, plus    │
 * │ the local cadastre dump's legal status, address and        │
 * │ encumbrances for this exact object — never the parcel's.   │
 * └────────────────────────────────────────────────────────────┘
 */

const KAD_PROOF = 'https://data.gov.lv/dati/lv/dataset/kadastra-informacijas-sistemas-atvertie-dati';
const ATIS_PROOF = 'https://data.gov.lv/dati/lv/dataset/atis-datu-un-kadastra-objektu-apgrutinajumu-klasifikators';

/* A day is plenty: BIS and the cadastre dump both move weekly at best. */
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;

export interface BuildingDetail {
  code: string;
  /** BIS "Būves" row, when BIS knows this building. */
  bis: { name: string; address: string; caseNr: string; kind: string } | null;
  /** The BIS case that row points to. */
  case: { stage: string; authority: string; created: string } | null;
  /** Legal status lines — status and person type only, never a name. */
  statuses: string[];
  /** Property number(s) the building is registered under. */
  properties: string[];
  /** True when that property is not the land unit's own — building and land are owned apart. */
  separate: boolean;
  address: string;
  encumbrances: string[];
  /** False while the cadastre dump is not indexed; the card says so instead of "none". */
  index: boolean;
  sources: { label: string; requestUrl: string; proof: string }[];
  fetchedAt: string;
  error?: string;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

export async function lookupBuildingDetail(rawCode: string, force?: boolean): Promise<BuildingDetail> {
  const code = cadastreDigits(rawCode);
  const cacheKey = `building:v2:${code}`;
  if (!force) {
    const cached = readCache(cacheKey, DETAIL_TTL_MS);
    if (cached) {
      return JSON.parse(cached.payload) as BuildingDetail;
    }
  }

  /* ---------- BIS: the building row, then its construction case ---------- */
  const bisLookup = await lookupBuildingsByCadastre(code, force);
  const row = bisLookup.records.find((record) => cadastreDigits(text(record.Buves_kadastra_apzimejums)) === code) ?? null;
  const caseNr = text(row?.Buvniecibas_lietas_numurs);
  const caseLookup = caseNr ? await lookupCasesByNumber([caseNr], force) : null;
  const caseRow = caseLookup?.record ?? null;

  /* ---------- local cadastre dump: this object only ---------- */
  const index = cadastreReady();

  /*
   * Rights hang off the property number, not always off the building.
   * linksFor maps building → property; when that property differs
   * from the land unit's own, the building is a separate property
   * (common in Soviet-era blocks and on leased municipal land).
   */
  const propertyOf = (nr: string) =>
    [...new Set(linksFor(nr).filter((link) => cadastreDigits(link.object_nr) === nr).map((link) => cadastreDigits(link.property_nr)))];
  const properties = index ? propertyOf(code) : [];
  const landProperties = index ? propertyOf(code.slice(0, 11)) : [];
  const separate = properties.length > 0 && !properties.some((nr) => landProperties.includes(nr));

  const statuses = index
    ? [
        ...new Set(
          ownersFor([code, ...properties]).map((owner) => labelStatus(owner.status, owner.person).toLocaleLowerCase('lv')),
        ),
      ]
    : [];
  const address = index ? (addressesFor([code])[0]?.text ?? '') : '';

  /* The dump sometimes stores only the code; the classifier names it. */
  const encumbrances: string[] = [];
  for (const item of index ? encumbrancesFor([code]) : []) {
    const name = item.name || (item.code ? await lookupAtisCode(item.code, force) : '');
    encumbrances.push([item.code, name].filter(Boolean).join(' — '));
  }

  const sources: BuildingDetail['sources'] = [
    { label: 'BIS būves', requestUrl: bisLookup.requestUrl, proof: bisLookup.proofUrl },
  ];
  if (caseLookup) {
    sources.push({ label: 'BIS lieta', requestUrl: caseLookup.requestUrl, proof: caseLookup.proofUrl });
  }
  if (index) {
    sources.push({ label: 'Kadastra atvērtie dati', requestUrl: '', proof: KAD_PROOF });
  }
  if (encumbrances.length) {
    sources.push({ label: 'ATIS klasifikators', requestUrl: '', proof: ATIS_PROOF });
  }

  const fetchedAt = new Date().toISOString();
  const detail: BuildingDetail = {
    code,
    bis: row
      ? {
          name: text(row.Buves_nosaukums),
          address: text(row.Buves_objekta_adreses_teksts),
          caseNr,
          kind: text(row.Buvniecibas_veids),
        }
      : null,
    case: caseRow
      ? {
          stage: text(caseRow.Aktuala_stadija),
          authority: text(caseRow.Atbildigas_iestades_nosaukums),
          created: text(caseRow.Lietas_izveidosanas_datums).slice(0, 10),
        }
      : null,
    statuses,
    properties,
    separate,
    address,
    encumbrances: [...new Set(encumbrances)],
    index,
    sources,
    fetchedAt,
    error: bisLookup.error,
  };

  /* A BIS hiccup is not cached, so the next click tries again. */
  if (!bisLookup.error) {
    writeCache(cacheKey, JSON.stringify(detail), fetchedAt);
  }
  return detail;
}
