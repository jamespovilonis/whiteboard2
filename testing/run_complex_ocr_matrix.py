#!/usr/bin/env python3
"""Complex DBNet + CoMER OCR matrix for multi-step math work.

The existing DBNet fixture matrix covers one algebra family. This runner adds
rational, logarithmic, derivative, and integral solving/evaluation boards with
multiple spacing variants. It verifies DBNet separation for every stroke order
and optionally posts each separated line crop to the local CoMER endpoint.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from io import BytesIO

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.latex_postprocess import repair_latex

RESULTS = ROOT / "testing" / "results" / "complex_ocr"
DBNET_MODULE = ROOT / "CanvasSegmentation" / "DBNet_Integration.py"
SPLITTER = ROOT / "testing" / "split_dbnet_fixture.js"
PADDLE_PYTHON = ROOT / ".venv" / "bin" / "python"

ORDERS = ["line-order", "reverse-lines", "interleaved-lines"]


@dataclass(frozen=True)
class ProblemFixture:
    name: str
    family: str
    lines: Sequence[str]
    max_line_width: int = 1120
    max_line_height: int = 96


PROBLEMS: Sequence[ProblemFixture] = [
    ProblemFixture(
        name="rational_solve",
        family="rational",
        lines=[
            r"\frac { x - 1 } { x + 1 } = 5",
            r"x - 1 = 5 ( x + 1 )",
            r"x - 1 = 5 x + 5",
            r"- x       - x",
            r"- 1 = 4 x + 5",
            r"- 5       - 5",
            r"- 6 = 4 x",
            r"/ 4       / 4",
            r"x = - \frac { 3 } { 2 }",
        ],
        max_line_width=1180,
        max_line_height=86,
    ),
    ProblemFixture(
        name="rational_quadratic_solve",
        family="rational",
        lines=[
            r"\frac { x ^ { 2 } - 1 } { x - 1 } = 4",
            r"x + 1 = 4",
            r"- 1       - 1",
            r"x = 3",
        ],
        max_line_width=1180,
        max_line_height=100,
    ),
    ProblemFixture(
        name="rational_two_fraction_solve",
        family="rational",
        lines=[
            r"\frac { x } { 2 } + \frac { 1 } { 3 } = 2",
            r"\times 6       \times 6",
            r"3 x + 2 = 12",
            r"- 2       - 2",
            r"3 x = 10",
            r"/ 3       / 3",
            r"x = \frac { 10 } { 3 }",
        ],
        max_line_width=1240,
        max_line_height=104,
    ),
    ProblemFixture(
        name="logarithmic_solve",
        family="logarithmic",
        lines=[
            r"\log _ { 2 } ( x ) + 3 = 7",
            r"- 3       - 3",
            r"\log _ { 2 } ( x ) = 4",
            r"2 ^ { 4 } = x",
            r"x = 16",
        ],
        max_line_width=1080,
        max_line_height=94,
    ),
    ProblemFixture(
        name="logarithmic_shift_solve",
        family="logarithmic",
        lines=[
            r"\log _ { 3 } ( x + 1 ) = 2",
            r"3 ^ { 2 } = x + 1",
            r"9 = x + 1",
            r"- 1       - 1",
            r"8 = x",
        ],
        max_line_width=1120,
        max_line_height=96,
    ),
    ProblemFixture(
        name="logarithmic_product_solve",
        family="logarithmic",
        lines=[
            r"\log _ { 2 } ( x ) + \log _ { 2 } ( 4 ) = 5",
            r"\log _ { 2 } ( 4 x ) = 5",
            r"2 ^ { 5 } = 4 x",
            r"32 = 4 x",
            r"/ 4       / 4",
            r"8 = x",
        ],
        max_line_width=1260,
        max_line_height=96,
    ),
    ProblemFixture(
        name="derivative_evaluate",
        family="derivative",
        lines=[
            r"f ( x ) = x ^ { 3 } + 2 x ^ { 2 }",
            r"f ' ( x ) = 3 x ^ { 2 } + 4 x",
            r"f ' ( 2 ) = 3 ( 2 ) ^ { 2 } + 4 ( 2 )",
            r"f ' ( 2 ) = 20",
        ],
        max_line_width=1180,
        max_line_height=96,
    ),
    ProblemFixture(
        name="derivative_product_evaluate",
        family="derivative",
        lines=[
            r"f ( x ) = x ^ { 2 } ( x + 3 )",
            r"f ' ( x ) = 2 x ( x + 3 ) + x ^ { 2 }",
            r"f ' ( 2 ) = 4 ( 5 ) + 4",
            r"f ' ( 2 ) = 24",
        ],
        max_line_width=1240,
        max_line_height=100,
    ),
    ProblemFixture(
        name="derivative_quotient_evaluate",
        family="derivative",
        lines=[
            r"f ( x ) = \frac { x ^ { 2 } + 1 } { x }",
            r"f ' ( x ) = \frac { x ^ { 2 } - 1 } { x ^ { 2 } }",
            r"f ' ( 2 ) = \frac { 3 } { 4 }",
        ],
        max_line_width=1240,
        max_line_height=118,
    ),
    ProblemFixture(
        name="integral_evaluate",
        family="integral",
        lines=[
            r"\int _ { 0 } ^ { 2 } ( 3 x ^ { 2 } + 1 ) d x",
            r"= [ x ^ { 3 } + x ] _ { 0 } ^ { 2 }",
            r"= ( 8 + 2 ) - ( 0 + 0 )",
            r"= 10",
        ],
        max_line_width=1180,
        max_line_height=100,
    ),
    ProblemFixture(
        name="integral_power_evaluate",
        family="integral",
        lines=[
            r"\int _ { 1 } ^ { 3 } 2 x d x",
            r"= [ x ^ { 2 } ] _ { 1 } ^ { 3 }",
            r"= 9 - 1",
            r"= 8",
        ],
        max_line_width=1120,
        max_line_height=100,
    ),
    ProblemFixture(
        name="integral_fraction_antiderivative",
        family="integral",
        lines=[
            r"\int _ { 0 } ^ { 2 } ( x + 1 ) d x",
            r"= [ \frac { x ^ { 2 } } { 2 } + x ] _ { 0 } ^ { 2 }",
            r"= ( 2 + 2 ) - ( 0 + 0 )",
            r"= 4",
        ],
        max_line_width=1240,
        max_line_height=116,
    ),
]


SPACING_VARIANTS: Dict[str, Dict[str, int]] = {
    "standard": {"margin_y": 76, "line_gap": 54},
    "dense": {"margin_y": 62, "line_gap": 20},
    "tight-steps": {"margin_y": 58, "line_gap": 4},
}


def slug(*parts: str) -> str:
    return "_".join(re.sub(r"[^a-zA-Z0-9]+", "-", part).strip("-").lower() for part in parts)


def placements_for(problem: ProblemFixture, variant: str) -> Tuple[List[Dict[str, float]], int, int]:
    spacing = SPACING_VARIANTS[variant]
    line_count = len(problem.lines)
    line_height = problem.max_line_height
    step = line_height + spacing["line_gap"]
    board_width = 1400
    board_height = max(760, spacing["margin_y"] * 2 + step * (line_count - 1) + line_height + 80)
    offsets = [0, 42, 24, 92, 40, 100, 34, 108, 64]
    placements: List[Dict[str, float]] = []
    for index in range(line_count):
        placements.append({
            "x": 118 + offsets[index % len(offsets)],
            "y": spacing["margin_y"] + index * step,
        })
    return placements, board_width, board_height


def build_board(problem: ProblemFixture, variant: str, seed: int):
    from synthetic_handwriting import place_handwriting_lines

    placements, board_width, board_height = placements_for(problem, variant)
    return place_handwriting_lines(
        problem.lines,
        board_width=board_width,
        board_height=board_height,
        placements=placements,
        seed=seed,
        max_line_width=problem.max_line_width,
        max_line_height=problem.max_line_height,
    )


def write_board(problem: ProblemFixture, variant: str, board) -> Tuple[Path, Path]:
    from synthetic_handwriting import save_board_png

    fixture_slug = slug(problem.name, variant)
    png_path = RESULTS / f"{fixture_slug}.png"
    json_path = RESULTS / f"{fixture_slug}.json"
    png_path.parent.mkdir(parents=True, exist_ok=True)
    save_board_png(board, str(png_path))
    json_path.write_text(json.dumps(board.to_json(), indent=2), encoding="utf-8")
    return png_path, json_path


def run_dbnet(png_path: Path, output_path: Path) -> Dict[str, object]:
    python = PADDLE_PYTHON if PADDLE_PYTHON.exists() else Path(sys.executable)
    code = """
