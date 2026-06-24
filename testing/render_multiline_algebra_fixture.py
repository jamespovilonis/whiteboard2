#!/usr/bin/env python3
"""Render a multi-line algebra fixture screenshot under testing/results."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from synthetic_handwriting import place_handwriting_lines, save_board_png


ALGEBRA_LINES = [
    r"2 x + 3 = 11",
    r"2 x = 8",
    r"x = 4",
]

ALGEBRA_WITH_STEPS_LINES = [
    r"2 x + 3 = 11",
    r"- 3      - 3",
    r"2 x = 8",
    r"/ 2      / 2",
    r"x = 4",
]


def build_fixture(variant: str = "standard"):
    if variant == "dense":
        latex_lines = ALGEBRA_LINES
        placements = [
            {"x": 126, "y": 116},
            {"x": 168, "y": 198},
            {"x": 210, "y": 280},
        ]
        max_line_height = 126
    elif variant == "dense-steps":
        latex_lines = ALGEBRA_WITH_STEPS_LINES
        placements = [
            {"x": 126, "y": 92},
            {"x": 176, "y": 158},
            {"x": 168, "y": 220},
            {"x": 198, "y": 282},
            {"x": 224, "y": 344},
        ]
        max_line_height = 104
    else:
        latex_lines = ALGEBRA_LINES
        placements = [
            {"x": 126, "y": 96},
            {"x": 202, "y": 268},
            {"x": 278, "y": 440},
        ]
        max_line_height = 126

    return place_handwriting_lines(
        latex_lines,
        board_width=1200,
        board_height=720,
        placements=placements,
        seed=42,
        max_line_height=max_line_height,
        max_line_width=850,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent / "results" / "multiline_algebra_board.png"),
        help="PNG path for the rendered fixture",
    )
    parser.add_argument(
        "--json",
        default=str(Path(__file__).resolve().parent / "results" / "multiline_algebra_board.json"),
        help="JSON metadata path for line placement and contours",
    )
    parser.add_argument(
        "--variant",
        choices=["standard", "dense", "dense-steps"],
        default="standard",
        help="Fixture spacing variant. dense variants intentionally crowd lines for DBNet stress tests.",
    )
    args = parser.parse_args()

    board = build_fixture(args.variant)
    output = Path(args.output)
    metadata = Path(args.json)
    if args.variant != "standard":
        output = output.with_name(output.stem + f"_{args.variant}" + output.suffix)
        metadata = metadata.with_name(metadata.stem + f"_{args.variant}" + metadata.suffix)
    output.parent.mkdir(parents=True, exist_ok=True)
    metadata.parent.mkdir(parents=True, exist_ok=True)
    save_board_png(board, str(output))
    metadata.write_text(json.dumps(board.to_json(), indent=2), encoding="utf-8")
    print(f"Wrote {output}")
    print(f"Wrote {metadata}")


if __name__ == "__main__":
    main()
