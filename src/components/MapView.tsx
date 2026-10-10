import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { API_ROOT, fetchParcelBuildings, fetchParcelsInBox } from '../api';
import type { Basemap, BuildingOutline, FloodYears, LayerMode, Parcel, ParcelOutline } from '../types';

/* Street vs satellite tiles. Esri World Imagery is free to display with attribution. */
const BASE_TILES: Record<
  Basemap,
  { url: string; attribution: string; maxNativeZoom: number }
> = {
  karte: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
    maxNativeZoom: 19,
  },
  satelits: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
  },
};

/*
 * LVĢMC flood map, drawn as two stacked layers per scenario
 * (served via /api/tiles/lvgmc — the server whitelists these ids):
 *
 *   river   — "Apdraudēto iedzīvotāju skaits" polygons. The river
 *             10 / 100 / 200 groups have no depth raster; these
 *             polygons are the modelled extent (shaded by people).
 *   coastal — "Ūdens dziļums" raster, the blue water itself. The
 *             server reads the same ids (geo.ts COASTAL_DEPTH), so
 *             the map and the panel row cannot disagree.
 *
 * Asking for the whole groups (2,54 / 16,68 / 30,82) also pulled in
 * roads, hatching, symbols and red cultural-heritage polygons, which
 * painted over the depth raster — at street zoom a flooded parcel
 * looked dry, and the red read as "flood" when it was heritage.
 */
const FLOOD_LAYERS: Record<FloodYears, { river: string; coastal: string }> = {
  '10': { river: '14', coastal: '67' },
  '100': { river: '28', coastal: '81' },
  '200': { river: '42', coastal: '95' },
};

const TAPIS_WMS = 'https://tapis.gov.lv/izpl/geoserver/tapis_apvienotie/wms';
const OZOLS_MAP = 'https://ozols.gov.lv/arcgis/rest/services/OZOLS_DABASDATI_PUB_DATU_APMAINA/MapServer';

/** Below this zoom the parcel mosaic would pull far too many polygons. */
export const MOSAIC_MIN_ZOOM = 17;

/** Where the map opens: Rīga old town, close enough to click a parcel at once. */
const START_VIEW: [number, number] = [56.9496, 24.1052];
const START_ZOOM = 16;

/** Pixels of the map covered by floating UI, so a parcel is never hidden behind the panel. */
export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A request to move the camera. `id` changes on every request so repeats still fire. */
export interface FocusRequest {
  id: number;
  parcel?: Parcel;
  center?: [number, number];
  zoom?: number;
}

interface Props {
  mode: LayerMode;
  flood: FloodYears;
  /** Street map or satellite under every overlay. */
  basemap: Basemap;
  parcel: Parcel | null;
  /** The spot just clicked, shown as a ripple until the parcel arrives. */
  pending: { lat: number; lon: number } | null;
  focus: FocusRequest | null;
  inset: Inset;
  onPick: (lat: number, lon: number) => void;
  /** Tells the shell whether the parcel mosaic is currently visible. */
  onMosaic: (state: MosaicState) => void;
  /** 14-digit code of the building shown in the panel, if any. */
  selectedBuilding: string | null;
  /** A lit footprint was clicked. The parcel stays as it is. */
  onBuilding: (building: BuildingOutline) => void;
  /** Every footprint on the current parcel, once loaded (empty on change). */
  onBuildings: (buildings: BuildingOutline[]) => void;
}

/**
 * What the "Kadastrs" layer is doing right now. `partial` means
 * a tile hit the server's cap or failed, so some outlines are missing.
 */
export type MosaicState = 'off' | 'zoom' | 'wide' | 'on' | 'loading' | 'partial';

/* ---------- mosaic tiles ---------- */

/*
 * Fixed grid in degrees, about 550 m × 600 m at Latvian latitudes.
 * The server caps one box at 0.015° × 0.03°, so a tile fits easily,
 * and a desktop window at zoom 17 needs roughly six of them.
 */
const TILE_LAT = 0.005;
const TILE_LON = 0.01;
const TILE_CACHE_MAX = 300;

