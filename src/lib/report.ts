import { showCadastre } from './cadastre';
import { APP_NAME } from '../brand';
import type { Fact, FieldSpec, Parcel, SourceId } from '../types';

/**
 * How the flat list of facts is grouped on screen.
 * Keys are the server's field keys (server/fields.ts).
 * `adreses_atbilstiba` is left out on purpose: it compares an
 * address someone typed in, and the map has no such input.
 */
export interface Section {
  id: string;
  title: string;
  keys: string[];
}

export const SECTIONS: Section[] = [
  {
    id: 'ipasums',
    title: 'Īpašums',
    keys: ['ipasuma_kadastra_nr', 'ipasuma_apzimejums', 'ipasuma_adrese', 'ipasuma_tiesibas', 'zemesgramata', 'buvju_konturas'],
  },
  {
    id: 'ierobezojumi',
    title: 'Ierobežojumi',
    keys: [
      'atis_apgrutinajumi',
      'pludi_10',
      'pludi_100',
      'pludi_200',
      'iadt',
      'ozols_mikroliegums',
      'ozols_biotops',
      'kulturas_piemineklis',
    ],
  },
  { id: 'planosana', title: 'Plānošana', keys: ['tapis_izmantosana', 'tapis_dokuments'] },
  { id: 'buvnieciba', title: 'Būvniecība', keys: ['buvniecibas_lieta'] },
  { id: 'es', title: 'ES finansējums', keys: ['es_projekti', 'cfla_atlases', 'ekii_atbalsts', 'liaa_atbalsts'] },
  { id: 'uznemumi', title: 'Uzņēmumi adresē', keys: ['uznemumi_adrese', 'vid_reitings', 'de_minimis', 'iepirkumi'] },
];

/** Every key the panel shows — the denominator of the progress bar. */
export const SHOWN_KEYS = SECTIONS.flatMap((section) => section.keys);

/** Short registry names for the meta line under each value. */
export const SOURCE_LABEL: Record<SourceId, string> = {
  ur: 'Uzņēmumu reģistrs',
  vid: 'VID',
  fm: 'Finanšu ministrija',
  bis: 'BIS',
  varis: 'VARIS',
  nkmp: 'NKMP',
  ozols: 'Ozols · DAP',
  lvgmc: 'LVĢMC',
  zg: 'Zemesgrāmata',
  tapis: 'TAPIS',
  kadastrs: 'VZD Kadastrs',
  es: 'ES fondi',
  eis: 'EIS',
  atis: 'VZD ATIS',
  cfla: 'CFLA',
  liaa: 'LIAA',
  ekii: 'LVIF / EKII',
};

export function formatStamp(value: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('lv-LV', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** “tikko” / “kešs ~5 h” — shows whether the row came off the wire or the day cache. */
export function cacheAge(fetchedAt: string): string {
  if (!fetchedAt) {
    return '';
  }
  const age = Date.now() - Date.parse(fetchedAt);
  if (Number.isNaN(age) || age < 0) {
    return '';
  }
  const minutes = Math.round(age / 60_000);
  if (minutes < 2) {
    return 'tikko iegūts';
  }
  if (minutes < 90) {
    return `kešs ~${minutes} min`;
  }
  return `kešs ~${Math.round(age / 3_600_000)} h`;
}

export function formatArea(areaM2: number | null): string {
  if (areaM2 == null) {
    return '';
  }
  if (areaM2 >= 10_000) {
    return `${(areaM2 / 10_000).toLocaleString('lv-LV', { maximumFractionDigits: 2 })} ha`;
  }
  return `${Math.round(areaM2).toLocaleString('lv-LV')} m²`;
}

export function shownValue(fact?: Fact): string {
  return (fact?.corrected_value || fact?.value || '').trim();
}

/**
 * Plain-data export of one report. Same facts the panel shows,
 * each with the machine query and the human proof page.
 */
export function buildExport(parcel: Parcel, facts: Fact[], fields: FieldSpec[], applicant: string) {
  const byKey = new Map(facts.map((fact) => [fact.field_key, fact]));
  return {
    app: APP_NAME,
    generated: new Date().toISOString(),
    cadastre: parcel.cadastre,
    areaM2: parcel.areaM2,
    point: parcel.point,
    applicantRegcode: applicant || null,
    parcelRequest: parcel.requestUrl,
    facts: SHOWN_KEYS.map((key) => {
      const fact = byKey.get(key);
      const spec = fields.find((field) => field.key === key);
      return {
        field: key,
        label: spec?.label ?? key,
        value: shownValue(fact),
        status: fact?.status ?? 'nav_iegūts',
        note: fact?.conflict_note || '',
        source: fact?.source_id ? SOURCE_LABEL[fact.source_id] : '',
        fetchedAt: fact?.fetched_at || '',
        query: fact?.source_url || '',
        proof: fact?.proof_url || '',
      };
    }),
  };
}

export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export { showCadastre };
