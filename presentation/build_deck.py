"""
Vienotais Zemes Reģistrs — 10 minūšu prezentācija (PowerPoint, latviski).

Palaišana:
    python3 -m venv .venv && .venv/bin/pip install python-pptx pillow
    .venv/bin/python build_deck.py

Ievade:  clips/*.mp4, posters/*.png, assets/*.jpg
Izvade:  Vienotais-Zemes-Registrs-prezentacija.pptx
"""
from __future__ import annotations

from pathlib import Path

from lxml import etree
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).parent
CLIPS = HERE / "clips"
POSTERS = HERE / "posters"
ASSETS = HERE / "assets"
CACHE = HERE / "assets" / "_prepared"
CACHE.mkdir(exist_ok=True)

# ── Palete: tā pati loģika, kas lietotnē (Apple sistēmas krāsas, tumšais režīms)
INK = RGBColor(0x0B, 0x12, 0x20)      # fons
CARD = RGBColor(0xFF, 0xFF, 0xFF)     # kartes (ar alfa)
WHITE = RGBColor(0xF5, 0xF7, 0xFA)
MUTED = RGBColor(0x9A, 0xA7, 0xBD)
BLUE = RGBColor(0x0A, 0x84, 0xFF)     # systemBlue
RED = RGBColor(0xFF, 0x45, 0x3A)      # systemRed — tikai nelabvēlīgam
GREEN = RGBColor(0x30, 0xD1, 0x58)    # systemGreen
FONT = "Helvetica Neue"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
W = prs.slide_width
H = prs.slide_height
BLANK = prs.slide_layouts[6]


# ───────────────────────── palīgfunkcijas ─────────────────────────
def rounded_png(src: Path, radius: int = 56, scale: float = 2.0) -> Path:
    """Palielina bildi un nogriež stūrus — lai tumšās ilustrācijas neizskatītos kā kastes."""
    out = CACHE / (src.stem + "_r.png")
    if out.exists():
        return out
    img = Image.open(src).convert("RGBA")
    img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
    img.putalpha(mask)
    img.save(out)
    return out


def fullbleed_png(src: Path) -> Path:
    """Fona bilde uz pilnu 16:9 kadru (palielināta, lai nav pikseļu)."""
    out = CACHE / (src.stem + "_full.jpg")
    if out.exists():
        return out
    img = Image.open(src).convert("RGB").resize((2560, 1440), Image.LANCZOS)
    img.save(out, quality=92)
    return out


def new_slide(notes: str, bg: Path | None = None):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = INK
    if bg is not None:
        s.shapes.add_picture(str(fullbleed_png(bg)), 0, 0, W, H)
    s.notes_slide.notes_text_frame.text = notes
    # Mīksta pārejas animācija starp slaidiem (fade), kā keynote.
    trans = etree.SubElement(s._element, qn("p:transition"), spd="med")
    etree.SubElement(trans, qn("p:fade"))
    clr = s._element.find(qn("p:clrMapOvr"))
    if clr is not None:
        clr.addnext(trans)
    return s


def text(slide, x, y, w, h, content, size=20, bold=False, color=WHITE, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, spacing=None, tracking=None):
    """Teksta lodziņš. `content` var būt str vai saraksts ar rindkopām."""
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    paras = content if isinstance(content, list) else [content]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if spacing:
            p.space_after = Pt(spacing)
        r = p.add_run()
        r.text = para
        r.font.name = FONT
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color
        if tracking:
            r._r.get_or_add_rPr().set("spc", str(tracking))
    return tb


def card(slide, x, y, w, h, alpha=10, radius=0.06, line=None):
    """Stikla kartīte: balts ar zemu necaurspīdību (backdrop-blur tuvinājums)."""
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.adjustments[0] = radius
    shp.fill.solid()
    shp.fill.fore_color.rgb = CARD
    clr = shp.fill._xPr.find(qn("a:solidFill")).find(qn("a:srgbClr"))
    etree.SubElement(clr, qn("a:alpha"), val=str(alpha * 1000))
    if line is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line
        shp.line.width = Pt(1)
    shp.shadow.inherit = False
    return shp


