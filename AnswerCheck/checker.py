"""Deterministic semantic equivalence checks for recognized math answers."""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable

import sympy
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

from .questions import get_question


logger = logging.getLogger(__name__)
MAX_CANDIDATES = 5
TRANSFORMATIONS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,
)
def sympy_pm(a, b):
    """Return the set ``{a - b, a + b}`` for plus/minus notation."""
    return sympy.FiniteSet(a - b, a + b)


KNOWN_FUNCTIONS = {
    "sqrt": sympy.sqrt,
    "sin": sympy.sin,
    "cos": sympy.cos,
    "tan": sympy.tan,
    "log": sympy.log,
    "exp": sympy.exp,
    "abs": sympy.Abs,
    "pm": sympy_pm,
}
KNOWN_CONSTANTS = {"pi": sympy.pi, "e": sympy.E}
ALLOWED_TEXT = re.compile(r"^[A-Za-z0-9_+*/^=().,{}\\-]+$")


class ParseFailure(ValueError):
    """Raised when a recognition candidate cannot be parsed safely."""


@dataclass(frozen=True)
class EquivalenceResult:
    equivalent: bool | None
    method: str
    detail: str = ""


def _extract_group(text: str, opening_index: int) -> tuple[str, int]:
    if opening_index >= len(text) or text[opening_index] != "{":
        raise ParseFailure("expected a braced LaTeX group")
    depth = 0
    for index in range(opening_index, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[opening_index + 1 : index], index + 1
    raise ParseFailure("unbalanced LaTeX braces")


def _replace_structural_latex(text: str) -> str:
    """Translate the small, common LaTeX subset emitted by CoMER."""

    output: list[str] = []
    index = 0
    while index < len(text):
        if text.startswith(r"\frac", index):
            numerator, after_numerator = _extract_group(text, index + 5)
            denominator, after_denominator = _extract_group(text, after_numerator)
            output.append(
                "((" + _replace_structural_latex(numerator) + ")/(" +
                _replace_structural_latex(denominator) + "))"
            )
            index = after_denominator
            continue
        if text.startswith(r"\sqrt", index):
            radicand, after_radicand = _extract_group(text, index + 5)
            output.append("sqrt(" + _replace_structural_latex(radicand) + ")")
            index = after_radicand
            continue
        if text.startswith("^{", index):
            exponent, after_exponent = _extract_group(text, index + 1)
            output.append("^(" + _replace_structural_latex(exponent) + ")")
            index = after_exponent
            continue
        output.append(text[index])
        index += 1
    return "".join(output)


def _insert_pm_commas(text: str) -> str:
    """Make ``pm(a b)`` parseable as ``pm(a,b)`` by inserting a comma."""

    result: list[str] = []
    index = 0
    while index < len(text):
        if text.startswith("pm(", index):
            start = index + 3
            depth = 1
            for j in range(start, len(text)):
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        inner = text[start:j]
                        break
            else:
                raise ParseFailure("unbalanced parentheses in pm(...)")
            # Insert a comma between the two arguments.  We assume the left
            # argument is a single symbol/term and the right argument follows.
            parts = inner.rsplit("-", 1)
            if len(parts) == 2:
                left, right = parts[0], parts[1]
                if left and right:
                    result.append(f"pm({left},{right})")
                    index = j + 1
                    continue
            result.append(text[index:j + 1])
            index = j + 1
            continue
        result.append(text[index])
        index += 1
    return "".join(result)


def normalize_latex(latex: str) -> str:
    if not isinstance(latex, str) or not latex.strip():
        raise ParseFailure("empty answer")
    text = latex.strip()
    for token in (r"\left", r"\right", r"\!", r"\,", r"\;", r"\:"):
        text = text.replace(token, "")
    replacements = {
        r"\cdot": "*",
        r"\times": "*",
        r"\div": "/",
        r"\pi": "pi",
        r"\mathrm{e}": "e",
        r"\operatorname": "",
        r"\pm": "pm",
        "−": "-",
        "×": "*",
        "÷": "/",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"\s+", "", text)
    text = _replace_structural_latex(text)
    text = text.replace("{", "(").replace("}", ")")
    text = _insert_pm_commas(text)
    if "\\" in text or not ALLOWED_TEXT.fullmatch(text):
        raise ParseFailure("answer contains unsupported LaTeX")
    return text


def _parse_expression(text: str) -> sympy.Expr:
    identifiers = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text))
    unknown_functions = {
        name for name in identifiers
        if re.search(rf"\b{re.escape(name)}\(", text)
        and name not in KNOWN_FUNCTIONS
    }
    if unknown_functions:
        raise ParseFailure("unsupported function: " + sorted(unknown_functions)[0])

    local_dict: dict[str, Any] = {**KNOWN_FUNCTIONS, **KNOWN_CONSTANTS}
    for name in identifiers:
        if name not in local_dict:
            local_dict[name] = sympy.Symbol(name, real=True)
    try:
        parsed = parse_expr(
            text,
            local_dict=local_dict,
            transformations=TRANSFORMATIONS,
            evaluate=True,
        )
    except Exception as exc:
        raise ParseFailure(f"could not parse expression: {exc}") from exc
    if not isinstance(parsed, sympy.Expr):
        raise ParseFailure("answer is not a mathematical expression")
    return parsed


