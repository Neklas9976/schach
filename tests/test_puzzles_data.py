"""Prueft den ausgelieferten Aufgabensatz gegen die Schachregeln.

static/puzzles.json wird erzeugt, nicht von Hand geschrieben - genau deshalb
gehoert die Datei geprueft. Ein Generator, der stillschweigend eine unmoegliche
Stellung oder einen illegalen Zug ablegt, faellt sonst erst dem Spieler auf, und
der haelt dann das Programm fuer kaputt.

Geprueft wird gegen eine *fremde* Regelimplementierung (python-chess), nicht
gegen die eigene: eine Engine, die ihre eigenen Ausgaben bestaetigt, bestaetigt
nur, dass sie zu sich selbst passt. python-chess ist reines Pruefwerkzeug und
wird nicht mit ausgeliefert; fehlt es, werden diese Tests uebersprungen.
"""

import json
import pathlib
import unittest

try:
    import chess
except ImportError:  # pragma: no cover
    chess = None

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "static" / "puzzles.json"


@unittest.skipIf(chess is None, "python-chess fehlt (python -m pip install chess)")
class PuzzleDataTest(unittest.TestCase):
    """Jede Aufgabe wird nachgespielt, nicht nur angeschaut."""

    @classmethod
    def setUpClass(cls):
        if not DATA.exists():
            raise unittest.SkipTest("static/puzzles.json fehlt")
        payload = json.loads(DATA.read_text(encoding="utf-8"))
        cls.puzzles = payload["puzzles"]

    def test_the_set_is_not_empty(self):
        self.assertTrue(self.puzzles)

    def test_ids_are_unique(self):
        ids = [p["id"] for p in self.puzzles]
        self.assertEqual(len(ids), len(set(ids)))

    def test_positions_are_unique(self):
        # Dieselbe Stellung zweimal waere keine zweite Aufgabe, sondern dieselbe.
        fens = [p["fen"] for p in self.puzzles]
        self.assertEqual(len(fens), len(set(fens)))

    def test_every_position_is_legal(self):
        for puzzle in self.puzzles:
            with self.subTest(puzzle=puzzle["id"]):
                board = chess.Board(puzzle["fen"])
                self.assertTrue(board.is_valid(), "unmoegliche Stellung")
                self.assertFalse(board.is_game_over(), "die Partie ist hier schon vorbei")

    def test_every_move_of_every_solution_is_legal(self):
        for puzzle in self.puzzles:
            with self.subTest(puzzle=puzzle["id"]):
                board = chess.Board(puzzle["fen"])
                for index, uci in enumerate(puzzle["moves"], start=1):
                    move = chess.Move.from_uci(uci)
                    self.assertIn(move, board.legal_moves,
                                  f"Zug {index} ({uci}) ist in {board.fen()} nicht legal")
                    board.push(move)

    def test_a_solution_ends_with_the_players_move(self):
        # Die Zuege wechseln sich ab und beginnen beim Spieler. Eine gerade
        # Anzahl hiesse, der letzte Zug gehoert dem Gegner - dann waere die
        # Aufgabe nach dem letzten gesuchten Zug noch gar nicht vorbei.
        for puzzle in self.puzzles:
            with self.subTest(puzzle=puzzle["id"]):
                self.assertEqual(len(puzzle["moves"]) % 2, 1, "Loesung endet beim Gegner")

    def test_the_player_never_has_only_one_move(self):
        for puzzle in self.puzzles:
            with self.subTest(puzzle=puzzle["id"]):
                board = chess.Board(puzzle["fen"])
                self.assertGreater(len(list(board.legal_moves)), 1,
                                   "eine Stellung mit nur einem Zug ist keine Aufgabe")

    def test_mate_claims_are_true(self):
        for puzzle in self.puzzles:
            if not puzzle.get("mateIn"):
                continue
            with self.subTest(puzzle=puzzle["id"]):
                board = chess.Board(puzzle["fen"])
                for uci in puzzle["moves"]:
                    board.push(chess.Move.from_uci(uci))
                self.assertTrue(board.is_checkmate(), "als Matt angekuendigt, ist aber keins")
                self.assertEqual(puzzle["mateIn"], (len(puzzle["moves"]) + 1) // 2)

    def test_a_mate_theme_matches_the_mate(self):
        for puzzle in self.puzzles:
            mate_themes = [t for t in puzzle["themes"] if t.startswith("mateIn")]
            if not mate_themes:
                continue
            with self.subTest(puzzle=puzzle["id"]):
                self.assertTrue(puzzle.get("mateIn"), "Mattthema ohne Matt")
                self.assertEqual(mate_themes, [f"mateIn{puzzle['mateIn']}"])

    def test_the_lead_in_move_really_leads_into_the_position(self):
        # Die Aufgabe spielt diesen Zug vor. Passt er nicht, steht danach eine
        # andere Stellung auf dem Brett als die, deren Loesung hinterlegt ist.
        for puzzle in self.puzzles:
            if "setupFen" not in puzzle:
                continue
            with self.subTest(puzzle=puzzle["id"]):
                board = chess.Board(puzzle["setupFen"])
                move = chess.Move.from_uci(puzzle["lastMove"])
                self.assertIn(move, board.legal_moves, "Vorspielzug ist nicht legal")
                board.push(move)
                self.assertEqual(board.fen(), puzzle["fen"],
                                 "nach dem Vorspielzug steht eine andere Stellung")

    def test_the_lead_in_move_belongs_to_the_opponent(self):
        for puzzle in self.puzzles:
            if "setupFen" not in puzzle:
                continue
            with self.subTest(puzzle=puzzle["id"]):
                before = chess.Board(puzzle["setupFen"])
                solver = chess.Board(puzzle["fen"]).turn
                self.assertNotEqual(before.turn, solver, "der Spieler zieht zweimal")

    def test_ratings_are_inside_the_scale(self):
        for puzzle in self.puzzles:
            with self.subTest(puzzle=puzzle["id"]):
                self.assertGreaterEqual(puzzle["rating"], 400)
                self.assertLessEqual(puzzle["rating"], 2800)

    def test_every_theme_has_a_german_label(self):
        # Ein Thema ohne Beschriftung erscheint als roher Bezeichner im Menue.
        source = (ROOT / "static" / "puzzles.js").read_text(encoding="utf-8")
        for theme in {t for p in self.puzzles for t in p["themes"]}:
            with self.subTest(theme=theme):
                self.assertIn(f"{theme}:", source, "kein deutscher Name fuer dieses Thema")

    def test_the_set_is_worth_training_with(self):
        # Untergrenzen, die einen kaputten Lauf auffangen sollen - nicht die
        # Zusammensetzung vorschreiben.
        self.assertGreaterEqual(len(self.puzzles), 100)
        self.assertGreaterEqual(len({t for p in self.puzzles for t in p["themes"]}), 5)
        self.assertTrue(any(p.get("mateIn") for p in self.puzzles), "keine Mattaufgabe")
        self.assertGreaterEqual(sum(1 for p in self.puzzles if len(p["moves"]) >= 3), 20,
                                "fast nur Einzelzuege")


if __name__ == "__main__":
    unittest.main()
