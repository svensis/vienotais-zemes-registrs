import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from './brand.ts';
import { getJob, startCollectJob } from './jobs.ts';
import { rateLimit } from './rateLimit.ts';
import {
  getClient,
  initDb,
  listFactsForClient,
  listSourceHealth,
  logEvent,
  updateClientSite,
} from './db.ts';
import { FIELD_GROUPS, FIELD_SPECS, cadastreDigits, isCadastre, isRegcode } from './fields.ts';
import { geocode } from './adapters/geocode.ts';
import { lookupParcelAt, lookupParcelBuildings, lookupParcelShape, lookupParcelsInBox } from './adapters/geo.ts';
import { cadastreReady } from './cadastreDb.ts';
import { lookupBuildingDetail } from './services/building.ts';
import { reportRow } from './services/report.ts';
import { sourceHealth } from './services/health.ts';
import { refreshSourceMeta } from './services/sourceMeta.ts';
import { SOURCE_MATRIX } from './sources.ts';
import { TILE_BROWSER_MAX_AGE, getFloodTile, parseTileRequest } from './tiles.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const PORT = Number(process.env.PORT) || 5174;
const HOST = process.env.HOST || '127.0.0.1';

initDb();

const app = express();
app.use(cors());
app.use(express.json());
app.use(rateLimit);

/*
 * Health: the same probe the PoC used, plus whether the
 * local cadastre index is in place. Without it the map still
 * works; only the ownership and encumbrance rows go quiet.
 */
app.get('/api/health', async (_req, res) => {
  res.json({ ...(await sourceHealth()), name: APP_NAME, cadastreIndex: cadastreReady() });
});

app.get('/api/health/sources', async (_req, res) => {
  const meta = await refreshSourceMeta();
  res.json({ ok: true, sources: meta, live: await sourceHealth() });
});

/*
 * What the map UI needs to label rows: field order and
 * group names come from the server so there is one list.
 */
app.get('/api/fields', (_req, res) => {
  res.json({ fields: FIELD_SPECS, groups: FIELD_GROUPS });
});

/*
 * LVĢMC flood map tiles through our disk cache (server/tiles.ts).
 * First render goes to LVĢMC; every later look is a local file.
 */
app.get('/api/tiles/lvgmc/:layers/:z/:x/:y', async (req, res) => {
  const tile = parseTileRequest(req.params.layers, req.params.z, req.params.x, req.params.y);
  if (!tile) {
    res.status(404).end();
    return;
  }
  try {
    const png = await getFloodTile(tile);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', `public, max-age=${TILE_BROWSER_MAX_AGE}`);
    res.end(png);
  } catch {
    // The map hides a failed tile; no JSON body needed for an <img>
    res.status(502).end();
  }
});

app.get('/api/sources', (_req, res) => {
  const health = Object.fromEntries(listSourceHealth().map((row) => [row.resource_id, row]));
  res.json({
    sources: SOURCE_MATRIX.map((row) => ({
      ...row,
      lastModified: health[row.resourceId]?.last_modified || '',
      healthNote: health[row.resourceId]?.note || '',
      healthOk: health[row.resourceId]?.ok,
      checkedAt: health[row.resourceId]?.checked_at || '',
    })),
  });
});

/*
 * The click. Latitude and longitude in, the land unit under
 * that point out: number, area, centre and outline. A click on
 * water or a road answers with `parcel: null`, not an error.
 */
app.get('/api/parcel/at', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Vajag lat un lon.' });
    return;
  }

  try {
    const parcel = await lookupParcelAt(lat, lon);
    res.json({ parcel });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Zemes vienību serviss neatbild.' });
  }
});

/*
 * Outlines for the current map window. Only the browser's
 * "Kadastrs" layer calls this, and only zoomed in far enough
 * for the window to hold a few hundred parcels at most.
 */
app.get('/api/parcels/box', async (req, res) => {
  const south = Number(req.query.s);
  const west = Number(req.query.w);
  const north = Number(req.query.n);
  const east = Number(req.query.e);
  if (![south, west, north, east].every(Number.isFinite)) {
    res.status(400).json({ error: 'Vajag s, w, n, e.' });
    return;
  }
  /* A window wider than ~1.5 km is not a parcel view. */
  if (north - south > 0.015 || east - west > 0.03) {
    res.json({ parcels: [], truncated: true, tooWide: true });
    return;
  }

  try {
    res.json(await lookupParcelsInBox(south, west, north, east));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Zemes vienību serviss neatbild.' });
  }
});