def parse_math(latex: str) -> tuple[str, sympy.Expr, sympy.Expr | None]:
    normalized = normalize_latex(latex)
    if normalized.count("=") > 1:
        raise ParseFailure("multiple equals signs are not supported")
    if "=" in normalized:
        left, right = normalized.split("=", 1)
        if not left or not right:
            raise ParseFailure("equation is missing one side")
        return "equation", _parse_expression(left), _parse_expression(right)
    return "expression", _parse_expression(normalized), None


def _zero(expr: sympy.Expr) -> bool:
    result = sympy.simplify(expr)
    return result == 0 or result.is_zero is True


def _equivalent_residuals(expected: sympy.Expr, student: sympy.Expr) -> EquivalenceResult:
    if _zero(expected - student) or _zero(expected + student):
        return EquivalenceResult(True, "equation_residual")

    try:
        ratio = sympy.simplify(expected / student)
        if ratio != 0 and not ratio.free_symbols and ratio.is_finite is not False:
            return EquivalenceResult(True, "constant_residual_factor")
    except Exception:
        pass

    symbols = sorted(expected.free_symbols | student.free_symbols, key=lambda item: item.name)
    if len(symbols) == 1:
        try:
            expected_set = sympy.solveset(expected, symbols[0], domain=sympy.S.Reals)
            student_set = sympy.solveset(student, symbols[0], domain=sympy.S.Reals)
            if expected_set == student_set:
                return EquivalenceResult(True, "real_solution_set")
            if not isinstance(expected_set, sympy.ConditionSet) and not isinstance(student_set, sympy.ConditionSet):
                return EquivalenceResult(False, "real_solution_set")
        except Exception:
            pass
    return EquivalenceResult(False, "symbolic_equation")


def _is_plus_minus_set(expr: sympy.Expr) -> bool:
    return isinstance(expr, sympy.FiniteSet) and len(expr) == 2


def _member_of_plus_minus_set(expected_pm: sympy.FiniteSet, student: sympy.Expr) -> bool:
    for member in expected_pm:
        result = _equivalent_residuals(expected_pm - student, member - student)
        if result.equivalent is True:
            return True
    return False


def check_equivalence(expected_latex: str, student_latex: str) -> EquivalenceResult:
    """Check semantic equivalence without invoking a language model."""

    try:
        expected_kind, expected_left, expected_right = parse_math(expected_latex)
        student_kind, student_left, student_right = parse_math(student_latex)
    except ParseFailure as exc:
        return EquivalenceResult(None, "parse_failure", str(exc))

    if expected_kind != student_kind:
        return EquivalenceResult(False, "answer_type_mismatch")
    if expected_kind == "expression":
        return EquivalenceResult(_zero(expected_left - student_left), "expression_difference")
    assert expected_right is not None and student_right is not None

    if _is_plus_minus_set(expected_right) and not _is_plus_minus_set(student_right):
        if _member_of_plus_minus_set(expected_right, student_right):
            return EquivalenceResult(True, "plus_minus_set")

    if _is_plus_minus_set(student_right) and not _is_plus_minus_set(expected_right):
        if _member_of_plus_minus_set(student_right, expected_right):
            return EquivalenceResult(True, "plus_minus_set")

    return _equivalent_residuals(expected_left - expected_right, student_left - student_right)


