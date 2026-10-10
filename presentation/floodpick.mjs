// Meklē labu plūdu demo gabalu: mazs (< 1 ha), un VISAS tā virsotnes
// atrodas LVĢMC 100 gadu jūras vējuzplūdu ūdens dziļuma slānī (81).
// Tieši 81 lasa arī serveris (server/adapters/geo.ts COASTAL_DEPTH), tāpēc
// karte un panelis noteikti sakrīt. Grupas 16 / 68 der tikai kartei —
// tajās ir arī iedzīvotāju režģis, kas identify «trāpa» gandrīz visur.
//
// Lietojums: node floodpick.mjs
import { BASE } from './lib.mjs';

const FLOOD =
  'https://geodata.lvgmc.lv/server/rest/services/Latvijas_pludu_riska_un_pludu_draudu_kartes_garumzimes/MapServer';

// Apdzīvotas vietas, kur plūdi ir zināma problēma — [nosaukums, lat, lon]
const AREAS = [
  ['carnikava', 57.128, 24.275],
  ['bolderaja', 57.03, 24.03],
  ['daugavgriva', 57.04, 24.0],
  ['jurmala_lielupe', 56.975, 23.83],
  ['mangalsala', 57.05, 24.08],
];
const STEP = 0.0025; // ~ 150–280 m režģis
const GRID = 4; // 9×9 punkti katrā vietā

/** Vai punkts ir 100 gadu jūras plūdu ūdens dziļuma laukumā (slānis 81). */
async function inFlood(lat, lon) {
  const p = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: 'all:81',
    tolerance: '0',
    mapExtent: `${lon - 0.002},${lat - 0.002},${lon + 0.002},${lat + 0.002}`,
    imageDisplay: '400,400,96',
    returnGeometry: 'false',
  });
  const r = await fetch(`${FLOOD}/identify?${p}`).then((x) => x.json()).catch(() => null);
  // Rastrs atbild arī sausumā ar "NoData" — tas nav ūdens. Atdodam dziļuma klasi (0 = sauss).
  const pixel = r?.results?.[0]?.attributes?.['Classify.Pixel Value'];
  const depth = Number(pixel);
  return Number.isFinite(depth) ? depth : 0;
}

// Kartē labi redzams tikai dziļāks ūdens; 1. klase (seklākā) gandrīz neiekrāsojas.
const MIN_DEPTH = Number(process.env.MIN_DEPTH || 2);

async function parcelAt(lat, lon) {
  const r = await fetch(`${BASE}/api/parcel/at?lat=${lat}&lon=${lon}`).then((x) => x.json()).catch(() => null);
  return r?.parcel || null;
}

const seen = new Set();
const hits = [];
for (const [name, lat0, lon0] of AREAS) {
  for (let i = -GRID; i <= GRID; i += 2) {
    for (let j = -GRID; j <= GRID; j += 2) {
      const lat = lat0 + i * STEP;
      const lon = lon0 + j * STEP * 1.8;
      if ((await inFlood(lat, lon)) < MIN_DEPTH) continue;
      const parcel = await parcelAt(lat, lon);
      if (!parcel?.cadastre || seen.has(parcel.cadastre)) continue;
      seen.add(parcel.cadastre);
      if (!(parcel.areaM2 > 600 && parcel.areaM2 < 10000)) continue;

      // Pārbaudām līdz 8 virsotnēm — visām jābūt plūdu laukumā
      const ring = parcel.rings?.[0] || [];
      const pick = ring.filter((_, k) => k % Math.max(1, Math.floor(ring.length / 8)) === 0).slice(0, 8);
      let all = pick.length > 0;
      for (const [la, lo] of pick) {
        if ((await inFlood(la, lo)) < 1) { all = false; break; }
      }
      if (!all) continue;
      hits.push({ area: name, cadastre: parcel.cadastre, m2: Math.round(parcel.areaM2), lat: parcel.point.lat, lon: parcel.point.lon });
      console.log('HIT', JSON.stringify(hits.at(-1)));
    }
  }
}
console.log(JSON.stringify(hits, null, 1));
