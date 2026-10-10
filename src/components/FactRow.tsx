import { useState } from 'react';
import { emptyKind, isAdverseFact } from '../lib/facts';
import { avotsHref, ckanHref, type ProofSite } from '../lib/proof';
import { cacheAge, formatStamp, shownValue, SOURCE_LABEL } from '../lib/report';
import type { Fact, FieldSpec } from '../types';
import { ExternalIcon } from './icons';

interface Props {
  spec: FieldSpec;
  fact?: Fact;
  /** True while the report job is still collecting; an empty row is then a skeleton. */
  running: boolean;
  site: ProofSite;
  /** When set, list entries that lead with a 14-digit building code become buttons. */
  onCode?: (code: string) => void;
  /** The code whose card is open, so its entry reads as selected. */
  activeCode?: string;
  /**
   * Hide on screen (empty / chip filter) but keep in the DOM so
   * print CSS can still show the full report.
   */
  filteredOut?: boolean;
}

/* A building designation at the very start of a list entry. */
const LEADING_CODE = /^(\d{14})(?!\d)/;

/* Restrictions where a "Jā" is the bad news, beside floods and ĪADT. */
const FLAG_ON_YES = new Set(['ozols_mikroliegums', 'ozols_biotops', 'kulturas_piemineklis']);

/**
 * “Jā — …” / “Nē” lead the value as a pill. A flood or nature hit
 * is flagged; “Nē” is the quiet green. Not a score: just a colour
 * on a yes/no the register itself gave.
 */
function splitVerdict(
  key: string,
  value: string,
): { pill: string; rest: string; tone: 'bad' | 'ok' | 'neutral' } | null {
  /*
   * No \b here: JS treats ā / ē as non-word characters, so
   * "Jā —" would never find a boundary after the "ā".
   */
  const match = value.match(/^(Jā|Nē|Neatbilst|Atbilst)(?=[\s—-]|$)\s*[—-]?\s*/i);
  if (!match) {
    return null;
  }
  const pill = match[1];
  const yes = /^jā/i.test(pill);
  const flagged =
    pill.toLowerCase() === 'neatbilst' ||
    (yes && (key.startsWith('pludi_') || key === 'iadt' || FLAG_ON_YES.has(key)));
  const clear = /^nē/i.test(pill) || /^atbilst/i.test(pill);
  return { pill, rest: value.slice(match[0].length), tone: flagged ? 'bad' : clear ? 'ok' : 'neutral' };
}

/**
 * Long answers arrive as a list. Atlas / LIAA cards are grouped
 * with a blank line so who / financing stay on the same item.
 * One-line lists (buildings, EU projects) still split on `\n`;
 * the rest on “ · ”.
 */
function items(text: string): string[] {
  const splitter = text.includes('\n\n') ? /\n\n+/ : text.includes('\n') ? '\n' : ' · ';
  return text
    .split(splitter)
    .map((part) => part.trim())
    .filter(Boolean);
}

const URL_SPLIT = /(https?:\/\/[^\s<>]+)/g;

function hrefOf(raw: string): string {
  return raw.replace(/[.,;:)\]\>]+$/g, '');
}

function linkLabel(href: string): string {
  if (/cfla\.gov\.lv/i.test(href)) {
    return 'Atvērt CFLA lapu';
  }
  if (/liaa|business\.gov\.lv/i.test(href)) {
    return 'Atvērt LIAA lapu';
  }
  return 'Atvērt';
}

/** Turn a trailing official URL into a verb, keep the rest as pre-line text. */
function LinkedValue({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT);
  if (parts.length === 1) {
    return <>{text}</>;
  }
  return (
    <>
      {parts.map((part, index) => {
        if (!/^https?:\/\//.test(part)) {
          return <span key={`${index}-${part.slice(0, 12)}`}>{part}</span>;
        }
        const href = hrefOf(part);
        return (
          <a key={href} href={href} target="_blank" rel="noreferrer" className="value-link">
            {linkLabel(href)}
          </a>
        );
      })}
    </>
  );
}

/**
 * Catalogue cards: keep every Atbilst visible, then fold the rest.
 * foldAfter is a count of visible items (not an exclusive end index).
 */
function foldAt(key: string, list: string[]): number {
  if (key === 'cfla_atlases' || key === 'liaa_atbalsts' || key === 'ekii_atbalsts') {
    const hits = list.filter((entry) => /^Atbilst\b/i.test(entry)).length;
    return Math.max(hits, 3);
  }
  return 5;
}

/** Hits first so a single match is never buried under non-matches. */
function orderCatalogue(list: string[]): string[] {
  const hits = list.filter((entry) => /^Atbilst\b/i.test(entry));
  const rest = list.filter((entry) => !/^Atbilst\b/i.test(entry));
  return [...hits, ...rest];
}

