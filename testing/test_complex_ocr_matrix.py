import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_complex_ocr_matrix import compare_latex


class ComplexOcrMatrixComparisonTest(unittest.TestCase):
    def assertStrictMatch(self, predicted, expected):
        result = compare_latex(predicted, expected)
        self.assertTrue(result["match"], result)
        self.assertTrue(result["strictMatch"], result)

    def assertStrictMismatch(self, predicted, expected):
        result = compare_latex(predicted, expected)
        self.assertFalse(result["match"], result)
        self.assertFalse(result["strictMatch"], result)

    def test_accepts_spacing_and_case_noise(self):
        self.assertStrictMatch("x = 1 6", "x = 16")
        self.assertStrictMatch("- 6 = 4 X", "- 6 = 4 x")

    def test_accepts_prime_equivalent(self):
        self.assertStrictMatch(
            r"f ^ { \prime } ( x ) = 3 x ^ { 2 } + 4 x",
            r"f ' ( x ) = 3 x ^ { 2 } + 4 x",
        )

    def test_rejects_missing_operator_structure(self):
        self.assertStrictMismatch(r"1 0 8 2 ( x ) = 4", r"\log _ { 2 } ( x ) = 4")
        self.assertStrictMismatch(r"2 4 = x", r"2 ^ { 4 } = x")
        self.assertStrictMismatch(
            r"f _ { 2 } ( 3 x ^ { 2 } + 1 ) d x",
            r"\int _ { 0 } ^ { 2 } ( 3 x ^ { 2 } + 1 ) d x",
        )

    def test_accepts_integral_limits_formatting(self):
        self.assertStrictMatch(
            r"\int \limits _ { 0 } ^ { 2 } ( 3 x ^ { 2 } + 1 ) d x",
            r"\int _ { 0 } ^ { 2 } ( 3 x ^ { 2 } + 1 ) d x",
        )


if __name__ == "__main__":
    unittest.main()
