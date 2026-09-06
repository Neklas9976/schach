"""Tests for the native engine bridge.

These use a scripted stub engine rather than Stockfish itself: the point is to
verify the bridge's protocol handling and failure modes, which must behave
identically no matter which UCI engine is installed.
"""

import os
import stat
import sys
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine_bridge import EngineError, EngineManager, UciEngine, find_engine  # noqa: E402

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def write_stub(directory: Path, body: str, name: str = "stockfish") -> Path:
    path = directory / name
    path.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(body), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


WORKING_STUB = """
    import sys
    for line in sys.stdin:
        cmd = line.strip()
        if cmd == "uci":
            print("id name StubFish"); print("uciok"); sys.stdout.flush()
        elif cmd == "isready":
            print("readyok"); sys.stdout.flush()
        elif cmd.startswith("go"):
            print("info depth 9 score cp -42 pv e2e4")
            print("bestmove e2e4"); sys.stdout.flush()
        elif cmd == "quit":
            break
"""


class EngineDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(__file__).resolve().parent / "_tmp_engine"
        (self.tmp / "engine").mkdir(parents=True, exist_ok=True)
        os.environ.pop("CHESS_ENGINE_PATH", None)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop("CHESS_ENGINE_PATH", None)

    def test_missing_engine_is_reported_not_raised(self):
        manager = EngineManager(self.tmp)
        status = manager.status()
        self.assertFalse(status["available"])
        self.assertIn("engine", status["reason"].lower())

    def test_engine_is_found_by_name_prefix(self):
        write_stub(self.tmp / "engine", WORKING_STUB, name="stockfish-windows-x86-64.exe")
        found = find_engine(self.tmp)
        self.assertIsNotNone(found)
        self.assertTrue(found.name.startswith("stockfish"))

    def test_environment_variable_takes_precedence(self):
        path = write_stub(self.tmp / "engine", WORKING_STUB, name="custom-engine")
        os.environ["CHESS_ENGINE_PATH"] = str(path)
        self.assertEqual(find_engine(self.tmp), path)

    def test_environment_variable_pointing_nowhere_is_ignored(self):
        os.environ["CHESS_ENGINE_PATH"] = str(self.tmp / "does-not-exist")
        self.assertIsNone(find_engine(self.tmp))

    def test_engine_is_found_inside_an_extracted_archive_folder(self):
        # Regression: users drop the whole unpacked download into engine/
        # rather than digging out the single executable. A flat scan reported
        # "not found" for this entirely correct setup.
        nested = self.tmp / "engine" / "stockfish-windows-x86-64-universal" / "stockfish"
        nested.mkdir(parents=True)
        binary = write_stub(nested, WORKING_STUB, name="stockfish-windows-x86-64-universal.exe")

        found = find_engine(self.tmp)
        self.assertEqual(found, binary)

    def test_documentation_files_are_not_mistaken_for_the_engine(self):
        # A Stockfish download ships Copying.txt, README.md and a src/ tree.
        # Picking one of those up would fail later with a confusing error.
        nested = self.tmp / "engine" / "stockfish"
        (nested / "src").mkdir(parents=True)
        (nested / "Copying.txt").write_text("GPL", encoding="utf-8")
        (nested / "stockfish-readme.txt").write_text("docs", encoding="utf-8")
        (nested / "src" / "stockfish.cpp").write_text("int main(){}", encoding="utf-8")

        self.assertIsNone(find_engine(self.tmp))

    def test_a_binary_directly_in_engine_wins_over_a_nested_one(self):
        nested = self.tmp / "engine" / "old-build"
        nested.mkdir(parents=True)
        write_stub(nested, WORKING_STUB, name="stockfish-old.exe")
        direct = write_stub(self.tmp / "engine", WORKING_STUB, name="stockfish.exe")

        self.assertEqual(find_engine(self.tmp), direct)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(__file__).resolve().parent / "_tmp_proto"
        (self.tmp / "engine").mkdir(parents=True, exist_ok=True)
        os.environ.pop("CHESS_ENGINE_PATH", None)
        self.path = write_stub(self.tmp / "engine", WORKING_STUB)
        self.engine = UciEngine(self.path)

    def tearDown(self):
        self.engine.stop()
        for child in (self.tmp / "engine").glob("*"):
            child.unlink()
        (self.tmp / "engine").rmdir()
        self.tmp.rmdir()

    def test_best_move_returns_move_and_parsed_info(self):
        result = self.engine.best_move(START_FEN, 200)
        self.assertEqual(result["bestmove"], "e2e4")
        self.assertEqual(result["depth"], 9)
        self.assertEqual(result["score_cp"], -42)

    def test_process_is_reused_across_requests(self):
        self.engine.best_move(START_FEN, 100)
        first = self.engine._process.pid
        self.engine.best_move(START_FEN, 100)
        self.assertEqual(self.engine._process.pid, first, "engine must not respawn per move")

    def test_malformed_fen_is_rejected_before_reaching_the_engine(self):
        with self.assertRaises(EngineError):
            self.engine.best_move("not a position", 200)

    def test_movetime_is_clamped_to_a_sane_range(self):
        # An unbounded movetime from the client could pin the engine forever.
        result = self.engine.best_move(START_FEN, 10_000_000)
        self.assertEqual(result["bestmove"], "e2e4")


class FailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(__file__).resolve().parent / "_tmp_fail"
        (self.tmp / "engine").mkdir(parents=True, exist_ok=True)
        os.environ.pop("CHESS_ENGINE_PATH", None)

    def tearDown(self):
        for child in (self.tmp / "engine").glob("*"):
            child.unlink()
        (self.tmp / "engine").rmdir()
        self.tmp.rmdir()

    def test_engine_that_exits_immediately_fails_fast(self):
        # Regression guard: this used to wait for the full handshake timeout
        # because end-of-stream was signalled with an ambiguous empty string.
        write_stub(self.tmp / "engine", "import sys\nsys.exit(1)\n")
        manager = EngineManager(self.tmp)
        started = time.monotonic()
        with self.assertRaises(EngineError):
            manager.best_move(START_FEN, 500)
        self.assertLess(time.monotonic() - started, 5.0, "a dead engine must be detected immediately")

    def test_engine_returning_garbage_is_rejected(self):
        write_stub(self.tmp / "engine", """
            import sys
            for line in sys.stdin:
                cmd = line.strip()
                if cmd == "uci":
                    print("uciok"); sys.stdout.flush()
                elif cmd == "isready":
                    print("readyok"); sys.stdout.flush()
                elif cmd.startswith("go"):
                    print("bestmove nonsense"); sys.stdout.flush()
                elif cmd == "quit":
                    break
        """)
        manager = EngineManager(self.tmp)
        with self.assertRaises(EngineError):
            manager.best_move(START_FEN, 300)

    def test_no_legal_move_is_reported_as_none(self):
        write_stub(self.tmp / "engine", """
            import sys
            for line in sys.stdin:
                cmd = line.strip()
                if cmd == "uci":
                    print("uciok"); sys.stdout.flush()
                elif cmd == "isready":
                    print("readyok"); sys.stdout.flush()
                elif cmd.startswith("go"):
                    print("bestmove (none)"); sys.stdout.flush()
                elif cmd == "quit":
                    break
        """)
        manager = EngineManager(self.tmp)
        result = manager.best_move(START_FEN, 300)
        self.assertIsNone(result["bestmove"])
        manager.shutdown()


if __name__ == "__main__":
    unittest.main()
