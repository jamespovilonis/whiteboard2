#!/usr/bin/env python3
"""Fast checks for the LaTeX-to-ink synthetic handwriting renderer."""

import unittest
import sys
from pathlib import Path

TESTING_DIR = Path(__file__).resolve().parent
if str(TESTING_DIR) not in sys.path:
    sys.path.insert(0, str(TESTING_DIR))

from synthetic_handwriting import place_handwriting_lines, render_handwriting


class SyntheticHandwritingTests(unittest.TestCase):
    def test_renders_simple_solution_to_ink_contours(self):
        fixture = render_handwriting("x = 4", seed=4)
        self.assertGreater(fixture.width, 10)
        self.assertGreater(fixture.height, 10)
        self.assertGreater(len(fixture.contours), 0)
        self.assertTrue(fixture.data_url.startswith("data:image/png;base64,"))

    def test_renders_nested_math_to_ink_contours(self):
        fixture = render_handwriting(r"x = \frac { - b \pm \sqrt { b ^ { 2 } - 4 a c } } { 2 a }", seed=9)
        self.assertGreater(fixture.width, 100)
        self.assertGreater(fixture.height, 40)
        self.assertGreater(len(fixture.contours), 5)

    def test_places_multiple_algebra_lines_on_board(self):
        board = place_handwriting_lines(
            [
                r"2 x + 3 = 11",
                r"2 x = 8",
                r"x = 4",
            ],
            board_width=1200,
            board_height=720,
            placements=[
                {"x": 120, "y": 90},
                {"x": 188, "y": 260},
                {"x": 250, "y": 430},
            ],
            seed=22,
        )
        self.assertEqual(len(board.lines), 3)
        self.assertGreater(len(board.contours), 8)
        self.assertTrue(board.data_url.startswith("data:image/png;base64,"))
        self.assertLess(board.lines[0].bbox["yMax"], board.lines[1].bbox["yMin"])
        self.assertLess(board.lines[1].bbox["yMax"], board.lines[2].bbox["yMin"])

    def test_places_lines_by_board_anchors(self):
        board = place_handwriting_lines(
            [r"x = 4", r"y = 2", r"z = 6"],
            board_width=900,
            board_height=600,
            placements=[
                {"anchor": "top-left"},
                {"anchor": "center"},
                {"anchor": "bottom-right"},
            ],
            seed=30,
        )
        self.assertLess(board.lines[0].x, board.lines[1].x)
        self.assertLess(board.lines[0].y, board.lines[1].y)
        self.assertGreater(board.lines[2].x, board.lines[1].x)
        self.assertGreater(board.lines[2].y, board.lines[1].y)

    def test_dense_intermediate_steps_are_tightly_spaced(self):
        board = place_handwriting_lines(
            [
                r"2 x + 3 = 11",
                r"- 3      - 3",
                r"2 x = 8",
                r"/ 2      / 2",
                r"x = 4",
            ],
            board_width=1200,
            board_height=720,
            placements=[
                {"x": 126, "y": 92},
                {"x": 176, "y": 158},
                {"x": 168, "y": 220},
                {"x": 198, "y": 282},
                {"x": 224, "y": 344},
            ],
            seed=42,
            max_line_height=104,
            max_line_width=850,
        )
        self.assertEqual(len(board.lines), 5)
        gaps = [
            board.lines[index + 1].bbox["yMin"] - board.lines[index].bbox["yMax"]
            for index in range(len(board.lines) - 1)
        ]
        self.assertTrue(all(gap < 28 for gap in gaps), gaps)
        self.assertGreater(len(board.contours), 15)


if __name__ == "__main__":
    unittest.main()
