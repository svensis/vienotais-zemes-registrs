// Ko LVĢMC identify atdod punktā — slāņu id, nosaukumi, pirmie atribūti.
// Lietojums: node floodprobe.mjs lat lon [slāņi]
const FLOOD =
  'https://geodata.lvgmc.lv/server/rest/services/Latvijas_pludu_riska_un_pludu_draudu_kartes_garumzimes/MapServer';
const [lat, lon] = process.argv.slice(2, 4).map(Number);
const layers = process.argv[4] || 'all:81';

const p = new URLSearchParams({
  f: 'json',
  geometry: JSON.stringify({ x: lon, y: lat }),
  geometryType: 'esriGeometryPoint',
  sr: '4326',
  layers,
  tolerance: '0',
  mapExtent: `${lon - 0.002},${lat - 0.002},${lon + 0.002},${lat + 0.002}`,
  imageDisplay: '400,400,96',
  returnGeometry: 'false',
});
const r = await fetch(`${FLOOD}/identify?${p}`).then((x) => x.json());
console.log(JSON.stringify((r.results || []).map((x) => [x.layerId, x.layerName, x.attributes]).slice(0, 6), null, 1));
