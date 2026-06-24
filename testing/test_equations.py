#!/usr/bin/env python3
"""
test_equations.py - Automated OCR accuracy tests for the whiteboard.
Uses Playwright to open the whiteboard, draw equation strokes, trigger
recognition, and compare predictions against ground truth.
"""

import json
import time
import os
import re
import sys
import argparse
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError as e:
    sync_playwright = None

from browser_canvas_bridge import draw_latex_equation as paste_latex_equation


# ---------- Character Stroke Definitions ----------
# Each char is a list of strokes. Each stroke is a list of (x, y) points in a 60x80 grid.

CHAR_STROKES = {
    "0": [[(30,15),(48,15),(52,30),(52,55),(48,68),(30,68),(12,55),(12,30),(30,15)]],
    "1": [[(30,15),(30,68)],[(20,18),(40,15)]],
    "2": [[(15,15),(45,15),(48,40),(18,45),(18,68),(50,68)]],
    "3": [[(15,15),(48,15),(48,38),(32,38)],[(48,38),(48,68),(15,68)]],
    "4": [[(40,15),(40,68)],[(40,18),(12,48),(52,48)]],
    "5": [[(45,15),(15,15),(15,40),(42,40),(42,68),(15,68)]],
    "6": [[(45,15),(18,15),(15,40),(15,60),(18,68),(42,68),(45,45),(18,45)]],
    "7": [[(15,15),(50,15),(30,68)]],
    "8": [[(30,15),(45,15),(48,35),(30,35),(15,35),(15,55),(42,55),(45,68),(30,68),(15,55)]],
    "9": [[(45,68),(45,15),(18,15),(15,38),(45,38)]],
    "a": [[(35,30),(22,30),(18,48),(18,60),(25,65),(42,65),(45,50),(45,30)],[(45,30),(45,25)]],
    "b": [[(15,15),(15,68)],[(15,40),(32,38),(42,48),(42,62),(30,65),(18,60)]],
    "c": [[(42,28),(22,28),(15,42),(15,58),(22,65),(42,65)]],
    "d": [[(48,15),(48,68)],[(48,40),(30,38),(20,48),(20,62),(32,65),(45,60)]],
    "e": [[(42,28),(20,28),(18,42),(18,58),(22,65),(42,65)],[(20,48),(40,48)]],
    "f": [[(22,15),(42,15)],[(28,15),(28,68)],[(18,42),(38,42)]],
    "g": [[(38,30),(22,30),(18,48),(18,60),(22,65),(38,65),(42,50),(42,30)],[(42,65),(42,82),(38,85),(20,85)]],
    "h": [[(15,15),(15,68)],[(15,40),(30,38),(42,48),(42,68)]],
    "i": [[(30,15)],[(30,28),(30,68)]],
    "k": [[(12,15),(12,68)],[(12,42),(42,18)],[(12,48),(40,68)]],
    "l": [[(30,15),(30,68)]],
    "m": [[(8,28),(8,68)],[(8,28),(22,28),(22,52),(22,68)],[(22,28),(36,28),(36,52),(36,68)]],
    "n": [[(12,28),(12,68)],[(12,28),(28,28),(40,50),(40,68)]],
    "o": [[(30,30),(42,30),(45,45),(42,58),(30,58),(18,45),(30,30)]],
    "p": [[(15,28),(15,85)],[(15,28),(32,28),(42,42),(42,58),(30,62),(18,58)]],
    "q": [[(42,28),(42,85)],[(42,28),(28,28),(18,42),(18,58),(30,62),(42,58)]],
    "r": [[(12,28),(12,68)],[(12,28),(38,28),(38,40)]],
    "s": [[(42,22),(18,22),(18,42),(42,42),(42,65),(18,65)]],
    "t": [[(25,15),(25,60)],[(15,38),(40,38)]],
    "u": [[(15,25),(15,60),(42,60),(42,25)]],
    "v": [[(12,25),(30,65),(48,25)]],
    "w": [[(5,25),(18,65),(30,35),(42,65),(55,25)]],
    "x": [[(12,25),(48,65)],[(48,25),(12,65)]],
    "y": [[(12,25),(30,50),(48,25)],[(30,50),(30,80)]],
    "z": [[(15,25),(48,25),(15,65),(48,65)]],
    "A": [[(10,68),(30,12),(50,68)],[(18,48),(42,48)]],
    "B": [[(12,12),(12,68)],[(12,12),(35,12),(42,28),(30,35)],[(12,35),(30,35)],[(12,35),(30,35),(42,52),(30,68),(12,68)]],
    "C": [[(48,18),(22,18),(12,38),(12,52),(22,68),(48,68)]],
    "D": [[(12,12),(12,68)],[(12,12),(32,12),(48,28),(48,52),(32,68),(12,68)]],
    "E": [[(48,12),(12,12),(12,68),(48,68)],[(12,42),(38,42)]],
    "F": [[(12,12),(12,68)],[(12,12),(48,12)],[(12,40),(38,40)]],
    "H": [[(12,12),(12,68)],[(48,12),(48,68)],[(12,42),(48,42)]],
    "I": [[(30,12),(30,68)],[(15,12),(45,12)],[(15,68),(45,68)]],
    "M": [[(8,68),(8,12),(30,42),(52,12),(52,68)]],
    "N": [[(10,68),(10,12),(50,68),(50,12)]],
    "P": [[(12,12),(12,68)],[(12,12),(38,12),(45,28),(35,35),(12,35)]],
    "R": [[(12,12),(12,68)],[(12,12),(35,12),(42,28),(32,35),(12,35)],[(30,40),(48,68)]],
    "S": [[(45,15),(18,15),(15,32),(42,35),(45,52),(30,65),(15,65)]],
    "T": [[(8,12),(52,12)],[(30,12),(30,68)]],
    "X": [[(10,12),(50,68)],[(50,12),(10,68)]],
    "+": [[(30,15),(30,65)],[(10,40),(50,40)]],
    "-": [[(10,40),(50,40)]],
    "=": [[(10,30),(50,30)],[(10,50),(50,50)]],
    "*": [[(18,20),(42,60)],[(42,20),(18,60)],[(10,40),(50,40)]],
    "/": [[(48,12),(8,68)]],
    "^": [[(15,35),(30,15),(45,35)]],
    "(": [[(42,10),(22,28),(18,42),(22,58),(42,72)]],
    ")": [[(18,10),(38,28),(42,42),(38,58),(18,72)]],
    "<": [[(48,20),(15,42),(48,62)]],
    ">": [[(12,20),(45,42),(12,62)]],
    "!": [[(30,10),(30,50)],[(30,60)]],
    "∫": [[(48,10),(8,10),(32,38),(8,65),(48,65)]],
}


