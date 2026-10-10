import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchFields,
  fetchParcelAt,
  fetchParcelByNumber,
  pollReport,
  startReport,
} from './api';
import { APP_TAGLINE } from './brand';
import { LayerSwitch } from './components/LayerSwitch';
import { LocateIcon } from './components/icons';
import { MapView, MOSAIC_MIN_ZOOM, type FocusRequest, type MosaicState } from './components/MapView';
import { ReportPanel } from './components/ReportPanel';
import { SearchBar } from './components/SearchBar';
import { SourcesSheet } from './components/SourcesSheet';
import { buildExport, downloadJson } from './lib/report';
import type {
  Basemap,
  BuildingOutline,
  Fact,
  FieldSpec,
  FloodYears,
  GeocodeHit,
  LayerMode,
  Parcel,
} from './types';

/* ---------- deep links: #/?cad=01000010002&l=pludi&y=100&b=sat ---------- */

const MODES: LayerMode[] = ['vieta', 'pludi', 'zonejums', 'daba', 'kadastrs'];

function readHash(): { cad: string; mode: LayerMode; flood: FloodYears; basemap: Basemap } {
  const query = new URLSearchParams(window.location.hash.replace(/^#\/?\??/, ''));
  const mode = query.get('l') as LayerMode;
  const flood = query.get('y') as FloodYears;
  const basemap = query.get('b') === 'sat' ? 'satelits' : 'karte';
  return {
    cad: (query.get('cad') ?? '').replace(/\D/g, ''),
    mode: MODES.includes(mode) ? mode : 'vieta',
    flood: flood === '10' || flood === '200' ? flood : '100',
    basemap,
  };
}

/** replaceState, not location.hash: no history spam and no hashchange echo. */
function writeHash(cad: string, mode: LayerMode, flood: FloodYears, basemap: Basemap): void {
  const query = new URLSearchParams();
  if (cad) {
    query.set('cad', cad);
  }
  if (mode !== 'vieta') {
    query.set('l', mode);
  }
  if (mode === 'pludi' && flood !== '100') {
    query.set('y', flood);
  }
  if (basemap === 'satelits') {
    query.set('b', 'sat');
  }
  const next = query.toString() ? `#/?${query.toString()}` : '#/';
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next);
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Wide screens get a right-hand card; narrow ones a bottom sheet. */
function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return wide;
}

const CAPTION: Partial<Record<LayerMode, string>> = {
  zonejums: 'Funkcionālais zonējums · TAPIS',
  daba: 'Īpaši aizsargājamās dabas teritorijas · Ozols',
};

export function App() {
  const initial = useMemo(readHash, []);
  const wide = useIsWide();

  const [fields, setFields] = useState<FieldSpec[]>([]);
  const [mode, setMode] = useState<LayerMode>(initial.mode);
  const [flood, setFlood] = useState<FloodYears>(initial.flood);
  const [basemap, setBasemap] = useState<Basemap>(initial.basemap);

  const [parcel, setParcel] = useState<Parcel | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [running, setRunning] = useState(false);
  const [reportError, setReportError] = useState('');
  const [applicant, setApplicant] = useState('');

  const [pending, setPending] = useState<{ lat: number; lon: number } | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [mosaic, setMosaic] = useState<MosaicState>('off');
  const [sheetOpen, setSheetOpen] = useState(false);

  /*
   * Buildings on the open parcel. The list comes from MapView (it
   * already fetched the footprints to light them); the selection is
   * whichever footprint, chip or panel code was tapped last.
   */
  const [buildings, setBuildings] = useState<BuildingOutline[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<BuildingOutline | null>(null);
  const [toast, setToast] = useToastState();
  const [searchNote, setSearchNote] = useState('');

  /*
   * Every click, search and deep link bumps `run`. A response from an
   * older run is dropped, so rapid clicking never paints the wrong parcel.
   */
  const run = useRef(0);
  const focusId = useRef(0);

  useEffect(() => {
    fetchFields()
      .then(setFields)
      .catch(() =>
        setReportError(
          'Lauku sarakstu neizdevās ielādēt — serveris, visticamāk, nereaģē. Pārlādējiet lapu vai pārbaudiet, vai API darbojas.',
        ),
      );
  }, []);

  /* ---------- the report: queue it, then poll until the job is done ---------- */
  const openParcel = useCallback(
    async (next: Parcel, opts: { fit: boolean; applicant?: string; force?: boolean }) => {
      const mine = ++run.current;
      const person = opts.applicant ?? '';

      setParcel(next);
      /* A new report (or a refresh) starts on the parcel, not on an old building. */
      setSelectedBuilding((current) => (current && current.code.startsWith(next.cadastre) ? current : null));
      setPending(null);
      setSearchNote('');
      setFacts([]);
      setReportError('');
      setApplicant(person);
      setRunning(true);
      if (opts.fit) {
        setFocus({ id: ++focusId.current, parcel: next });
      }

      try {
        const started = await startReport({ cadastre: next.cadastre, applicant: person, force: opts.force });
        if (mine !== run.current) {
          return;
        }
        setFacts(started.facts);

        /* Up to ~4 minutes; most parcels finish in a few seconds. */
        let failures = 0;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          await sleep(attempt < 4 ? 500 : 800);
          if (mine !== run.current) {
            return;
          }
          try {
            const tick = await pollReport(started.jobId);
            failures = 0;
            if (mine !== run.current) {
              return;
            }
            setFacts(tick.facts);
            if (tick.job?.status === 'error') {
              throw new Error(tick.job.error || 'Pārskatu neizdevās savākt.');
            }
            if (tick.job?.status === 'done') {
              break;
            }
          } catch (error) {
            /* One dropped poll is not a failed report. */
            failures += 1;
            if (failures >= 3 || (error instanceof Error && /Pārskatu/.test(error.message))) {
              throw error;
            }
          }
        }
      } catch (error) {
        if (mine === run.current) {
          setReportError(
            error instanceof Error
              ? error.message
              : 'Pārskatu neizdevās savākt. Mēģiniet vēlreiz ar pogu «Atjaunot no avotiem».',
          );
        }
      } finally {
        if (mine === run.current) {
          setRunning(false);
        }
      }
    },
    [],
  );

  /* ---------- a click on the map ---------- */
  const handlePick = useCallback(
    async (lat: number, lon: number) => {
      const mine = ++run.current;
      setPending({ lat, lon });
      setSearchNote('');
      try {
        const found = await fetchParcelAt(lat, lon);
        if (mine !== run.current) {
          return;
        }
        if (!found) {
          setPending(null);
          setToast('Šeit nav zemes vienības. Klikšķiniet citā vietā kartē vai meklējiet pēc numura.');
          return;
        }
        await openParcel(found, { fit: false });
      } catch (error) {
        if (mine === run.current) {
          setPending(null);
          setToast(
            error instanceof Error
              ? error.message
              : 'Zemes vienību neizdevās atrast. Mēģiniet citu vietu vai ievadiet kadastra numuru.',
          );
        }
      }
    },
    [openParcel, setToast],
  );

  /* ---------- search by number, by address, deep link ---------- */
  const openNumber = useCallback(
    async (cadastre: string, opts: { silent?: boolean } = {}) => {
      const mine = ++run.current;
      try {
        const found = await fetchParcelByNumber(cadastre);
        if (mine !== run.current) {
          return;
        }
        if (!found) {
          setSearchNote(
            `Zemes vienība ${cadastre.slice(0, 11)} nav atrasta kadastra datos. Pārbaudiet ciparus vai meklējiet pēc adreses.`,
          );
          return;
        }
        await openParcel(found, { fit: true });
      } catch (error) {
        if (mine === run.current && !opts.silent) {
          setSearchNote(
            error instanceof Error
              ? error.message
              : 'Meklēšana neizdevās. Pārbaudiet savienojumu un mēģiniet vēlreiz.',
          );
        }
      }
    },
    [openParcel],
  );

  const openAddress = useCallback(
    async (hit: GeocodeHit) => {
      /* Fly there first so the map is already moving while the parcel loads. */
      setFocus({ id: ++focusId.current, center: [hit.lat, hit.lon], zoom: 18 });
      await handlePick(hit.lat, hit.lon);
    },
    [handlePick],
  );

  /* Deep link on first load, and again if the user pastes another link. */
  useEffect(() => {
    if (initial.cad.length >= 11) {
      void openNumber(initial.cad);
    }
    const onHash = () => {
      const next = readHash();
      setMode(next.mode);
      setFlood(next.flood);
      setBasemap(next.basemap);
      if (next.cad.length >= 11 && next.cad.slice(0, 11) !== parcel?.cadastre) {
        void openNumber(next.cad);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // The first-load link runs once; later hash edits are handled by onHash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Keep the address bar a shareable link. */
  useEffect(() => {
    writeHash(parcel?.cadastre ?? '', mode, flood, basemap);
  }, [parcel, mode, flood, basemap]);

  function closePanel() {
    run.current += 1;
    setParcel(null);
    setSelectedBuilding(null);
    setFacts([]);
    setRunning(false);
    setReportError('');
    setApplicant('');
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast('Saite nokopēta starpliktuvē.');
    } catch {
      setToast('Starpliktuve nav pieejama. Kopējiet adresi no pārlūka joslas — tā jau ir pareiza.');
    }
  }

  function locate() {
    if (!navigator.geolocation) {
      setToast('Šajā pārlūkā atrašanās vietas noteikšana nav pieejama. Meklējiet adresi laukā augšā.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.dispatchEvent(
          new CustomEvent('zk:locate', { detail: { lat: position.coords.latitude, lon: position.coords.longitude } }),
        );
      },
      () =>
        setToast(
          'Atrašanās vietu neizdevās noteikt. Atļaujiet atrašanās vietu pārlūkā vai meklējiet adresi.',
        ),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  /* Pixels the floating UI covers, so the camera keeps the parcel in the clear. */
  const inset = useMemo(
    () => ({
      top: wide ? 0 : 128,
      left: 0,
      right: parcel && wide ? 456 : 0,
      bottom: parcel && !wide ? Math.round(window.innerHeight * 0.46) : 0,
    }),
    [parcel, wide],
  );

  const caption =
    mode === 'pludi'
      ? `Plūdu risks · reizi ${flood} gados · LVĢMC`
      : mode === 'kadastrs'
        ? mosaic === 'zoom'
          ? `Pietuvini kartei līdz ${MOSAIC_MIN_ZOOM}. mērogam, lai redzētu zemes vienību robežas`
          : mosaic === 'wide'
            ? 'Pietuvini kartei, lai redzētu zemes vienību robežas'
            : mosaic === 'loading'
              ? 'Ielādē zemes vienību robežas…'
              : mosaic === 'partial'
                ? 'Te ir biezs. Pietuvini, lai redzētu visas robežas'
                : 'Zemes vienību robežas · VZD'
        : CAPTION[mode];

  return (
    <div className="app">
      <MapView
        mode={mode}
        flood={flood}
        basemap={basemap}
        parcel={parcel}
        pending={pending}
        focus={focus}
        inset={inset}
        onPick={handlePick}
        onMosaic={setMosaic}
        selectedBuilding={selectedBuilding?.code ?? null}
        onBuilding={setSelectedBuilding}
        onBuildings={setBuildings}
      />

      <SearchBar
        onNumber={(cadastre) => void openNumber(cadastre)}
        onAddress={(hit) => void openAddress(hit)}
        onInfo={() => setSheetOpen(true)}
        note={searchNote}
      />

      <LayerSwitch
        mode={mode}
        flood={flood}
        basemap={basemap}
        onMode={setMode}
        onFlood={setFlood}
        onBasemap={setBasemap}
      />

      {/* Quiet hint until the first click. */}
      {!parcel && !pending ? (
        <div className="hint-pill glass" aria-live="polite">
          <span className="pulse-dot" />
          {APP_TAGLINE}
        </div>
      ) : null}

      {caption && !(parcel && !wide) ? <div className="caption glass">{caption}</div> : null}

      <button
        type="button"
        className={`fab glass${parcel && wide ? ' fab-shift' : ''}${parcel && !wide ? ' fab-hidden' : ''}`}
        onClick={locate}
        aria-label="Mana atrašanās vieta"
        title="Mana atrašanās vieta"
      >
        <LocateIcon />
      </button>

      {parcel ? (
        <ReportPanel
          parcel={parcel}
          facts={facts}
          fields={fields}
          running={running}
          error={reportError}
          applicant={applicant}
          buildings={buildings}
          selectedBuilding={selectedBuilding}
          onBuilding={setSelectedBuilding}
          onClose={closePanel}
          onRefresh={() => void openParcel(parcel, { fit: false, applicant, force: true })}
          onCompany={(regcode) => void openParcel(parcel, { fit: false, applicant: regcode })}
          onShare={() => void share()}
          onPrint={() => window.print()}
          onJson={() =>
            downloadJson(`vienotais-zemes-registrs-${parcel.cadastre}.json`, buildExport(parcel, facts, fields, applicant))
          }
        />
      ) : null}

      {toast ? (
        <div className="toast glass" role="status">
          {toast}
        </div>
      ) : null}

      {sheetOpen ? <SourcesSheet onClose={() => setSheetOpen(false)} /> : null}
    </div>
  );
}

/**
 * A single self-clearing message. Setting it again restarts the
 * timer, so a burst of failed clicks does not stack up toasts.
 */
function useToastState(): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const timer = useRef(0);
  const show = useCallback((next: string) => {
    window.clearTimeout(timer.current);
    setMessage(next);
    timer.current = window.setTimeout(() => setMessage(''), 3200);
  }, []);
  return [message, show];
}