/* Address search → a handful of points the map can fly to. */
app.get('/api/geocode', async (req, res) => {
  try {
    res.json({ hits: await geocode(String(req.query.q ?? '')) });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Adrešu meklētājs neatbild.' });
  }
});

/*
 * Buildings standing on one land unit, for the map glow.
 * Never a 5xx: a quiet building service only means no glow.
 */
app.get('/api/parcel/:id/buildings', async (req, res) => {
  const digits = cadastreDigits(req.params.id);
  if (digits.length < 11) {
    res.status(400).json({ error: 'Kadastra numuram vajag 11 ciparus.' });
    return;
  }
  res.json(await lookupParcelBuildings(digits));
});

/*
 * One building's card: BIS row + case, legal status, address and
 * encumbrances for that exact 14-digit designation.
 */
app.get('/api/building/:code', async (req, res) => {
  const digits = cadastreDigits(req.params.code);
  if (digits.length !== 14) {
    res.status(400).json({ error: 'Būves apzīmējumam vajag 14 ciparus.' });
    return;
  }
  try {
    res.json(await lookupBuildingDetail(digits, req.query.force === '1'));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Būves dati nav pieejami.' });
  }
});

/*
 * One land unit by number: search box and deep links.
 * Kept after /api/parcel/at so "at" is not read as an id.
 */
app.get('/api/parcel/:id', async (req, res) => {
  const digits = cadastreDigits(req.params.id);
  if (digits.length < 11) {
    res.status(400).json({ error: 'Kadastra numuram vajag 11 ciparus.' });
    return;
  }

  try {
    const parcel = await lookupParcelShape(digits);
    res.json({ id: digits.slice(0, 11), parcel, rings: parcel?.rings ?? [] });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Zemes vienību serviss neatbild.' });
  }
});

/*
 * Click → report. Returns at once with a job id; the facts
 * land one by one while the browser polls /api/jobs/:id.
 * Without `force`, fresh cache entries are reused, so a
 * second click on the same parcel answers in a blink.
 */
app.post('/api/parcel/report', (req, res) => {
  const cadastre = cadastreDigits(String(req.body?.cadastre ?? ''));
  const applicant = cadastreDigits(String(req.body?.applicant ?? ''));
  const force = Boolean(req.body?.force);

  if (!isCadastre(cadastre)) {
    res.status(400).json({ error: 'Kadastra numuram jābūt 11–17 cipariem.' });
    return;
  }
  if (applicant && !isRegcode(applicant)) {
    res.status(400).json({ error: 'Uzņēmuma reģistrācijas numuram jābūt 11 cipariem.' });
    return;
  }

  const clientId = reportRow({ cadastre, applicant, applicantName: '' });
  logEvent('parcel_report', { cadastre, applicant: Boolean(applicant), force });
  const job = startCollectJob({ force, clientId });
  res.json({ jobId: job.id, clientId, ...reportBody(clientId) });
});

/** The partial (or finished) card for one hidden row. */
function reportBody(clientId: string) {
  const client = getClient(clientId);
  return {
    client: client
      ? {
          id: client.id,
          cadastre: client.project_cadastre,
          lat: client.project_lat,
          lon: client.project_lon,
          applicantRegcode: client.applicant_regcode,
          applicantName: client.applicant_name,
        }
      : null,
    facts: listFactsForClient(clientId),
  };
}

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Darbs nav atrasts.' });
    return;
  }
  res.json({ job, ...reportBody(job.clientId || '') });
});

/*
 * Optional: company check. Same parcel, plus one registration
 * number. VID rating, de minimis and procurement then follow
 * that company instead of whoever sits at the address.
 */
app.post('/api/parcel/report/company', (req, res) => {
  const cadastre = cadastreDigits(String(req.body?.cadastre ?? ''));
  const applicant = cadastreDigits(String(req.body?.applicant ?? ''));
  if (!isCadastre(cadastre) || !isRegcode(applicant)) {
    res.status(400).json({ error: 'Vajag kadastra numuru un 11 ciparu reģistrācijas numuru.' });
    return;
  }
  const clientId = reportRow({ cadastre, applicant, applicantName: '' });
  const job = startCollectJob({ force: false, clientId });
  res.json({ jobId: job.id, clientId, ...reportBody(clientId) });
});

/* The site's own lat/lon, stored once the evaluation finds a point. */
void updateClientSite;

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} API http://${HOST}:${PORT}`);
  void refreshSourceMeta().catch(() => undefined);
});