def pill(slide, x, y, w, label, color=BLUE, size=13):
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(0.36))
    shp.adjustments[0] = 0.5
    shp.fill.solid()
    shp.fill.fore_color.rgb = color
    clr = shp.fill._xPr.find(qn("a:solidFill")).find(qn("a:srgbClr"))
    etree.SubElement(clr, qn("a:alpha"), val="22000")
    shp.line.color.rgb = color
    shp.line.width = Pt(1)
    shp.shadow.inherit = False
    tf = shp.text_frame
    tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = label
    r.font.name = FONT
    r.font.size = Pt(size)
    r.font.bold = True
    r.font.color.rgb = color if color != BLUE else RGBColor(0x64, 0xB5, 0xFF)
    return shp


def eyebrow(slide, label, x=0.8, y=0.62):
    text(slide, x, y, 8, 0.3, label.upper(), size=12, bold=True, color=BLUE, tracking=180)


def title(slide, content, x=0.8, y=0.95, w=11.7, size=40):
    text(slide, x, y, w, 1.4, content, size=size, bold=True, color=WHITE)


def video(slide, name, x, y, w, h):
    """Klips ar plānu rāmi; plakāts ir pirmais kadrs, ko redz pirms atskaņošanas."""
    card(slide, x - 0.07, y - 0.07, w + 0.14, h + 0.14, alpha=14, radius=0.025)
    return slide.shapes.add_movie(
        str(CLIPS / f"{name}.mp4"), Inches(x), Inches(y), Inches(w), Inches(h),
        poster_frame_image=str(POSTERS / f"{name}.png"), mime_type="video/mp4",
    )


def bullets(slide, x, y, w, items, size=20, gap=0.62, dot=BLUE):
    for i, item in enumerate(items):
        yy = y + i * gap
        d = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(yy + 0.11), Inches(0.12), Inches(0.12))
        d.fill.solid()
        d.fill.fore_color.rgb = dot
        d.line.fill.background()
        d.shadow.inherit = False
        text(slide, x + 0.3, yy, w - 0.3, gap, item, size=size, color=WHITE)


def footer(slide, label="ZEMES KARTE"):
    text(slide, 0.8, 7.0, 4, 0.25, label, size=9, bold=True, color=MUTED, tracking=220)


# ───────────────────────── 1. Titulslaids (0:00 – 0:20) ─────────────────────────
s = new_slide(
    "[0:00–0:20] Sveiki. Es rādīšu vienu lietu — karti, kurā uzklikšķini uz jebkura zemes gabala Latvijā "
    "un uzreiz redzi visu, ko valsts par to jau ir publicējusi atvērti. Bez pieteikšanās, bez maksas, bez atslēgām.",
    bg=ASSETS / "bg-title.jpg",
)
text(s, 0.9, 2.55, 11, 1.6, "Vienotais Zemes Reģistrs", size=52, bold=True)
text(s, 0.95, 3.95, 8, 0.7, "Uzklikšķini zemei. Redzi visu.", size=30, color=RGBColor(0x64, 0xB5, 0xFF))
text(s, 0.95, 5.9, 8, 0.4, "ATVĒRTO DATU HAKATONS  ·  LATVIJA", size=13, bold=True, color=MUTED, tracking=220)

# ───────────────────────── 2. Āķis (0:20 – 0:50) ─────────────────────────
s = new_slide(
    "[0:20–0:50] Iedomājieties: jūs pērkat zemes gabalu. Vai tas atrodas plūdu zonā? Vai tur ir aizsargājama daba? "
    "Kas tur atļauts būvēt? Atbilde ir publiska — bet sadalīta vienpadsmit avotos. Tas ir tas, ko mēs saliekam vienā klikšķī.",
)
eyebrow(s, "Jautājums")
title(s, ["Pērc zemes gabalu.", "Vai zini, kas ar to nav kārtībā?"], size=54, y=1.1)
for i, (big, small) in enumerate([("11", "atvērto datu avoti"), ("11", "dažādas vietnes"), ("0", "vietas, kur viss kopā")]):
    x = 0.8 + i * 4.0
    card(s, x, 4.1, 3.7, 2.2, alpha=8)
    text(s, x + 0.35, 4.3, 3.2, 1.2, big, size=72, bold=True, color=RED if big == "0" else RGBColor(0x64, 0xB5, 0xFF))
    text(s, x + 0.35, 5.6, 3.2, 0.5, small, size=18, color=MUTED)
footer(s)

