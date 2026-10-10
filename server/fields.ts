import type { FieldGroupId, FieldKey, FieldSpec } from './types.ts';

/*
 * The live card is only the evaluation checklist.
 * Every row is filled from a cadastre number.
 */
export const FIELD_GROUPS: { id: FieldGroupId; label: string }[] = [
  { id: 'ipasums', label: 'Īpašums' },
  { id: 'teritorija', label: 'Teritorija' },
  { id: 'lietas', label: 'Būvniecība un projekti' },
  { id: 'iesniedzejs', label: 'Iesniedzējs' },
  { id: 'atbilstiba', label: 'Atbilstība' },
];

/** What the cadastre search card actually renders. */
export const FIELD_SPECS: FieldSpec[] = [
  { key: 'ipasuma_kadastra_nr', label: 'Kadastra numurs', sourceId: 'kadastrs', group: 'ipasums' },
  { key: 'ipasuma_apzimejums', label: 'Kadastra apzīmējums', sourceId: 'kadastrs', group: 'ipasums' },
  { key: 'ipasuma_adrese', label: 'Adrese', sourceId: 'kadastrs', group: 'ipasums' },
  { key: 'ipasuma_tiesibas', label: 'Īpašuma tiesības', sourceId: 'kadastrs', group: 'ipasums' },
  /* Folio link only: the open cadastre has no owner name, the Land Book does. */
  { key: 'zemesgramata', label: 'Zemesgrāmata', sourceId: 'zg', group: 'ipasums' },
  /* Same footprints the map lights up orange. */
  { key: 'buvju_konturas', label: 'Būves uz zemes vienības', sourceId: 'kadastrs', group: 'ipasums' },

  { key: 'atis_apgrutinajumi', label: 'Apgrūtinājumi (ATIS klasifikators)', sourceId: 'atis', group: 'teritorija' },
  { key: 'tapis_izmantosana', label: 'Teritorijas izmantošana', sourceId: 'tapis', group: 'teritorija' },
  { key: 'tapis_dokuments', label: 'Teritorijas plānošanas dokuments', sourceId: 'tapis', group: 'teritorija' },
  { key: 'pludi_10', label: 'Applūstoša teritorija, reizi 10 gados', sourceId: 'lvgmc', group: 'teritorija' },
  { key: 'pludi_100', label: 'Applūstoša teritorija, reizi 100 gados', sourceId: 'lvgmc', group: 'teritorija' },
  { key: 'pludi_200', label: 'Applūstoša teritorija, reizi 200 gados', sourceId: 'lvgmc', group: 'teritorija' },
  { key: 'iadt', label: 'Īpaši aizsargājama dabas teritorija', sourceId: 'ozols', group: 'teritorija' },
  { key: 'ozols_mikroliegums', label: 'Mikroliegums', sourceId: 'ozols', group: 'teritorija' },
  { key: 'ozols_biotops', label: 'Aizsargājams biotops', sourceId: 'ozols', group: 'teritorija' },
  { key: 'kulturas_piemineklis', label: 'Kultūras piemineklis', sourceId: 'nkmp', group: 'teritorija' },

  { key: 'buvniecibas_lieta', label: 'Būvniecības lieta', sourceId: 'bis', group: 'lietas' },
  /* Places from CFLA open data, joined to the project list for name/status/amount. */
  { key: 'es_projekti', label: 'ES projekti šajā kadastrā', sourceId: 'es', group: 'lietas' },
  /* Official 2021–2027 HTML table. Ranked, never filtered as “you qualify”. */
  { key: 'cfla_atlases', label: 'CFLA atvērtās atlases', sourceId: 'cfla', group: 'lietas' },
  /* LVIF/EKII open household AER — ekii.lv HTML, not the stale CKAN XLSX. */
  { key: 'ekii_atbalsts', label: 'EKII mājsaimniecību AER', sourceId: 'ekii', group: 'lietas' },
  /* LIAA catalogue on data.gov.lv — person, not parcel. */
  { key: 'liaa_atbalsts', label: 'LIAA atbalsts uzņēmumam', sourceId: 'liaa', group: 'iesniedzejs' },

  { key: 'uznemumi_adrese', label: 'Uzņēmumi un struktūrvienības adresē', sourceId: 'ur', group: 'iesniedzejs' },
  { key: 'vid_reitings', label: 'VID reitings', sourceId: 'vid', group: 'iesniedzejs' },
  { key: 'de_minimis', label: 'De minimis atbalsts', sourceId: 'fm', group: 'iesniedzejs' },
  { key: 'iepirkumi', label: 'Publiskais iepirkums', sourceId: 'eis', group: 'iesniedzejs' },

  { key: 'adreses_atbilstiba', label: 'Adrese un kadastrs', sourceId: 'kadastrs', group: 'atbilstiba' },
];

export function cadastreDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Parcel is 11 digits; a building designation keeps the extra suffix. */
export function isCadastre(value: string): boolean {
  const digits = cadastreDigits(value);
  return digits.length >= 11 && digits.length <= 17;
}

export function formatCadastre(value: string): string {
  /* One run of digits. The grouped form 0900 031 0017 is not shown. */
  return cadastreDigits(value);
}

/** Kept so the previous register mapper still compiles. */
export const UR_REGISTER_KEYS: FieldKey[] = [
  'nosaukums',
  'registracijas_numurs',
  'juridiska_forma',
  'juridiska_adrese',
  'registracijas_datums',
  'registra_statuss',
  'izslegsanas_datums',
  'pasta_indekss',
  'sepa',
  'adreses_kods',
];

export const VID_VAT_KEYS: FieldKey[] = [
  'pvn_numurs',
  'pvn_statuss',
  'pvn_registracijas_datums',
];

export const SELECTION_ID = 'atlase-poc-2026';

export const SEED_CLIENTS: { regcode: string; name: string }[] = [];

export function isRegcode(value: string): boolean {
  return /^\d{11}$/.test(value.trim());
}
