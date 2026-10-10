"""
Vienotais Zemes Reģistrs — hakatona prezentācija (v2, latvija.gov.lv stilā, LV).

Struktūra (pēc žūrijas prasības):
    1. Titulslaids
    2. Problēmas raksturojums — iedzīvotāja puse + CFLA / valsts pārvaldes puse
    3. Mūsu risinājuma apraksts
    4. Līdzīgo risinājumu salīdzinājums (bezmaksas, atvērtais kods, latvija.lv)
    5. Demonstrācija — vairāki slaidi ar video, ieskaitot JSON → AI čatbots

Palaišana:
    .venv/bin/python build_deck_hackathon.py

Ievade:
    clips/*.mp4, posters/*.png         ← node clips.mjs + ./convert.sh
    ai-sources/measure.json            ← node ai-measure.mjs (tokenu skaitļi)
Izvade:
    Vienotais-Zemes-Registrs-hakatons.pptx
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import qrcode
from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

HERE = Path(__file__).parent
CLIPS = HERE / "clips"
POSTERS = HERE / "posters"
MEASURE = HERE / "ai-sources" / "measure.json"
LIVE_URL = "https://172.82.74.224.sslip.io/hakatons/"

# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Palete — tā pati, kas lietotnē (src/index.css) un portals.pptx.      ║
# ║  Akcents (sarkanbrūnais) tikai galvenajam skaitlim vai vārdam slaidā. ║
# ╚══════════════════════════════════════════════════════════════════════╝
BG = RGBColor(0xF4, 0xF7, 0xFB)
SURFACE = RGBColor(0xFF, 0xFF, 0xFF)
TINT = RGBColor(0xE9, 0xF2, 0xFC)
INK = RGBColor(0x1C, 0x1C, 0x1C)
MUTED = RGBColor(0x4A, 0x4E, 0x56)
FAINT = RGBColor(0x5C, 0x65, 0x70)
LINE = RGBColor(0xC1, 0xD2, 0xE5)
ACCENT = RGBColor(0xA0, 0x1B, 0x36)
ACCENT_DEEP = RGBColor(0x7D, 0x15, 0x29)
ACCENT_SOFT = RGBColor(0xFB, 0xEC, 0xEF)
MAP_BLUE = RGBColor(0x2B, 0x6C, 0xB0)
GREEN = RGBColor(0x1B, 0x6B, 0x38)
GREEN_SOFT = RGBColor(0xE6, 0xF4, 0xEA)
ORANGE = RGBColor(0xC4, 0x5C, 0x00)
ORANGE_SOFT = RGBColor(0xFD, 0xF0, 0xE3)
GREY_SOFT = RGBColor(0xEE, 0xF0, 0xF3)
FONT = "Ubuntu"

# ── Tokenu mērījums: ņemam īstos skaitļus, nevis izdomātus
M = json.loads(MEASURE.read_text(encoding="utf-8"))
JSON_TOK = M["export"]["tokens"]
SRC_TOK = M["sources"]["tokensText"]
SRC_DOCS = M["sources"]["documents"]
SRC_PORTALS = M["sources"]["portals"]
RATIO = M["ratioText"]
RATIO_NO_TAPIS = M["ratioTextWithoutLargest"]


def lv_int(n: int) -> str:
    """957708 → '957 708' (latviešu tūkstošu atdalītājs — atstarpe)."""
    return f"{n:,}".replace(",", " ")


# ── 16:9, tukšs izkārtojums — visu zīmējam paši
prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SLIDE_NO = [0]


# ════════════════════════════════════════════════════════════════════════
#  Pamata palīgi
# ════════════════════════════════════════════════════════════════════════
def new_slide(notes: str, bg=BG):
    """Jauns slaids ar fonu, runātāja piezīmēm un maigu fade pāreju."""
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = bg
    s.notes_slide.notes_text_frame.text = notes

    # Fade pāreja — p:transition jāieliek uzreiz aiz clrMapOvr, citādi PowerPoint to ignorē
    trans = etree.SubElement(s._element, qn("p:transition"), spd="med")
    etree.SubElement(trans, qn("p:fade"))
    clr = s._element.find(qn("p:clrMapOvr"))
    if clr is not None:
        clr.addnext(trans)

    SLIDE_NO[0] += 1
    return s


def text(slide, x, y, w, h, content, size=20, bold=False, color=INK, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, spacing=None, tracking=None, line=None):
    """
    Teksta bloks. `content` var būt virkne, saraksts (rindkopas) vai saraksts ar
    (teksts, krāsa, treknraksts) kortežiem vienas rindkopas iekšienē — tā var
    iekrāsot vienu vārdu teikumā.
    """
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
        if line:
            p.line_spacing = line

        # Rindkopa ir vai nu vienkārša virkne, vai segmentu kortežs
        runs = para if isinstance(para, tuple) else ((para, color, bold),)
        for seg in runs:
            seg_text, seg_color, seg_bold = seg if isinstance(seg, tuple) else (seg, color, bold)
            r = p.add_run()
            r.text = seg_text
            r.font.name = FONT
            r.font.size = Pt(size)
            r.font.bold = seg_bold
            r.font.color.rgb = seg_color
            if tracking:
                r._r.get_or_add_rPr().set("spc", str(tracking))
    return tb


def card(slide, x, y, w, h, fill=SURFACE, radius=0.06, line=LINE):
    """Portāla kartīte — balta virsma ar matiņa apmali, bez ēnas."""
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.adjustments[0] = radius
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    if line is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line
        shp.line.width = Pt(1)
    shp.shadow.inherit = False
    return shp


def rect(slide, x, y, w, h, fill):
    """Plakans taisnstūris (joslas, progresa stieņi)."""
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def accent_bar(slide, x, y, w=0.08, h=0.9, color=ACCENT):
    return rect(slide, x, y, w, h, color)


def pill(slide, x, y, w, label, color=ACCENT, fill=TINT, size=12, h=0.34):
    """Kapsula ar tekstu — statusi «Jā / Nē / Atbilst», birkas, demo numuri."""
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.adjustments[0] = 0.5
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    shp.line.color.rgb = color
    shp.line.width = Pt(1)
    shp.shadow.inherit = False
    tf = shp.text_frame
    tf.margin_top = tf.margin_bottom = 0
    tf.margin_left = tf.margin_right = Inches(0.05)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = label
    r.font.name = FONT
    r.font.size = Pt(size)
    r.font.bold = True
    r.font.color.rgb = color
    return shp


def eyebrow(slide, label, x=0.8, y=0.55, color=ACCENT):
    """Mazais virsraksts virs lielā — sadaļas nosaukums ar platāku burtu atstarpi."""
    text(slide, x, y, 11, 0.28, label.upper(), size=11, bold=True, color=color, tracking=160)


def title(slide, content, x=0.8, y=0.85, w=11.7, size=36, h=1.35):
    text(slide, x, y, w, h, content, size=size, bold=True, color=INK, line=0.95)


def footer(slide, section=""):
    """Apakšējā josla: produkts kreisajā, sadaļa + slaida nr. labajā."""
    text(slide, 0.8, 7.05, 6, 0.25, "VIENOTAIS ZEMES REĢISTRS", size=9, bold=True, color=FAINT, tracking=180)
    right = f"{section}  ·  {SLIDE_NO[0]:02d}" if section else f"{SLIDE_NO[0]:02d}"
    text(slide, 7.5, 7.05, 5.0, 0.25, right, size=9, color=FAINT, align=PP_ALIGN.RIGHT)


def video(slide, name, x, y, w, h):
    """
    Iegults klips ar plakātu (vidējais kadrs no convert.sh). Apkārt balta
    kartīte, lai video izskatās kā logs portālā, nevis «uzlīmēts».
    """
    card(slide, x - 0.06, y - 0.06, w + 0.12, h + 0.12, fill=SURFACE, radius=0.035)
    mp4 = CLIPS / f"{name}.mp4"
    poster = POSTERS / f"{name}.png"
    if not mp4.exists():
        text(slide, x, y + h / 2 - 0.2, w, 0.4, f"[nav klipa: {name}]", size=14, color=MUTED, align=PP_ALIGN.CENTER)
        return None
    return slide.shapes.add_movie(
        str(mp4), Inches(x), Inches(y), Inches(w), Inches(h),
        poster_frame_image=str(poster) if poster.exists() else None,
        mime_type="video/mp4",
    )


def bullets(slide, x, y, w, items, size=16, gap=0.55, dot=ACCENT, color=INK):
    """Punktu saraksts ar apaļiem akcenta punktiem (nevis teksta «•»)."""
    for i, item in enumerate(items):
        yy = y + i * gap
        d = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(yy + 0.1), Inches(0.11), Inches(0.11))
        d.fill.solid()
        d.fill.fore_color.rgb = dot
        d.line.fill.background()
        d.shadow.inherit = False
        text(slide, x + 0.28, yy, w - 0.28, gap, item, size=size, color=color)


def arrow(slide, x1, y1, x2, y2, color=LINE, width=2.0):
    """Taisna bulta diagrammām (avoti → API → izvade)."""
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = color
    c.line.width = Pt(width)
    ln = c.line._get_or_add_ln()
    etree.SubElement(ln, qn("a:tailEnd"), type="triangle", w="med", len="med")
    return c


def qr(slide, url, x, y, size):
    """QR kods uz tiešraides versiju — žūrija var atvērt telefonā, kamēr runājam."""
    img = qrcode.make(url, border=1)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    slide.shapes.add_picture(buf, Inches(x), Inches(y), Inches(size), Inches(size))


# ════════════════════════════════════════════════════════════════════════
#  Demo slaida veidne — video pa labi, stāsts un 3 izsaucieni pa kreisi.
#  Visiem demo slaidiem viens režģis, lai acs nav jāpārorientē.
# ════════════════════════════════════════════════════════════════════════
def demo_slide(no, total, who, headline, story, callouts, clip, caption, notes):
    s = new_slide(notes)
    eyebrow(s, f"Demonstrācija  ·  {no} / {total}  ·  {who}")
    text(s, 0.8, 0.9, 4.3, 1.6, headline, size=30, bold=True, line=0.95)
    text(s, 0.8, 2.55, 4.1, 1.0, story, size=14, color=MUTED, line=1.1)

    # Izsaucieni — ko skatītājam pamanīt video
    for i, (tag, tag_color, tag_fill, body) in enumerate(callouts):
        y = 3.75 + i * 0.95
        pill(s, 0.8, y, 1.25, tag, color=tag_color, fill=tag_fill, size=11)
        text(s, 2.2, y + 0.02, 2.9, 0.85, body, size=13, color=INK, line=1.05)

    # Video — 16:10 klipi (1600×1000), tāpēc augstums = platums × 0.625
    video(s, clip, 5.35, 0.95, 7.4, 4.625)
    text(s, 5.35, 5.78, 7.4, 0.35, caption, size=11, color=MUTED)
    footer(s, "Demonstrācija")
    return s


YES = ("Jā", ACCENT, ACCENT_SOFT)
NO = ("Nē", MUTED, GREY_SOFT)
FIT = ("Atbilst", GREEN, GREEN_SOFT)
NOFIT = ("Neatbilst", MUTED, GREY_SOFT)
INFO = ("Avots", MAP_BLUE, TINT)


# ════════════════════════════════════════════════════════════════════════
#  1. TITULSLAIDS
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[0:00–0:30] Labdien. Mēs esam Vienotais Zemes Reģistrs. "
    "Viena karte, kurā uzklikšķini uz jebkuras zemes vienības Latvijā un redzi visu, ko valsts par to jau publicējusi "
    "atvērti — 19 avotos, vienā panelī, ar saiti uz katru oficiālo ierakstu. "
    "Nākamās desmit minūtes: problēma no divām pusēm, risinājums, salīdzinājums un — galvenais — demonstrācija."
)
# Kreisā puse — nosaukums un solījums
accent_bar(s, 0.8, 1.9, 0.1, 2.05)
text(s, 1.15, 1.75, 6.8, 0.4, "ATVĒRTO DATU HAKATONS 2026", size=12, bold=True, color=ACCENT, tracking=180)
text(s, 1.15, 2.15, 6.8, 1.6, ["Vienotais", "Zemes Reģistrs"], size=50, bold=True, line=0.9)
text(s, 1.15, 3.95, 6.6, 0.5, "Uzklikšķini zemei. Redzi visu.", size=24, color=ACCENT_DEEP)

# Trīs skaitļi — produkts vienā rindā
for i, (big, small) in enumerate([("19", "atvērtie avoti"), ("1", "klikšķis"), ("0 €", "maksa")]):
    x = 1.15 + i * 2.1
    text(s, x, 4.95, 1.9, 0.7, big, size=34, bold=True, color=INK if i < 2 else ACCENT)
    text(s, x, 5.65, 1.9, 0.35, small, size=13, color=MUTED)
pill(s, 1.15, 6.3, 2.9, "Atvērtais kods · MIT", color=GREEN, fill=GREEN_SOFT, size=11)

# Labā puse — reāls kadrs no produkta, bez rāmja trokšņa
poster = POSTERS / "pircejs.png"
card(s, 7.55, 0.9, 5.1, 5.9, fill=SURFACE, radius=0.04)
if poster.exists():
    # Apgriežam kadru, lai redz kontūru un paneli (attēls 1600×1000 → kadrs 5.0×5.8)
    pic = s.shapes.add_picture(str(poster), Inches(7.6), Inches(0.95), Inches(5.0), Inches(5.8))
    pic.crop_left = 0.20
    pic.crop_right = 0.0
    pic.crop_top = 0.0
    pic.crop_bottom = 0.0
footer(s)


# ════════════════════════════════════════════════════════════════════════
#  2. PROBLĒMA — iedzīvotāja / pircēja / īpašnieka puse
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[0:30–1:30] Problēma, pirmā puse — cilvēks. Ilze sludinājumā redz zemi pie jūras. Lai saprastu, vai tur var celt māju, "
    "viņai jāatver kadastrs, zemesgrāmata, ATIS apgrūtinājumi, TAPIS zonējums, LVĢMC plūdu karte, Ozols dabai, BIS būvniecībai. "
    "Ja grib atbalstu saules paneļiem — vēl CFLA, LVIF EKII, LIAA. Mēs to izmērījām vienai zemei: 16 portāli, 25 atsevišķi pieprasījumi. "
    "Dati ir atvērti. Bet katrs savā stūrī, katrs savā formātā, un neviens tos nesaliek kopā."
)
eyebrow(s, "Problēma  ·  1 / 2  ·  Iedzīvotājs")
title(s, ["Dati ir atvērti.", f"Bet izkaisīti {SRC_PORTALS} portālos."], size=38, h=1.4)

# Kreisā kolonna — Ilzes ceļš, viens jautājums = viens portāls
journey = [
    ("Kam pieder?", "kadastrs.lv · zemesgramata.lv"),
    ("Kas aizliegts?", "ATIS apgrūtinājumi"),
    ("Ko drīkst celt?", "TAPIS zonējums"),
    ("Vai applūst?", "LVĢMC plūdu kartes"),
    ("Vai ir daba?", "ozols.gov.lv"),
    ("Kāds atbalsts?", "CFLA · LVIF EKII · LIAA"),
]
card(s, 0.8, 2.45, 7.0, 4.3)
text(s, 1.1, 2.62, 6.4, 0.3, "ILZE PĒRK ZEMI VECĀĶOS. SEŠI JAUTĀJUMI —", size=10, bold=True, color=FAINT, tracking=120)
for i, (q, where) in enumerate(journey):
    y = 3.05 + i * 0.6
    text(s, 1.1, y, 2.4, 0.4, q, size=15, bold=True)
    text(s, 3.55, y + 0.02, 4.1, 0.4, where, size=14, color=MUTED)
    if i < len(journey) - 1:
        rect(s, 1.1, y + 0.5, 6.4, 0.01, LINE)

# Labā kolonna — izmērītie skaitļi
for i, (big, small, col) in enumerate([
    (str(SRC_PORTALS), "portāli vienai zemei", ACCENT),
    (str(SRC_DOCS), "atsevišķi pieprasījumi", INK),
    ("0", "vietas, kur tas viss kopā", INK),
]):
    y = 2.45 + i * 1.45
    card(s, 8.1, y, 4.45, 1.3, fill=SURFACE)
    text(s, 8.4, y + 0.18, 1.8, 0.9, big, size=44, bold=True, color=col)
    text(s, 10.05, y + 0.42, 2.4, 0.6, small, size=14, color=MUTED)
footer(s, "Problēma")


# ════════════════════════════════════════════════════════════════════════
#  3. PROBLĒMA — CFLA / valsts pārvaldes puse
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[1:30–2:30] Otra puse — valsts. CFLA vērtētājs saņem projekta iesniegumu par ēku. Viņam jāpārbauda: kam pieder zeme, "
    "vai pieteicējs vispār drīkst pieteikties konkrētajā atlasē, vai uz šī kadastra jau nav ES projekta — dubultā finansējuma risks, "
    "vai nav apgrūtinājumu, vai uzņēmumam nav pārsniegts de minimis. Tie ir pieci vai vairāk reģistri, ekrānšāviņi Word failā "
    "un nekādas atkārtojamas pēdas. Pašvaldības, LVIF, LIAA dara to pašu — katra atsevišķi. Tas ir dārgi, lēni un kļūdaini."
)
eyebrow(s, "Problēma  ·  2 / 2  ·  CFLA un valsts pārvalde")
title(s, ["Katrs vērtētājs", "saliek ainu no nulles."], size=38, h=1.4)

pains = [
    ("Manuāla pārbaude", "Īpašnieka veids, apgrūtinājumi, zonējums — katrs savā reģistrā, katram iesniegumam."),
    ("Dubultā finansējuma risks", "Vai uz šī kadastra jau ir ES projekts? Atbilde ir data.gov.lv, bet neviens to nesasaista ar zemi."),
    ("Nav pierādījumu pēdas", "Ekrānšāviņš Word failā nav pārbaudāms. Revidents nevar atkārtot, ko redzēja vērtētājs."),
    ("Dublēts darbs", "CFLA, LVIF, LIAA, pašvaldības — viens un tas pats darbs, četras reizes."),
]
for i, (head, body) in enumerate(pains):
    x = 0.8 + (i % 2) * 6.0
    y = 2.5 + (i // 2) * 2.1
    card(s, x, y, 5.75, 1.9)
    accent_bar(s, x + 0.25, y + 0.32, 0.07, 0.5)
    text(s, x + 0.55, y + 0.27, 5.0, 0.45, head, size=18, bold=True)
    text(s, x + 0.55, y + 0.85, 4.95, 0.95, body, size=13, color=MUTED, line=1.1)
footer(s, "Problēma")


# ════════════════════════════════════════════════════════════════════════
#  4. RISINĀJUMS — 19 avoti → 1 API → panelis / JSON
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[2:30–3:30] Mūsu risinājums. Ievadi kadastra numuru vai adresi — vai vienkārši uzklikšķini kartē. "
    "Serveris paralēli vaicā 19 atvērtos avotus: VZD kadastru un ATIS, TAPIS, LVĢMC, Ozols, BIS, ES fondu datus, CFLA, LVIF EKII, "
    "LIAA, UR, VID, EIS un citus. Katrs atbild savā tempā, rindas panelī piepildās pa vienai. "
    "Rezultāts trīs formās: panelis cilvēkam, drukājama atskaite, un viens JSON fails — mašīnai vai AI."
)
eyebrow(s, "Risinājums")
title(s, ["Viena zeme. 19 avoti.", "Viena atbilde."], size=36, h=1.4)

# Kreisā kolonna — avotu kaudze (grupēta pēc panela sekcijām no src/lib/report.ts)
groups = [
    ("Īpašums", "VZD kadastrs · Zemesgrāmata"),
    ("Ierobežojumi", "ATIS · LVĢMC · Ozols · NKMP"),
    ("Plānošana", "TAPIS"),
    ("Būvniecība", "BIS · VZD ēkas"),
    ("ES finansējums", "ES fondi · CFLA · LVIF EKII · LIAA"),
    ("Uzņēmumi", "UR · VID · FM · EIS"),
]
for i, (sec, src) in enumerate(groups):
    y = 2.45 + i * 0.68
    card(s, 0.8, y, 4.3, 0.56, radius=0.2)
    text(s, 1.05, y + 0.14, 1.75, 0.3, sec, size=12, bold=True)
    text(s, 2.8, y + 0.15, 2.25, 0.3, src, size=10, color=MUTED)
    arrow(s, 5.15, y + 0.28, 5.85, 4.5, color=LINE, width=1.25)

# Vidus — viens API
card(s, 5.9, 3.65, 2.3, 1.7, fill=ACCENT, line=None, radius=0.12)
text(s, 5.9, 3.9, 2.3, 0.4, "1 API", size=24, bold=True, color=SURFACE, align=PP_ALIGN.CENTER)
text(s, 5.9, 4.45, 2.3, 0.7, ["paralēli · kešs", "avots katram faktam"], size=11, color=SURFACE,
     align=PP_ALIGN.CENTER)

# Labā kolonna — trīs izvades
outs = [
    ("Panelis", "cilvēkam — kartē, telefonā", MAP_BLUE),
    ("Atskaite", "drukāšanai un lietai", INK),
    ("JSON", "vienā failā — AI un sistēmām", ACCENT),
]
for i, (head, body, col) in enumerate(outs):
    y = 2.75 + i * 1.3
    arrow(s, 8.25, 4.5, 8.85, y + 0.5, color=LINE, width=1.25)
    card(s, 8.9, y, 3.65, 1.05)
    accent_bar(s, 9.1, y + 0.25, 0.07, 0.55, color=col)
    text(s, 9.35, y + 0.18, 3.0, 0.4, head, size=17, bold=True, color=col)
    text(s, 9.35, y + 0.58, 3.1, 0.35, body, size=12, color=MUTED)
footer(s, "Risinājums")


# ════════════════════════════════════════════════════════════════════════
#  5. RISINĀJUMS — principi, kas atšķir no «vēl viena portāla»
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[3:30–4:15] Četri principi. Pirmais — pierādījums: zem katra fakta ir Avots un Pieprasījums, var atvērt oficiālo ierakstu. "
    "Otrais — once-only: lietotājam nekas nav jāievada, ko valsts jau zina. Trešais — godīgi statusi: ja avots neatbild, "
    "mēs rakstām 'nav iegūts', nevis 'Nē'. Ceturtais — bez personas datiem un bez maksas avotiem. "
    "Tehniski: React un Leaflet pārlūkā, Express serveris, SQLite kadastra indekss ar 1,5 GB VZD datiem."
)
eyebrow(s, "Risinājums  ·  principi")
title(s, "Nevis vēl viens portāls.", size=36, h=0.8)
principles = [
    ("Pierādījums katram faktam", "Avots — oficiālais ieraksts. Pieprasījums — tieši tas izsaukums, ko veica serveris.", "Avots ↗"),
    ("Once-only", "Neko nav jāievada. Kadastra numurs vai klikšķis kartē — pārējo valsts jau zina.", "VDAA princips"),
    ("Godīgi statusi", "Ja avots neatbild — «nav iegūts», nevis «Nē». Pretrunas starp avotiem — parādām.", "Jā · Nē · ?"),
    ("Tikai atvērtie dati", "Bez personu vārdiem, bez maksas API, bez pieteikšanās. Licence — MIT.", "0 €"),
]
for i, (head, body, tag) in enumerate(principles):
    x = 0.8 + (i % 2) * 6.0
    y = 2.05 + (i // 2) * 2.15
    card(s, x, y, 5.75, 1.95)
    text(s, x + 0.35, y + 0.3, 3.9, 0.45, head, size=18, bold=True)
    pill(s, x + 4.15, y + 0.3, 1.3, tag, color=MAP_BLUE, size=10)
    text(s, x + 0.35, y + 0.9, 5.1, 0.95, body, size=13, color=MUTED, line=1.1)
text(s, 0.8, 6.45, 11.7, 0.35,
     "React + Leaflet  ·  Express (Node 22)  ·  SQLite kadastra indekss (VZD, ~1,5 GB)  ·  kešs 24 h",
     size=12, color=FAINT)
footer(s, "Risinājums")


# ════════════════════════════════════════════════════════════════════════
#  6. SALĪDZINĀJUMS — matrica ar līdzīgajiem risinājumiem
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[4:15–5:15] Salīdzinājums. Kadastrs.lv un zemesgrāmata dod vienu avotu, zemesgrāmatā dati par maksu. "
    "Geolatvija.lv ir lielisks ģeoportāls, bet tas rāda slāņus, nevis atbildi par konkrēto zemi. "
    "Lursoft apvieno daudz, bet tas ir maksas un slēgts. CFLA un EKII portāli zina par atlasēm, bet ne par zemi. "
    "Mēs — vienīgie, kas apvieno zemi ar ES finansējumu, ir bezmaksas, ar atvērtu kodu, ar JSON eksportu un gatavi "
    "iebūvēšanai latvija.lv e-pakalpojumā."
)
eyebrow(s, "Līdzīgo risinājumu salīdzinājums")
title(s, "Ko jau var — un ko nevar.", size=34, h=0.8)

cols = ["Bezmaksas", "Atvērtais\nkods", "Apvieno\navotus", "ES atbalsta\natbilstība", "JSON /\nAPI", "latvija.lv\nintegrācija"]
# Vērtības: Y = jā, P = daļēji, N = nē
rows = [
    ("kadastrs.lv", "VZD", "P", "N", "N", "N", "P", "N"),
    ("zemesgramata.lv", "TNA", "N", "N", "N", "N", "N", "P"),
    ("geolatvija.lv", "ģeoportāls", "Y", "N", "P", "N", "Y", "N"),
    ("Lursoft", "komerciāls", "N", "N", "Y", "N", "P", "N"),
    ("CFLA / LVIF portāli", "atlases", "Y", "N", "N", "P", "N", "N"),
    ("Vienotais Zemes Reģistrs", "mūsu", "Y", "Y", "Y", "Y", "Y", "Y"),
]
TX, TY, NAME_W, CELL_W, ROW_H = 0.8, 2.0, 3.35, 1.4, 0.66

# Galvene
for j, c in enumerate(cols):
    text(s, TX + NAME_W + j * CELL_W, TY, CELL_W, 0.55, c, size=11, bold=True, color=MUTED, align=PP_ALIGN.CENTER)

MARK = {
    "Y": ("✓", GREEN, GREEN_SOFT),
    "P": ("daļēji", ORANGE, ORANGE_SOFT),
    "N": ("—", FAINT, GREY_SOFT),
}
for i, (name, kind, *vals) in enumerate(rows):
    y = TY + 0.7 + i * ROW_H
    ours = i == len(rows) - 1
    # Mūsu rinda — iekrāsota, lai acs uzreiz atrod
    card(s, TX - 0.1, y - 0.06, NAME_W + CELL_W * len(cols) + 0.2, ROW_H - 0.08,
         fill=ACCENT_SOFT if ours else SURFACE, line=ACCENT if ours else LINE, radius=0.15)
    text(s, TX + 0.15, y + 0.06, NAME_W - 0.2, 0.3, name, size=14, bold=True, color=ACCENT_DEEP if ours else INK)
    text(s, TX + 0.15, y + 0.33, NAME_W - 0.2, 0.25, kind, size=10, color=FAINT)
    for j, v in enumerate(vals):
        label, col, fill = MARK[v]
        pill(s, TX + NAME_W + j * CELL_W + 0.25, y + 0.1, CELL_W - 0.5, label, color=col, fill=fill,
             size=12 if v != "P" else 10, h=0.34)

text(s, 0.8, 6.55, 11.8, 0.35,
     "Daļēji: kadastrs.lv — pamatdati bez maksas, izvērsti par maksu; zemesgrāmata — e-pakalpojums latvija.lv, dati par maksu; "
     "geolatvija.lv — WMS/WFS slāņi; Lursoft — maksas API; CFLA — atlases bez saites ar zemi.",
     size=9, color=FAINT)
footer(s, "Salīdzinājums")


# ════════════════════════════════════════════════════════════════════════
#  7. SALĪDZINĀJUMS — trīs lietas, ko neviens cits nedod kopā
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[5:15–6:00] Trīs lietas, kas mūs atšķir. Bezmaksas — nekādu abonementu, nekādu maksas API. "
    "Atvērtais kods ar MIT licenci — jebkura iestāde var paņemt, pārbaudīt un izvietot savā serverī. "
    "Un integrācija latvija.lv: e-pakalpojums var vai nu atvērt mūsu saiti ar kadastra numuru, vai izsaukt REST API un saņemt "
    "to pašu JSON. Valstij nav jāpērk jauna sistēma — tikai jāpieslēdz."
)
eyebrow(s, "Kāpēc tieši šis")
title(s, ["Bezmaksas. Atvērts.", "Gatavs latvija.lv."], size=36, h=1.4)
three = [
    ("0 €", "Bezmaksas", "Tikai atvērtie valsts dati. Nav abonementa, nav maksas API, nav pieteikšanās.", ACCENT),
    ("MIT", "Atvērtais kods", "Jebkura iestāde var paņemt, pārbaudīt un palaist savā serverī. Bez piegādātāja atkarības.", GREEN),
    ("latvija.lv", "Iebūvējams", "Saite ar kadastru vai REST API — e-pakalpojums saņem to pašu JSON, ko redz cilvēks.", MAP_BLUE),
]
for i, (big, head, body, col) in enumerate(three):
    x = 0.8 + i * 4.0
    card(s, x, 2.55, 3.75, 3.9)
    text(s, x + 0.35, 2.85, 3.1, 0.9, big, size=40 if i < 2 else 30, bold=True, color=col)
    text(s, x + 0.35, 3.95, 3.1, 0.45, head, size=18, bold=True)
    text(s, x + 0.35, 4.5, 3.1, 1.6, body, size=13, color=MUTED, line=1.15)
footer(s, "Salīdzinājums")


# ════════════════════════════════════════════════════════════════════════
#  8. INTEGRĀCIJA latvija.lv — kā tieši
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[6:00–6:40] Kā integrēt. Variants A: e-pakalpojums atver saiti ar kadastra numuru — mūsu karte atveras ar jau atlasītu zemi un slāņiem. "
    "Variants B: e-pakalpojuma serveris izsauc POST /api/parcel/report ar kadastra numuru un saņem darba ID; "
    "pēc tam GET /api/jobs/id atdod visus faktus ar avotiem. CFLA iesnieguma formā tas nozīmē: vērtētājs atver iesniegumu — "
    "zemes aina jau ir pielikumā."
)
eyebrow(s, "Integrācija e-pakalpojumos")
title(s, "Divi veidi pieslēgties.", size=34, h=0.8)

# A — dziļā saite
card(s, 0.8, 2.0, 5.75, 4.55)
pill(s, 1.1, 2.3, 1.1, "A", color=MAP_BLUE, size=12)
text(s, 2.35, 2.3, 4.0, 0.4, "Dziļā saite", size=20, bold=True)
text(s, 1.1, 2.95, 5.2, 0.7, "Cilvēkam. E-pakalpojums atver karti ar jau atlasītu zemi un slāni.", size=13,
     color=MUTED, line=1.1)
card(s, 1.1, 3.8, 5.15, 1.1, fill=GREY_SOFT, line=None, radius=0.08)
text(s, 1.3, 3.95, 4.8, 0.85,
     ["…/hakatons/#/?cad=80880050264", "     &l=pludi&y=100&b=sat"], size=13, color=INK)
bullets(s, 1.1, 5.15, 5.2, ["cad — kadastra numurs", "l, y, b — slānis, plūdu gads, pamatkarte"], size=12, gap=0.45,
        dot=MAP_BLUE, color=MUTED)

# B — REST API
card(s, 6.8, 2.0, 5.75, 4.55)
pill(s, 7.1, 2.3, 1.1, "B", color=ACCENT, size=12)
text(s, 8.35, 2.3, 4.0, 0.4, "REST API", size=20, bold=True)
text(s, 7.1, 2.95, 5.2, 0.7, "Sistēmai. CFLA, LVIF vai pašvaldības e-pakalpojums saņem faktus ar avotiem.", size=13,
     color=MUTED, line=1.1)
card(s, 7.1, 3.8, 5.15, 1.5, fill=GREY_SOFT, line=None, radius=0.08)
text(s, 7.3, 3.95, 4.8, 1.3,
     [(("POST ", ACCENT, True), ("/api/parcel/report", INK, False)),
      "  { cadastre, applicant? }  →  jobId",
      (("GET  ", ACCENT, True), ("/api/jobs/:id", INK, False)),
      "  →  facts[ value, source, proof ]"],
     size=12, color=MUTED, spacing=2)
bullets(s, 7.1, 5.5, 5.2, ["Tas pats JSON, ko lejupielādē cilvēks", "Var izvietot iestādes serverī (MIT)"],
        size=12, gap=0.45, dot=ACCENT, color=MUTED)
footer(s, "Integrācija")


# ════════════════════════════════════════════════════════════════════════
#  9. DEMONSTRĀCIJA — ievadslaids ar scenāriju karti
# ════════════════════════════════════════════════════════════════════════
DEMOS = [
    ("Pircējs", "Zeme pie jūras — vai var celt māju?", "01001142213"),
    ("Pircējs", "Plūdu risks 10 / 100 / 200 gados", "80880050264"),
    ("Uzņēmums", "Kam varu pieteikties — un kam ne?", "54620100583"),
    ("CFLA", "Pašvaldības ēka un atvērtā atlase", "01000070142"),
    ("Pārvalde", "Uzņēmums adresē: VID, de minimis", "40003032949"),
    ("AI", "Viens JSON fails → čatbots", f"×{RATIO:.0f} mazāk tokenu"),
    ("Visur", "Pierādījums un telefons", "Avots ↗"),
]
s = new_slide(
    "[6:40–7:00] Tagad — demonstrācija. Septiņi īsi video, visi ierakstīti no tiešraides versijas, ar īstiem kadastra numuriem. "
    "Neviens nav sagatavots ar roku — tie ir tie paši dati, ko redzēsiet, ja atvērsiet QR kodu beigās."
)
eyebrow(s, "Demonstrācija")
title(s, ["Septiņi stāsti.", "Īsti kadastra numuri."], size=36, h=1.4)
for i, (who, what, ref) in enumerate(DEMOS):
    col, row = i % 2, i // 2
    x = 0.8 + col * 6.0
    y = 2.55 + row * 1.05
    card(s, x, y, 5.75, 0.88, radius=0.15)
    text(s, x + 0.25, y + 0.2, 0.5, 0.45, f"{i + 1}", size=22, bold=True, color=ACCENT)
    text(s, x + 0.8, y + 0.13, 3.3, 0.3, what, size=14, bold=True)
    text(s, x + 0.8, y + 0.48, 3.0, 0.3, who, size=11, color=MUTED)
    pill(s, x + 3.95, y + 0.27, 1.6, ref, color=MAP_BLUE, size=10)
footer(s, "Demonstrācija")

TOTAL = len(DEMOS)

# ── Demo 1 — pircējs pie jūras
demo_slide(
    1, TOTAL, "Pircējs",
    ["Zeme pie jūras.", "Vai var celt māju?"],
    "Sludinājums: 5,8 ha Vecāķos, fiziskas personas īpašums. Viens kadastra numurs — un pirms zvana mākleram jau zinām atbildi.",
    [
        (*YES, "Plūdi reizi 100 gados — jūras vējuzplūdi (LVĢMC)"),
        (*YES, "ATIS: dabas liegums, applūstoša teritorija"),
        (*INFO, "Zonējums DA1 — daba, ne apbūve (TAPIS)"),
    ],
    "pircejs",
    "01001142213 · Vecāķi, Rīga · satelīts · tikai rindas ar datiem",
    "[7:00–7:40] Ilzes stāsts. Ievadām kadastru 01001142213. Kontūra uz satelīta. Īpašnieks — fiziska persona, būvju nav. "
    "Plūdi reizi 100 gados — jā, jūras vējuzplūdi. ATIS: applūstoša teritorija, dabas liegums, aizsargjosla. "
    "Un TAPIS zonējums — DA1, dabas un apstādījumu teritorija. Māju te nebūvēs. Ilze to uzzina 30 sekundēs, nevis pēc avansa.",
)

# ── Demo 2 — plūdi ar slāni
demo_slide(
    2, TOTAL, "Pircējs",
    ["Plūdi —", "bez GIS diploma."],
    "Spuņciems pie Lielupes. Pārslēdzam LVĢMC scenārijus: zils ir tikai ūdens, gabals — karmīna kontūra.",
    [
        (*NO, "Reizi 10 gados — ūdens skar malas, centrs sauss"),
        (*YES, "Reizi 100 gados — gabals zem ūdens"),
        (*INFO, "Karte un rinda — viens LVĢMC ūdens dziļuma slānis"),
    ],
    "pludi",
    "80880050264 · Loki, Spuņciems, Mārupes nov. · Plūdi 10 → 100 → 200",
    "[7:40–8:15] Tas pats jautājums kartē. Spuņciems, pašvaldības zeme pie Lielupes. Zils kartē ir tikai ūdens — pats gabals ir karmīna kontūra. "
    "Reizi 10 gados ūdens skar malas, bet centrs sauss — panelī Nē. Reizi 100 gados gabals zem ūdens, 200 gados vēl dziļāk. "
    "Panelis saka to pašu vārdos: Jā, jūras vējuzplūdi. Karte un rinda lasa vienu un to pašu LVĢMC ūdens dziļuma slāni, tāpēc tie nevar nesakrist. "
    "Flīzes kešojam savā serverī — LVĢMC tās zīmē vienreiz, pēc tam tās nāk uzreiz.",
)

# ── Demo 3 — juridiska persona un atbalsts
demo_slide(
    3, TOTAL, "Uzņēmums / īpašnieks",
    ["Kam varu", "pieteikties?"],
    "„Ozoliņi”, Līvbērze — juridiskas personas zeme ar trim būvēm. Sistēma salīdzina īpašnieka veidu ar katras atlases nosacījumiem.",
    [
        (*NOFIT, "CFLA atlases — paredzētas pašvaldībām"),
        (*FIT, "LVIF / EKII — termiņš, summa, intensitāte"),
        (*INFO, "Rādām arī «Nē» — ar iemeslu"),
    ],
    "juridiska",
    "54620100583 · Ozoliņi, Līvbērzes pag., Jelgavas nov. · juridiska persona",
    "[8:15–8:55] Uzņēmējs ar zemi Līvbērzē. Īpašnieks — juridiska persona, trīs būves no 1918. līdz 1939. gadam. "
    "Ieslēdzam arī Nē rindas. CFLA atvērtās atlases — neatbilst, jo tās paredzētas pašvaldībām; un mēs pasakām kāpēc. "
    "LVIF EKII — atbilst: redzam termiņu, maksimālo summu un atbalsta intensitāti. Tas, ko agrāk meklēja trīs portālos.",
)

# ── Demo 4 — CFLA vērtētājs
demo_slide(
    4, TOTAL, "CFLA vērtētājs",
    ["Viena saite", "iesniegumā."],
    "Kaļķu iela 1, Rīga — pašvaldības īpašums. Vērtētājs atver vienu saiti un filtrē tikai ES finansējumu.",
    [
        (*FIT, "2.1.1.6. — pašvaldību ēku energoefektivitāte"),
        (*INFO, "Termiņš 15.07.–29.10.2026 un atlikums"),
        (*INFO, "Katram faktam — Avots un Pieprasījums"),
    ],
    "cfla_atlase",
    "01000070142 · Kaļķu iela 1, Rīga · sekcija «ES finansējums»",
    "[8:55–9:30] Tagad otra puse — CFLA. Iesniegumā ir saite ar kadastru 01000070142, Kaļķu iela 1. Vērtētājs izvēlas sekciju ES finansējums. "
    "Īpašnieks pašvaldība, tāpēc atbilst atlasei 2.1.1.6 — pašvaldību ēku energoefektivitāte, ar termiņu un atlikumu. "
    "Un zem katras rindas — Avots un Pieprasījums. Revidents var atkārtot tieši to, ko redzēja vērtētājs.",
)

# ── Demo 5 — uzņēmums adresē
demo_slide(
    5, TOTAL, "Valsts pārvalde",
    ["Kas strādā", "šajā adresē?"],
    "Pieteicēja reģistrācijas numurs — un panelis pievieno uzņēmuma datus: nozari, nodokļus, de minimis atbalstu.",
    [
        (*INFO, "UR — uzņēmums un adrese"),
        (*INFO, "VID — NACE nozare un nodokļi"),
        (*INFO, "FM — piešķirtais de minimis"),
    ],
    "uznemums",
    "Kaļķu iela 1 + reģ. nr. 40003032949 (AS Latvenergo)",
    "[9:30–10:00] Pārvaldes skats uz uzņēmumu. Pievienojam pieteicēja reģistrācijas numuru — piemērā Latvenergo. "
    "Panelis pievieno UR datus, VID nozari un nodokļus, FM de minimis atbalstu. Tieši tas, ko pārbauda pirms finansējuma piešķiršanas.",
)

# ── Demo 6 — JSON → AI (video)
demo_slide(
    6, TOTAL, "AI čatbots",
    ["Viens fails", "AI čatam."],
    "Lejupielādējam JSON un iemetam čatbotā. Nav jākopē 25 lapas — visa zeme, ar avotiem, vienā failā.",
    [
        ("JSON", MAP_BLUE, TINT, f"{lv_int(JSON_TOK)} tokenu · 25 fakti · {M['export']['bytes'] // 1000} KB"),
        (*YES, f"Bez eksporta — {lv_int(SRC_TOK)} tokenu, neietilpst"),
        (*FIT, "AI atrod pretrunas starp avotiem — ar saitēm"),
    ],
    "json_ai",
    "01001142213 · ai-demo.html · tiktoken o200k_base",
    "[10:00–10:45] Un tagad — AI. Tā pati Vecāķu zeme. Viena poga — JSON. Iemetam failu demo čatā. "
    f"Ja tos pašus datus kopētu no portāliem — {SRC_DOCS} dokumenti, gandrīz miljons tokenu, neietilpst nevienā konteksta logā. "
    f"Ar eksportu — viens fails, ap {JSON_TOK // 100 * 100} tokenu. Jautājam: vai šo zemi var pirkt mājai un kādu atbalstu var saņemt. "
    "Atbilde atsaucas uz konkrētiem avotiem un pat pamana pretrunu: LVĢMC 10 gadu slānis saka Nē, bet ATIS jau reģistrē applūstošu teritoriju. "
    "Godīgi: video atbilde ir iepriekš sagatavota no šī paša faila; ar API atslēgu demo lapa vaicā modeli tiešraidē.",
)


# ════════════════════════════════════════════════════════════════════════
#  Demo 6b — tokenu skaitļi (bez video, lai skaitlis paliek atmiņā)
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    f"[10:45–11:15] Skaitļi no mērījuma, ne no gaisa. {SRC_DOCS} dokumenti no {SRC_PORTALS} portāliem — {lv_int(SRC_TOK)} tokenu teksta. "
    f"Mūsu JSON — {lv_int(JSON_TOK)}. Tas ir {RATIO:.0f} reizes mazāk. Pat ja izmetam lielāko — TAPIS WFS atbildi, kas viena ir 900 tūkstoši — "
    f"joprojām {RATIO_NO_TAPIS:.1f} reizes mazāk. Mazāk tokenu nozīmē lētāk, ātrāk un mazāk halucināciju, jo modelim nav jārok HTML."
)
eyebrow(s, "Demonstrācija  ·  6 / 7  ·  AI čatbots  ·  mērījums")
text(s, 0.8, 0.9, 6.0, 0.7, "Mazāk tokenu. Vairāk jēgas.", size=32, bold=True)

# Lielais skaitlis
text(s, 0.8, 1.85, 5.6, 1.9, f"×{RATIO:.0f}", size=120, bold=True, color=ACCENT, line=0.85)
text(s, 0.8, 3.8, 5.4, 0.8, ["mazāk tokenu nekā avotu teksts.",
                             f"Pat bez lielākās TAPIS atbildes — ×{RATIO_NO_TAPIS:.1f}."], size=15, color=MUTED, spacing=4)

# Stieņi — proporcija kā konteksta logs
BAR_X, BAR_W = 0.8, 5.6
card(s, BAR_X, 4.95, BAR_W, 1.75)
text(s, BAR_X + 0.3, 5.1, 3.5, 0.3, f"{SRC_DOCS} dokumenti no portāliem", size=12, bold=True)
text(s, BAR_X + 3.4, 5.1, 1.9, 0.3, lv_int(SRC_TOK), size=12, bold=True, color=MUTED, align=PP_ALIGN.RIGHT)
rect(s, BAR_X + 0.3, 5.45, BAR_W - 0.6, 0.16, LINE)
text(s, BAR_X + 0.3, 5.85, 3.5, 0.3, "Viens JSON eksports", size=12, bold=True, color=ACCENT)
text(s, BAR_X + 3.4, 5.85, 1.9, 0.3, lv_int(JSON_TOK), size=12, bold=True, color=ACCENT, align=PP_ALIGN.RIGHT)
rect(s, BAR_X + 0.3, 6.2, max(0.04, (BAR_W - 0.6) * JSON_TOK / SRC_TOK), 0.16, ACCENT)

# Labā puse — kā izskatās prompts
card(s, 6.85, 0.95, 5.7, 5.75)
text(s, 7.15, 1.2, 5.1, 0.3, "KĀ TO IZMANTOT", size=10, bold=True, color=FAINT, tracking=140)
steps = [
    ("1", "Panelī — «Lejupielādēt JSON»"),
    ("2", "Pievieno failu jebkurā čatbotā"),
    ("3", "Jautā par zemi — dabiskā valodā"),
]
for i, (n, t) in enumerate(steps):
    y = 1.65 + i * 0.55
    pill(s, 7.15, y, 0.45, n, color=ACCENT, size=11)
    text(s, 7.75, y + 0.04, 4.6, 0.35, t, size=14, bold=True)

card(s, 7.15, 3.4, 5.1, 1.35, fill=GREY_SOFT, line=None, radius=0.08)
text(s, 7.35, 3.52, 4.75, 1.15,
     [(("facts[]", ACCENT, True), (" — 25 rindas, katrai:", MUTED, False)),
      "field · label · value · status",
      "note · source · fetchedAt",
      (("query · proof", MAP_BLUE, True), (" ← saites pārbaudei", MUTED, False))],
     size=12, color=INK, spacing=1)
card(s, 7.15, 4.95, 5.1, 1.5, fill=TINT, line=None, radius=0.08)
text(s, 7.35, 5.07, 4.75, 1.3,
     ["„Vai šo zemi var pirkt mājai un kādu ES atbalstu var saņemt? Atsaucies uz avotiem no faila.”"],
     size=13, color=INK, line=1.1)
footer(s, "Demonstrācija")


# ════════════════════════════════════════════════════════════════════════
#  Demo 7 — pierādījums + telefons (divi video blakus)
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[11:15–11:45] Divas lietas nobeigumā. Pa kreisi — pierādījums: uzspiežam Avots, atveras oficiālais reģistrs; Pieprasījums — "
    "precīzā API atbilde, ko redzēja serveris. Neticiet mums — pārbaudiet. Pa labi — telefons: tā pati karte, panelis kā apakšējā loksne. "
    "Desktops, planšete, telefons — viens produkts, WCAG 2.1 AA."
)
eyebrow(s, f"Demonstrācija  ·  {TOTAL} / {TOTAL}  ·  Pierādījums un telefons")
text(s, 0.8, 0.9, 8.0, 0.7, "Neticiet mums. Pārbaudiet.", size=30, bold=True)
video(s, "pierad", 0.8, 1.85, 7.6, 4.75)
text(s, 0.8, 6.7, 7.6, 0.3, "Avots → oficiālais ieraksts  ·  Pieprasījums → precīzā API atbilde", size=11, color=MUTED)
# Telefona klips 390×844 → saglabājam proporciju
PH_H = 4.9
PH_W = PH_H * 390 / 844
video(s, "telefons", 12.55 - PH_W - 0.4, 1.85, PH_W, PH_H)
text(s, 9.0, 1.95, 1.0, 2.0, ["Telefonā", "— apakšējā", "loksne."], size=13, color=MUTED, line=1.1)
footer(s, "Demonstrācija")


# ════════════════════════════════════════════════════════════════════════
#  IETEKME + robežas
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[11:45–12:30] Ko tas dod. Iedzīvotājam — atbilde pirms darījuma, nevis pēc. CFLA un pārvaldei — vienota aina un atkārtojama pierādījumu pēda "
    "katram iesniegumam. AI — viens fails, kurā ir viss. Un godīgi par robežām: atbilstība atlasei ir norāde, nevis lēmums; personas datus mēs nevācam. "
    "Nākamie soļi: pilots ar CFLA vienā atlasē, VDAA Storybook komponenti un oficiāls e-pakalpojums latvija.lv."
)
eyebrow(s, "Ietekme un nākamie soļi")
title(s, "Ko tas maina.", size=36, h=0.8)
impact = [
    ("Iedzīvotājam", "Atbilde pirms darījuma — 30 sekundēs, ne pēc avansa.", MAP_BLUE),
    ("CFLA un pārvaldei", "Viena aina katram iesniegumam. Pēda, ko revidents var atkārtot.", ACCENT),
    ("AI un sistēmām", f"Viens JSON fails — ×{RATIO:.0f} mazāk tokenu nekā avoti.", GREEN),
]
for i, (head, body, col) in enumerate(impact):
    x = 0.8 + i * 4.0
    card(s, x, 2.0, 3.75, 1.95)
    accent_bar(s, x + 0.3, 2.3, 0.07, 0.5, color=col)
    text(s, x + 0.55, 2.27, 3.0, 0.4, head, size=17, bold=True, color=col)
    text(s, x + 0.3, 2.95, 3.2, 0.95, body, size=13, color=MUTED, line=1.1)

# Robežas — godīgi, mazāk akcenta
card(s, 0.8, 4.25, 5.75, 2.45, fill=TINT, line=None)
text(s, 1.1, 4.45, 5.2, 0.3, "KAS TAS NAV", size=10, bold=True, color=FAINT, tracking=140)
bullets(s, 1.1, 4.9, 5.2, ["Nav lēmums — atbilstība ir norāde", "Nav personas datu — tikai atvērtie",
                           "Nav oficiāls e-pakalpojums (vēl)"], size=13, gap=0.5, dot=MUTED, color=INK)
# Nākamie soļi
card(s, 6.8, 4.25, 5.75, 2.45)
text(s, 7.1, 4.45, 5.2, 0.3, "NĀKAMIE SOĻI", size=10, bold=True, color=ACCENT, tracking=140)
bullets(s, 7.1, 4.9, 5.2, ["Pilots ar CFLA vienā atlasē", "VDAA Storybook komponenti",
                           "E-pakalpojums latvija.lv"], size=13, gap=0.5, dot=ACCENT, color=INK)
footer(s, "Ietekme")


# ════════════════════════════════════════════════════════════════════════
#  PALDIES + QR
# ════════════════════════════════════════════════════════════════════════
s = new_slide(
    "[12:30–13:00] Vienotais Zemes Reģistrs. Uzklikšķini zemei. Redzi visu. Bezmaksas, atvērts, gatavs latvija.lv. "
    "QR kods ved uz tiešraides versiju — pamēģiniet savu zemi, kamēr uzdodat jautājumus. Paldies."
)
accent_bar(s, 0.8, 2.0, 0.1, 1.55)
text(s, 1.15, 1.85, 7.5, 1.6, ["Uzklikšķini zemei.", "Redzi visu."], size=46, bold=True, line=0.92)
text(s, 1.15, 3.75, 7.0, 0.5, "Paldies. Jautājumi?", size=24, color=ACCENT)
for i, label in enumerate(["0 € · bezmaksas", "MIT · atvērtais kods", "latvija.lv · iebūvējams"]):
    pill(s, 1.15 + i * 2.45, 4.65, 2.3, label, color=[ACCENT, GREEN, MAP_BLUE][i], size=11)
text(s, 1.15, 5.45, 7.2, 0.9, [LIVE_URL, "Dokumentācija: docs/ARHITEKTURA.md"], size=14, color=MUTED, spacing=4)

# QR kods kartītē
card(s, 9.0, 1.55, 3.55, 4.5)
qr(s, LIVE_URL, 9.35, 1.85, 2.85)
text(s, 9.0, 4.95, 3.55, 0.35, "Pamēģini savu zemi", size=15, bold=True, align=PP_ALIGN.CENTER)
text(s, 9.0, 5.35, 3.55, 0.35, "tiešraide · bez pieteikšanās", size=11, color=MUTED, align=PP_ALIGN.CENTER)
footer(s)


out = HERE / "Vienotais-Zemes-Registrs-hakatons.pptx"
prs.save(out)
print(f"saved {out}  ·  {SLIDE_NO[0]} slaidi")
