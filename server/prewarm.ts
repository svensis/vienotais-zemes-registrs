/**
 * Fills the cache for a handful of demo parcels so the first
 * click on stage answers in a blink instead of waiting on
 * five government servers.
 *
 *   CACHE_TTL_HOURS=168 npm run prewarm
 *   CACHE_TTL_HOURS=168 npm start        (same value, so the cache is still fresh)
 *
 * Each spot is a point on the map, not a hard-coded number:
 * the same click lookup the app uses finds the parcel under it.
 */
import { initDb } from './db.ts';
import { lookupParcelAt } from './adapters/geo.ts';
import { evaluateClient } from './services/evaluate.ts';
import { reportRow } from './services/report.ts';

const SPOTS: { name: string; lat: number; lon: number }[] = [
  { name: 'Rīga, Kaļķu iela 1 (Vecrīga)', lat: 56.94967, lon: 24.10785 },
  { name: 'Rīga, Brīvības piemineklis', lat: 56.95159, lon: 24.11338 },
  { name: 'Jūrmala, Majori (piekraste, plūdi)', lat: 56.9707, lon: 23.7857 },
  { name: 'Ķemeri (dabas teritorija)', lat: 56.9538, lon: 23.5051 },
  { name: 'Sigulda, Turaida (Gaujas NP)', lat: 57.1857, lon: 24.8454 },
  { name: 'Cēsis, Vecpilsēta', lat: 57.3122, lon: 25.2705 },
  { name: 'Liepāja, Karosta', lat: 56.5522, lon: 21.0125 },
];

initDb();
console.log(`Sasilda kešu: ${SPOTS.length} vietas`);

for (const spot of SPOTS) {
  const started = Date.now();
  try {
    const parcel = await lookupParcelAt(spot.lat, spot.lon);
    if (!parcel) {
      console.log(`  ✗ ${spot.name} — zem punkta nav zemes vienības`);
      continue;
    }
    const clientId = reportRow({ cadastre: parcel.cadastre, applicant: '', applicantName: '' });
    await evaluateClient(clientId, false);
    console.log(`  ✓ ${spot.name} → ${parcel.cadastre} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    console.log(`  ✗ ${spot.name} — ${error instanceof Error ? error.message : error}`);
  }
}

console.log('Gatavs.');
process.exit(0);