import importlib.util
import json
import sys
from pathlib import Path
from PIL import Image

module_path = Path(sys.argv[1])
png_path = Path(sys.argv[2])
output_path = Path(sys.argv[3])
spec = importlib.util.spec_from_file_location("dbnet_integration", module_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
image = Image.open(png_path)
payload = {"detections": module.dbnet_detector.predict(image)}
output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
print(json.dumps({"rawDetections": len(payload["detections"])}))
"""
    completed = subprocess.run(
        [str(python), "-c", code, str(DBNET_MODULE), str(png_path), str(output_path)],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(output_path.read_text(encoding="utf-8"))


def run_splitter(board_path: Path, dbnet_path: Path, order: str) -> Dict[str, object]:
    completed = subprocess.run(
        ["node", str(SPLITTER), str(board_path), str(dbnet_path), order],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(completed.stdout)


def validate_split(problem: ProblemFixture, variant: str, split: Dict[str, object]) -> List[str]:
    failures: List[str] = []
    expected = len(problem.lines)
    if split["splitCandidates"] != expected:
        failures.append(
            f"{problem.name}/{variant}/{split['order']}: expected {expected} lines, got {split['splitCandidates']}"
        )
    seen: List[int] = []
    for index, line_set in enumerate(split["splitSyntheticLineSets"]):
        if len(line_set) != 1:
            failures.append(
                f"{problem.name}/{variant}/{split['order']}: split {index} mixes source lines {line_set}"
            )
        else:
            seen.append(int(line_set[0]))
    missing = sorted(set(range(expected)) - set(seen))
    if missing:
        failures.append(
            f"{problem.name}/{variant}/{split['order']}: missing source lines {missing}"
        )
    duplicates = sorted(index for index in set(seen) if seen.count(index) > 1)
    if duplicates:
        failures.append(
            f"{problem.name}/{variant}/{split['order']}: source lines split more than once {duplicates}"
        )
    return failures


def normalize_latex(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def canonical_latex(text: str) -> str:
    """Normalize harmless CoMER/fixture formatting without hiding structure errors."""
    out = text or ""
    replacements = {
        r"\left": "",
        r"\right": "",
        r"\,": "",
        r"\!": "",
        r"\limits": "",
        r"\prime": "'",
    }
    for old, new in replacements.items():
        out = out.replace(old, new)
    out = out.replace("X", "x")
    out = re.sub(r"\^\s*\{\s*'\s*\}", "'", out)
    out = re.sub(r"\^\s*'", "'", out)
    out = re.sub(r"\s+", "", out)
    return out


def latex_key_tokens(text: str) -> List[str]:
    tokens = []
    for token in [
        r"\frac", r"\log", r"\int", r"\sum", r"\sqrt", r"\lim",
        "^", "_", "=", "+", "-", "x", "d", "f", "2", "3", "4", "5", "7", "10", "16", "20",
    ]:
        if token in text:
            tokens.append(token)
    return tokens


def loose_latex_match(predicted: str, expected: str) -> Dict[str, object]:
    expected_tokens = latex_key_tokens(expected)
    missing = [token for token in expected_tokens if token not in predicted]
    required = max(1, int(len(expected_tokens) * 0.7))
    matched = len(expected_tokens) - len(missing)
    return {
        "match": (matched >= required and "=" in predicted) if "=" in expected else matched >= required,
        "reason": "key-token coverage",
        "matchedTokens": matched,
        "expectedTokens": len(expected_tokens),
        "missingTokens": missing,
    }


def compare_latex(predicted: str, expected: str) -> Dict[str, object]:
    pred_canonical = canonical_latex(predicted)
    expected_canonical = canonical_latex(expected)
    loose = loose_latex_match(predicted, expected)
    if pred_canonical == expected_canonical:
        return {
            "match": True,
            "strictMatch": True,
            "looseMatch": True,
            "reason": "canonical-exact",
            "canonicalPredicted": pred_canonical,
            "canonicalExpected": expected_canonical,
            "loose": loose,
        }
    return {
        "match": False,
        "strictMatch": False,
        "looseMatch": bool(loose["match"]),
        "reason": "canonical-mismatch",
        "canonicalPredicted": pred_canonical,
        "canonicalExpected": expected_canonical,
        "loose": loose,
    }


def crop_line(board_png: Path, bbox: Dict[str, float], output_path: Path, padding: int = 22) -> Path:
    image = Image.open(board_png).convert("RGB")
    x_min = max(0, int(float(bbox["xMin"])) - padding)
    y_min = max(0, int(float(bbox["yMin"])) - padding)
    x_max = min(image.width, int(float(bbox["xMax"])) + padding)
    y_max = min(image.height, int(float(bbox["yMax"])) + padding)
    crop = image.crop((x_min, y_min, x_max, y_max))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    crop.save(output_path)
    return output_path


def crop_contours(
    contours: Sequence[Sequence[Dict[str, float]]],
    bbox: Dict[str, float],
    output_path: Path,
    padding: int = 22,
) -> Path:
    x_min = int(float(bbox["xMin"])) - padding
    y_min = int(float(bbox["yMin"])) - padding
    x_max = int(float(bbox["xMax"])) + padding
    y_max = int(float(bbox["yMax"])) + padding
    width = max(1, x_max - x_min)
    height = max(1, y_max - y_min)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    for contour in contours:
        points = []
        for point in contour:
            points.append((float(point["x"]) - x_min, float(point["y"]) - y_min))
        if len(points) >= 3:
            draw.polygon(points, fill="black")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def write_line_image_from_fixture(
    problem: ProblemFixture,
    variant: str,
    source_line_index: int,
    board_path: Path,
    output_path: Path,
    padding: int = 22,
) -> Optional[Path]:
    try:
        board = json.loads(board_path.read_text(encoding="utf-8"))
        line = (board.get("lines") or [])[source_line_index]
        data_url = line.get("dataUrl") or ""
        if not data_url.startswith("data:image/png;base64,"):
            return None
        image_bytes = base64.b64decode(data_url.split(",", 1)[1])
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        if padding > 0:
            padded = Image.new("RGB", (image.width + 2 * padding, image.height + 2 * padding), "white")
            padded.paste(image, (padding, padding))
            image = padded
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path)
        return output_path
    except Exception:
        return None


def post_image(url: str, image_path: Path, timeout_seconds: float) -> Dict[str, object]:
    boundary = "----whiteboard-" + uuid.uuid4().hex
    image_bytes = image_path.read_bytes()
    body = b"".join([
        f"--{boundary}\r\n".encode("ascii"),
        b'Content-Disposition: form-data; name="file"; filename="line.png"\r\n',
        b"Content-Type: image/png\r\n\r\n",
        image_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode("ascii"),
    ])
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds + 3) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            raise
        payload["_httpStatus"] = exc.code
        return payload


def healthcheck(api_url: str, timeout_seconds: float = 2.0) -> Optional[Dict[str, object]]:
    try:
        with urllib.request.urlopen(f"{api_url}/health?model=comer", timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def recognize_split_lines(
    api_url: str,
    problem: ProblemFixture,
    variant: str,
    order_result: Dict[str, object],
    board_png: Path,
    board_path: Path,
    timeout_seconds: float,
    crop_source_mode: str,
) -> List[Dict[str, object]]:
    records: List[Dict[str, object]] = []
    recognize_url = f"{api_url}/recognize?model=comer&timeout_seconds={timeout_seconds}"
    for index, bbox in enumerate(order_result.get("splitBboxes", [])):
        line_set = order_result["splitSyntheticLineSets"][index]
        expected_index = int(line_set[0]) if len(line_set) == 1 else None
        expected_latex = problem.lines[expected_index] if expected_index is not None else ""
        crop_path = RESULTS / "crops" / f"{slug(problem.name, variant, order_result['order'])}_line_{index + 1}.png"
        if crop_source_mode == "fixture-line" and expected_index is not None:
            wrote_fixture_line = write_line_image_from_fixture(
                problem, variant, expected_index, board_path, crop_path
            )
            crop_source = "fixture-line-image" if wrote_fixture_line else "split-contours"
        else:
            wrote_fixture_line = None
            crop_source = "split-contours"
        if not wrote_fixture_line:
            split_contours = order_result.get("splitContours") or []
            if index < len(split_contours) and split_contours[index]:
                crop_contours(split_contours[index], bbox, crop_path)
            else:
                crop_line(board_png, bbox, crop_path)
                crop_source = "board-crop"
        started = time.monotonic()
        try:
            payload = post_image(recognize_url, crop_path, timeout_seconds)
            elapsed = time.monotonic() - started
            predicted = ""
            if payload.get("top"):
                predicted = str(payload["top"].get("latex") or "")
            raw_predicted = predicted
            predicted = repair_latex(predicted)
            comparison = compare_latex(predicted, expected_latex)
            record = {
                "lineIndex": index,
                "sourceLineIndex": expected_index,
                "expectedLatex": expected_latex,
                "crop": str(crop_path),
                "cropSource": crop_source,
                "predictedLatex": predicted,
                "httpStatus": payload.get("_httpStatus", 200),
                "elapsedSeconds": round(float(payload.get("elapsedSeconds", elapsed)), 3),
                "timedOut": bool(payload.get("timedOut")),
                "match": comparison["match"],
                "comparison": comparison,
                "topCandidates": payload.get("candidates", [])[:5],
            }
            if raw_predicted != predicted:
                record["rawPredictedLatex"] = raw_predicted
                record["postprocessed"] = True
            records.append(record)
        except Exception as exc:
            records.append({
                "lineIndex": index,
                "sourceLineIndex": expected_index,
                "expectedLatex": expected_latex,
                "crop": str(crop_path),
                "error": str(exc),
                "match": False,
            })
    return records


def iter_selected_problems(names: Optional[Sequence[str]]) -> Iterable[ProblemFixture]:
    if not names:
        yield from PROBLEMS
        return
    selected = set(names)
    for problem in PROBLEMS:
        if problem.name in selected or problem.family in selected:
            yield problem


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spacing", nargs="*", choices=sorted(SPACING_VARIANTS), default=None)
    parser.add_argument("--problem", nargs="*", default=None, help="Problem names or families to run")
    parser.add_argument("--orders", nargs="*", choices=ORDERS, default=ORDERS)
    parser.add_argument("--recognize-order", choices=ORDERS, default="line-order")
    parser.add_argument("--skip-comer", action="store_true", help="Only run DBNet separation checks")
    parser.add_argument("--api-url", default="http://localhost:8000")
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--write-summary", default=str(RESULTS / "complex_ocr_matrix_summary.json"))
    parser.add_argument(
        "--crop-source",
        choices=["split-contours", "fixture-line"],
        default="split-contours",
        help="Image source for CoMER crops after DBNet split validation.",
    )
    parser.add_argument(
        "--allow-loose-comer",
        action="store_true",
        help="Do not fail the run when CoMER is only a loose key-token match.",
    )
    args = parser.parse_args()

    spacings = args.spacing or list(SPACING_VARIANTS)
    problems = list(iter_selected_problems(args.problem))
    if not problems:
        print("No matching problems.", file=sys.stderr)
        return 2

    summary: List[Dict[str, object]] = []
    failures: List[str] = []
    health = None if args.skip_comer else healthcheck(args.api_url)
    should_recognize = not args.skip_comer and bool(health and health.get("loaded") is not False)
    if not args.skip_comer and not should_recognize:
        print("CoMER health check failed; running DBNet separation only.", file=sys.stderr)

    seed = 300
    for problem in problems:
        for variant in spacings:
            seed += 17
            board = build_board(problem, variant, seed)
            png_path, board_path = write_board(problem, variant, board)
            dbnet_path = RESULTS / f"{slug(problem.name, variant)}_dbnet.json"
            dbnet_payload = run_dbnet(png_path, dbnet_path)
            fixture_record: Dict[str, object] = {
                "name": problem.name,
                "family": problem.family,
                "spacing": variant,
                "expectedLineCount": len(problem.lines),
                "png": str(png_path),
                "boardJson": str(board_path),
                "rawDetections": len(dbnet_payload.get("detections", [])),
                "orders": [],
            }
            print(f"{problem.name}/{variant}: raw detections={fixture_record['rawDetections']}")
            for order in args.orders:
                split = run_splitter(board_path, dbnet_path, order)
                failures.extend(validate_split(problem, variant, split))
                fixture_record["orders"].append(split)
                print(
                    f"  {order}: base={split['baseCandidates']} bands={split['dbnetBands']} "
                    f"split={split['splitCandidates']} strokes={split['splitStrokeCounts']}"
                )
                if should_recognize and order == args.recognize_order:
                    recognitions = recognize_split_lines(
                        args.api_url,
                        problem,
                        variant,
                        split,
                        png_path,
                        board_path,
                        args.timeout_seconds,
                        args.crop_source,
                    )
                    split["comerRecognitions"] = recognitions
                    strict_matched = sum(1 for item in recognitions if item.get("match"))
                    loose_matched = sum(
                        1
                        for item in recognitions
                        if (item.get("comparison") or {}).get("looseMatch")
                    )
                    print(
                        f"    CoMER strict matches: {strict_matched}/{len(recognitions)} "
                        f"(loose {loose_matched}/{len(recognitions)})"
                    )
                    if not args.allow_loose_comer:
                        for item in recognitions:
                            if item.get("match"):
                                continue
                            display_line = (
                                int(item["sourceLineIndex"]) + 1
                                if item.get("sourceLineIndex") is not None
                                else item.get("lineIndex")
                            )
                            failures.append(
                                f"{problem.name}/{variant}/{order}: CoMER strict mismatch "
                                f"line {display_line}: expected "
                                f"{item.get('expectedLatex')!r}, got {item.get('predictedLatex')!r}"
                            )
            summary.append(fixture_record)

    summary_path = Path(args.write_summary)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Wrote {summary_path}")

    if failures:
        print("OCR verification failures:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
