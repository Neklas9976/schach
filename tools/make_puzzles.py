"""Erzeugt den Puzzle-Satz fuer die Website.

Warum selbst erzeugen statt eine fertige Sammlung einzubinden: die Seite steht
unter GPLv3 und soll ohne fremde Datenlizenzen auskommen. Ausserdem laesst sich
so jede Loesung *beweisen* statt sie zu glauben - jedes Puzzle hier ist von
Stockfish auf voller Staerke geprueft.

Verfahren, im Grunde das von lichess:

1. Zwei absichtlich schwache Stockfish-Instanzen spielen gegeneinander. Schwache
   Gegner produzieren genau das, woraus Taktikaufgaben bestehen: Fehler.
2. Nach jedem Zug wird die Stellung kurz gescannt (geringe Tiefe, MultiPV 2).
   Das ist billig und sortiert 95 % der Stellungen sofort aus.
3. Was den Scan uebersteht, wird auf voller Tiefe geprueft. Ein Puzzle entsteht
   nur, wenn der beste Zug *deutlich* besser ist als der zweitbeste - sonst
   waere die Aufgabe mehrdeutig und die Rueckmeldung "falsch" schlicht unfair.
4. Die Loesung wird fortgesetzt, solange sie eindeutig bleibt.

Aufruf:
    python tools/make_puzzles.py --count 250 --out static/puzzles.json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import chess
except ImportError:  # pragma: no cover - Hinweis, kein Programmablauf
    sys.exit("Bitte zuerst installieren:  python -m pip install chess")

ROOT = Path(__file__).resolve().parent.parent

# Figurenwerte in Centipawns, nur fuer die Themen-Erkennung.
VALUE = {chess.PAWN: 100, chess.KNIGHT: 320, chess.BISHOP: 330,
         chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 0}


def find_engine() -> Path:
    """Sucht die Stockfish-Binaerdatei unter engine/."""
    override = os.environ.get("STOCKFISH_PATH")
    if override and Path(override).exists():
        return Path(override)
    candidates = sorted(
        p for p in (ROOT / "engine").rglob("*")
        if p.is_file()
        and p.suffix.lower() in (".exe", "")
        and "stockfish" in p.name.lower()
        and p.suffix.lower() != ".cpp"
    )
    for path in candidates:
        # Quelltextdateien tragen denselben Namen, sind aber nicht ausfuehrbar.
        if path.suffix.lower() == ".exe" or os.access(path, os.X_OK):
            return path
    sys.exit("Keine Stockfish-Binaerdatei unter engine/ gefunden.")


class Engine:
    """Die duenne UCI-Schicht, die dieses Skript braucht.

    Bewusst nicht engine_bridge.py: das dort ist auf die Weboberflaeche
    zugeschnitten (Zwecke, Wiederanlauf, Elo-Begrenzung pro Anfrage) und wuerde
    hier nur im Weg stehen.
    """

    def __init__(self, path: Path, threads: int = 1, hash_mb: int = 64):
        self.proc = subprocess.Popen(
            [str(path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.send("uci")
        self.wait_for("uciok")
        self.setoption("Threads", threads)
        self.setoption("Hash", hash_mb)
        self.ready()

    def send(self, line: str) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def wait_for(self, token: str) -> list[str]:
        assert self.proc.stdout
        lines = []
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("Stockfish hat sich unerwartet beendet.")
            line = line.strip()
            lines.append(line)
            if line.startswith(token):
                return lines

    def setoption(self, name: str, value) -> None:
        self.send(f"setoption name {name} value {value}")

    def ready(self) -> None:
        self.send("isready")
        self.wait_for("readyok")

    def new_game(self) -> None:
        self.send("ucinewgame")
        self.ready()

    def analyse(self, board: chess.Board, *, depth: int, multipv: int = 1) -> dict:
        """Liefert die MultiPV-Linien und die Tiefe, ab der der beste Zug steht.

        Diese Stabilitaetstiefe ist spaeter das Schwierigkeitsmass: ein Zug, den
        schon eine Suche der Tiefe 4 findet, ist eine andere Aufgabe als einer,
        der erst bei Tiefe 16 auftaucht.
        """
        self.setoption("MultiPV", multipv)
        self.send(f"position fen {board.fen()}")
        self.send(f"go depth {depth}")
        lines: dict[int, dict] = {}
        top_at_depth: dict[int, str] = {}
        assert self.proc.stdout
        while True:
            raw = self.proc.stdout.readline()
            if not raw:
                raise RuntimeError("Stockfish hat sich unerwartet beendet.")
            raw = raw.strip()
            if raw.startswith("bestmove"):
                break
            if not raw.startswith("info ") or " pv " not in raw:
                continue
            parsed = _parse_info(raw)
            if parsed is None:
                continue
            lines[parsed["multipv"]] = parsed
            if parsed["multipv"] == 1:
                top_at_depth[parsed["depth"]] = parsed["pv"][0]

        stable = _stability_depth(top_at_depth)
        return {"lines": [lines[k] for k in sorted(lines)], "stable_depth": stable}

    def best_move(self, board: chess.Board, *, movetime: int, elo: int | None) -> str | None:
        """Ein Zug eines absichtlich begrenzten Spielers."""
        if elo is None:
            self.setoption("UCI_LimitStrength", "false")
        else:
            # Die Optionen bleiben fuer die Lebensdauer des Prozesses gesetzt,
            # werden hier aber jedes Mal neu gesagt: der Elo-Wert wechselt von
            # Partie zu Partie.
            self.setoption("UCI_LimitStrength", "true")
            self.setoption("UCI_Elo", elo)
        self.setoption("MultiPV", 1)
        self.send(f"position fen {board.fen()}")
        self.send(f"go movetime {movetime}")
        out = self.wait_for("bestmove")
        token = out[-1].split()
        if len(token) < 2 or token[1] == "(none)":
            return None
        return token[1]

    def close(self) -> None:
        try:
            self.send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def _parse_info(raw: str) -> dict | None:
    parts = raw.split()
    out = {"multipv": 1, "depth": 0, "cp": None, "mate": None, "pv": []}
    i = 0
    while i < len(parts):
        tok = parts[i]
        if tok == "depth" and i + 1 < len(parts):
            out["depth"] = int(parts[i + 1]); i += 2
        elif tok == "multipv" and i + 1 < len(parts):
            out["multipv"] = int(parts[i + 1]); i += 2
        elif tok == "score" and i + 2 < len(parts):
            if parts[i + 1] == "cp":
                out["cp"] = int(parts[i + 2])
            elif parts[i + 1] == "mate":
                out["mate"] = int(parts[i + 2])
            i += 3
        elif tok == "pv":
            out["pv"] = parts[i + 1:]
            break
        else:
            i += 1
    return out if out["pv"] else None


def _stability_depth(top_at_depth: dict[int, str]) -> int:
    """Kleinste Tiefe, ab der der beste Zug nicht mehr wechselt."""
    if not top_at_depth:
        return 0
    depths = sorted(top_at_depth)
    final = top_at_depth[depths[-1]]
    stable = depths[-1]
    for d in reversed(depths):
        if top_at_depth[d] != final:
            break
        stable = d
    return stable


def score_cp(line: dict) -> int:
    """Bewertung aus Sicht der Seite am Zug, Matt als grosse Zahl."""
    if line["mate"] is not None:
        return 100000 - abs(line["mate"]) * 100 if line["mate"] > 0 else -100000 + abs(line["mate"]) * 100
    return line["cp"] or 0


@dataclass
class Puzzle:
    fen: str
    moves: list[str]
    themes: list[str] = field(default_factory=list)
    rating: int = 1200
    mate_in: int | None = None
    setup_fen: str | None = None
    last_move: str | None = None

    def to_json(self, index: int) -> dict:
        data = {
            "id": f"p{index:04d}",
            "fen": self.fen,
            "moves": self.moves,
            "rating": self.rating,
            "themes": self.themes,
        }
        if self.mate_in:
            data["mateIn"] = self.mate_in
        if self.setup_fen and self.last_move:
            data["setupFen"] = self.setup_fen
            data["lastMove"] = self.last_move
        return data


def _least_valuable_capture(board: chess.Board, target: int) -> chess.Move | None:
    """Der billigste legale Schlagzug auf ein Feld.

    Ueber die legalen Zuege statt ueber die Angreifermaske: damit fallen
    gefesselte Figuren von selbst heraus, die eine reine Maske mitzaehlen
    wuerde.
    """
    best = None
    best_value = 10**9
    for move in board.legal_moves:
        if move.to_square != target:
            continue
        piece = board.piece_at(move.from_square)
        if piece is None:
            continue
        value = VALUE[piece.piece_type] or 10**6   # der Koenig schlaegt zuletzt
        if value < best_value:
            best, best_value = move, value
    return best


def see(board: chess.Board, move: chess.Move) -> int:
    """Statische Abtauschbewertung: was bleibt, wenn auf dem Zielfeld beide
    Seiten der Reihe nach zuschlagen.

    python-chess bringt so etwas nicht mit, und fuer die Frage "ist das ein
    Opfer?" gibt es keinen Ersatz: ein Zug, der Material verliert und trotzdem
    der beste ist, ist genau das.
    """
    target = move.to_square
    victim = board.piece_at(target)
    gain = [VALUE[victim.piece_type] if victim else 0]
    mover = board.piece_at(move.from_square)
    if mover is None:
        return 0
    on_square = VALUE[move.promotion] if move.promotion else VALUE[mover.piece_type]

    board = board.copy(stack=False)
    board.push(move)
    depth = 0
    while True:
        capture = _least_valuable_capture(board, target)
        if capture is None:
            break
        depth += 1
        gain.append(on_square - gain[depth - 1])
        attacker = board.piece_at(capture.from_square)
        on_square = VALUE[capture.promotion] if capture.promotion else VALUE[attacker.piece_type]
        board.push(capture)
        if max(-gain[depth - 1], gain[depth]) < 0:
            break   # beide Seiten wuerden hier abbrechen

    for i in range(len(gain) - 1, 0, -1):
        gain[i - 1] = -max(-gain[i - 1], gain[i])
    return gain[0]


# --- Themen ---------------------------------------------------------------
# Nur was sich aus der Stellung wirklich ablesen laesst. Lieber wenige richtige
# Etiketten als viele geratene.

def detect_themes(board: chess.Board, moves: list[str], mate_in: int | None) -> list[str]:
    themes: list[str] = []
    start = board.copy()
    first = chess.Move.from_uci(moves[0])

    if mate_in:
        themes.append(f"mateIn{mate_in}")

    if first.promotion:
        themes.append("promotion")

    # Opfer: die statische Abtauschbewertung sagt, der Zug verliert Material -
    # und trotzdem ist er der beste. Genau das macht ein Opfer aus.
    if see(start, first) < 0:
        themes.append("sacrifice")
    elif start.is_capture(first):
        captured = start.piece_at(first.to_square)
        if captured and not start.is_attacked_by(not start.turn, first.to_square):
            themes.append("hangingPiece")

    after = start.copy()
    after.push(first)

    # Gabel: die gezogene Figur greift danach mindestens zwei wertvolle Steine
    # an (Koenig zaehlt mit).
    attacked = []
    for sq in after.attacks(first.to_square):
        piece = after.piece_at(sq)
        if piece and piece.color != start.turn:
            attacked.append(VALUE[piece.piece_type] if piece.piece_type != chess.KING else 10000)
    if len([v for v in attacked if v >= 320]) >= 2:
        themes.append("fork")

    if after.is_check() and "fork" not in themes:
        themes.append("check")

    # Grundreihenmatt: das Matt faellt auf der Grundreihe des Verlierers und
    # kommt von Turm oder Dame.
    if mate_in:
        final = start.copy()
        for uci in moves:
            final.push(chess.Move.from_uci(uci))
        loser = final.turn
        king_sq = final.king(loser)
        back_rank = 0 if loser == chess.WHITE else 7
        last = chess.Move.from_uci(moves[-1])
        mover = final.piece_at(last.to_square)
        if (king_sq is not None and chess.square_rank(king_sq) == back_rank
                and mover and mover.piece_type in (chess.ROOK, chess.QUEEN)
                and chess.square_rank(last.to_square) == back_rank):
            themes.append("backRankMate")

    if len(moves) >= 5:
        themes.append("long")
    if not themes:
        themes.append("advantage")
    return themes


def rate(board: chess.Board, moves: list[str], themes: list[str],
         stable_depth: int, swing: int) -> int:
    """Schwierigkeit, aus Nachpruefbarem statt aus Bauchgefuehl.

    Die Stabilitaetstiefe ist der Kern: sie sagt, wie tief man rechnen muss,
    bis der Zug sich aufdraengt. Der Rest sind Aufschlaege fuer das, was
    Menschen erfahrungsgemaess uebersehen - stille Zuege und Opfer.
    """
    player_moves = (len(moves) + 1) // 2
    rating = 700 + stable_depth * 55 + (player_moves - 1) * 180

    first = chess.Move.from_uci(moves[0])
    if "sacrifice" in themes:
        rating += 220
    if not board.is_capture(first) and not board.gives_check(first):
        rating += 120           # ein stiller Zug ist schwerer zu sehen
    if "mateIn1" in themes:
        rating -= 250
    if "hangingPiece" in themes:
        rating -= 120
    if swing > 60000:           # ein erzwungenes Matt ist konkreter als "+3"
        rating -= 80
    return max(600, min(2600, int(round(rating / 10) * 10)))


# --- Kandidatenpruefung ---------------------------------------------------

SCAN_DEPTH = 12
VERIFY_DEPTH = 18
MIN_ADVANTAGE = 260     # so gut muss der beste Zug sein
MIN_MARGIN = 220        # so viel besser als der zweitbeste
MAX_WITHOUT = 130       # ohne den Zug darf die Stellung nicht schon gewonnen sein


def forced_mate(lines: list[dict]) -> bool:
    """Der beste Zug setzt matt, und zwar als einziger so schnell."""
    if lines[0]["mate"] is None or lines[0]["mate"] <= 0:
        return False
    other = lines[1]["mate"] if len(lines) > 1 else None
    # Ein zweites, ebenso schnelles Matt macht die Aufgabe mehrdeutig.
    return other is None or other <= 0 or other > lines[0]["mate"]


def looks_promising(lines: list[dict], *, fresh: bool = True) -> bool:
    """Traegt die Stellung eine Aufgabe?

    `fresh` unterscheidet den Einstieg von der Fortsetzung: am Anfang darf die
    Stellung ohne den gesuchten Zug noch nicht gewonnen sein, mitten in einer
    Kombination ist sie das natuerlich laengst.
    """
    if len(lines) < 2:
        return False
    # Erzwungenes Matt bekommt seinen eigenen Massstab. Wer mattsetzen kann,
    # steht fast immer schon klar auf Gewinn - die Centipawn-Bedingungen unten
    # haben deshalb praktisch jede Mattaufgabe aussortiert. Hier zaehlt allein:
    # es gibt ein Matt, und nur dieser eine Zug fuehrt so schnell hin.
    if forced_mate(lines):
        return True
    best, second = score_cp(lines[0]), score_cp(lines[1])
    if best < MIN_ADVANTAGE or best - second < MIN_MARGIN:
        return False
    return second <= MAX_WITHOUT if fresh else True


def build_puzzle(engine: Engine, board: chess.Board, last_move: chess.Move | None,
                 max_player_moves: int = 3) -> Puzzle | None:
    """Prueft eine Stellung und baut, wenn sie traegt, die ganze Loesung."""
    if board.is_game_over() or len(list(board.legal_moves)) < 2:
        return None

    result = engine.analyse(board, depth=VERIFY_DEPTH, multipv=2)
    lines = result["lines"]
    if not looks_promising(lines):
        return None

    first = chess.Move.from_uci(lines[0]["pv"][0])

    # Ein Rueckschlag auf dem Feld, auf das der Gegner gerade gezogen hat, ist
    # keine Aufgabe, sondern Reflex.
    if last_move and first.to_square == last_move.to_square and board.is_capture(first):
        return None

    start_fen = board.fen()
    setup_fen = None
    if last_move and board.move_stack:
        before = board.copy()
        before.pop()
        setup_fen = before.fen()
    swing = score_cp(lines[0]) - score_cp(lines[1])
    stable_depth = result["stable_depth"]

    play = board.copy()
    moves: list[str] = []
    mate_in: int | None = None

    for step in range(max_player_moves):
        if step == 0:
            player_line = lines[0]
            player_move = first
        else:
            step_result = engine.analyse(play, depth=VERIFY_DEPTH, multipv=2)
            step_lines = step_result["lines"]
            if len(step_lines) < 2:
                break
            # Weiterfuehren nur, solange die Fortsetzung eindeutig bleibt -
            # sonst wuerde die Aufgabe einen von mehreren guten Zuegen als
            # falsch abstempeln. Bei einem Matt in n gegen ein Matt in n+1 ist
            # der Abstand in Centipawns winzig; ohne den Mattfall brach die
            # Loesung genau dort ab, wo sie interessant wird.
            if not looks_promising(step_lines, fresh=False):
                break
            player_move = chess.Move.from_uci(step_lines[0]["pv"][0])
            # Im Schach stehen und mit dem Koenig wegziehen ist keine Aufgabe,
            # sondern Pflicht. Solche Zuege haengten die Loesung nur in die
            # Laenge ("finde Kf8, dann Kg7") und werden nicht mehr angehaengt.
            mover = play.piece_at(player_move.from_square)
            if (play.is_check() and mover and mover.piece_type == chess.KING
                    and not play.is_capture(player_move)):
                break

        moves.append(player_move.uci())
        play.push(player_move)

        if play.is_checkmate():
            mate_in = (len(moves) + 1) // 2
            break
        if play.is_game_over():
            # Patt oder Remis als "Loesung" waere irrefuehrend.
            return None

        # Die Antwort des Gegners spielt das Programm selbst, sie muss also
        # nicht eindeutig sein - nur die beste.
        reply = engine.analyse(play, depth=VERIFY_DEPTH, multipv=1)
        if not reply["lines"]:
            break
        reply_move = chess.Move.from_uci(reply["lines"][0]["pv"][0])
        moves.append(reply_move.uci())
        play.push(reply_move)
        if play.is_game_over():
            moves.pop()
            play.pop()
            break

    # Endet die Loesung mit einem Gegnerzug, ist der letzte Zug nicht der des
    # Spielers - abschneiden.
    while moves and len(moves) % 2 == 0:
        moves.pop()

    if not moves:
        return None
    if mate_in is None and len(moves) < 3:
        # Ein einzelner Zug ohne Matt ist meist nur "Figur steht ein" - zu
        # duenn fuer eine Aufgabe, ausser er gewinnt sehr viel.
        if swing < 500:
            return None

    base = chess.Board(start_fen)
    themes = detect_themes(base, moves, mate_in)
    rating = rate(base, moves, themes, stable_depth, swing)
    return Puzzle(fen=start_fen, moves=moves, themes=themes, rating=rating,
                  mate_in=mate_in, setup_fen=setup_fen,
                  last_move=last_move.uci() if last_move else None)


# --- Partien erzeugen -----------------------------------------------------

def play_game(white: Engine, black: Engine, scanner: Engine, rng: random.Random,
              *, movetime: int, max_plies: int, elo_white: int, elo_black: int):
    """Spielt eine Partie und liefert unterwegs die Stellungen zum Scannen."""
    board = chess.Board()
    for e in (white, black, scanner):
        e.new_game()

    # Eroeffnungsvielfalt: die ersten Zuege aus den vier besten einer flachen
    # Suche wuerfeln. Ohne das spielt Stockfish immer dieselbe Partie.
    opening_plies = rng.choice([4, 6, 8, 10])
    for _ in range(opening_plies):
        if board.is_game_over():
            return
        res = scanner.analyse(board, depth=6, multipv=4)
        options = [chess.Move.from_uci(l["pv"][0]) for l in res["lines"]]
        options = [m for m in options if m in board.legal_moves]
        if not options:
            return
        board.push(rng.choice(options))

    last_move = board.peek() if board.move_stack else None
    while not board.is_game_over() and board.ply() < max_plies:
        yield board.copy(), last_move
        mover, elo = ((white, elo_white) if board.turn == chess.WHITE
                      else (black, elo_black))
        # Die Elo-Begrenzung muss bei *jedem* Zug mitgeschickt werden. Sie hier
        # wegzulassen war der Grund, warum die "schwachen" Spieler in voller
        # Staerke gespielt haben - und ohne Fehler gibt es nichts zu finden.
        uci = mover.best_move(board, movetime=movetime, elo=elo)
        if uci is None:
            return
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            return
        board.push(move)
        last_move = move


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=250)
    parser.add_argument("--out", default=str(ROOT / "static" / "puzzles.json"))
    parser.add_argument("--seed", type=int, default=20260907)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--movetime", type=int, default=50)
    parser.add_argument("--max-plies", type=int, default=90)
    parser.add_argument("--time-budget", type=float, default=0,
                        help="Sekunden; 0 bedeutet unbegrenzt")
    parser.add_argument("--require-mate", action="store_true",
                        help="nur erzwungene Matts sammeln")
    args = parser.parse_args()

    path = find_engine()
    print(f"Stockfish: {path}", flush=True)
    rng = random.Random(args.seed)

    white = Engine(path, threads=1, hash_mb=32)
    black = Engine(path, threads=1, hash_mb=32)
    scanner = Engine(path, threads=args.threads, hash_mb=256)

    puzzles: list[Puzzle] = []
    seen: set[str] = set()
    started = time.time()
    games = 0
    scanned = 0
    promising = 0

    try:
        while len(puzzles) < args.count:
            if args.time_budget and time.time() - started > args.time_budget:
                print("Zeitbudget aufgebraucht.", flush=True)
                break
            games += 1
            # Schwache Gegner sind hier das Werkzeug: sie stellen die Fehler
            # her, aus denen Taktikaufgaben ueberhaupt bestehen.
            elo_white = rng.choice([1320, 1400, 1500, 1650, 1800])
            elo_black = rng.choice([1320, 1400, 1500, 1650, 1800])
            for board, last_move in play_game(white, black, scanner, rng,
                                              movetime=args.movetime,
                                              max_plies=args.max_plies,
                                              elo_white=elo_white,
                                              elo_black=elo_black):
                if board.ply() < 8:
                    continue
                scanned += 1
                key = board.board_fen() + " " + ("w" if board.turn else "b")
                if key in seen:
                    continue

                quick = scanner.analyse(board, depth=SCAN_DEPTH, multipv=2)
                if not looks_promising(quick["lines"]):
                    continue
                promising += 1

                puzzle = build_puzzle(scanner, board, last_move)
                if puzzle is None:
                    continue
                if args.require_mate and not puzzle.mate_in:
                    continue
                seen.add(key)
                puzzles.append(puzzle)
                print(f"[{len(puzzles):4d}/{args.count}] {puzzle.rating:>4}  "
                      f"{'+'.join(puzzle.themes):<28} {len(puzzle.moves)} Halbzuege  "
                      f"({games} Partien, {scanned} Stellungen, "
                      f"{promising} Kandidaten, "
                      f"{time.time()-started:.0f}s)", flush=True)
                if len(puzzles) >= args.count:
                    break
    except KeyboardInterrupt:
        print("\nAbgebrochen - das bisher Gefundene wird trotzdem geschrieben.", flush=True)
    finally:
        for e in (white, black, scanner):
            e.close()

    # Nach Schwierigkeit sortieren: die Oberflaeche kann so ohne eigenes
    # Sortieren an der passenden Stelle einsteigen.
    puzzles.sort(key=lambda p: p.rating)
    payload = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "generator": "tools/make_puzzles.py",
        "note": ("Selbst erzeugt und von Stockfish auf voller Staerke geprueft. "
                 "Keine fremde Puzzle-Datenbank, keine fremde Datenlizenz."),
        "puzzles": [p.to_json(i + 1) for i, p in enumerate(puzzles)],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(puzzles)} Puzzles nach {out} geschrieben "
          f"({time.time()-started:.0f}s, {games} Partien, "
          f"{scanned} Stellungen, {promising} Kandidaten).", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
