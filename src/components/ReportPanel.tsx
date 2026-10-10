import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { APP_NAME } from '../brand';
import { hasUsefulData } from '../lib/facts';
import { BuildingCard } from './BuildingCard';
import { FactRow } from './FactRow';
import {
  CloseIcon,
  CodeIcon,
  CollapseIcon,
  ExpandIcon,
  PrintIcon,
  RefreshIcon,
  ShareIcon,
} from './icons';
import type { ProofSite } from '../lib/proof';
import { formatArea, SECTIONS, SHOWN_KEYS, shownValue } from '../lib/report';
import type { BuildingOutline, Fact, FieldSpec, Parcel } from '../types';

type Detent = 'peek' | 'half' | 'full';

/** 'all' = every section; otherwise a SECTIONS[].id chip. */
type SectionFilter = 'all' | string;

interface Props {
  parcel: Parcel;
  facts: Fact[];
  fields: FieldSpec[];
  running: boolean;
  error: string;
  applicant: string;
  /** Footprints on this parcel, as lit on the map. */
  buildings: BuildingOutline[];
  /** The one whose card sits on top of the report, if any. */
  selectedBuilding: BuildingOutline | null;
  /** Select a building, or pass null to go back to the parcel alone. */
  onBuilding: (building: BuildingOutline | null) => void;
  onClose: () => void;
  onRefresh: () => void;
  onCompany: (regcode: string) => void;
  onShare: () => void;
  onPrint: () => void;
  onJson: () => void;
}

/**
 * The result panel. A floating glass card on the right for
 * desktop and tablet; a bottom sheet with three detents on a phone.
 * Rows are keyed by field, so a row that arrives mid-collect
 * simply replaces its skeleton in place.
 *
 * Desktop can widen the card; chips above the scroll filter
 * sections; “Tikai ar datiem” drops empty / Nē noise.
 */
