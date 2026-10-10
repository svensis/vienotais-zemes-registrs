"""
Tokenu skaitītājs slaidam „viens JSON pret avotu kaudzi”.

Skaita ar tiktoken o200k_base (GPT-4o/5 saimes tokenizators). Claude un
Gemini tokenizatori dod līdzīgu kārtu — mums svarīga attiecība, ne cents.

Lietojums:
    .venv/bin/python ai_tokens.py                 # mēra ai-sources/ → measure.json
    .venv/bin/python ai_tokens.py --stdin         # skaita stdin, izdrukā skaitli
"""
import json
import sys
from pathlib import Path

import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
HERE = Path(__file__).parent
SRC = HERE / "ai-sources"


def count(text: str) -> int:
    # disallowed_special=() — lai avotu tekstā nejauši atrasts "<|endoftext|>"
    # neuzspridzina skaitīšanu.
    return len(ENC.encode(text, disallowed_special=()))


def main() -> None:
    # ----------------------------------------------------------------
    # Režīms serverim: viens fails no stdin → viens skaitlis.
    # ----------------------------------------------------------------
    if "--stdin" in sys.argv:
        print(count(sys.stdin.read()))
        return

    manifest = json.loads((SRC / "manifest.json").read_text())
    cad = manifest["cadastre"]
    export_text = (SRC / f"export-{cad}.json").read_text()

    # Kompaktā versija — to pašu JSON bez atstarpēm, ko var dot API.
    export_min = json.dumps(json.loads(export_text), ensure_ascii=False, separators=(",", ":"))

    rows = []
    for item in manifest["urls"]:
        raw = (SRC / "raw" / f"{item['id']}.txt").read_text(errors="ignore")
        txt = (SRC / "text" / f"{item['id']}.txt").read_text(errors="ignore")
        rows.append({
            **item,
            "tokensRaw": count(raw) if item["ok"] else 0,
            "tokensText": count(txt) if item["ok"] else 0,
        })

    # ----------------------------------------------------------------
    # Kopsavilkums. Virsraksta skaitlis ir konservatīvais — tikai tīrs
    # teksts bez HTML, jo tik daudz cilvēks reāli iekopētu čatā.
    # ----------------------------------------------------------------
    total_raw = sum(r["tokensRaw"] for r in rows)
    total_text = sum(r["tokensText"] for r in rows)
    exp_tokens = count(export_text)
    exp_min_tokens = count(export_min)

    result = {
        "cadastre": cad,
        "encoding": "o200k_base",
        "export": {"tokens": exp_tokens, "tokensMinified": exp_min_tokens, "bytes": len(export_text.encode())},
        "sources": {
            "portals": len(manifest["sources"]),
            "documents": len(rows),
            "documentsOk": sum(1 for r in rows if r["ok"]),
            "tokensRaw": total_raw,
            "tokensText": total_text,
        },
        "ratioText": round(total_text / exp_tokens, 1),
        # Bez lielākā dokumenta (TAPIS WFS ar visu apkaimi) — lai slaidā
        # varam teikt „pat ja izmet rekordistu, joprojām ×N”.
        "largest": max(rows, key=lambda r: r["tokensText"])["url"],
        "tokensTextWithoutLargest": total_text - max(r["tokensText"] for r in rows),
        "ratioTextWithoutLargest": round((total_text - max(r["tokensText"] for r in rows)) / exp_tokens, 1),
        "ratioRaw": round(total_raw / exp_tokens, 1),
        "rows": rows,
    }
    (SRC / "measure.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"eksports: {exp_tokens} tokenu ({exp_min_tokens} kompakts)")
    print(f"avoti: {len(rows)} dok., teksts {total_text}, neapstrādāti {total_raw}")
    print(f"attiecība: teksts ×{result['ratioText']}, neapstrādāti ×{result['ratioRaw']}")
    for r in sorted(rows, key=lambda r: -r["tokensText"])[:8]:
        print(f"  {r['tokensText']:>8}  {r['url'][:90]}")


if __name__ == "__main__":
    main()