# ───────────────────────── 3. Problēma (0:50 – 1:40) ─────────────────────────
s = new_slide(
    "[0:50–1:40] Latvija ir izdarījusi grūto daļu — dati ir atvērti. Bet īpašums ir vienā reģistrā, plūdi citā, "
    "zonējums trešā, būvniecība ceturtā. Katram sava koordinātu sistēma; vienā servisā platums ir pirmais, citā — garums. "
    "Cilvēks, kuram vienkārši jāpieņem lēmums, šo darbu nevar paveikt. Tāpēc pārskata nav.",
    bg=ASSETS / "art-problem.jpg",
)
eyebrow(s, "Problēma")
title(s, ["Dati ir atvērti.", "Pārskata nav."], size=54, y=1.1, w=7)
bullets(
    s, 0.8, 3.7, 6.2,
    [
        "Īpašums vienā reģistrā, plūdi citā, zonējums trešā.",
        "Katram sava koordinātu sistēma un formāts.",
        "Vienā servisā vispirms platums, citā — garums.",
        "Cilvēkam vajag atbildi, nevis vienpadsmit cilnes.",
    ],
    size=19, gap=0.78,
)
footer(s)

# ───────────────────────── 4. Risinājums + klips (1:40 – 3:10) ─────────────────────────
s = new_slide(
    "[1:40–3:10] Šeit ir produkts. Ieraksta nav — tas ir īstais ekrāns. Uzklikšķinu uz zemes gabala Āgenskalnā. "
    "Pēc sekundes ir kontūra un kadastra numurs. Tad rindas sāk piepildīties pa vienai: tiklīdz kāds avots atbild, "
    "tā rinda parādās. Lēnie servisi neaizkavē ātros. Zem katras rindas — avots, laiks, un divas saites: "
    "uz oficiālo reģistru un uz precīzo pieprasījumu. Ritinu: īpašums, ierobežojumi, plānošana, būvniecība, ES nauda, uzņēmumi.",
)
eyebrow(s, "Risinājums")
text(s, 0.8, 0.95, 4.2, 2.0, ["Viens", "klikšķis."], size=46, bold=True)
bullets(
    s, 0.8, 3.1, 3.9,
    [
        "Kontūra ~1 sekundē.",
        "Rindas piepildās pa vienai.",
        "Katrai — avots un pieprasījums.",
    ],
    size=17, gap=0.8,
)
video(s, "klikskis", 5.05, 1.05, 7.8, 4.875)
text(s, 5.05, 6.2, 7.8, 0.4, "Tiešraides ieraksts · Rīga, Āgenskalns · bez montāžas", size=12, color=MUTED)
footer(s)

# ───────────────────────── 5. Slāņi (3:10 – 4:20) ─────────────────────────
s = new_slide(
    "[3:10–4:20] Karte nav tikai fons. Pieci slāņi. Kadastrs — zemes vienību robežas, parādās no tuvinājuma 17. "
    "Plūdi — LVĢMC jūras vējuzplūdu kartes reizi 10, 100 un 200 gados; redziet — Vecāķu piekraste. "
    "Zonējums — TAPIS funkcionālais zonējums Rīgas centrā. Daba — Ozols aizsargājamās teritorijas. "
    "Pārslēdzējs ir sliežu kontrole kā iOS: pirkstiņš slīd ar atsperes animāciju.",
)
eyebrow(s, "Slāņi")
text(s, 0.8, 0.95, 4.2, 2.0, ["Pieci slāņi.", "Viena karte."], size=42, bold=True)
for i, (name, src) in enumerate(
    [("Vieta", "OpenStreetMap"), ("Kadastrs", "VZD robežas"), ("Plūdi", "LVĢMC · 10 / 100 / 200 g."),
     ("Zonējums", "TAPIS"), ("Daba", "Ozols · ĪADT")]
):
    y = 3.0 + i * 0.7
    text(s, 0.8, y, 1.7, 0.4, name, size=18, bold=True, color=WHITE)
    text(s, 2.5, y + 0.03, 2.6, 0.4, src, size=14, color=MUTED)
video(s, "slani", 5.3, 0.9, 7.5, 4.69)
text(s, 5.3, 5.9, 7.5, 0.5, "Slāņu flīzes nāk tieši no valsts serveriem — mūsu serveris tās negriež.", size=13, color=MUTED)
footer(s)