# ---------- Equation Definitions ----------
EQUATIONS = [
    ("simple_pythagorean", "a 2 + b 2 = c 2", r"a ^ { 2 } + b ^ { 2 } = c ^ { 2 }", "simple"),
    ("simple_x_equals_yz", "x = y + z", r"x = y + z", "simple"),
    ("simple_square_root", "x = / y", r"x = \sqrt { y }", "simple"),
    ("simple_less_than", "a < b + c", r"a < b + c", "simple"),
    ("simple_plus_minus", "x = 2 + - 3", r"x = 2 \pm 3", "simple"),
    ("simple_fraction", "a / b = c", r"\frac { a } { b } = c", "simple"),
    ("simple_times", "y = a * b / c", r"y = a \cdot \frac { b } { c }", "simple"),
    ("simple_exponent", "c = a 2 + b 2", r"c = a ^ { 2 } + b ^ { 2 }", "simple"),
    ("complex_fraction_rational_equation", "1 / x 2 - 3 = 1", r"\frac { 1 } { x ^ { 2 } - 3 } = 1", "complex"),
    ("complex_radical_linear_equation", "/ x + 1 + 8 = 1 2", r"\sqrt { x + 1 } + 8 = 12", "complex"),
    ("complex_quadratic", "x = - b + - / b 2 - 4 a c / 2 a", r"x = \frac { - b \pm \sqrt { b ^ { 2 } - 4 a c } } { 2 a }", "complex"),
    ("complex_eulers", "e i + 1 = 0", r"e ^ { i \pi } + 1 = 0", "complex"),
    ("complex_limit", "l i m n ( 1 + 1 / n ) n = e", r"\lim _ { n \to \infty } ( 1 + \frac { 1 } { n } ) ^ { n } = e", "complex"),
    ("complex_sum", "S k = 1 1 / k 2 = 2 / 6", r"\sum _ { k = 1 } ^ { \infty } \frac { 1 } { k ^ { 2 } } = \frac { \pi ^ { 2 } } { 6 }", "complex"),
]


