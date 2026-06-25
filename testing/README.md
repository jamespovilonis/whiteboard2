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

## Complex solving OCR matrix

`run_complex_ocr_matrix.py` expands the OCR checks to full problem-solving
boards:

- rational equation solving with fraction clearing and intermediate operation
  rows, a quadratic-over-linear rational equation, and a two-fraction
  rational equation;
- logarithmic solving with bases/subscripts, shifted arguments, and
  exponentiation/product-log steps;
- derivative evaluation with repeated exponent work and a product-rule style
  expansion, plus quotient-rule evaluation; and
- definite integral evaluation with limits, substitution steps, and a second
  power-rule integral plus a fractional antiderivative.

Each problem is rendered in `standard`, `dense`, and `tight-steps` spacing. The
DBNet separation pass replays every board with `line-order`, `reverse-lines`,
and `interleaved-lines` timing:

```bash
python3 testing/run_complex_ocr_matrix.py --skip-comer
```

When the local CoMER server is running, the same script can crop each separated
line and post it to `/recognize`:

```bash
python3 testing/run_complex_ocr_matrix.py \
  --orders line-order \
  --recognize-order line-order \
  --timeout-seconds 20 \
  --write-summary testing/results/complex_ocr/complex_ocr_matrix_all_comer_20s.json
```

By default, CoMER receives split-stroke crops that match the browser
`LinesRasterizer` path. `--crop-source fixture-line` is available for isolating
recognition against the original synthetic line image after DBNet has already
validated a one-source-line split; this is useful for diagnosing contour
artifacts such as filled-in zeros, but it is not the primary app-path evidence.

The 20 second timeout matches the server maximum and avoids false failures on
larger derivative/integral crops. By default, CoMER verification is strict:
harmless formatting noise such as `x = 1 6` versus `x = 16`, uppercase `X`, and
`\prime` formatting are normalized, but missing operators such as `\log`,
`\int`, or exponent structure fail the run. Add `--allow-loose-comer` only when
you want exploratory key-token similarity stats without failing the matrix.

The latest DBNet-only evidence is
`testing/results/complex_ocr/complex_ocr_matrix_full_dbnet_all_orders.json`:
exact separation for all 36 rational, logarithmic, derivative, and integral
boards across line-order, reverse-lines, and interleaved-lines timing
(108 board/order cases).
With corrected mathtext rendering for token-spaced LaTeX, split-stroke crops
that match the browser rasterization path, and conservative LaTeX postprocessing
for common CoMER token confusions, the latest strict CoMER evidence in
`testing/results/complex_ocr/complex_ocr_matrix_full_live_comer_20s.json`
is 177/177 top-choice matches for line-order boards. The focused tier-three
rerun in
`testing/results/complex_ocr/complex_ocr_matrix_tier3_live_comer_20s.json`
is 60/60 strict.
