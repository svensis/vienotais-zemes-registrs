# Vienotais Zemes Reģistrs

**Uzklikšķiniet zemei. Redziet visu.**

Karte uz visu ekrānu. Uzklikšķiniet uz jebkuras zemes vienības Latvijā — un saņemiet visu, ko par to saka atvērtie valsts dati: īpašuma statusu, apgrūtinājumus, plūdu risku, zonējumu, dabas aizsardzību, būvniecības lietas, ES projektus un uzņēmumus adresē. Katrai rindai ir avots, laika zīmogs un precīzs pieprasījums, ko Jūs varat atvērt un pārbaudīt.

Bez vērtējuma. Bez personas datiem. Bez atslēgām un maksas avotiem.

Saskarne seko [VDAA / Latvija.gov.lv e-pakalpojumu principiem](https://github.com/lata-org/ai-open-data-2026-hakatons/tree/main/vdaa-epakalpojumi) (once-only, WCAG 2.1 AA, mierīgs portāla izskats). Tas **nav** oficiāls Latvija.gov.lv e-pakalpojums un nelieto VDAA Storybook SDK — oficiālajam komplektam: `atbalsts@vdaa.gov.lv`.

## Palaišana (lokāli)

Vajag Node 22 vai jaunāku (izmanto iebūvēto `node:sqlite`).

```bash
npm install
npm run dev          # http://localhost:5173  (API: 127.0.0.1:5174)
```

Kadastra indekss (`data/cadastre.sqlite`, ~1,5 GB) dod īpašuma tiesības, adresi un apgrūtinājumus. Ir divi ceļi:

```bash
npm run setup:data   # lejupielādē VZD XML (~4,9 GB) un uzbūvē indeksu
# vai nokopē jau uzbūvēto failu uz data/cadastre.sqlite
```

Bez tā karte darbojas, bet minētās rindas paliek tukšas ar skaidru paskaidrojumu.

Demonstrācijai — sasildīt kešu septiņām vietām, lai pirmais klikšķis atbild uzreiz:

```bash
CACHE_TTL_HOURS=168 npm run prewarm
CACHE_TTL_HOURS=168 npm run dev
```

Produkcijas režīms: `npm run build && npm start`.

## Ko vari izdarīt

| | |
|---|---|
| Klikšķis uz kartes | zemes vienības kontūra + pārskats |
| Meklētājs | kadastra numurs (11–17 cipari) vai adrese |
| Slāņi | Vieta · Kadastrs · Plūdi (10/100/200 g.) · Zonējums · Daba |
| Saite | `#/?cad=01000070142&l=pludi&y=100` atver tieši to pašu skatu |
| Druka | A4 pārskats ar izdrukātām avotu saitēm |
| JSON | mašīnlasāms eksports ar pieprasījumiem un pierādījumiem |
| Uzņēmuma pārbaude | ievadi reģ. nr. — VID reitings, de minimis, iepirkumi un LIAA atbalsts seko tam |
| CFLA atlases | atvērtie 2021–2027 konkursi ar termiņu, kas var pieteikties un atlikušo finansējumu; no nolikuma — intensitāte, max finansējums, MVU, NACE; atbilstība pēc īpašnieka veida, komersanta adresē, NACE, MVU aplēses un de minimis atlikuma |
| Ēkas | klikšķis uz zemes vienības iededz tās būves oranžā (VZD INSPIRE „Ēkas”) |
| Ierobežojumi | plūdi, ĪADT, mikroliegumi, biotopi, kultūras pieminekļi; Zemesgrāmatas saite īpašniekam |

## Dokumentācija

- [`docs/ARHITEKTURA.md`](docs/ARHITEKTURA.md) — kā tas strādā un kā dati tiek saņemti tehniski

## Licence

[MIT](LICENSE) — bezmaksas, atvērts pirmkods. Drīkst lietot, mainīt un iebūvēt
savos e-pakalpojumos (arī latvija.lv), saglabājot autortiesību paziņojumu.

## Nosaukums

Produkta nosaukums ir `src/brand.ts` un `server/brand.ts` — maini abus un `index.html`.