interface TileEntry {
  parcels: ParcelOutline[];
  truncated: boolean;
}

/*
 * Module-level so the cache survives switching layers and back.
 * A Map keeps insertion order, which is all an LRU needs:
 * touching a tile re-inserts it at the end, eviction pops the front.
 */
const tileCache = new Map<string, TileEntry>();

function touchTile(key: string): void {
  const entry = tileCache.get(key);
  if (entry) {
    tileCache.delete(key);
    tileCache.set(key, entry);
  }
}

function rememberTile(key: string, entry: TileEntry): void {
  tileCache.delete(key);
  tileCache.set(key, entry);
  while (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    tileCache.delete(oldest);
  }
}

/** Grid keys ("row:col") covering a window. */
function tilesFor(bounds: L.LatLngBounds): string[] {
  const rows = [Math.floor(bounds.getSouth() / TILE_LAT), Math.floor(bounds.getNorth() / TILE_LAT)];
  const cols = [Math.floor(bounds.getWest() / TILE_LON), Math.floor(bounds.getEast() / TILE_LON)];
  const keys: string[] = [];
  for (let row = rows[0]; row <= rows[1]; row += 1) {
    for (let col = cols[0]; col <= cols[1]; col += 1) {
      keys.push(`${row}:${col}`);
    }
  }
  return keys;
}

/**
 * South, west, north, east of one tile. Rounded to 4 decimals so
 * the server's cache key is byte-identical on every request.
 */
function tileBox(key: string): [number, number, number, number] {
  const [row, col] = key.split(':').map(Number);
  const round = (value: number) => Number(value.toFixed(4));
  return [round(row * TILE_LAT), round(col * TILE_LON), round((row + 1) * TILE_LAT), round((col + 1) * TILE_LON)];
}

/**
 * ArcGIS MapServer export, one image per map tile.
 * These services have no public XYZ cache, and an
 * img request does not need CORS.
 */
class ArcgisExportLayer extends L.GridLayer {
  private service: string;
  private layers: string;

  constructor(service: string, layers: string, options: L.GridLayerOptions) {
    super(options);
    this.service = service;
    this.layers = layers;
  }

  protected createTile(coords: L.Coords): HTMLElement {
    const size = 256;
    const world = 20037508.342789244;
    const img = document.createElement('img');

    /* Web-Mercator bounds of this one tile. */
    const res = (world * 2) / size / 2 ** coords.z;
    const xmin = -world + coords.x * size * res;
    const xmax = xmin + size * res;
    const ymax = world - coords.y * size * res;
    const ymin = ymax - size * res;

    const params = new URLSearchParams({
      bbox: `${xmin},${ymin},${xmax},${ymax}`,
      bboxSR: '3857',
      imageSR: '3857',
      size: `${size},${size}`,
      format: 'png32',
      transparent: 'true',
      layers: `show:${this.layers}`,
      f: 'image',
    });
    img.alt = '';
    img.width = size;
    img.height = size;
    img.src = `${this.service}/export?${params.toString()}`;
    /* A tile the service refuses should leave a gap, not a broken-image icon. */
    img.addEventListener('error', () => {
      img.style.opacity = '0';
    });
    return img;
  }
}

function ringsToLatLngs(parcel: Parcel): L.LatLngExpression[][] {
  return parcel.rings.map((ring) => ring.map(([lat, lon]) => [lat, lon] as L.LatLngTuple));
}

/**
 * The whole screen. Leaflet is driven imperatively from a few
 * effects — one per concern — so React never re-creates the map.
 * Clicks are reported upward; the shell decides what a click means.
 */
