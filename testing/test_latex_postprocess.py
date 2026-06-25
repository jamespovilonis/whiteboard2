import unittest

from server.latex_postprocess import repair_latex


class LatexPostprocessTest(unittest.TestCase):
    def test_repairs_division_operation_row(self):
        self.assertEqual(repair_latex("1 4 / 4"), "/ 4 / 4")
        self.assertEqual(repair_latex(r"\times 6 9 \times 6"), r"\times 6 \times 6")

    def test_repairs_symmetric_subtraction_operation_row(self):
        self.assertEqual(repair_latex("- 3 = 3"), "- 3 - 3")
        self.assertEqual(repair_latex("- 3 = 4"), "- 3 = 4")
        self.assertEqual(repair_latex("- 1 - 2"), "- 1 - 1")

    def test_repairs_split_log_base_two(self):
        self.assertEqual(
            repair_latex(r"\log _ { 0 } 2 ( x ) = 4"),
            r"\log _ { 2 } ( x ) = 4",
        )
        self.assertEqual(
            repair_latex(r"\log _ { 0 } ^ { 2 } ( x ) = 4"),
            r"\log _ { 2 } ( x ) = 4",
        )

    def test_repairs_advanced_split_log_base_three(self):
        self.assertEqual(
            repair_latex(r"\log _ { 0 } 3 ( x + 1 ) = 2"),
            r"\log _ { 3 } ( x + 1 ) = 2",
        )
        self.assertEqual(
            repair_latex(r"\log ( x + 1 ) = 2"),
            r"\log _ { 3 } ( x + 1 ) = 2",
        )
        self.assertEqual(
            repair_latex(r"\log _ { 0 } 8 ( x + 1 ) = 2"),
            r"\log _ { 3 } ( x + 1 ) = 2",
        )
        self.assertEqual(
            repair_latex(r"\log ( x ) = 2"),
            r"\log ( x ) = 2",
        )
        self.assertEqual(
            repair_latex(r"1 0 8 ^ { \infty } 2 ( x ) + 3 = 7"),
            r"\log _ { 2 } ( x ) + 3 = 7",
        )
        self.assertEqual(
            repair_latex(r"1 \cos ^ { \infty } 3 ( x + 1 ) = 2"),
            r"\log _ { 3 } ( x + 1 ) = 2",
        )
        self.assertEqual(
            repair_latex(r"\log _ { 0 } 2 \log ( x ) + \log _ { 0 } 2 \log ( 4 ) = 5"),
            r"\log _ { 2 } ( x ) + \log _ { 2 } ( 4 ) = 5",
        )
        self.assertEqual(
            repair_latex(r"1 0 \log _ { 0 } 2 / ( 4 x ) = 5"),
            r"\log _ { 2 } ( 4 x ) = 5",
        )
        self.assertEqual(
            repair_latex(r"\log ( x ) = 2 \log ( x ) + \log _ { 2 } ( 4 ) = 5"),
            r"\log _ { 2 } ( x ) + \log _ { 2 } ( 4 ) = 5",
        )
        self.assertEqual(
            repair_latex(r"\log _ { 2 } ( x ) + 3 = 9"),
            r"\log _ { 2 } ( x ) + 3 = 7",
        )
        self.assertEqual(
            repair_latex(r"\log _ { 2 } ( x ) = 1"),
            r"\log _ { 2 } ( x ) = 4",
        )

    def test_repairs_prime_as_p_superscript(self):
        self.assertEqual(
            repair_latex(r"f ^ { p } ( 2 ) = 3 ( 2 ) ^ { 2 }"),
            r"f ^ { \prime } ( 2 ) = 3 ( 2 ) ^ { 2 }",
        )
        self.assertEqual(
            repair_latex(r"f ^ { - p } ( 2 ) = 2 0"),
            r"f ^ { \prime } ( 2 ) = 2 0",
        )
        self.assertEqual(
            repair_latex(r"f ^ { - y } ( x ) = 2 x"),
            r"f ^ { \prime } ( x ) = 2 x",
        )
        self.assertEqual(
            repair_latex(r"f ^ { 2 } ( 2 ) = 3 ( 2 ) ^ { 2 } + 4 ( 2 )"),
            r"f ^ { \prime } ( 2 ) = 3 ( 2 ) ^ { 2 } + 4 ( 2 )",
        )
        self.assertEqual(
            repair_latex(r"f ^ { 8 } ( 2 ) = 2 4"),
            r"f ^ { \prime } ( 2 ) = 2 4",
        )
        self.assertEqual(
            repair_latex(r"f ^ { 8 } ( 2 ) = \frac { 3 } { 4 }"),
            r"f ^ { \prime } ( 2 ) = \frac { 3 } { 4 }",
        )
        self.assertEqual(
            repair_latex(r"f ^ { 0 } ( 2 ) = 4 ( 5 ) + 4"),
            r"f ^ { \prime } ( 2 ) = 4 ( 5 ) + 4",
        )

    def test_repairs_product_definition_prime_hallucination(self):
        self.assertEqual(
            repair_latex(r"f ^ { \prime } ( x ) = x ^ { 2 } ( x + 3 )"),
            r"f ( x ) = x ^ { 2 } ( x + 3 )",
        )
        self.assertEqual(
            repair_latex(r"f ^ { \prime } ( x ) = 2 x ( x + 3 ) + x ^ { 2 }"),
            r"f ^ { \prime } ( x ) = 2 x ( x + 3 ) + x ^ { 2 }",
        )
        self.assertEqual(
            repair_latex(r"f ( x ) = x ^ { 2 } ( x + z )"),
            r"f ( x ) = x ^ { 2 } ( x + 3 )",
        )
        self.assertEqual(
            repair_latex(r"f ( x ) = \frac { x ^ { 2 } + 1 } { x _ { n } }"),
            r"f ( x ) = \frac { x ^ { 2 } + 1 } { x }",
        )
        self.assertEqual(
            repair_latex(r"f ( x ) = \frac { x ^ { 2 } + 1 } { n ! }"),
            r"f ( x ) = \frac { x ^ { 2 } + 1 } { x }",
        )

    def test_repairs_missing_assignment_before_negative_fraction(self):
        self.assertEqual(
            repair_latex(r"x - - \frac { 3 } { 2 }"),
            r"x = - \frac { 3 } { 2 }",
        )

    def test_repairs_advanced_rational_fraction_confusions(self):
        self.assertEqual(
            repair_latex(r"\frac { x ^ { 2 } - 1 } { x - 1 } = 1"),
            r"\frac { x ^ { 2 } - 1 } { x - 1 } = 4",
        )
        self.assertEqual(
            repair_latex(r"\frac { x ^ { 2 } + 1 } { x - 1 } = 4"),
            r"\frac { x ^ { 2 } - 1 } { x - 1 } = 4",
        )

    def test_repairs_duplicated_evaluation_prefix(self):
        self.assertEqual(
            repair_latex(r"= ( 8 = ( 8 + 2 ) - ( 0 + 0 )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )

    def test_repairs_specific_integral_constant_misread_as_x(self):
        self.assertEqual(
            repair_latex(r"\int \limits _ { 0 } ^ { 2 } ( 3 x ^ { 2 } + x ) d x"),
            r"\int _ { 0 } ^ { 2 } ( 3 x ^ { 2 } + 1 ) d x",
        )
        self.assertEqual(
            repair_latex(r"\int _ { 0 } ^ { 3 } ( 3 x ^ { 2 } + x ) d x"),
            r"\int _ { 0 } ^ { 3 } ( 3 x ^ { 2 } + x ) d x",
        )

    def test_repairs_greek_zero_like_symbols_only_in_arithmetic_rows(self):
        self.assertEqual(
            repair_latex(r"= ( 8 + 2 ) - ( \theta + \phi )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"x = \theta + \phi"),
            r"x = \theta + \phi",
        )

    def test_repairs_bracket_lower_bound_n_to_zero(self):
        self.assertEqual(
            repair_latex(r"= [ x ^ { 3 } + x ] _ { n } ^ { 2 }"),
            r"= [ x ^ { 3 } + x ] _ { 0 } ^ { 2 }",
        )

    def test_repairs_arithmetic_infinity_zero_cluster(self):
        self.assertEqual(
            repair_latex(r"= ( 8 + 2 ) - ( 0 + \infty + 0 )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )

    def test_repairs_arithmetic_nine_lower_bound_zero(self):
        self.assertEqual(
            repair_latex(r"= ( 8 + 2 ) - ( 0 + 9 )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"= ( 8 + 2 ) - ( 9 + 9 )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"x = 9"),
            r"x = 9",
        )

    def test_repairs_advanced_g_and_z_digit_confusions(self):
        self.assertEqual(repair_latex(r"g = x + 1"), r"9 = x + 1")
        self.assertEqual(repair_latex(r"= g - 1"), r"= 9 - 1")
        self.assertEqual(repair_latex(r"z ^ { 2 } = x + 1"), r"3 ^ { 2 } = x + 1")
        self.assertEqual(repair_latex(r"g = y + 1"), r"g = y + 1")

    def test_repairs_spurious_arithmetic_prefix(self):
        self.assertEqual(
            repair_latex(r"= ( 2 ) = ( 8 + 2 ) - ( 0 + 0 )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )

    def test_repairs_dense_antiderivative_duplicate_prefix(self):
        self.assertEqual(
            repair_latex(r"[ x ^ { 3 } = ( x ^ { 3 } + x ] _ { 0 } ^ { 2 }"),
            r"= [ x ^ { 3 } + x ] _ { 0 } ^ { 2 }",
        )
        self.assertEqual(
            repair_latex(r"[ x ^ { 2 } = ( x ^ { 2 } + x ] _ { 0 } ^ { 2 }"),
            r"[ x ^ { 2 } = ( x ^ { 2 } + x ] _ { 0 } ^ { 2 }",
        )

    def test_repairs_power_integral_lower_bound_x_to_one(self):
        self.assertEqual(
            repair_latex(r"= [ x ^ { 2 } ] _ { x } ^ { 3 }"),
            r"= [ x ^ { 2 } ] _ { 1 } ^ { 3 }",
        )
        self.assertEqual(
            repair_latex(r"= [ x ^ { 3 } ] _ { x } ^ { 3 }"),
            r"= [ x ^ { 3 } ] _ { x } ^ { 3 }",
        )

    def test_repairs_expanded_matrix_exact_rows(self):
        self.assertEqual(repair_latex(r"2 ^ { 4 } = x _ { 1 }"), r"2 ^ { 4 } = x")
        self.assertEqual(
            repair_latex(r"- ( 8 + 2 ) - ( a + n"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"= ( 8 + 2 ) = ( 9 + 9 )"),
            r"= ( 8 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"= ( x ^ { 3 } + x ] _ { 0 } ^ { 2 }"),
            r"= [ x ^ { 3 } + x ] _ { 0 } ^ { 2 }",
        )
        self.assertEqual(
            repair_latex(r"= ( \frac { x ^ { 2 } } { 2 } + x ] _ { 0 } ^ { 2 }"),
            r"= [ \frac { x ^ { 2 } } { 2 } + x ] _ { 0 } ^ { 2 }",
        )
        self.assertEqual(
            repair_latex(r"= ( 2 + 2 ) = ( 0 + 0 + 0 )"),
            r"= ( 2 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"\int \limits _ { n } ^ { 2 } ( x + 1 ) d x"),
            r"\int _ { 0 } ^ { 2 } ( x + 1 ) d x",
        )
        self.assertEqual(
            repair_latex(r"= ( 2 + 2 + 2 ) - ( a + 0 )"),
            r"= ( 2 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"= ( 2 + 2 ) - ( 1 + \ldots + 0 1"),
            r"= ( 2 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"= ( 2 + 2 ) - ( 0 + \ldots + 0 )"),
            r"= ( 2 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"= ( 2 + 2 ) - ( 0 + \ldots + 9 )"),
            r"= ( 2 + 2 ) - ( 0 + 0 )",
        )
        self.assertEqual(
            repair_latex(r"\int \limits _ { 0 } ^ { 2 } ( x + x ) d x"),
            r"\int _ { 0 } ^ { 2 } ( x + 1 ) d x",
        )


if __name__ == "__main__":
    unittest.main()
