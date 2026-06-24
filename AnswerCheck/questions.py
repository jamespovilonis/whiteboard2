"""Reviewed questions derived from ``testing/test_equations.py`` fixtures."""

from copy import deepcopy
import json
from pathlib import Path


QUESTIONS = {
    "simple_pythagorean": {
        "id": "simple_pythagorean",
        "prompt": "Write the Pythagorean theorem using a, b, and c.",
        "expected_latex": r"a ^ { 2 } + b ^ { 2 } = c ^ { 2 }",
        "answer_type": "equation",
        "variables": ["a", "b", "c"],
        "assumptions": {"domain": "real"},
        "solution_path": ["Square both legs and set their sum equal to the square of the hypotenuse."],
        "source_fixture": "testing/test_equations.py:simple_pythagorean",
    },
    "simple_x_equals_yz": {
        "id": "simple_x_equals_yz",
        "prompt": "Write an equation stating that x is the sum of y and z.",
        "expected_latex": r"x = y + z",
        "answer_type": "equation",
        "variables": ["x", "y", "z"],
        "assumptions": {"domain": "real"},
        "solution_path": [
            "The phrase 'the sum of y and z' is represented by y + z.",
            "Set x equal to that sum: x = y + z.",
        ],
        "source_fixture": "testing/test_equations.py:simple_x_equals_yz",
    },
    "simple_square_root": {
        "id": "simple_square_root",
        "prompt": "Write an equation stating that x is the square root of y.",
        "expected_latex": r"x = \sqrt { y }",
        "answer_type": "equation",
        "variables": ["x", "y"],
        "assumptions": {"domain": "real"},
        "solution_path": ["Represent the square root of y as √y.", "Set x equal to √y."],
        "source_fixture": "testing/test_equations.py:simple_square_root",
    },
    "simple_fraction": {
        "id": "simple_fraction",
        "prompt": "Write an equation stating that a divided by b equals c.",
        "expected_latex": r"\frac { a } { b } = c",
        "answer_type": "equation",
        "variables": ["a", "b", "c"],
        "assumptions": {"domain": "real", "nonzero": ["b"]},
        "solution_path": ["Represent a divided by b as the fraction a/b.", "Set the fraction equal to c."],
        "source_fixture": "testing/test_equations.py:simple_fraction",
    },
    "simple_times": {
        "id": "simple_times",
        "prompt": "Write y as a times b, divided by c.",
        "expected_latex": r"y = a \cdot \frac { b } { c }",
        "answer_type": "equation",
        "variables": ["a", "b", "c", "y"],
        "assumptions": {"domain": "real", "nonzero": ["c"]},
        "solution_path": ["Multiply a and b, divide the product by c, and set the result equal to y."],
        "source_fixture": "testing/test_equations.py:simple_times",
    },
    "simple_exponent": {
        "id": "simple_exponent",
        "prompt": "Write c as the sum of a squared and b squared.",
        "expected_latex": r"c = a ^ { 2 } + b ^ { 2 }",
        "answer_type": "equation",
        "variables": ["a", "b", "c"],
        "assumptions": {"domain": "real"},
        "solution_path": ["Square a and b, add the squares, and set c equal to the sum."],
        "source_fixture": "testing/test_equations.py:simple_exponent",
    },
}


def _load_solving_questions() -> None:
    """Add concrete solve-for-x fixtures maintained in the testing directory."""

    fixture_path = Path(__file__).resolve().parent.parent / "testing" / "solving_questions.json"
    with fixture_path.open(encoding="utf-8") as fixture_file:
        fixtures = json.load(fixture_file)
    for fixture in fixtures:
        question_id = fixture["id"]
        QUESTIONS[question_id] = {
            "id": question_id,
            "prompt": fixture["prompt"],
            "expected_latex": fixture["solution_latex"],
            "equivalent_solutions": fixture.get("equivalent_solutions", []),
            "answer_type": "equation",
            "variables": ["x"],
            "assumptions": {"domain": "real"},
            "source_fixture": f"testing/solving_questions.json:{question_id}",
        }


_load_solving_questions()


def get_question(question_id: str) -> dict:
    """Return a copy of a reviewed question or raise ``KeyError``."""

    return deepcopy(QUESTIONS[question_id])
