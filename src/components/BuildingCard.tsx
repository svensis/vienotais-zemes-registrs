import { useEffect, useState } from 'react';
import { fetchBuildingDetail } from '../api';
import { CloseIcon, ExternalIcon } from './icons';
import type { BuildingDetail, BuildingOutline } from '../types';

interface Props {
  building: BuildingOutline;
  /** Every footprint on the parcel, for the switcher chips. */
  buildings: BuildingOutline[];
  onSelect: (building: BuildingOutline) => void;
  onClose: () => void;
}

/*
 * ┌────────────────────────────────────────────────────────────┐
 * │ The building card. Two speeds on purpose:                  │
 * │  1. Stat tiles paint instantly from the WFS outline the    │
 * │     map already holds (year, floors, use…).                │
 * │  2. BIS + cadastre rows stream in from /api/building/:code │
 * │     behind a shimmer, so the card never sits empty.        │
 * └────────────────────────────────────────────────────────────┘
 */

/** "01000010023001" → "0100 001 0023 001": the way VZD prints a building designation. */
function spacedCode(code: string): string {
  return code.length === 14 ? `${code.slice(0, 4)} ${code.slice(4, 7)} ${code.slice(7, 11)} ${code.slice(11)}` : code;
}

/** "2015-08-17" → "17.08.2015", the Latvian way. */
function lvDate(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase('lv') + text.slice(1) : text;
}

/*
 * A block of flats links to one property per flat — 18 numbers is a
 * wall, not an answer. Lead with the land unit's own property, show
 * two more, then just count the rest.
 */
function propertyLine(detail: BuildingDetail, parcelNr: string): string {
  if (!detail.properties.length) {
    return '';
  }
  const sorted = [...detail.properties].sort((a, b) => Number(b === parcelNr) - Number(a === parcelNr));
  const shown = sorted.slice(0, 3).join(', ');
  const rest = sorted.length - 3;
  const tail = rest > 0 ? ` un vēl ${rest} (dzīvokļi vai telpu grupas)` : '';
  return `${shown}${tail}${detail.separate ? ' — atsevišķs no zemes' : ''}`;
}

