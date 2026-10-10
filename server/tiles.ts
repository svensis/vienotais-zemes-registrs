import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from './brand.ts';

/*
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  LVĢMC flood tiles, cached on disk.                               │
 * │                                                                   │
 * │  The flood MapServer has no XYZ cache; every tile is a fresh      │
 * │  /export render. Three things keep the map quick:                 │
 * │                                                                   │
 * │  1. Big tiles. The map asks for 1024 px tiles (Leaflet tileSize   │
 * │     1024 + zoomOffset -2) — same sharpness, 16× fewer renders.    │
 * │     A whole window is ~12 requests per layer instead of ~120.     │
 * │  2. Disk cache. A tile rendered once is a local file for 30 days; │
 * │     the flood maps change once in a planning cycle.               │
 * │  3. Sibling prefetch. When one layer of a tile is asked for, the  │
 * │     other five (10 / 100 / 200 × river / coast) are rendered in   │
 * │     the background, so switching scenario is instant.             │
 * └──────────────────────────────────────────────────────────────────┘
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Tile edge in pixels. Must match tileSize in MapView (and zoomOffset = -log2(size/256)). */
export const TILE_SIZE = 1024;
const TILE_DIR = path.join(ROOT, 'data', 'tiles', `lvgmc-${TILE_SIZE}`);

const FLOOD_MAP =
  'https://geodata.lvgmc.lv/server/rest/services/Latvijas_pludu_riska_un_pludu_draudu_kartes_garumzimes/MapServer';

/*
 * Only the ids the map actually draws (MapView FLOOD_LAYERS):
 * river extent 14 / 28 / 42, coastal depth 67 / 81 / 95.
 * Anything else is refused, so this cannot become an open proxy.
 */
const FLOOD_LAYER_IDS = ['14', '28', '42', '67', '81', '95'];
const ALLOWED_LAYERS = new Set(FLOOD_LAYER_IDS);

/* Rendered flood maps barely change — 30 days on disk, 7 days in the browser. */
const DISK_TTL_MS = 30 * 24 * 3600 * 1000;
export const TILE_BROWSER_MAX_AGE = 7 * 24 * 3600;

/* Request zooms after the -2 offset: map zoom 6…18 → 4…16. */
const MIN_Z = 4;
const MAX_Z = 17;

/*
 * Be polite to LVĢMC: at most this many renders at once. Visible
 * tiles jump the queue; background prefetch waits behind them.
 */
const MAX_UPSTREAM = 6;

export type TileRequest = { layers: string; z: number; x: number; y: number };

/** Validates path params; returns null for anything we will not render. */
export function parseTileRequest(layers: string, z: string, x: string, y: string): TileRequest | null {
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y.replace(/\.png$/, ''));
  if (!ALLOWED_LAYERS.has(layers)) return null;
  if (![zi, xi, yi].every(Number.isInteger)) return null;
  if (zi < MIN_Z || zi > MAX_Z) return null;
  const n = 2 ** zi;
  if (xi < 0 || yi < 0 || xi >= n || yi >= n) return null;
  return { layers, z: zi, x: xi, y: yi };
}

/** Web-Mercator bounds of one XYZ tile (the grid is the same at any pixel size). */
function tileBbox({ z, x, y }: TileRequest): string {
  const world = 20037508.342789244;
  const span = (world * 2) / 2 ** z;
  const xmin = -world + x * span;
  const ymax = world - y * span;
  return `${xmin},${ymax - span},${xmin + span},${ymax}`;
}

function tilePath(t: TileRequest): string {
  return path.join(TILE_DIR, t.layers, String(t.z), String(t.x), `${t.y}.png`);
}

/* ─────────────── tiny two-lane queue for upstream renders ─────────────── */

let running = 0;
const urgent: Array<() => void> = [];
const background: Array<() => void> = [];

/** Waits for a free upstream slot; visible tiles are served before prefetch. */
function acquire(priority: 'urgent' | 'background'): Promise<void> {
  if (running < MAX_UPSTREAM) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    (priority === 'urgent' ? urgent : background).push(() => {
      running += 1;
      resolve();
    });
  });
}

function release(): void {
  running -= 1;
  const next = urgent.shift() || background.shift();
  next?.();
}

/** Asks LVĢMC to render one tile. Throws on anything that is not a PNG. */
async function renderTile(t: TileRequest): Promise<Buffer> {
  const params = new URLSearchParams({
    bbox: tileBbox(t),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${TILE_SIZE},${TILE_SIZE}`,
    format: 'png32',
    transparent: 'true',
    layers: `show:${t.layers}`,
    f: 'image',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${FLOOD_MAP}/export?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.startsWith('image/')) {
      throw new Error(`LVĢMC ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/* One render per tile even if several browsers (or the prefetch) ask at once. */
const inFlight = new Map<string, Promise<Buffer>>();

/** Fresh file on disk, or null. */
function freshStat(file: string): fs.Stats | null {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat && Date.now() - stat.mtimeMs < DISK_TTL_MS ? stat : null;
}

/** Disk → in-flight → render (through the queue) → disk. */
async function loadTile(t: TileRequest, priority: 'urgent' | 'background'): Promise<Buffer> {
  const file = tilePath(t);
  if (freshStat(file)) {
    return fs.promises.readFile(file);
  }

  const pending = inFlight.get(file);
  if (pending) return pending;

  const stale = fs.statSync(file, { throwIfNoEntry: false });
  const job = (async () => {
    await acquire(priority);
    try {
      const png = await renderTile(t);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      // Temp name first, so a half-written tile is never served
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.writeFile(tmp, png);
      await fs.promises.rename(tmp, file);
      return png;
    } catch (error) {
      // LVĢMC down — an old tile still beats a hole in the map
      if (stale) return fs.promises.readFile(file);
      throw error;
    } finally {
      release();
      inFlight.delete(file);
    }
  })();
  inFlight.set(file, job);
  return job;
}

/**
 * Serves one visible tile, then quietly warms the other flood layers
 * for the same square so the 10 / 100 / 200 switch never waits.
 */
export async function getFloodTile(t: TileRequest): Promise<Buffer> {
  const png = await loadTile(t, 'urgent');
  for (const layers of FLOOD_LAYER_IDS) {
    if (layers === t.layers) continue;
    const sibling = { ...t, layers };
    if (freshStat(tilePath(sibling)) || inFlight.has(tilePath(sibling))) continue;
    void loadTile(sibling, 'background').catch(() => undefined);
  }
  return png;
}
