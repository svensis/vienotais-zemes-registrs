import type { Basemap, FloodYears, LayerMode } from '../types';

const MODES: { id: LayerMode; label: string; title: string }[] = [
  { id: 'vieta', label: 'Vieta', title: 'OpenStreetMap' },
  { id: 'kadastrs', label: 'Kadastrs', title: 'VZD zemes vienību robežas' },
  { id: 'pludi', label: 'Plūdi', title: 'LVĢMC plūdu riska un draudu kartes' },
  { id: 'zonejums', label: 'Zonējums', title: 'TAPIS funkcionālais zonējums' },
  { id: 'daba', label: 'Daba', title: 'Ozols — ĪADT, mikroliegumi, biotopi' },
];

const BASEMAPS: { id: Basemap; label: string; title: string }[] = [
  { id: 'karte', label: 'Karte', title: 'Ielu karte · OpenStreetMap' },
  { id: 'satelits', label: 'Satelīts', title: 'Satelīta ortofoto · Esri' },
];

interface Props {
  mode: LayerMode;
  flood: FloodYears;
  basemap: Basemap;
  onMode: (mode: LayerMode) => void;
  onFlood: (years: FloodYears) => void;
  onBasemap: (basemap: Basemap) => void;
}

/**
 * Layer + basemap pickers. Overlay modes stay mutually exclusive;
 * Karte / Satelīts swaps the tiles underneath every overlay.
 */
export function LayerSwitch({ mode, flood, basemap, onMode, onFlood, onBasemap }: Props) {
  const index = Math.max(0, MODES.findIndex((item) => item.id === mode));
  const floodIndex = ['10', '100', '200'].indexOf(flood);
  const baseIndex = Math.max(0, BASEMAPS.findIndex((item) => item.id === basemap));

  return (
    <>
      {/* Overlay modes stay top-left, next to search. */}
      <div className="layers">
        <div className="segmented glass" role="group" aria-label="Kartes slānis" style={{ ['--i' as string]: index, ['--n' as string]: MODES.length }}>
          <span className="thumb" aria-hidden="true" />
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.title}
              aria-pressed={mode === item.id}
              onClick={() => onMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {mode === 'pludi' ? (
          <div
            className="segmented segmented-sub glass pop"
            role="group"
            aria-label="Plūdu scenārijs"
            style={{ ['--i' as string]: floodIndex, ['--n' as string]: 3 }}
          >
            <span className="thumb" aria-hidden="true" />
            {(['10', '100', '200'] as const).map((years) => (
              <button key={years} type="button" aria-pressed={flood === years} onClick={() => onFlood(years)}>
                reizi {years} g.
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Basemap lives bottom-left — out of the layer strip, above attribution. */}
      <div className="basemap-switch">
        <div
          className="segmented segmented-sub glass"
          role="group"
          aria-label="Fona skats"
          style={{ ['--i' as string]: baseIndex, ['--n' as string]: BASEMAPS.length }}
        >
          <span className="thumb" aria-hidden="true" />
          {BASEMAPS.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.title}
              aria-pressed={basemap === item.id}
              onClick={() => onBasemap(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
