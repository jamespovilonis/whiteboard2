#!/usr/bin/env python3
"""Run DBNet + browser-splitter fixture checks.

This script assumes the fixture PNG/JSON files already exist under
``testing/results``. Generate them with ``render_multiline_algebra_fixture.py``
and the fraction fixture command documented in ``testing/README.md``.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "testing" / "results"
DBNET_MODULE = ROOT / "CanvasSegmentation" / "DBNet_Integration.py"
SPLITTER = ROOT / "testing" / "split_dbnet_fixture.js"


FIXTURES = [
    {
        "name": "standard",
        "png": RESULTS / "multiline_algebra_board.png",
        "json": RESULTS / "multiline_algebra_board.json",
        "expected": 3,
        "orders": ["line-order", "reverse-lines", "interleaved-lines"],
    },
    {
        "name": "dense",
        "png": RESULTS / "multiline_algebra_board_dense.png",
        "json": RESULTS / "multiline_algebra_board_dense.json",
        "expected": 3,
        "orders": ["line-order", "reverse-lines", "interleaved-lines"],
    },
    {
        "name": "dense-steps",
        "png": RESULTS / "multiline_algebra_board_dense-steps.png",
        "json": RESULTS / "multiline_algebra_board_dense-steps.json",
        "expected": 5,
        "orders": ["line-order", "reverse-lines", "interleaved-lines"],
    },
    {
        "name": "fraction",
        "png": RESULTS / "fraction_x_minus_1_over_x_plus_1_eq_5.png",
        "json": RESULTS / "fraction_x_minus_1_over_x_plus_1_eq_5.json",
        "expected": 1,
        "orders": ["line-order", "reverse-lines", "interleaved-lines"],
    },
]


def load_dbnet_module():
    spec = importlib.util.spec_from_file_location("dbnet_integration", DBNET_MODULE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run_dbnet(module, png_path: Path, output_path: Path) -> Dict[str, object]:
    image = Image.open(png_path)
    detections = module.dbnet_detector.predict(image)
    payload = {"detections": detections}
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def run_splitter(board_path: Path, dbnet_path: Path, order: str) -> Dict[str, object]:
    completed = subprocess.run(
        ["node", str(SPLITTER), str(board_path), str(dbnet_path), order],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(completed.stdout)


def validate_split(name: str, expected: int, result: Dict[str, object]) -> List[str]:
    failures: List[str] = []
    if result["splitCandidates"] != expected:
        failures.append(
            f"{name}/{result['order']}: expected {expected} split candidates, got {result['splitCandidates']}"
        )
    for index, line_set in enumerate(result["splitSyntheticLineSets"]):
        if len(line_set) != 1:
            failures.append(
                f"{name}/{result['order']}: split {index} mixes fixture lines {line_set}"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-summary", default=str(RESULTS / "dbnet_fixture_matrix_summary.json"))
    args = parser.parse_args()

    missing = [
        str(path)
        for fixture in FIXTURES
        for path in (fixture["png"], fixture["json"])
        if not path.exists()
    ]
    if missing:
        print("Missing fixture files:", file=sys.stderr)
        for path in missing:
            print(f"  {path}", file=sys.stderr)
        return 2

    module = load_dbnet_module()
    summary = []
    failures: List[str] = []

    for fixture in FIXTURES:
        dbnet_path = RESULTS / f"{fixture['name']}_dbnet_matrix.json"
        payload = run_dbnet(module, fixture["png"], dbnet_path)
        print(f"{fixture['name']}: raw detections={len(payload['detections'])}")
        fixture_result = {
            "name": fixture["name"],
            "expected": fixture["expected"],
            "rawDetections": len(payload["detections"]),
            "orders": [],
        }
        for order in fixture["orders"]:
            split = run_splitter(fixture["json"], dbnet_path, order)
            fixture_result["orders"].append(split)
            print(
                f"  {order}: base={split['baseCandidates']} "
                f"bands={split['dbnetBands']} split={split['splitCandidates']} "
                f"strokes={split['splitStrokeCounts']}"
            )
            failures.extend(validate_split(fixture["name"], fixture["expected"], split))
        summary.append(fixture_result)

    summary_path = Path(args.write_summary)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Wrote {summary_path}")

    if failures:
        print("FAILURES:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
