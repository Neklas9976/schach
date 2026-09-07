"""Bridge between the web app and a native UCI chess engine (e.g. Stockfish).

The browser cannot execute a native binary, but the Flask server running on the
same machine can. This module owns the engine subprocess and exposes a small,
synchronous request/response API on top of the UCI protocol.

Design notes
------------
* One long-lived process. Starting Stockfish costs hundreds of milliseconds
  (it loads its NNUE network), so respawning per move would be very noticeable.
* A dedicated reader thread drains stdout into a queue. Reading inline would
  deadlock as soon as the engine emits more output than the pipe buffer holds.
* Every request is serialised behind a lock. UCI is a stateful, single-session
  protocol - two overlapping searches on one process would interleave and the
  replies could not be told apart.
* The engine is treated as untrusted for *availability*, not for security: any
  malformed or missing reply must surface as a clean error instead of hanging
  the request thread forever.
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import threading
import time
from pathlib import Path

# Accepts the standard algebraic UCI move format, including promotions.
_MOVE_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")

# A FEN is whitespace-separated fields over a restricted alphabet. This is a
# sanity check to keep malformed input from reaching the engine, not a full
# validator - the engine itself is the authority on legality.
_FEN_RE = re.compile(r"^[rnbqkpRNBQKP1-8/]+ [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+$")

_ENGINE_NAMES = (
    "stockfish.exe",
    "stockfish",
    "stockfish-windows-x86-64-universal.exe",
)

# Extensions that can plausibly be an engine binary. Everything else in a
# Stockfish download (Copying.txt, README.md, the whole src/ tree, the helper
# shell scripts) must be ignored, or the search would happily "find" a text
# file and fail later with a confusing error.
#
# On Windows a batch wrapper counts too: CreateProcess launches .bat/.cmd as
# readily as an .exe, and wrapping the engine to pin a Syzygy path or a thread
# count is a normal way to ship it there.
_BINARY_SUFFIXES = {"", ".exe", ".bin"}
if os.name == "nt":
    _BINARY_SUFFIXES |= {".bat", ".cmd"}

# Range Stockfish accepts for UCI_Elo. Values outside it are rejected by the
# engine with a silent no-op, which would look like the strength cap simply
# not working, so requests are clamped here instead.
_MIN_ELO = 1320
_MAX_ELO = 3190

# How deep to look below engine/. Unpacking the official archive produces
# engine/stockfish-.../stockfish-....exe, and some tools add another wrapper
# folder on top, so two extra levels covers the realistic cases without
# walking a large tree.
_MAX_SEARCH_DEPTH = 3


def _looks_like_engine(path: Path) -> bool:
    return (
        path.is_file()
        and path.name.lower().startswith("stockfish")
        and path.suffix.lower() in _BINARY_SUFFIXES
    )


def _scan_for_engine(directory: Path, depth: int = 0) -> Path | None:
    """Finds an engine binary in `directory`, descending into subfolders.

    Users naturally drop the whole extracted archive folder in place rather
    than digging out the single executable, so a flat scan would report
    "not found" for a perfectly correct setup.
    """
    try:
        entries = sorted(directory.iterdir())
    except OSError:
        return None

    # Files before directories: a binary sitting directly in engine/ wins over
    # one buried in a subfolder.
    for candidate in entries:
        if _looks_like_engine(candidate):
            return candidate

    if depth >= _MAX_SEARCH_DEPTH:
        return None

    for candidate in entries:
        if candidate.is_dir():
            found = _scan_for_engine(candidate, depth + 1)
            if found is not None:
                return found

    return None


class EngineError(RuntimeError):
    """Raised when the engine is unavailable or misbehaves."""


def find_engine(base_dir: Path) -> Path | None:
    """Locates a usable engine binary.

    Resolution order: explicit environment variable, then any executable in the
    project's `engine/` directory. The directory scan means the user can simply
    drop the download in place without editing configuration.
    """
    override = os.environ.get("CHESS_ENGINE_PATH")
    if override:
        candidate = Path(override).expanduser()
        return candidate if candidate.is_file() else None

    engine_dir = base_dir / "engine"
    if not engine_dir.is_dir():
        return None

    # Exact, well-known names take priority when they sit directly in engine/.
    for name in _ENGINE_NAMES:
        candidate = engine_dir / name
        if candidate.is_file():
            return candidate

    return _scan_for_engine(engine_dir)


class UciEngine:
    """A single long-lived UCI engine process."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._process: subprocess.Popen | None = None
        self._lines: queue.Queue[str] = queue.Queue()
        self._reader: threading.Thread | None = None
        self._lock = threading.Lock()
        self.name = "Unbekannte Engine"

    # -- process lifecycle -------------------------------------------------

    def _spawn(self) -> None:
        if not self.path.is_file():
            raise EngineError(f"Engine nicht gefunden: {self.path}")

        kwargs = {}
        if os.name == "nt":
            # Keep the engine from flashing up its own console window.
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

        try:
            self._process = subprocess.Popen(
                [str(self.path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                cwd=str(self.path.parent),
                **kwargs,
            )
        except OSError as exc:
            raise EngineError(f"Engine konnte nicht gestartet werden: {exc}") from exc

        self._lines = queue.Queue()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

        self._send("uci")
        self._await("uciok", timeout=15.0, collect=self._capture_name)
        self._send("isready")
        self._await("readyok", timeout=15.0)

    def _capture_name(self, line: str) -> None:
        if line.startswith("id name "):
            self.name = line[len("id name "):].strip()

    def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for line in process.stdout:
            self._lines.put(line.strip())
        # A None sentinel marks end-of-stream. An empty string would be
        # ambiguous: engines do emit blank lines, and confusing the two made a
        # crashed engine wait for the full timeout instead of failing at once.
        self._lines.put(None)

    def _alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def ensure_started(self) -> None:
        if not self._alive():
            self._spawn()

    def stop(self) -> None:
        if not self._alive():
            self._process = None
            return
        process = self._process
        try:
            self._send("quit")
            process.wait(timeout=3)
        except Exception:
            process.kill()
            try:
                process.wait(timeout=2)
            except Exception:
                pass
        finally:
            # Pipes must be closed explicitly. Dropping the reference alone
            # leaks a file handle per restart, which accumulates over a long
            # session of switching engines.
            for stream in (process.stdin, process.stdout):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:
                    pass
            self._process = None

    # -- protocol ----------------------------------------------------------

    def _send(self, command: str) -> None:
        if self._process is None or self._process.stdin is None:
            raise EngineError("Engine läuft nicht")
        try:
            self._process.stdin.write(command + "\n")
            self._process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise EngineError(f"Verbindung zur Engine verloren: {exc}") from exc

    def _await(self, prefix: str, timeout: float, collect=None) -> str:
        """Reads lines until one starts with `prefix`, or the timeout expires."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EngineError(f"Zeitüberschreitung beim Warten auf '{prefix}'")
            try:
                line = self._lines.get(timeout=remaining)
            except queue.Empty:
                raise EngineError(f"Zeitüberschreitung beim Warten auf '{prefix}'")

            if line is None:
                raise EngineError("Die Engine hat sich unerwartet beendet")
            if collect is not None:
                collect(line)
            if line.startswith(prefix):
                return line

    def _drain(self) -> None:
        """Discards leftover output from an earlier, abandoned search."""
        while True:
            try:
                if self._lines.get_nowait() is None:
                    raise EngineError("Die Engine hat sich unerwartet beendet")
            except queue.Empty:
                return

    # -- public API --------------------------------------------------------

    def best_move(
        self,
        fen: str,
        movetime_ms: int,
        skill: int | None = None,
        elo: int | None = None,
    ) -> dict:
        if not _FEN_RE.match(fen):
            raise EngineError("Ungültige Stellungsangabe")

        movetime_ms = max(50, min(int(movetime_ms), 60_000))

        with self._lock:
            self.ensure_started()
            self._drain()

            if skill is not None:
                skill = max(0, min(int(skill), 20))
                self._send(f"setoption name Skill Level value {skill}")

            # UCI options persist for the life of the process, so the strength
            # cap has to be restated on every request - including the "off"
            # case. Without that, switching from level 4 back to level 8 would
            # silently keep playing at 1800 Elo.
            if elo is None:
                self._send("setoption name UCI_LimitStrength value false")
            else:
                elo = max(_MIN_ELO, min(int(elo), _MAX_ELO))
                self._send("setoption name UCI_LimitStrength value true")
                self._send(f"setoption name UCI_Elo value {elo}")

            self._send("ucinewgame")
            self._send("isready")
            self._await("readyok", timeout=15.0)

            self._send(f"position fen {fen}")
            self._send(f"go movetime {movetime_ms}")

            info = {"depth": None, "score_cp": None, "mate": None}

            def collect(line: str) -> None:
                if not line.startswith("info "):
                    return
                tokens = line.split()
                if "depth" in tokens:
                    try:
                        info["depth"] = int(tokens[tokens.index("depth") + 1])
                    except (IndexError, ValueError):
                        pass
                if "score" in tokens:
                    try:
                        kind = tokens[tokens.index("score") + 1]
                        value = int(tokens[tokens.index("score") + 2])
                        if kind == "cp":
                            info["score_cp"] = value
                        elif kind == "mate":
                            info["mate"] = value
                    except (IndexError, ValueError):
                        pass

            # Generous margin over movetime: the engine finishes its current
            # iteration before answering, and a loaded machine can be slow.
            line = self._await("bestmove", timeout=movetime_ms / 1000 + 20.0, collect=collect)

        parts = line.split()
        move = parts[1] if len(parts) > 1 else "(none)"
        if move == "(none)":
            return {"bestmove": None, **info}
        if not _MOVE_RE.match(move):
            raise EngineError(f"Unerwartete Antwort der Engine: {line!r}")

        return {"bestmove": move, **info}


class EngineManager:
    """Lazily creates engines and reports their availability to the app.

    There is one process *per purpose*, not one overall. UCI is a single
    session: every request on a process is serialised behind that process's
    lock. With a shared engine, turning on the evaluation bar would put an
    analysis request in front of the opponent's move and the board would
    visibly stall on every turn. Separate processes cost a little memory and
    remove the contention entirely.
    """

    PURPOSES = ('play', 'analysis')

    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir)
        self._engines: dict[str, UciEngine] = {}
        self._lock = threading.Lock()

    def status(self) -> dict:
        path = find_engine(self.base_dir)
        if path is None:
            engine_dir = self.base_dir / "engine"
            return {
                "available": False,
                "reason": (
                    "Keine Engine gefunden. Lege die Stockfish-Programmdatei (.exe) in den "
                    "Ordner 'engine/' – ein entpackter Unterordner ist ebenfalls in Ordnung. "
                    "Danach den Server neu starten."
                ),
                "searched": str(engine_dir),
            }
        # `file` is what the UI shows. The full path is kept for the rare case
        # where the user needs to know *which* of several binaries was picked,
        # but it is far too long to put in front of them by default.
        started = next((e for e in self._engines.values() if e.name != "Unbekannte Engine"), None)
        return {
            "available": True,
            "path": str(path),
            "file": path.name,
            "name": started.name if started is not None else None,
        }

    def _get(self, purpose: str = "play") -> UciEngine:
        with self._lock:
            path = find_engine(self.base_dir)
            if path is None:
                raise EngineError(
                    "Keine Engine gefunden. Lege die Stockfish-Datei in den Ordner 'engine/'."
                )
            engine = self._engines.get(purpose)
            if engine is None or engine.path != path:
                if engine is not None:
                    engine.stop()
                engine = UciEngine(path)
                self._engines[purpose] = engine
            return engine

    def _run(self, purpose: str, action):
        engine = self._get(purpose)
        try:
            return action(engine)
        except EngineError:
            # A crashed or wedged engine must not poison every later request,
            # so the process is dropped and rebuilt on the next call.
            engine.stop()
            raise

    def best_move(
        self,
        fen: str,
        movetime_ms: int,
        skill: int | None = None,
        elo: int | None = None,
    ) -> dict:
        return self._run("play", lambda e: e.best_move(fen, movetime_ms, skill, elo))

    def evaluate(self, fen: str, movetime_ms: int = 300) -> dict:
        """Scores a position at full strength on the analysis process.

        Never capped: an evaluation bar or a game review has to say how good
        the position actually is, not how good it looks to a deliberately
        weakened opponent.
        """
        return self._run("analysis", lambda e: e.best_move(fen, movetime_ms, skill=20, elo=None))

    def shutdown(self) -> None:
        for engine in list(self._engines.values()):
            engine.stop()
        self._engines.clear()
