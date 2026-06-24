"""Browser bridge for pasting synthetic handwriting into the whiteboard.

This module is intentionally test-local.  It knows how to convert a
``BoardFixture`` into the browser's stroke store, but it does not depend on the
application's test runner.
"""

from __future__ import annotations

from typing import Any, Dict

from synthetic_handwriting import BoardFixture, place_handwriting_lines


PASTE_BOARD_JS = """
(fixture) => {
    const canvasEl = document.getElementById('whiteboard');
    const bgCanvas = document.getElementById('whiteboard-bg');
    const canvasWidth = canvasEl ? canvasEl.clientWidth : fixture.width;
    const canvasHeight = canvasEl ? canvasEl.clientHeight : fixture.height;
    const now = Date.now();

    if (!window.strokeSaver) throw new Error('strokeSaver is not loaded');

    fixture.lines.forEach((line, lineIndex) => {
        line.contours.forEach((outline, contourIndex) => {
            if (!outline || outline.length < 3) return;
            const xs = outline.map((pt) => pt.x);
            const ys = outline.map((pt) => pt.y);
            const xMin = Math.min(...xs);
            const yMin = Math.min(...ys);
            const xMax = Math.max(...xs);
            const yMax = Math.max(...ys);
            const id = 'synthetic_hw_' + (lineIndex + 1) + '_' + (contourIndex + 1) + '_' + now;
            const rawPoints = outline.map((pt) => ({ x: pt.x, y: pt.y, pressure: 0.55 }));
            const points = rawPoints.map((pt, pointIndex) => ({
                x: Math.max(0, Math.min(1, pt.x / canvasWidth)),
                y: Math.max(0, Math.min(1, pt.y / canvasHeight)),
                t: pointIndex * 4,
                pressure: pt.pressure
            }));
            const bbox = {
                xMin: Math.max(0, Math.min(1, xMin / canvasWidth)),
                yMin: Math.max(0, Math.min(1, yMin / canvasHeight)),
                xMax: Math.max(0, Math.min(1, xMax / canvasWidth)),
                yMax: Math.max(0, Math.min(1, yMax / canvasHeight))
            };
            window.strokeSaver.strokes.push({
                id,
                startTime: now + lineIndex * 900 + contourIndex * 12,
                endTime: now + lineIndex * 900 + contourIndex * 12 + 8,
                points,
                rawPoints,
                outlinePoints: outline,
                color: '#000000',
                canvasBbox: { xMin, yMin, xMax, yMax },
                bbox,
                syntheticLatex: line.latex,
                syntheticLineIndex: lineIndex,
                relationsToPrev: { dx: 0, dy: 0, dt: contourIndex * 12, overlapRatio: 0 }
            });
            window.strokeSaver.strokeStartTimes.set(id, now + lineIndex * 900 + contourIndex * 12);
        });
    });

    if (typeof redrawAllStrokes === 'function') {
        redrawAllStrokes();
    } else if (bgCanvas) {
        const ctx = bgCanvas.getContext('2d');
        ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
        ctx.save();
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#000000';
        fixture.contours.forEach((outline) => {
            if (!outline || outline.length < 3) return;
            ctx.beginPath();
            ctx.moveTo(outline[0].x, outline[0].y);
            for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
            ctx.closePath();
            ctx.fill();
        });
        ctx.restore();
    }

    if (typeof IdentifyLine !== 'undefined') IdentifyLine.finalizeStroke();
    if (typeof LinesRasterizer !== 'undefined') {
        LinesRasterizer.clearCache();
        LinesRasterizer.rasterizeAllLines();
    }
    window.__lastSyntheticBoard = fixture;
}
"""


def get_canvas_size(page: Any, default_width: int = 1400, default_height: int = 800) -> Dict[str, int]:
    size = page.evaluate(
        """
        (fallback) => {
            const canvasEl = document.getElementById('whiteboard');
            return {
                width: canvasEl ? canvasEl.clientWidth : fallback.width,
                height: canvasEl ? canvasEl.clientHeight : fallback.height
            };
        }
        """,
        {"width": default_width, "height": default_height},
    )
    return {
        "width": int(size.get("width") or default_width),
        "height": int(size.get("height") or default_height),
    }


def paste_board_fixture(page: Any, board: BoardFixture) -> BoardFixture:
    page.evaluate(PASTE_BOARD_JS, board.to_json())
    return board


def draw_latex_lines(page: Any, latex_lines, *, placements=None, seed: int = 0) -> BoardFixture:
    size = get_canvas_size(page)
    board = place_handwriting_lines(
        latex_lines,
        board_width=size["width"],
        board_height=size["height"],
        placements=placements,
        seed=seed,
    )
    return paste_board_fixture(page, board)


def draw_latex_equation(page: Any, latex: str, *, seed: int = 0) -> BoardFixture:
    size = get_canvas_size(page)
    board = place_handwriting_lines(
        [latex],
        board_width=size["width"],
        board_height=size["height"],
        placements=[{"anchor": "center"}],
        seed=seed,
        max_line_height=max(120, min(220, size["height"] - 180)),
    )
    return paste_board_fixture(page, board)