# ───────────────────────── 6. Pierādījums (4:20 – 5:00) ─────────────────────────
s = new_slide(
    "[4:20–5:00] Svarīgākā rinda — katram faktam līdzi nāk pierādījums. «Avots» ved uz oficiālo reģistru. "
    "«Pieprasījums» ved uz precīzo API izsaukumu, kas šo vērtību atdeva — redzat, tā ir tīra atbilde no data.gov.lv. "
    "Mēs neko neizdomājam un nevērtējam. Ja jūs mums neticat — pārbaudiet.",
)
eyebrow(s, "Pierādījums")
text(s, 0.8, 0.95, 4.3, 2.4, ["Neticiet", "mums.", "Pārbaudiet."], size=44, bold=True)
text(s, 0.8, 3.8, 4.0, 2.0,
     ["Avots — oficiālais reģistrs uz šo ierakstu.", "Pieprasījums — precīzais izsaukums, kas atdeva vērtību."],
     size=17, color=MUTED, spacing=10)
video(s, "pierad", 5.3, 1.0, 7.5, 4.69)
text(s, 5.3, 5.95, 7.5, 0.4, "data.gov.lv atbilde pieprasījumam — tā pati, ko redzēja serveris.", size=13, color=MUTED)
footer(s)

# ───────────────────────── 7. Ko saņem (5:00 – 5:40) ─────────────────────────
s = new_slide(
    "[5:00–5:40] Ko jūs saņemat pēc viena klikšķa: īpašums, ierobežojumi, plūdi, daba, būvniecība, ES nauda. "
    "Un — ja adrese ir juridiskai personai — VID reitings, de minimis, iepirkumi. Šeit Kaļķu iela 1, Latvenergo: "
    "reitings A, 57 tūkstoši eiro de minimis. Nav vērtējuma no mums — tikai tas, ko reģistri jau zināja.",
)
eyebrow(s, "Ko tu saņem")
text(s, 0.8, 0.95, 4.3, 1.6, ["Seši jautājumi.", "Viena atbilde."], size=32, bold=True)
items = [
    ("Īpašums", "tiesības, adrese, saistītie objekti"),
    ("Ierobežojumi", "apgrūtinājumi pēc ATIS"),
    ("Plūdi", "reizi 10, 100, 200 gados"),
    ("Daba", "ĪADT, mikroliegumi"),
    ("Būvniecība", "BIS lietas pēc būves"),
    ("Uzņēmums", "VID, de minimis, iepirkumi"),
]
for i, (a, b) in enumerate(items):
    y = 2.55 + i * 0.62
    text(s, 0.8, y, 4.2, 0.32, a, size=17, bold=True)
    text(s, 0.8, y + 0.28, 4.2, 0.28, b, size=13, color=MUTED)
video(s, "uznemums", 5.3, 1.0, 7.5, 4.69)
text(s, 5.3, 5.95, 7.5, 0.4, "Kaļķu iela 1 · reģ. nr. 40003032949 · Latvenergo — reitings A.", size=13, color=MUTED)
footer(s)

# ───────────────────────── 8. Reāls piemērs: plūdi (5:40 – 6:10) ─────────────────────────
s = new_slide(
    "[5:40–6:10] Reāls piemērs. Vecāķi, 5,8 hektāru gabals pie jūras. Plūdu slānis rāda svītrojumu, "
    "un rinda panelī saka to pašu: reizi 10 gados — Nē, reizi 100 gados — Jā, jūras vējuzplūdi. "
    "Karte un skaitlis nevar runāt pretī, jo abi nāk no viena avota.",
)
eyebrow(s, "Reāls piemērs")
text(s, 0.8, 0.95, 4.3, 2.4, ["Vecāķi,", "5,8 ha."], size=44, bold=True)
card(s, 0.8, 3.1, 4.0, 2.7, alpha=8)
text(s, 1.1, 3.3, 3.5, 0.4, "KADASTRS 01001142213", size=11, bold=True, color=MUTED, tracking=140)
for i, (lab, val, col) in enumerate([("reizi 10 gados", "Nē", GREEN), ("reizi 100 gados", "Jā", RED), ("reizi 200 gados", "Jā", RED)]):
    y = 3.85 + i * 0.62
    text(s, 1.1, y + 0.04, 2.2, 0.4, lab, size=16, color=WHITE)
    pill(s, 3.5, y, 1.0, val, color=col, size=14)