def _gemma_equivalence(question: dict, candidate: str) -> EquivalenceResult:
    """Use local Gemma only for deterministic ``unknown`` outcomes."""

    if os.getenv("ANSWER_CHECK_OLLAMA_FALLBACK", "0").lower() not in {"1", "true", "yes"}:
        return EquivalenceResult(None, "fallback_disabled")
    prompt = (
        "Decide only whether the candidate answer is mathematically equivalent to the "
        "reference answer for the question. Return JSON with keys equivalent (boolean) "
        "and reason (short string).\n"
        f"Question: {question['prompt']}\n"
        f"Reference: {question['expected_latex']}\n"
        f"Candidate: {candidate}"
    )
    payload = json.dumps({
        "model": os.getenv("ANSWER_CHECK_OLLAMA_MODEL", "gemma4:e2b"),
        "messages": [{"role": "user", "content": prompt}],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0},
    }).encode("utf-8")
    request = urllib.request.Request(
        os.getenv("ANSWER_CHECK_OLLAMA_URL", "http://127.0.0.1:11434/api/chat"),
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            outer = json.loads(response.read().decode("utf-8"))
        result = json.loads(outer["message"]["content"])
        if isinstance(result.get("equivalent"), bool):
            return EquivalenceResult(
                result["equivalent"], "gemma_fallback", str(result.get("reason", ""))[:200]
            )
    except (OSError, KeyError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
        logger.warning("Gemma answer-check fallback failed: %s", exc)
    return EquivalenceResult(None, "fallback_failed")


def _candidate_latex(candidate: Any) -> str:
    if isinstance(candidate, str):
        return candidate
    if isinstance(candidate, dict):
        return str(candidate.get("latex", ""))
    return str(getattr(candidate, "latex", ""))


def check_answer(question_id: str, lines: Iterable[Any]) -> dict:
    """Check the last recognized answer line against a saved answer path."""

    question = get_question(question_id)
    line_list = list(lines)
    if not line_list:
        return {"correct": False, "status": "incorrect", "reason": "no_answer"}

    def line_index(line: Any) -> int:
        if isinstance(line, dict):
            return int(line.get("lineIndex", 0))
        return int(getattr(line, "lineIndex", 0))

    answer_line = max(line_list, key=line_index)
    candidates = answer_line.get("candidates", []) if isinstance(answer_line, dict) else answer_line.candidates
    unknown: list[tuple[int, str]] = []
    checked = 0
    for rank, candidate in enumerate(list(candidates)[:MAX_CANDIDATES], start=1):
        latex = _candidate_latex(candidate)
        checked += 1
        references = [question["expected_latex"]] + question.get("equivalent_solutions", [])
        results = [check_equivalence(reference, latex) for reference in references]
        matched_result = next((result for result in results if result.equivalent is True), None)
        if matched_result:
            return {
                "correct": True,
                "status": "correct",
                "matchedRank": rank,
                "matchedLatex": latex,
                "method": matched_result.method,
                "checkedCandidates": checked,
            }
        if any(result.equivalent is None for result in results):
            unknown.append((rank, latex))

    for rank, latex in unknown:
        fallback = _gemma_equivalence(question, latex)
        if fallback.equivalent is True:
            return {
                "correct": True,
                "status": "correct",
                "matchedRank": rank,
                "matchedLatex": latex,
                "method": fallback.method,
                "checkedCandidates": checked,
            }

    return {
        "correct": False,
        "status": "incorrect",
        "reason": "no_equivalent_candidate",
        "checkedCandidates": checked,
    }