export function FactRow({ spec, fact, running, site, onCode, activeCode, filteredOut }: Props) {
  const [expanded, setExpanded] = useState(false);
  /* Shared class so print can un-hide without a wrapper that breaks .row + .row. */
  const filterClass = filteredOut ? ' row-filtered' : '';

  /* Nothing yet: skeleton while the job runs, a dash once it has finished. */
  if (!fact) {
    return (
      <div className={`row${running ? ' row-skeleton' : ''}${filterClass}`}>
        <div className="row-label">{spec.label}</div>
        {running ? <div className="shimmer" aria-label="Ielādē" /> : <div className="row-value muted">Nav iegūts</div>}
      </div>
    );
  }

  const raw = shownValue(fact);
  const kind = emptyKind(fact);
  const adverse = isAdverseFact(spec.key, fact);
  const catalogue = spec.key === 'cfla_atlases' || spec.key === 'liaa_atbalsts' || spec.key === 'ekii_atbalsts';
  /*
   * Do not strip a leading Atbilst from the whole catalogue string —
   * that ate the only match and flipped the chip to “Neviena neatbilst”.
   */
  const verdict = catalogue ? null : splitVerdict(spec.key, raw);
  const body = verdict ? verdict.rest : raw;
  const list = catalogue ? orderCatalogue(items(body)) : items(body);
  const foldAfter = foldAt(spec.key, list);
  /* Detect hits on the raw value before any display munging. */
  const autoHits = catalogue && /\bAtbilst\b/i.test(raw);
  const autoMiss = catalogue && kind === 'hit' && !autoHits && /^nē$/i.test(raw.trim());
  const avots = avotsHref(site, fact);
  const ckan = ckanHref(fact, avots);
  const age = cacheAge(fact.fetched_at);

  return (
    <div
      className={`row row-in${adverse ? ' row-adverse' : ''}${kind === 'kluda' ? ' row-error' : ''}${filterClass}`}
    >
      <div className="row-label">{spec.label}</div>

      <div className="row-value">
        {kind === 'kluda' ? (
          <span className="chip chip-warn">Avots neatbildēja</span>
        ) : kind === 'nav_datu' ? (
          <span className="muted">Nav datu</span>
        ) : (
          <>
            {autoHits ? (
              <span className="pill pill-ok">Automātiska atbilstība</span>
            ) : autoMiss ? (
              <span className="chip chip-quiet">Neviena neatbilst šim gabalam</span>
            ) : verdict ? (
              <span className={`pill pill-${verdict.tone}`}>{verdict.pill}</span>
            ) : null}
            {list.length > 1 ? (
              <ul className="value-list">
                {list.map((entry, index) => {
                  /* Building rows: the whole entry is the tap target, not just the digits. */
                  const code = onCode ? entry.match(LEADING_CODE)?.[1] : undefined;
                  return (
                    <li
                      key={`${index}-${entry.slice(0, 24)}`}
                      /* Folded entries stay in the DOM so a printout still carries every one. */
                      className={`${adverse ? 'adverse-text' : ''}${
                        !expanded && list.length > foldAfter && index >= foldAfter ? ' beyond' : ''
                      }${code ? ' code-entry' : ''}${code && code === activeCode ? ' on' : ''}`}
                    >
                      {code && onCode ? (
                        <button type="button" className="code-link" onClick={() => onCode(code)} title="Atvērt būves kartīti">
                          {entry}
                        </button>
                      ) : (
                        <LinkedValue text={entry} />
                      )}
                    </li>
                  );
                })}
                {!expanded && list.length > foldAfter ? (
                  <li className="fold">
                    <button type="button" onClick={() => setExpanded(true)}>
                      Rādīt vēl {list.length - foldAfter}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : (
              <span className={`value-block${adverse ? ' adverse-text' : ''}`}>
                {list[0] ? <LinkedValue text={list[0]} /> : verdict ? '' : '—'}
              </span>
            )}
          </>
        )}
      </div>

      {fact.conflict_note ? (
        <div className="row-note">
          <LinkedValue text={fact.conflict_note} />
        </div>
      ) : null}

      <div className="row-meta">
        <span>{SOURCE_LABEL[spec.sourceId] ?? spec.sourceId}</span>
        {fact.fetched_at ? <span>{formatStamp(fact.fetched_at)}</span> : null}
        {age ? <span>{age}</span> : null}
        {avots ? (
          <a href={avots} target="_blank" rel="noreferrer">
            Avots <ExternalIcon />
          </a>
        ) : null}
        {ckan ? (
          <a className="row-query" href={ckan} target="_blank" rel="noreferrer" title="Precīzais pieprasījums, kas atdeva šo rindu">
            Pieprasījums <ExternalIcon />
          </a>
        ) : null}
      </div>
    </div>
  );
}
