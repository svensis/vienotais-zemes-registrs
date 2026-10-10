import type { Fact, FieldKey } from '../types';

/**
 * Register events and site overlays that an officer should
 * notice — not a score, just visual weight on the card.
 */
const ADVERSE_IF_PRESENT: FieldKey[] = [
  'izslegsanas_datums',
  'likvidacija',
  'maksatnespeja',
  'sankcijas',
  'darbibas_apturesana',
  'nodrosinajuma_lidzekli',
  'reorganizacija',
  'kulturas_piemineklis',
  'ozols_iadt',
  'ozols_mikroliegums',
  'ozols_biotops',
  'pludu_nnprt',
  'pludu_apdraudetas_ekas',
];

function shownValue(fact?: Fact): string {
  return (fact?.corrected_value || fact?.value || '').trim();
}

function isEmptyMarker(value: string): boolean {
  return !value || value === '—' || value === 'nav' || /^nav\b/i.test(value);
}

/**
 * True when the live value is a real hit that is “bad news”
 * or the register itself says the company is gone / VAT dead.
 */
export function isAdverseFact(fieldKey: FieldKey, fact?: Fact): boolean {
  if (!fact) {
    return false;
  }
  if (fact.status === 'konflikts' || fact.status === 'kluda') {
    return fact.status === 'konflikts';
  }

  const value = shownValue(fact);
  if (fieldKey === 'registra_statuss') {
    return /izslēgt/i.test(value);
  }
  if (fieldKey === 'pvn_statuss') {
    return /nav aktīvs/i.test(value);
  }
  if (fieldKey === 'vid_reitings') {
    return /^[CDEF]/i.test(value) || /augsts risks|zems/i.test(value);
  }
  if (fieldKey === 'adreses_atbilstiba') {
    return /neatbilst/i.test(value);
  }
  if (fieldKey === 'pludi_10' || fieldKey === 'pludi_100' || fieldKey === 'pludi_200' || fieldKey === 'iadt' || fieldKey === 'de_minimis') {
    return /^jā/i.test(value);
  }
  /* The map panel writes these as "Jā — …" / "Nē", so a plain "Nē" is not news. */
  if (fieldKey === 'ozols_mikroliegums' || fieldKey === 'ozols_biotops' || fieldKey === 'kulturas_piemineklis') {
    return /^jā/i.test(value);
  }
  if (!ADVERSE_IF_PRESENT.includes(fieldKey)) {
    return false;
  }
  return !isEmptyMarker(value);
}

/**
 * Three empty states officers kept mixing up:
 * nav = we asked, nothing there
 * — / nav_datu = no feed / no join key
 * kļūda = the feed failed
 */
export function emptyKind(fact?: Fact): 'hit' | 'nav' | 'nav_datu' | 'kluda' | 'tukss' {
  if (!fact) {
    return 'tukss';
  }
  if (fact.status === 'kluda') {
    return 'kluda';
  }
  if (fact.status === 'nav_datu') {
    return 'nav_datu';
  }
  const value = shownValue(fact);
  if (value === 'nav' || value.toLowerCase() === 'nav') {
    return 'nav';
  }
  if (!value || value === '—') {
    return 'tukss';
  }
  return 'hit';
}

export function qualityLabel(fact?: Fact): string {
  switch (emptyKind(fact)) {
    case 'kluda':
      return 'Avots neatbildēja';
    case 'nav_datu':
      return 'Nav datu / nav sasaistes';
    case 'nav':
      return 'Vaicāts — trāpījuma nav';
    case 'tukss':
      return 'Vēl nav iegūts';
    default:
      return '';
  }
}

/**
 * Always keep the identity row and ownership — even when the
 * panel is set to “Tikai ar datiem” and the rest of a section
 * is empty noise.
 */
const ALWAYS_SHOW_KEYS = new Set<string>(['ipasuma_kadastra_nr', 'ipasuma_tiesibas']);

/**
 * True when a fact row is worth keeping under “Tikai ar datiem”.
 * Hides empty / “Nav datu” / plain “Nē” clears; keeps errors,
 * conflicts, skeletons while the job runs, and real hits.
 */
export function hasUsefulData(key: string, fact: Fact | undefined, running: boolean): boolean {
  if (ALWAYS_SHOW_KEYS.has(key)) {
    return true;
  }
  /* Still collecting — leave the shimmer so the panel does not jump. */
  if (!fact) {
    return running;
  }
  if (fact.status === 'kluda' || fact.status === 'konflikts') {
    return true;
  }
  const kind = emptyKind(fact);
  if (kind === 'tukss' || kind === 'nav' || kind === 'nav_datu') {
    return false;
  }
  const value = shownValue(fact);
  /* Quiet “Nē” on floods / nature / similar — not news. */
  if (/^nē(\s*[—-]?\s*)?$/i.test(value)) {
    return false;
  }
  return true;
}