video(s, "plusma", 5.3, 1.0, 7.5, 4.69)
text(s, 5.3, 5.95, 7.5, 0.4, "Klikšķis uz gabala · rinda: «Jā — jūras vējuzplūdi».", size=13, color=MUTED)
footer(s)

# ───────────────────────── 9. Meklēšana + telefons (6:10 – 6:50) ─────────────────────────
s = new_slide(
    "[6:10–6:50] Ja klikšķināt negribas — rakstiet adresi vai 11 ciparu numuru. Karte aizlido un atver to pašu pārskatu. "
    "Un tas pats darbojas telefonā: pārskats kļūst par apakšējo loksni ar trim pozīcijām, ko velk ar pirkstu — "
    "tieši kā Apple Maps. Desktops, planšete, telefons — viens kods, trīs izkārtojumi.",
)
eyebrow(s, "Meklēšana un telefons")
text(s, 0.8, 0.95, 8, 0.9, "Raksti. Velc. Klikšķini.", size=38, bold=True)
video(s, "meklesana", 0.8, 2.05, 7.2, 4.5)
text(s, 0.8, 6.7, 7.2, 0.3, "Adrese → Nominatim → tas pats klikšķa ceļš.", size=12, color=MUTED)
video(s, "telefons", 9.4, 0.85, 2.95, 6.39)
footer(s)

# ───────────────────────── 10. Arhitektūra (6:50 – 7:50) ─────────────────────────
s = new_slide(
    "[6:50–7:50] Kā tas darbojas. Pārlūks — React un Leaflet. Lokāls Express serveris — plāns tulks: "
    "viens vienkāršs JSON uz priekšu, desmit protokoli uz aizmuguri. Klikšķis kļūst par WFS INTERSECTS vaicājumu pret VZD zemes vienībām. "
    "Tad serveris paralēli jautā astoņus avotus un katrs raksta savu rindu SQLite, tiklīdz atbild. Pārlūks ik 0,8 sekundes jautā progresu. "
    "Kadastra īpašuma tiesības un apgrūtinājumi nāk no vietējā 1,5 gigabaitu indeksa, jo CKAN DataStore šos XML neatver.",
)
eyebrow(s, "Arhitektūra")
title(s, "Pārlūks jautā. Serveris tulko. Avoti atbild.", size=34, y=0.95)

def box(x, y, w, h, head, lines, accent=BLUE):
    card(s, x, y, w, h, alpha=9, radius=0.05)
    text(s, x + 0.25, y + 0.2, w - 0.5, 0.4, head, size=17, bold=True, color=accent)
    text(s, x + 0.25, y + 0.7, w - 0.5, h - 0.8, lines, size=12.5, color=WHITE, spacing=5)

box(0.8, 2.0, 3.2, 3.6, "PĀRLŪKS", ["React 18 + Leaflet", "Klikšķis → lat, lon", "Skeleti → rindas (spring)", "Slāņu flīzes tieši no valsts"])
box(4.7, 2.0, 3.9, 3.6, "LOKĀLAIS SERVERIS",
    ["Express · /api/parcel/at", "POST /api/parcel/report → jobId", "GET /api/jobs/:id (polling ~0,8 s)",
     "SQLite kešs · 24 h", "cadastre.sqlite · 1,5 GB · read-only"])
box(9.3, 2.0, 3.25, 3.6, "ATVĒRTIE AVOTI",
    ["VZD WFS (VISS)", "data.gov.lv CKAN DataStore", "TAPIS · Ozols · LVĢMC", "OSM + Nominatim"], accent=GREEN)
for x0 in (4.05, 8.65):
    ar = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(x0), Inches(3.55), Inches(0.58), Inches(0.42))
    ar.fill.solid()
    ar.fill.fore_color.rgb = BLUE
    ar.line.fill.background()
    ar.shadow.inherit = False
text(s, 0.8, 5.95, 11.7, 0.8,
     "Katrs avots raksta savu rindu, tiklīdz atbild. Lēns Ozols neaizklāj plūdu vai zonējuma rindu.",
     size=17, bold=True, color=RGBColor(0x64, 0xB5, 0xFF))