export function ReportPanel(props: Props) {
  const { parcel, facts, fields, running, error, applicant } = props;
  const [detent, setDetent] = useState<Detent>('half');
  const [regcode, setRegcode] = useState('');
  /* Desktop only — CSS hides the control under 900px. */
  const [expanded, setExpanded] = useState(false);
  const [sectionFilter, setSectionFilter] = useState<SectionFilter>('all');
  /* Default on: long reports with eight “Nē” rows are the pain point. */
  const [onlyWithData, setOnlyWithData] = useState(true);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startTop: number; lastY: number; lastT: number; velocity: number } | null>(null);

  /* A new parcel always opens mid-sheet and resets filters to “everything”. */
  useEffect(() => {
    setDetent('half');
    setRegcode('');
    setSectionFilter('all');
  }, [parcel.cadastre]);

  /*
   * A building tap brings its card into view: scroll to the top
   * (that is where the card lives) and, on a phone, lift a peeking
   * sheet to the middle detent so the card is not hiding off-screen.
   */
  const selectedCode = props.selectedBuilding?.code ?? '';
  useEffect(() => {
    if (!selectedCode) {
      return;
    }
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setDetent((current) => (current === 'peek' ? 'half' : current));
  }, [selectedCode]);

  /* Codes in the "Būvju kontūras" row open the card, if that building is lit. */
  function openCode(code: string) {
    const found = props.buildings.find((building) => building.code === code);
    if (found) {
      props.onBuilding(found);
    }
  }

  const byKey = useMemo(() => new Map(facts.map((fact) => [fact.field_key, fact])), [facts]);
  const specByKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);

  /* Rows the panel actually shows, to turn "N of M" into a bar. */
  const have = SHOWN_KEYS.filter((key) => byKey.has(key)).length;
  /* Idle → 0 so the fade-out does not flash a full accent bar. */
  const progress = running ? Math.max(0.08, have / SHOWN_KEYS.length) : 0;

  /* First real address becomes the subtitle under the number. */
  const addressFact = byKey.get('ipasuma_adrese');
  const addressText = addressFact && addressFact.status !== 'nav_datu' ? shownValue(addressFact) : '';
  const address = /^nav\b/i.test(addressText) ? '' : addressText.split(' · ')[0];

  /* What the proof links need to know about this site. */
  const site: ProofSite = {
    regcode: parcel.cadastre,
    project_cadastre: parcel.cadastre,
    project_lat: parcel.point ? String(parcel.point.lat) : '',
    project_lon: parcel.point ? String(parcel.point.lon) : '',
    project_address: address,
  };

  /*
   * ---- bottom-sheet drag (phone only; CSS ignores the transform on desktop) ----
   * Pointer events on the grabber. While dragging, --drag moves the
   * sheet with no transition; on release the nearest detent wins,
   * nudged by fling velocity, and the CSS spring finishes the move.
   */
  function detentTop(next: Detent): number {
    const vh = window.innerHeight;
    const height = vh * 0.9;
    const offset = next === 'full' ? 0 : next === 'half' ? vh * 0.44 : height - 168;
    return vh - height + offset;
  }

  function onDown(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startY: event.clientY,
      startTop: panel.getBoundingClientRect().top,
      lastY: event.clientY,
      lastT: performance.now(),
      velocity: 0,
    };
    panel.classList.add('dragging');
  }

  function onMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || !panel) {
      return;
    }
    const now = performance.now();
    state.velocity = (event.clientY - state.lastY) / Math.max(1, now - state.lastT);
    state.lastY = event.clientY;
    state.lastT = now;

    /* Never drag above the full detent. */
    const minTop = detentTop('full');
    const top = Math.max(minTop, state.startTop + (event.clientY - state.startY));
    const base = detentTop(detent);
    panel.style.setProperty('--drag', `${top - base}px`);
  }

  function onUp() {
    const state = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!state || !panel) {
      return;
    }
    panel.classList.remove('dragging');

    const top = state.startTop + (state.lastY - state.startY) + state.velocity * 160;
    const options: Detent[] = ['peek', 'half', 'full'];
    const nearest = options.reduce((best, option) =>
      Math.abs(detentTop(option) - top) < Math.abs(detentTop(best) - top) ? option : best,
    );
    panel.style.removeProperty('--drag');
    setDetent(nearest);
  }

  function submitCompany(event: FormEvent) {
    event.preventDefault();
    const digits = regcode.replace(/\D/g, '');
    if (digits.length === 11) {
      props.onCompany(digits);
    }
  }

  const regDigits = regcode.replace(/\D/g, '');

  /*
   * Which keys survive “Tikai ar datiem”. Print CSS ignores the
   * filter chrome and forces every .block visible — so we still
   * render filtered-out sections with a print-only class path:
   * hidden sections keep `data-print="1"` and stay in the DOM.
   */
  function keysFor(sectionKeys: string[]): string[] {
    if (!onlyWithData) {
      return sectionKeys;
    }
    return sectionKeys.filter((key) => hasUsefulData(key, byKey.get(key), running));
  }

  return (
    <aside
      ref={panelRef}
      className={`panel${expanded ? ' is-wide' : ''}`}
      data-detent={detent}
      aria-label="Zemes vienības pārskats"
    >
      <div
        className="grabber"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => setDetent(detent === 'full' ? 'half' : 'full')}
        role="presentation"
      >
        <span />
      </div>

      <header className="panel-head">
        <div className="panel-title">
          <p className="print-only">
            {APP_NAME} · atvērtie valsts dati · {new Date().toLocaleString('lv-LV')}
          </p>
          <p className="eyebrow">Zemes vienība</p>
          <h2 className="cad">{parcel.cadastre}</h2>
          <p className="sub">
            {[formatArea(parcel.areaM2), address].filter(Boolean).join(' · ') || 'Kadastra dati'}
          </p>
        </div>
        <div className="panel-actions">
          {/* Desktop widen — phone already has full detent via the grabber. */}
          <button
            type="button"
            className="icon-btn panel-expand"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? 'Samazināt paneli' : 'Paplašināt paneli'}
            aria-label={expanded ? 'Samazināt paneli' : 'Paplašināt paneli'}
            aria-pressed={expanded}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
          </button>
          <button type="button" className="icon-btn" onClick={props.onShare} title="Kopēt saiti" aria-label="Kopēt saiti">
            <ShareIcon />
          </button>
          <button type="button" className="icon-btn" onClick={props.onPrint} title="Drukāt vienas lapas pārskatu" aria-label="Drukāt">
            <PrintIcon />
          </button>
          <button type="button" className="icon-btn" onClick={props.onJson} title="Lejupielādēt JSON" aria-label="Lejupielādēt JSON">
            <CodeIcon />
          </button>
          <button type="button" className="icon-btn" onClick={props.onClose} title="Aizvērt" aria-label="Aizvērt">
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className={`progress${running ? ' on' : ''}`} aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      {/*
       * Narrow-panel filters: a section <select> (no horizontal scroll)
       * and a visible switch for empty-row hiding. Print hides this rail.
       */}
      <div className="panel-filters" aria-label="Pārskata filtri">
        <label className="filter-field">
          <span className="filter-label">Sekcija</span>
          <select
            className="filter-select"
            value={sectionFilter}
            onChange={(event) => setSectionFilter(event.target.value)}
            aria-label="Rādīt sekciju"
          >
            <option value="all">Viss</option>
            {SECTIONS.map((section) => (
              <option key={section.id} value={section.id}>
                {section.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="filter-switch"
          role="switch"
          aria-checked={onlyWithData}
          onClick={() => setOnlyWithData((value) => !value)}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-copy">
            <span className="switch-title">Tikai ar datiem</span>
            <span className="switch-hint">Slēpj tukšās un „Nē” rindas</span>
          </span>
        </button>
      </div>

      <div className="panel-scroll" ref={scrollRef}>
        {error ? <p className="banner">{error}</p> : null}

        {/* Keyed by code so switching buildings replays the spring entrance. */}
        {props.selectedBuilding ? (
          <BuildingCard
            key={props.selectedBuilding.code}
            building={props.selectedBuilding}
            buildings={props.buildings}
            onSelect={props.onBuilding}
            onClose={() => props.onBuilding(null)}
          />
        ) : null}

        {SECTIONS.map((section) => {
          const visibleKeys = keysFor(section.keys);
          const chipMatch = sectionFilter === 'all' || sectionFilter === section.id;
          const showCompany = section.id === 'uznemumi';
          /*
           * Screen: hide by chip / empty. Print: every block stays
           * (print CSS un-hides .block.is-filtered).
           */
          const emptyOnScreen = visibleKeys.length === 0 && !showCompany;
          const hideOnScreen = !chipMatch || emptyOnScreen;

          return (
            <section
              key={section.id}
              className={`block${hideOnScreen ? ' is-filtered' : ''}`}
              data-section={section.id}
            >
              <h3>{section.title}</h3>
              <div className="rows">
                {/*
                 * Print path: always emit every key so paper is complete.
                 * Screen path: only the keys that passed the data filter.
                 */}
                {section.keys.map((key) => {
                  const spec = specByKey.get(key);
                  if (!spec) {
                    return null;
                  }
                  /*
                   * Chip filter hides a whole section via .block.is-filtered.
                   * Per-row filter only applies “Tikai ar datiem” inside a
                   * visible section — keeps .row siblings for hairlines.
                   */
                  const dataHidden = onlyWithData && !visibleKeys.includes(key);
                  return (
                    <FactRow
                      key={key}
                      spec={spec}
                      fact={byKey.get(key)}
                      running={running}
                      site={site}
                      filteredOut={dataHidden}
                      /* Only the buildings row has codes worth tapping, and only once they are lit. */
                      onCode={key === 'buvju_konturas' && props.buildings.length ? openCode : undefined}
                      activeCode={key === 'buvju_konturas' ? selectedCode : undefined}
                    />
                  );
                })}
              </div>

              {/* Company check lives with the rows it changes. */}
              {showCompany ? (
                <form className="company" onSubmit={submitCompany}>
                  <label htmlFor="company-reg">Ievadiet uzņēmuma reģistrācijas numuru</label>
                  <div className="company-row">
                    <input
                      id="company-reg"
                      inputMode="numeric"
                      placeholder="Reģistrācijas numurs (11 cipari)"
                      value={regcode}
                      onChange={(event) => setRegcode(event.target.value)}
                    />
                    <button type="submit" className="btn" disabled={regDigits.length !== 11 || running}>
                      Pārbaudīt
                    </button>
                  </div>
                  <p className="hint">
                    {applicant
                      ? `VID reitings, de minimis un iepirkumi tagad seko reģ. nr. ${applicant}.`
                      : 'VID reitings, de minimis un iepirkumi sekos šim numuram, nevis uzņēmumiem adresē.'}
                  </p>
                </form>
              ) : null}
            </section>
          );
        })}

        <footer className="panel-foot">
          <button type="button" className="btn btn-quiet" onClick={props.onRefresh} disabled={running}>
            <RefreshIcon /> Atjaunot no avotiem
          </button>
          <p>
            Tikai atvērtie valsts dati. Nav vērtējuma, nav personas datu. Katrai rindai ir avots, ko Jūs varat atvērt
            un pārbaudīt.
          </p>
        </footer>
      </div>
    </aside>
  );
}