export function MapView({
  mode,
  flood,
  basemap,
  parcel,
  pending,
  focus,
  inset,
  onPick,
  onMosaic,
  selectedBuilding,
  onBuilding,
  onBuildings,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.Layer | null>(null);
  /* Street or satellite — swapped without rebuilding the map. */
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const parcelLayerRef = useRef<L.LayerGroup | null>(null);
  const pendingLayerRef = useRef<L.Marker | null>(null);
  const mosaicRef = useRef<L.LayerGroup | null>(null);
  const drawnRef = useRef(new Map<string, L.Polygon>());
  const buildingLayerRef = useRef<L.LayerGroup | null>(null);
  /* code → footprint, so selection restyles one path instead of redrawing all. */
  const buildingPolysRef = useRef(new Map<string, L.Polygon>());
  const canvasRef = useRef<L.Canvas | null>(null);
  /* First paint uses whatever basemap the shell opened with. */
  const basemapRef = useRef(basemap);
  basemapRef.current = basemap;

  /*
   * Callbacks and insets change every render; the map is built once.
   * Refs let the long-lived Leaflet handlers read the latest values.
   */
  const pickRef = useRef(onPick);
  const insetRef = useRef(inset);
  const mosaicCbRef = useRef(onMosaic);
  const modeRef = useRef(mode);
  const buildingCbRef = useRef(onBuilding);
  const buildingsCbRef = useRef(onBuildings);
  const selectedRef = useRef(selectedBuilding);
  pickRef.current = onPick;
  insetRef.current = inset;
  mosaicCbRef.current = onMosaic;
  modeRef.current = mode;
  buildingCbRef.current = onBuilding;
  buildingsCbRef.current = onBuildings;
  selectedRef.current = selectedBuilding;

  /* ---------- build the map once ---------- */
  useEffect(() => {
    if (!host.current || mapRef.current) {
      return;
    }

    const map = L.map(host.current, {
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.5,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 90,
      minZoom: 6,
      maxZoom: 20,
    }).setView(START_VIEW, START_ZOOM);

    /* Base tiles under every government overlay (street or satellite). */
    const base = BASE_TILES[basemapRef.current];
    baseLayerRef.current = L.tileLayer(base.url, {
      attribution: base.attribution,
      maxZoom: 20,
      maxNativeZoom: base.maxNativeZoom,
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    canvasRef.current = L.canvas({ padding: 0.4 });
    parcelLayerRef.current = L.layerGroup().addTo(map);
    mosaicRef.current = L.layerGroup().addTo(map);
    /* Added last so the lit buildings sit above the parcel fill. */
    buildingLayerRef.current = L.layerGroup().addTo(map);

    map.on('click', (event: L.LeafletMouseEvent) => {
      pickRef.current(event.latlng.lat, event.latlng.lng);
    });

    mapRef.current = map;
    /* The container is sized by CSS after first paint. */
    window.setTimeout(() => map.invalidateSize(), 80);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* ---------- swap street ↔ satellite without touching overlays ---------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const next = BASE_TILES[basemap];
    baseLayerRef.current?.remove();
    baseLayerRef.current = L.tileLayer(next.url, {
      attribution: next.attribution,
      maxZoom: 20,
      maxNativeZoom: next.maxNativeZoom,
    }).addTo(map);
    /* Keep the base under floods / zoning / parcel fills. */
    baseLayerRef.current.bringToBack();
  }, [basemap]);

  /* ---------- government overlay ---------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    overlayRef.current?.remove();
    overlayRef.current = null;

    let layer: L.Layer | null = null;
    /* Blue = water on the flood layer, so the selection turns into an outline (index.css). */
    map.getContainer().classList.toggle('flood-mode', mode === 'pludi');

    if (mode === 'pludi') {
      /*
       * River extent underneath, coastal water on top — one group, so
       * swapping modes removes both. Tiles come through our disk cache
       * (server/tiles.ts); L.tileLayer also cancels requests left over
       * from the fly-in zoom levels, which the export layer did not.
       * Past z18 the depth raster has no finer cells — Leaflet upscales.
       *
       * 1024 px tiles one zoom-pair up (zoomOffset -2) cover the same
       * ground at the same sharpness as 16 normal tiles: a window is
       * ~12 requests per layer, not ~120. Must match TILE_SIZE in
       * server/tiles.ts.
       */
      const ids = FLOOD_LAYERS[flood];
      const cached = (layerId: string, opacity: number) =>
        L.tileLayer(`${API_ROOT}/api/tiles/lvgmc/${layerId}/{z}/{x}/{y}.png`, {
          opacity,
          tileSize: 1024,
          zoomOffset: -2,
          maxZoom: 20,
          maxNativeZoom: 18,
          minZoom: 6,
          attribution: 'Plūdi &copy; LVĢMC',
          /* A tile LVĢMC refuses should leave a gap, not a broken-image icon. */
          errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
        });
      layer = L.layerGroup([cached(ids.river, 0.6), cached(ids.coastal, 0.78)]);
    } else if (mode === 'daba') {
      layer = new ArcgisExportLayer(OZOLS_MAP, '4,1,15', { opacity: 0.78, maxZoom: 20 });
    } else if (mode === 'zonejums') {
      layer = L.tileLayer.wms(TAPIS_WMS, {
        layers: 'funkcionalais_zonejums',
        format: 'image/png',
        transparent: true,
        version: '1.1.1',
        opacity: 0.72,
        maxZoom: 20,
      });
    }

    if (layer) {
      layer.addTo(map);
      overlayRef.current = layer;
    }
  }, [mode, flood]);

  /* ---------- parcel mosaic ("Kadastrs") ---------- */
  useEffect(() => {
    const map = mapRef.current;
    const group = mosaicRef.current;
    if (!map || !group) {
      return;
    }

    /* Polygons on screen, by parcel number, so a pan only diffs. */
    const drawn = drawnRef.current;

    if (mode !== 'kadastrs') {
      group.clearLayers();
      drawn.clear();
      mosaicCbRef.current('off');
      return;
    }

    let timer = 0;
    let serial = 0;
    let controller: AbortController | null = null;
    let lastState: MosaicState | null = null;
    if (!map.hasLayer(group)) {
      group.addTo(map);
    }

    /* The shell re-renders on every call, so only report real changes. */
    const report = (state: MosaicState) => {
      if (state !== lastState) {
        lastState = state;
        mosaicCbRef.current(state);
      }
    };

    /*
     * Draw what the tile cache holds for the given keys, touching
     * only the difference: new parcels are added, parcels that
     * drifted out of the padded window are dropped, the rest
     * stay put. No clearLayers, so nothing flickers mid-pan.
     */
    const paint = (keys: string[]) => {
      if (!group) {
        return;
      }
      const wanted = new Map<string, ParcelOutline>();
      for (const key of keys) {
        for (const item of tileCache.get(key)?.parcels ?? []) {
          wanted.set(item.cadastre, item);
        }
      }

      /* Out with whatever left the window... */
      for (const [cadastre, polygon] of drawn) {
        if (!wanted.has(cadastre)) {
          group.removeLayer(polygon);
          drawn.delete(cadastre);
        }
      }

      /* ...and in with the newcomers only. */
      for (const [cadastre, item] of wanted) {
        if (drawn.has(cadastre)) {
          continue;
        }
        /*
         * Thin outlines on the one shared canvas renderer: a few
         * hundred polygons stay smooth and clicks fall through.
         */
        const polygon = L.polygon(
          item.rings.map((ring) => ring.map(([lat, lon]) => [lat, lon] as L.LatLngTuple)),
          {
            renderer: canvasRef.current ?? undefined,
            interactive: false,
            color: '#0a84ff',
            weight: 1,
            opacity: 0.75,
            fillColor: '#0a84ff',
            fillOpacity: 0.05,
          },
        ).addTo(group);
        drawn.set(cadastre, polygon);
      }
    };

    async function refresh() {
      const current = ++serial;
      if (!map || !group) {
        return;
      }

      /*
       * Zoomed out: hide the layer instead of emptying it, so
       * zooming back in shows the outlines again at once.
       */
      if (map.getZoom() < MOSAIC_MIN_ZOOM) {
        controller?.abort();
        group.remove();
        report('zoom');
        return;
      }
      if (!map.hasLayer(group)) {
        group.addTo(map);
      }

      /* A little margin so short pans land on outlines already drawn. */
      const keys = tilesFor(map.getBounds().pad(0.15));
      const missing = keys.filter((key) => !tileCache.has(key));

      /* Everything cached: repaint with no spinner and no network. */
      paint(keys);
      keys.forEach(touchTile);
      if (!missing.length) {
        report(keys.some((key) => tileCache.get(key)?.truncated) ? 'partial' : 'on');
        return;
      }

      /* A newer pan supersedes whatever is still in flight. */
      controller?.abort();
      const own = new AbortController();
      controller = own;
      report('loading');

      const results = await Promise.allSettled(
        missing.map(async (key) => {
          const [south, west, north, east] = tileBox(key);
          const result = await fetchParcelsInBox(south, west, north, east, own.signal);
          rememberTile(key, { parcels: result.parcels, truncated: Boolean(result.truncated) });
        }),
      );
      if (current !== serial || own.signal.aborted || modeRef.current !== 'kadastrs') {
        return;
      }

      paint(keys);
      const failed = results.some((result) => result.status === 'rejected');
      if (failed && !drawn.size) {
        report('zoom');
        return;
      }
      report(failed || keys.some((key) => tileCache.get(key)?.truncated) ? 'partial' : 'on');
    }

    /* Debounce so a drag does not fire a request per frame. */
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 180);
    };

    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    void refresh();

    return () => {
      window.clearTimeout(timer);
      serial += 1;
      controller?.abort();
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
    };
  }, [mode]);

  /* ---------- the selected parcel ---------- */
  useEffect(() => {
    const group = parcelLayerRef.current;
    if (!group) {
      return;
    }
    group.clearLayers();
    if (!parcel) {
      return;
    }

    if (parcel.rings.length) {
      /* The className hooks the CSS pulse; SVG renderer so it can animate. */
      L.polygon(ringsToLatLngs(parcel), {
        className: 'parcel-selected',
        color: '#0a84ff',
        weight: 3,
        fillColor: '#0a84ff',
        fillOpacity: 0.22,
        interactive: false,
        lineJoin: 'round',
      }).addTo(group);
    } else if (parcel.point) {
      L.circleMarker([parcel.point.lat, parcel.point.lon], {
        radius: 10,
        color: '#0a84ff',
        fillColor: '#0a84ff',
        fillOpacity: 0.3,
        interactive: false,
      }).addTo(group);
    }
  }, [parcel]);

  /* ---------- buildings on the selected parcel ---------- */
  useEffect(() => {
    const group = buildingLayerRef.current;
    if (!group) {
      return;
    }
    group.clearLayers();
    buildingPolysRef.current.clear();
    buildingsCbRef.current([]);
    if (!parcel?.cadastre || !parcel.rings.length) {
      return;
    }

    /*
     * Fetched after the outline is already on screen, so the
     * parcel never waits for the buildings. A new click aborts
     * the old request; a slow or failed one just leaves no glow.
     */
    const controller = new AbortController();
    fetchParcelBuildings(parcel.cadastre, controller.signal)
      .then(({ buildings }) => {
        if (controller.signal.aborted) {
          return;
        }
        buildings.forEach((building: BuildingOutline, index: number) => {
          const polygon = L.polygon(
            building.rings.map((ring) => ring.map(([lat, lon]) => [lat, lon] as L.LatLngTuple)),
            {
              className: 'building-lit',
              color: '#ff9f0a',
              weight: 1.5,
              fillColor: '#ff9f0a',
              fillOpacity: 0.55,
              /* Clickable now: a footprint opens its own card. */
              interactive: true,
              bubblingMouseEvents: false,
              lineJoin: 'round',
            },
          ).addTo(group);

          /*
           * The click must not fall through to the map, or the map
           * would re-pick the parcel and wipe the card it just opened.
           */
          polygon.on('click', (event: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event);
            buildingCbRef.current(building);
          });

          /* Hover hint: name and year, same glass as the rest of the UI. */
          const hint = [building.name || 'Būve', building.built].filter(Boolean).join(' · ');
          polygon.bindTooltip(hint, { className: 'building-tip', direction: 'top', sticky: true, opacity: 1 });

          /* Stagger the spring-in so the buildings light up one after another. */
          const path = polygon.getElement() as SVGElement | undefined;
          path?.style.setProperty('animation-delay', `${Math.min(index, 12) * 40}ms`);
          if (building.code === selectedRef.current) {
            path?.classList.add('building-selected');
          }
          buildingPolysRef.current.set(building.code, polygon);
        });
        buildingsCbRef.current(buildings);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [parcel]);

  /*
   * ---------- selected building ----------
   * Only a class flips; the CSS does the deeper fill and white halo,
   * and the selected path is raised so its halo is never clipped.
   */
  useEffect(() => {
    buildingPolysRef.current.forEach((polygon, code) => {
      const path = polygon.getElement() as SVGElement | undefined;
      const on = code === selectedBuilding;
      path?.classList.toggle('building-selected', on);
      if (on) {
        polygon.bringToFront();
      }
    });
  }, [selectedBuilding]);

  /* ---------- click ripple while the parcel loads ---------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    pendingLayerRef.current?.remove();
    pendingLayerRef.current = null;
    if (!pending) {
      return;
    }
    /*
     * The ring lives in an inner span. Leaflet positions this marker
     * with an inline transform; a scale animation (or a CSS
     * `transform: none !important`) on the same element replaces that
     * translate and parks the circle at the map's top-left. Outer
     * shell stays still; only `.click-ripple-ring` may scale.
     */
    pendingLayerRef.current = L.marker([pending.lat, pending.lon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'click-ripple',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        html: '<span class="click-ripple-ring"></span>',
      }),
    }).addTo(map);
  }, [pending]);

  /* ---------- camera moves ---------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) {
      return;
    }

    const { top, right, bottom, left } = insetRef.current;

    if (focus.parcel?.rings.length) {
      /* Fit the outline into whatever part of the screen the UI leaves free. */
      const bounds = L.latLngBounds(ringsToLatLngs(focus.parcel).flat() as L.LatLngTuple[]);
      map.flyToBounds(bounds, {
        paddingTopLeft: [left + 48, top + 96],
        paddingBottomRight: [right + 48, bottom + 48],
        maxZoom: 19,
        duration: 0.9,
      });
      return;
    }

    const target = focus.center ?? (focus.parcel?.point ? [focus.parcel.point.lat, focus.parcel.point.lon] : null);
    if (target) {
      map.flyTo(target as L.LatLngTuple, focus.zoom ?? 18, { duration: 0.9 });
    }
  }, [focus]);

  /* ---------- keep a click-selected parcel out from under the panel ---------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !parcel || !parcel.point || focus?.parcel?.cadastre === parcel.cadastre) {
      return;
    }

    const { top, right, bottom, left } = insetRef.current;
    const size = map.getSize();
    const at = map.latLngToContainerPoint([parcel.point.lat, parcel.point.lon]);
    const free = { x0: left + 24, x1: size.x - right - 24, y0: top + 80, y1: size.y - bottom - 24 };

    /* Already comfortably visible: leave the camera alone. */
    if (at.x >= free.x0 && at.x <= free.x1 && at.y >= free.y0 && at.y <= free.y1) {
      return;
    }
    const dx = at.x - (free.x0 + free.x1) / 2;
    const dy = at.y - (free.y0 + free.y1) / 2;
    map.panBy([dx, dy], { animate: true, duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcel]);

  /* ---------- locate me (also used by the shell's button via window event) ---------- */
  useEffect(() => {
    const onLocate = (event: Event) => {
      const detail = (event as CustomEvent<{ lat: number; lon: number }>).detail;
      mapRef.current?.flyTo([detail.lat, detail.lon], 18, { duration: 0.9 });
    };
    window.addEventListener('zk:locate', onLocate);
    return () => window.removeEventListener('zk:locate', onLocate);
  }, []);

  return <div ref={host} className="map-root" aria-label="Zemes vienību karte" />;
}
