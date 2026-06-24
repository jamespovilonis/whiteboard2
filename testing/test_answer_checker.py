#!/usr/bin/env python3
"""Targeted tests for deterministic semantic answer checking."""

import os
import sys
import unittest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from AnswerCheck.checker import check_answer, check_equivalence, normalize_latex


class EquivalenceTests(unittest.TestCase):
    def test_reversed_equation_is_equivalent(self):
        self.assertTrue(check_equivalence("x=2", "2=x").equivalent)

    def test_scaled_equation_is_equivalent(self):
        self.assertTrue(check_equivalence("x=2", "2x=4").equivalent)

    def test_different_solution_is_incorrect(self):
        self.assertFalse(check_equivalence("x=2", "x=3").equivalent)

    def test_expression_order_is_equivalent(self):
        self.assertTrue(check_equivalence("x+y", "y+x").equivalent)

    def test_fraction_latex_is_supported(self):
        self.assertEqual(normalize_latex(r"\frac{x}{2}=1"), "((x)/(2))=1")
        self.assertTrue(check_equivalence(r"\frac{x}{2}=1", "x=2").equivalent)

    def test_unsupported_latex_is_unknown(self):
        result = check_equivalence("x=2", r"\sum_{i=1}^{n}i")
        self.assertIsNone(result.equivalent)


class CandidatePipelineTests(unittest.TestCase):
    def test_concrete_solving_questions_accept_solution_only(self):
        cases = {
            "solve_addition_x_plus_3": "4=x",
            "solve_two_step_2x_plus_3": "x=4",
            "solve_division_x_over_3": "15=x",
            "solve_three_x_minus_5": "x=5",
        }
        for question_id, solution in cases.items():
            with self.subTest(question_id=question_id):
                result = check_answer(question_id, [{
                    "lineIndex": 0,
                    "candidates": [{"latex": solution}],
                }])
                self.assertTrue(result["correct"])

    def test_correct_candidate_can_be_rank_five(self):
        result = check_answer("simple_x_equals_yz", [{
            "lineIndex": 0,
            "candidates": [
                {"latex": "x=y-z"},
                {"latex": "x=y*z"},
                {"latex": "x=y/z"},
                {"latex": "x=y"},
                {"latex": "z+y=x"},
                {"latex": "x=y+z+1"},
            ],
        }])
        self.assertTrue(result["correct"])
        self.assertEqual(result["matchedRank"], 5)

    def test_candidates_after_rank_five_are_ignored(self):
        result = check_answer("simple_x_equals_yz", [{
            "lineIndex": 0,
            "candidates": [
                {"latex": "x=0"}, {"latex": "x=1"}, {"latex": "x=2"},
                {"latex": "x=3"}, {"latex": "x=4"}, {"latex": "x=y+z"},
            ],
        }])
        self.assertFalse(result["correct"])
        self.assertEqual(result["checkedCandidates"], 5)

    def test_final_line_is_the_answer_line(self):
        result = check_answer("simple_x_equals_yz", [
            {"lineIndex": 0, "candidates": [{"latex": "x=y+z"}]},
            {"lineIndex": 1, "candidates": [{"latex": "x=y-z"}]},
        ])
        self.assertFalse(result["correct"])


if __name__ == "__main__":
    unittest.main()
