from pathlib import Path
import atexit
import threading
import webbrowser

from flask import Flask, jsonify, render_template, request

from engine_bridge import EngineError, EngineManager

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)
engine_manager = EngineManager(BASE_DIR)
atexit.register(engine_manager.shutdown)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/engine/status')
def engine_status():
    """Lets the UI tell the user whether a native engine is usable."""
    return jsonify(engine_manager.status())


@app.route('/api/engine/bestmove', methods=['POST'])
def engine_bestmove():
    payload = request.get_json(silent=True) or {}
    fen = payload.get('fen')
    if not isinstance(fen, str):
        return jsonify({'error': 'Es wurde keine Stellung übergeben.'}), 400

    try:
        movetime = int(payload.get('movetime', 1000))
    except (TypeError, ValueError):
        return jsonify({'error': 'Ungültige Rechenzeit.'}), 400

    skill = payload.get('skill')
    if skill is not None:
        try:
            skill = int(skill)
        except (TypeError, ValueError):
            return jsonify({'error': 'Ungültige Spielstärke.'}), 400

    # `null` is meaningful here and distinct from a missing key: it is how the
    # maximum level asks for an uncapped engine.
    elo = payload.get('elo')
    if elo is not None:
        try:
            elo = int(elo)
        except (TypeError, ValueError):
            return jsonify({'error': 'Ungültige Elo-Vorgabe.'}), 400

    try:
        result = engine_manager.best_move(fen, movetime, skill, elo)
    except EngineError as exc:
        # 503: the request was fine, the engine just is not available.
        return jsonify({'error': str(exc)}), 503

    return jsonify(result)


@app.route('/api/engine/evaluate', methods=['POST'])
def engine_evaluate():
    """Scores one position, for the evaluation bar and the game review.

    Separate from /bestmove because it must never be weakened by the current
    difficulty level, and because it runs on its own engine process so an
    analysis request cannot queue behind the opponent's search.
    """
    payload = request.get_json(silent=True) or {}
    fen = payload.get('fen')
    if not isinstance(fen, str):
        return jsonify({'error': 'Es wurde keine Stellung übergeben.'}), 400

    try:
        movetime = int(payload.get('movetime', 300))
    except (TypeError, ValueError):
        return jsonify({'error': 'Ungültige Rechenzeit.'}), 400

    try:
        result = engine_manager.evaluate(fen, movetime)
    except EngineError as exc:
        return jsonify({'error': str(exc)}), 503

    return jsonify(result)


def open_browser():
    webbrowser.open('http://127.0.0.1:5000')


if __name__ == '__main__':
    threading.Timer(0.8, open_browser).start()
    app.run(debug=True, use_reloader=False)
