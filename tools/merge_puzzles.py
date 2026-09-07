"""Fasst mehrere Laeufe von make_puzzles.py zu einem Aufgabensatz zusammen.

Ein Lauf sammelt, was ihm begegnet. Mattaufgaben brauchen aber einen eigenen
Durchgang (`--require-mate`), weil sie sonst untergehen - in einer Stellung mit
erzwungenem Matt steht man ohnehin fast immer schon auf Gewinn, und der
gewoehnliche Filter sortiert genau das aus. Dieses Skript legt die Ergebnisse
zusammen, wirft Doppelte weg und nummeriert neu.

Aufruf:
    python tools/merge_puzzles.py a.json b.json --out static/puzzles.json
"""

from __future__ import annotations

import argparse
import collections
import json
import time
from pathlib import Path


def load(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["puzzles"] if isinstance(data, dict) else data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    merged: dict[str, dict] = {}
    for name in args.inputs:
        path = Path(name)
        puzzles = load(path)
        added = 0
        for puzzle in puzzles:
            # Die Stellung ist der Schluessel, nicht die laufende Nummer: zwei
            # Laeufe vergeben dieselben Nummern fuer verschiedene Aufgaben.
            key = puzzle["fen"]
            if key in merged:
                continue
            merged[key] = puzzle
            added += 1
        print(f"{path.name}: {len(puzzles)} gelesen, {added} neu")

    puzzles = sorted(merged.values(), key=lambda p: (p["rating"], p["fen"]))
    for index, puzzle in enumerate(puzzles, start=1):
        puzzle["id"] = f"p{index:04d}"

    themes = collections.Counter(t for p in puzzles for t in p["themes"])
    payload = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "generator": "tools/make_puzzles.py + tools/merge_puzzles.py",
        "note": ("Selbst erzeugt und von Stockfish auf voller Staerke geprueft. "
                 "Keine fremde Puzzle-Datenbank, keine fremde Datenlizenz."),
        "puzzles": puzzles,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n{len(puzzles)} Aufgaben nach {out}")
    print("Themen:", ", ".join(f"{t}={n}" for t, n in themes.most_common()))
    buckets = collections.Counter((p["rating"] // 200) * 200 for p in puzzles)
    print("Schwierigkeit:", ", ".join(f"{k}-{k+199}: {v}" for k, v in sorted(buckets.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
