#!/usr/bin/env python3
"""Live browser test using synthetic handwritten answer fixtures.

Start ``server/start_server.sh`` first, then run this file.  It draws the
configured question's answer on the real whiteboard and waits for the answer
checker verdict.
"""

import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_equations import clear_whiteboard, draw_latex_equation


QUESTION_ID = "solve_addition_x_plus_3"


def load_question_answer(question_id):
    questions_path = Path(__file__).with_name("solving_questions.json")
    with questions_path.open() as f:
        for question in json.load(f):
            if question["id"] == question_id:
                return question["solution_latex"]
    raise KeyError(question_id)


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(f"http://localhost:8000/index.html?questionId={QUESTION_ID}", timeout=30_000)
        page.wait_for_function("typeof window.strokeSaver !== 'undefined'")
        page.wait_for_function("typeof window.AnswerPredictionStore !== 'undefined'")
        clear_whiteboard(page)
        draw_latex_equation(page, load_question_answer(QUESTION_ID), seed=101)
        page.evaluate("LatexPredictor.recognize()")
        page.wait_for_function(
            "document.getElementById('answer-check-result').textContent !== 'Checking…' && "
            "document.getElementById('answer-check-result').textContent.length > 0",
            timeout=60_000,
        )
        result = page.locator("#answer-check-result").inner_text()
        stored = page.evaluate("AnswerPredictionStore.getLines()")
        assert len(stored) == 1, stored
        assert 1 <= len(stored[0]["candidates"]) <= 5, stored
        assert result in {"Correct", "Incorrect"}, result
        print(f"Verdict: {result}; stored candidates: {len(stored[0]['candidates'])}")
        browser.close()


if __name__ == "__main__":
    main()