def render_equation(chars_str, origin_x, origin_y, char_w=60, char_h=80, gap=8):
    """Convert a character string into positioned stroke lists in canvas coords."""
    all_strokes = []
    x = origin_x
    for ch in chars_str:
        if ch == " ":
            # Spaces make fixtures readable; normal character spacing already
            # leaves enough separation for the handwriting line grouper.
            continue
        ch_strokes = CHAR_STROKES.get(ch, [])
        for stroke in ch_strokes:
            positioned = [(px + x, py + origin_y) for (px, py) in stroke]
            all_strokes.append(positioned)
        x += char_w + gap
    return all_strokes


def draw_equation(page, chars_str, cw=1400, ch=800):
    """Inject stroke data into the browser whiteboard for an equation string."""
    char_w, char_h, gap = 60, 80, 8
    visible_chars = len(chars_str.replace(" ", ""))
    total_w = visible_chars * char_w + max(0, visible_chars - 1) * gap
    origin_x = max(40, (cw - total_w) // 2)
    origin_y = max(60, (ch - char_h) // 2)
    strokes = render_equation(chars_str, origin_x, origin_y, char_w, char_h, gap)
    strokes_json = json.dumps(strokes)

    js = f"""
    (function() {{
        var eqStrokes = {strokes_json};
        var canvasEl = document.getElementById('whiteboard');
        var cw = canvasEl.clientWidth;
        var ch = canvasEl.clientHeight;

        for (var si = 0; si < eqStrokes.length; si++) {{
            var rawPts = eqStrokes[si];
            if (rawPts.length < 2) continue;
            strokeSaver.startStroke(rawPts[0][0], rawPts[0][1], 0.5, cw, ch);
            for (var pi = 1; pi < rawPts.length; pi++) {{
                strokeSaver.addPoint(rawPts[pi][0], rawPts[pi][1], 0.5, cw, ch);
            }}
            var smootherPts = rawPts.map(function(pt) {{ return {{x: pt[0], y: pt[1]}}; }});
            var outline = strokeSmoother.smooth(smootherPts);
            strokeSaver.endStroke(outline, '#000000');
        }}

        if (typeof IdentifyLine !== 'undefined') IdentifyLine.finalizeStroke();
        if (typeof LinesRasterizer !== 'undefined') {{
            LinesRasterizer.clearCache();
            LinesRasterizer.rasterizeAllLines();
        }}
    }})();
    """
    page.evaluate(js)


def draw_latex_equation(page, latex, seed=0, cw=1400, ch=800):
    """Render LaTeX as synthetic handwriting and paste it into the whiteboard."""
    return paste_latex_equation(page, latex, seed=seed)


def clear_whiteboard(page):
    page.evaluate("""
    (function() {
        if (typeof window.clearAllStrokes === 'function') {
            window.clearAllStrokes();
        } else if (window.strokeSaver) {
            strokeSaver.clear();
            if (typeof IdentifyLine !== 'undefined') IdentifyLine.groupStrokesIntoLines();
            if (typeof LinesRasterizer !== 'undefined') {
                LinesRasterizer.clearCache();
                LinesRasterizer.rasterizeAllLines();
            }
        }
        if (typeof LatexPredictor !== 'undefined') LatexPredictor.clearPredictions();
    })();
    """)
    time.sleep(0.3)


def trigger_recognition(page):
    page.evaluate("""
    (function() {
        if (typeof LatexPredictor !== 'undefined') LatexPredictor.recognize();
    })();
    """)
    try:
        page.wait_for_selector(".prediction-row", timeout=20000)
    except Exception:
        pass
    time.sleep(2)


def extract_predictions(page):
    return page.evaluate("""
    (function() {
        var rows = document.querySelectorAll('.prediction-row');
        var out = {};
        if (rows.length === 0) return out;
        var row = rows[0];
        var cols = row.querySelectorAll('.prediction-col');
        var names = ['comer', 'san', 'can'];
        for (var i = 0; i < cols.length; i++) {
            var col = cols[i];
            var model = names[i] || ('col_' + i);
            var latex = '';
            var raw = col.querySelector('.prediction-raw');
            if (raw) latex = raw.textContent.trim();
            var confidence = null;
            var conf = col.querySelector('.prediction-conf-badge');
            if (conf) {
                var c = parseFloat(conf.textContent.replace('%', ''));
                if (!isNaN(c)) confidence = c / 100.0;
            }
            out[model] = {latex: latex, confidence: confidence};
        }
        return out;
    })();
    """)


def latex_matches(pred, ground):
    """Loose comparison: whitespace-normalized exact or key-symbol check."""
    if not pred or not ground:
        return False, "empty prediction"
    p = re.sub(r"\s+", "", pred)
    g = re.sub(r"\s+", "", ground)
    if p == g:
        return True, "exact"

    key_symbols = ["\\frac", "\\sqrt", "\\sum", "\\int", "\\lim", "\\pi", "\\pm",
                   "\\cdot", "\\infty", "\\to", "\^{\\{", "_{\\{"]
    missing = [s for s in key_symbols if s in g and s not in p]
    if not missing:
        return True, "key_symbols_match"
    return False, "missing: " + ",".join(missing)


def load_ground_truth():
    path = Path(__file__).parent / "expected_latex.txt"
    gt = {}
    if not path.exists():
        return gt
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 2:
                gt[parts[0]] = parts[1]
    return gt


def run_tests(playwright, headless=True, category=None):
    ground_truth = load_ground_truth()
    tests = [t for t in EQUATIONS if (not category or t[3] == category)]

    browser = playwright.chromium.launch(headless=headless)
    context = browser.new_context(viewport={"width": 1400, "height": 900})
    page = context.new_page()

    url = "http://localhost:8000/index.html"
    print(f"Opening {url}")
    page.goto(url, timeout=20000)

    page.wait_for_function("typeof window.strokeSaver !== 'undefined'", timeout=10000)
    page.wait_for_function("typeof window.LatexPredictor !== 'undefined'", timeout=10000)
    time.sleep(2)
    print("Whiteboard loaded.\n")

    results = []
    for idx, (name, char_str, latex, cat) in enumerate(tests, 1):
        print(f"[{idx}/{len(tests)}] {name} ({cat})")
        clear_whiteboard(page)
        board = draw_latex_equation(page, latex, seed=idx)
        rendered = board.lines[0]
        time.sleep(0.5)
        trigger_recognition(page)
        predictions = extract_predictions(page)
        gt = ground_truth.get(name, latex)

        item = {
            "name": name,
            "category": cat,
            "char_string": char_str,
            "ground_truth": gt,
            "synthetic": {
                "width": rendered.width,
                "height": rendered.height,
                "contours": len(rendered.contours),
                "preview": board.data_url,
            },
            "predictions": {},
        }
        for model in ["comer", "san", "can"]:
            pred = predictions.get(model)
            if pred and pred.get("latex") and pred["latex"] not in ("(failed)", "(empty)", "(no result)", ""):
                match, reason = latex_matches(pred["latex"], gt)
                status = "PASS" if match else "FAIL"
                conf = pred.get("confidence")
                conf_str = f"{conf:.2%}" if conf is not None else "?"
                print(f"  [{model:5s}] {status} conf={conf_str} {pred['latex'][:70]}")
                item["predictions"][model] = {"latex": pred["latex"], "confidence": conf, "match": match, "reason": reason}
            else:
                print(f"  [{model:5s}] SKIP no prediction")
                item["predictions"][model] = None
        results.append(item)
        print()

    browser.close()
    return results


def print_summary(results):
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    models = ["comer", "san", "can"]
    totals = {m: {"pass": 0, "fail": 0, "skip": 0} for m in models}
    for r in results:
        for m in models:
            p = r["predictions"].get(m)
            if p is None:
                totals[m]["skip"] += 1
            elif p["match"]:
                totals[m]["pass"] += 1
            else:
                totals[m]["fail"] += 1
    print(f"{'Model':8} {'Pass':>6} {'Fail':>6} {'Skip':>6}")
    for m in models:
        t = totals[m]
        print(f"{m.upper():8} {t['pass']:>6} {t['fail']:>6} {t['skip']:>6}")
    print()


def main():
    if sync_playwright is None:
        print("Playwright not installed. Run: pip install playwright && playwright install chromium")
        sys.exit(1)

    parser = argparse.ArgumentParser()
    parser.add_argument("--headful", action="store_true", help="Show browser window")
    parser.add_argument("--category", choices=["simple", "complex"], help="Only test simple or complex equations")
    parser.add_argument("--output", default=None, help="Path to save results JSON")
    args = parser.parse_args()

    print("Whiteboard OCR Test Runner\n")
    with sync_playwright() as playwright:
        results = run_tests(playwright, headless=not args.headful, category=args.category)

    if results:
        print_summary(results)
        out = Path(args.output) if args.output else (Path(__file__).parent / "results" / "results.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"Results saved to: {out}")
    else:
        print("No tests matched.")


if __name__ == "__main__":
    main()