footer(s)

# ───────────────────────── 11. Atvērtie avoti (7:50 – 8:30) ─────────────────────────
s = new_slide(
    "[7:50–8:30] Visi vienpadsmit avoti ir publiski. Pārsvarā CC0 no data.gov.lv, pārējie — publiski ģeoservisi bez atslēgas. "
    "Nav maksas datu, nav skrāpēšanas, nav personas datu. Katram pieprasījumam ir identificējošs User-Agent, lai datu turētāji redz, kas jautā. "
    "Pilns saraksts ar licencēm un ierobežojumiem ir pašā lietotnē — poga «Dati».",
)
eyebrow(s, "Atvērtie avoti")
title(s, "Vienpadsmit avoti. Nulle atslēgu.", size=34, y=0.95)
rows = [
    ("Kadastrs", "VZD", "īpašums, adrese, apgrūtinājumi", "CC0"),
    ("ATIS", "VZD", "apgrūtinājumu klasifikators", "CC0"),
    ("Zonējums", "VRAA · TAPIS", "funkcionālais zonējums", "publisks WFS"),
    ("Plūdi", "LVĢMC", "10 / 100 / 200 gadi", "atvērti ģeodati"),
    ("Daba", "DAP · Ozols", "ĪADT, mikroliegumi", "CC0"),
    ("Būvniecība", "BVKB · BIS", "ēkas un lietas", "CC0"),
    ("ES projekti", "FM", "īstenošanas vietas", "CC0"),
    ("Uzņēmumi", "UR", "subjekti pēc adreses koda", "CC0"),
    ("VID reitings", "VID", "nodokļu maksātāju reitings", "CC0"),
    ("De minimis", "FM", "piešķirtais atbalsts", "CC0"),
    ("Iepirkumi", "IUB · EIS", "izsludinātie iepirkumi", "CC0"),
]
tbl = s.shapes.add_table(len(rows) + 1, 4, Inches(0.8), Inches(1.9), Inches(11.7), Inches(4.8)).table
for ci, wd in enumerate([2.2, 2.6, 4.7, 2.2]):
    tbl.columns[ci].width = Inches(wd)
def cell(r, c, val, bold=False, color=WHITE, fill=None, size=13):
    ce = tbl.cell(r, c)
    ce.text = ""
    p = ce.text_frame.paragraphs[0]
    run = p.add_run()
    run.text = val
    run.font.name = FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    ce.margin_top = ce.margin_bottom = Inches(0.03)
    ce.fill.solid()
    ce.fill.fore_color.rgb = fill or INK
for ci, head in enumerate(["Avots", "Turētājs", "Ko dod", "Licence"]):
    cell(0, ci, head.upper(), bold=True, color=BLUE, fill=RGBColor(0x14, 0x1E, 0x33), size=11)
for ri, row in enumerate(rows, start=1):
    shade = RGBColor(0x10, 0x19, 0x2B) if ri % 2 else INK
    for ci, val in enumerate(row):
        cell(ri, ci, val, bold=(ci == 0), color=(WHITE if ci != 3 else MUTED), fill=shade)
footer(s)