export function BuildingCard({ building, buildings, onSelect, onClose }: Props) {
  const [detail, setDetail] = useState<BuildingDetail | null>(null);
  const [error, setError] = useState('');

  /*
   * One request per selected code. Switching chips aborts the old
   * one, so a slow BIS answer never paints over the newer building.
   */
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError('');
    fetchBuildingDetail(building.code, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) {
          setDetail(found);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Būves datus neizdevās ielādēt.');
        }
      });
    return () => controller.abort();
  }, [building.code]);

  /* ---------- instant tiles: only the ones VZD actually filled ---------- */
  const tiles: { label: string; value: string }[] = [
    { label: 'Būvēta', value: building.built },
    { label: 'Stāvi', value: building.floors != null ? String(building.floors) : '' },
    { label: 'Dzīvokļi', value: building.dwellings != null ? String(building.dwellings) : '' },
    { label: 'Telpu grupas', value: building.units != null ? String(building.units) : '' },
    { label: 'Lietošana', value: capitalise(building.use ?? '') },
    { label: 'Stāvoklis', value: capitalise(building.condition ?? '') },
  ].filter((tile) => tile.value);

  /* ---------- streamed rows: label + value, empty ones dropped ---------- */
  const loading = !detail && !error;
  const caseLine = detail?.bis?.caseNr
    ? [
        detail.bis.caseNr,
        detail.case?.stage,
        detail.case?.authority,
        detail.case?.created ? `izveidota ${lvDate(detail.case.created)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const rows: { label: string; value: string; tone?: 'warn' }[] = detail
    ? [
        { label: 'Adrese', value: detail.address || detail.bis?.address || '' },
        { label: 'Tiesiskais statuss', value: detail.statuses.map(capitalise).join(' · ') },
        {
          label: detail.properties.length > 1 ? 'Īpašumi' : 'Īpašums',
          value: propertyLine(detail, building.code.slice(0, 11)),
          tone: detail.separate ? ('warn' as const) : undefined,
        },
        { label: 'Būvniecības lieta', value: caseLine },
        { label: 'Būvniecības veids', value: detail.bis?.kind ?? '' },
        { label: 'Apgrūtinājumi', value: detail.encumbrances.join('\n') },
      ].filter((row) => row.value)
    : [];

  return (
    <section className="building-card" aria-label={`Būve ${building.code}`}>
      {/* ---------- header: same rhythm as the parcel header above ---------- */}
      <header className="bcard-head">
        <div className="panel-title">
          <p className="eyebrow eyebrow-orange">Būve</p>
          <h3 className="bcard-code">{spacedCode(building.code)}</h3>
          <p className="sub">{building.name || 'Nosaukums nav norādīts'}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="Atpakaļ uz zemes vienību" aria-label="Aizvērt būvi">
          <CloseIcon />
        </button>
      </header>

      {/* ---------- stat tiles, like a Health summary ---------- */}
      {tiles.length ? (
        <div className="bstats">
          {tiles.map((tile) => (
            <div key={tile.label} className="bstat">
              {/* Numbers stay big; words (use, condition) wrap smaller instead of clipping. */}
              <span className={`bstat-value${/^\d+$/.test(tile.value) ? '' : ' bstat-word'}`}>{tile.value}</span>
              <span className="bstat-label">{tile.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ---------- registers: shimmer first, then the real rows ---------- */}
      <div className="rows">
        {loading
          ? ['Adrese', 'Tiesiskais statuss', 'Būvniecības lieta'].map((label) => (
              <div key={label} className="row row-skeleton">
                <div className="row-label">{label}</div>
                <div className="shimmer" aria-label="Ielādē" />
              </div>
            ))
          : null}

        {error ? (
          <div className="row">
            <span className="chip chip-warn">Avots neatbildēja</span>
            <div className="row-note">{error}</div>
          </div>
        ) : null}

        {rows.map((row) => (
          <div key={row.label} className="row row-in">
            <div className="row-label">{row.label}</div>
            <div className={`row-value${row.tone === 'warn' ? ' bcard-warn' : ''}`}>
              <span className="value-block">{row.value}</span>
            </div>
          </div>
        ))}

        {/* Honest empty state: nothing found is still an answer. */}
        {detail && !rows.length ? (
          <div className="row row-in">
            <div className="row-value muted">BIS un kadastra dumpā par šo būvi vairāk nekā nav.</div>
          </div>
        ) : null}

        {detail && !detail.index ? (
          <div className="row">
            <div className="row-note">Kadastra dumps vēl nav indeksēts — statuss un apgrūtinājumi parādīsies pēc tam.</div>
          </div>
        ) : null}

        {/* Where every line came from, same meta strip as the report rows. */}
        {detail?.sources.length ? (
          <div className="row">
            <div className="row-meta">
              <span>Kadastrs · INSPIRE{building.recorded ? ` · ${lvDate(building.recorded)}` : ''}</span>
              {detail.sources
                .filter((source) => source.proof || source.requestUrl)
                .map((source) => (
                  <a key={source.label} href={source.requestUrl || source.proof} target="_blank" rel="noreferrer">
                    {source.label} <ExternalIcon />
                  </a>
                ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* ---------- switcher: every footprint on the parcel, no map aiming ---------- */}
      {buildings.length > 1 ? (
        <div className="bchips" role="tablist" aria-label="Būves uz zemes vienības">
          {buildings.map((item) => (
            <button
              key={item.code}
              type="button"
              role="tab"
              aria-selected={item.code === building.code}
              className={`bchip${item.code === building.code ? ' on' : ''}`}
              onClick={() => onSelect(item)}
              title={item.name}
            >
              <span>{item.code.slice(11)}</span>
              {item.name ? <em>{item.name}</em> : null}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
