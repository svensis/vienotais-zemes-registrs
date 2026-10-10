/**
 * Shared domain types for the local PoC.
 *
 * Status values come from the original review workflow:
 * facts are collected, then a person confirms or corrects them.
 * Nothing here is a decision or a risk score.
 */
export type FactStatus =
  | 'gaida'
  | 'apstiprinats'
  | 'labots'
  | 'konflikts'
  | 'nav_datu'
  | 'kluda';

/**
 * One row in the source matrix / fact trail.
 * Extra UR dumps stay under `ur` so the officer still
 * sees the register as the owner, not a random CKAN id.
 */
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

export type FieldGroupId =
  | 'ur'
  | 'ur_notikumi'
  | 'vid'
  | 'fm'
  | 'vieta'
  | 'pieeja'
  | 'ipasums'
  | 'teritorija'
  | 'lietas'
  | 'iesniedzejs'
  | 'atbilstiba';

export type FieldKey =
  | 'nosaukums'
  | 'registracijas_numurs'
  | 'juridiska_forma'
  | 'juridiska_adrese'
  | 'registracijas_datums'
  | 'registra_statuss'
  | 'izslegsanas_datums'
  | 'pasta_indekss'
  | 'sepa'
  | 'adreses_kods'
  | 'pamatkapitals'
  | 'likvidacija'
  | 'maksatnespeja'
  | 'sankcijas'
  | 'darbibas_apturesana'
  | 'nodrosinajuma_lidzekli'
  | 'reorganizacija'
  | 'nacionalas_nozimes_statuss'
  | 'dalibnieki_jp'
  | 'darbinieku_skaits'
  | 'finansu_gads'
  | 'pvn_numurs'
  | 'pvn_statuss'
  | 'pvn_registracijas_datums'
  | 'vid_reitings'
  | 'vid_reitinga_skaidrojums'
  | 'samaksatie_nodokli'
  | 'de_minimis_skaits'
  | 'de_minimis_summa'
  | 'de_minimis_programmas'
  | 'adrese_oficiala'
  | 'koordinates'
  | 'bis_objektu_skaits'
  | 'bis_kadastrs'
  | 'bis_buves'
  | 'kulturas_piemineklis'
  | 'ozols_iadt'
  | 'ozols_mikroliegums'
  | 'ozols_biotops'
  | 'adrese_citi_komersanti'
  | 'adrese_filiales'
  | 'adrese_saimnieciska_pazime'
  | 'tapis_zonejums'
  | 'tapis_apgrutinajumi'
  | 'tapis_ipasie_noteikumi'
  | 'pludu_nnprt'
  | 'pludu_apdraudetas_ekas'
  | 'zemesgramata'
  | 'geo_punkts_avots'
  | 'dalibnieki_fp_skaits'
  | 'finansu_apgrozijums'
  | 'amatpersonas'
  | 'plg'
  | 'vid_paradi'
  | 'ipasuma_adrese'
  | 'ipasuma_kadastra_nr'
  | 'ipasuma_apzimejums'
  | 'ipasuma_tiesibas'
  | 'atis_apgrutinajumi'
  | 'tapis_izmantosana'
  | 'tapis_dokuments'
  | 'pludi_10'
  | 'pludi_100'
  | 'pludi_200'
  | 'iadt'
  | 'buvniecibas_lieta'
  | 'es_projekti'
  | 'cfla_atlases'
  | 'ekii_atbalsts'
  | 'liaa_atbalsts'
  | 'de_minimis'
  | 'uznemumi_adrese'
  | 'iepirkumi'
  | 'adreses_atbilstiba'
  /* Building footprints on the land unit (VZD INSPIRE "Ēkas"). */
  | 'buvju_konturas';

export interface FieldSpec {
  key: FieldKey;
  label: string;
  sourceId: SourceId;
  group: FieldGroupId;
}

export interface Selection {
  id: string;
  title: string;
  created_at: string;
}

export interface Client {
  id: string;
  selection_id: string;
  name: string;
  regcode: string;
  created_at: string;
  /** Officer-entered project site — geo lookups prefer this over UR. */
  project_cadastre: string;
  project_lat: string;
  project_lon: string;
  project_address: string;
  /** UR registration number of the applicant, when the officer typed one. */
  applicant_regcode: string;
  /** UR name, if we have it. The card title stays the cadastre number. */
  applicant_name: string;
}

export interface Fact {
  id: string;
  client_id: string;
  field_key: FieldKey;
  value: string;
  source_id: SourceId | '';
  source_url: string;
  proof_url: string;
  fetched_at: string;
  status: FactStatus;
  corrected_value: string;
  reviewed_at: string;
  reviewer: string;
  conflict_note: string;
  previous_value: string;
}

export interface AuditEvent {
  id: string;
  type: string;
  payload: string;
  created_at: string;
}

export interface Kpis {
  totalFields: number;
  filledFields: number;
  autoFillPct: number;
  traceablePct: number;
  pendingReviews: number;
  confirmed: number;
  conflicts: number;
  errors: number;
}

export interface SourceHealth {
  resource_id: string;
  last_modified: string;
  checked_at: string;
  ok: number;
  note: string;
}

export interface Snapshot {
  selection: Selection;
  clients: Client[];
  facts: Fact[];
  kpis: Kpis;
  fields: FieldSpec[];
  groups: { id: FieldGroupId; label: string }[];
  sourceHealth: SourceHealth[];
}