# ───────────────────────── 12. Inženierija (8:30 – 9:20) ─────────────────────────
s = new_slide(
    "[8:30–9:20] Kas bija grūti. Pirmkārt — asu secība. Tas pats VZD serviss: INTERSECTS prasa platumu pirms garuma, "
    "bet BBOX — garumu pirms platuma. VARIS kolonnas KOORD_X un KOORD_Y ir apgrieztas. Otrkārt — kadastra īpašuma dati ir 4,9 gigabaitu XML, "
    "ko DataStore neatver; mēs tos straumējam SQLite indeksā un meklējam milisekundēs. Treškārt — ātrums: katrs avots raksta savu rindu. "
    "Ceturtkārt — godīgums: ja serviss nav pieejams, rinda saka «Avots neatbildēja», nevis «Nē». Pārejoši kļūdas netiek iekešotas.",
)
eyebrow(s, "Inženierija")
title(s, "Četras lietas, kas gandrīz salauza.", size=36, y=0.95)
cards = [
    ("Asu secība", "INTERSECTS: platums, garums.\nBBOX: garums, platums.\nVARIS: X un Y apmainīti vietām.", RED),
    ("4,9 GB XML", "DataStore tos neatver. Straumējam\nuz SQLite — 4,8 milj. apgrūtinājumu,\nmeklēšana milisekundēs.", BLUE),
    ("Lēnie avoti", "Katrs raksta savu rindu, tiklīdz\natbild. Skeleti → rindas.\nNeviens neaizkavē pārējos.", BLUE),
    ("Godīgs «nav»", "Serviss nokrita ≠ «Nē».\nPārejošas kļūdas netiek\niekešotas uz 24 stundām.", GREEN),
]
for i, (head, body, col) in enumerate(cards):
    x = 0.8 + (i % 2) * 6.0
    y = 2.1 + (i // 2) * 2.45
    card(s, x, y, 5.7, 2.2, alpha=9, radius=0.05)
    text(s, x + 0.35, y + 0.28, 5, 0.5, head, size=22, bold=True, color=col if col != BLUE else RGBColor(0x64, 0xB5, 0xFF))
    text(s, x + 0.35, y + 0.92, 5, 1.2, body.split("\n"), size=14, color=MUTED, spacing=3)
footer(s)

# ───────────────────────── 13. Izrāviens + tālāk (9:20 – 9:50) ─────────────────────────
s = new_slide(
    "[9:20–9:50] Kāpēc tas ir izrāviens. Pirmo reizi viens klikšķis savieno vienpadsmit valsts reģistrus. "
    "Bez atslēgām, bez maksas, bez personas datiem — un katrs fakts ir pārbaudāms. "
    "Un tas ir paplašināms: jauns avots ir viens adapters un viena rinda. Tālāk — pašvaldību dati, gabalu salīdzināšana "
    "un brīdinājumi, kad mainās kāds gabals, ko jūs sekojat.",
)
eyebrow(s, "Izrāviens")
text(s, 0.8, 0.95, 6.0, 1.8, ["Dati bija atvērti.", "Tagad tie ir lietojami."], size=36, bold=True)
bullets(
    s, 0.8, 3.0, 5.8,
    [
        "Vienpadsmit reģistri vienā klikšķī.",
        "Katrs fakts — ar avotu un pieprasījumu.",
        "Bez atslēgām, maksas un personas datiem.",
        "Jauns avots = viens adapters + viena rinda.",
    ],
    size=18, gap=0.82,
)
card(s, 7.3, 1.0, 5.25, 5.4, alpha=9, radius=0.04)
text(s, 7.7, 1.3, 4.5, 0.4, "TĀLĀK", size=12, bold=True, color=BLUE, tracking=200)
for i, (a, b) in enumerate([
    ("Pašvaldību dati", "detālplānojumi, nodevas, nekustamā īpašuma nodoklis"),
    ("Salīdzini gabalus", "divi kadastri blakus — atšķirības izceltas"),
    ("Sekojiet gabalam", "brīdinājums, kad mainās kāda rinda"),
    ("Atvērts API", "tā pati atbilde citiem — mašīnlasāms JSON jau ir"),
]):
    y = 1.9 + i * 1.12
    text(s, 7.7, y, 4.5, 0.4, a, size=19, bold=True)
    text(s, 7.7, y + 0.4, 4.5, 0.55, b, size=13, color=MUTED)
footer(s)

# ───────────────────────── 14. Noslēgums (9:50 – 10:00) ─────────────────────────
s = new_slide(
    "[9:50–10:00] Vienotais Zemes Reģistrs. Uzklikšķiniet zemei. Redziet visu. Paldies — jautājumi.",
    bg=ASSETS / "bg-close.jpg",
)
text(s, 7.4, 2.4, 5.5, 1.6, ["Uzklikšķini zemei.", "Redzi visu."], size=44, bold=True)
text(s, 7.4, 4.55, 5.5, 0.5, "Paldies.", size=26, color=RGBColor(0x64, 0xB5, 0xFF))
text(s, 7.4, 5.6, 5.5, 0.9,
     ["npm run dev  →  localhost:5173", "Dokumentācija: docs/ARHITEKTURA.md"],
     size=13, color=MUTED, spacing=4)

out = HERE / "Vienotais-Zemes-Registrs-prezentacija.pptx"
prs.save(out)
print("saglabāts:", out, f"({out.stat().st_size / 1e6:.1f} MB)")
