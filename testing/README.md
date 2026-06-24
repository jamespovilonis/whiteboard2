# Testing workflow

## Synthetic handwriting fixtures

`synthetic_handwriting.py` renders LaTeX into rough black ink contours. Browser
tests paste those contours into `StrokeDataSaver`, which means the normal
whiteboard path still runs:

1. contour strokes are grouped by `IdentifyLineDBNet`;
2. DBNet reads the rasterized candidate image;
3. CoMER reads the selected line image; and
4. answer checking consumes the stored LaTeX candidates.

The fixture data keeps the existing problem-answer pairs in
`solving_questions.json`; only the drawing mechanism changed.

## Fast local checks

```bash
python3 -m unittest \
  testing/test_synthetic_handwriting.py \
  testing/test_answer_checker.py \
  testing/test_dbnet_integration.py
```

These do not require the browser, DBNet model, or CoMER server.

## Live DBNet + CoMER checks

Start the unified server first, then run the Playwright OCR runner:

```bash
server/start_server.sh
python3 testing/test_equations.py --category simple
```

For the answer-check path backed by the solving question fixtures:

```bash
python3 testing/test_answer_check_browser.py
```

The JSON output from `test_equations.py` includes a base64 preview of each
synthetic handwritten fixture plus the contour count used to paste it into the
canvas.

## Multi-line board fixtures

Use `place_handwriting_lines()` from `synthetic_handwriting.py` when a test
needs several expressions on the same board. Each line can be placed by explicit
`x`/`y` coordinates or by anchors such as `top-left`, `center`, and
`bottom-right`.

Generate the standard multi-line algebra preview with:

```bash
python3 testing/render_multiline_algebra_fixture.py
```

Generate crowded DBNet stress variants with:

```bash
python3 testing/render_multiline_algebra_fixture.py --variant dense
python3 testing/render_multiline_algebra_fixture.py --variant dense-steps
```

It writes:

- `testing/results/multiline_algebra_board.png`
- `testing/results/multiline_algebra_board.json`

After PaddleOCR is installed, run the full DBNet segmentation matrix with:

```bash
source .venv/bin/activate
python testing/run_dbnet_fixture_matrix.py
```

The matrix checks standard algebra spacing, dense algebra spacing, dense
intermediate-step work, and a stacked fraction control. Each board is replayed
through the splitter with line-order, reverse-line, and interleaved stroke
timing.
