// PenStroke.js
// Two-canvas architecture for real-time perfect-freehand smoothing.
// Includes checkpoint-based undo/redo (saves full state every N strokes, deltas between).

// ---- Canvas setup ----
var bgCanvas = document.getElementById("whiteboard-bg");
var fgCanvas = document.getElementById("whiteboard");
var bgCtx = bgCanvas.getContext("2d");
var fgCtx = fgCanvas.getContext("2d");

var penBtn = document.getElementById("pen");
var isDrawing = false;
var dpr = window.devicePixelRatio || 1;

// Stroke data saver instance (also exposed globally for IdentifyLine.js)
window.strokeSaver = new StrokeDataSaver();
var strokeSaver = window.strokeSaver;

// ── Checkpoint-based undo/redo ─────────────────────────────────────
// Saves a full snapshot every CHECKPOINT_INTERVAL strokes. Between snapshots,
// records delta operations [action, index] for undo/redo traversal.
var CHECKPOINT_INTERVAL = 10; // full snapshot every N strokes
var _undoStack = [];          // array of {snapshot: strokesArr, strokeCount: int}
var _redoStack = [];          // same structure as _undoStack
var _deltaBuffer = [];        // deltas since last checkpoint (reset when a new one is written)
var _strokeCounterForCheckpoints = 0;

function pushCheckpoint() {
  var curStrokes = strokeSaver.getStrokes();
  var snapshot = JSON.parse(JSON.stringify(curStrokes));
  _undoStack.push({ snapshot: snapshot, strokeCount: strokeSaver.getStrokeCount() });
  if (_undoStack.length > 50) _undoStack.shift();
  // Clear delta buffer — we jumped to a new checkpoint
  _deltaBuffer = [];
}

function pushDelta(action, index) {
  _deltaBuffer.push({ action: action, index: index });
}

/**
 * Undo: traverse deltas backward from the top of _undoStack.
 * If no deltas exist at that level, fall back to the previous checkpoint.
 */
function undoStroke() {
  if (_undoStack.length === 0) return;
  var currentTop = _undoStack[_undoStack.length - 1];

  // First try deltas (reverse order)
  for (var d = _deltaBuffer.length - 1; d >= 0; d--) {
    var delta = _deltaBuffer[d];
    if (delta.action === "add") {
      // Remove stroke at this index
      var strokes = JSON.parse(JSON.stringify(strokeSaver.getStrokes()));
      if (delta.index < strokes.length) {
        strokes.splice(delta.index, 1);
        _undoStack.pop();
        _redoStack.push({ snapshot: strokes, strokeCount: strokes.length });
        _deltaBuffer.splice(d, 1); // remove this delta from buffer
        strokeSaver.strokes = strokes;
        strokeSaver.currentStroke = null;
        redrawAllStrokes();
        if (typeof IdentifyLine !== "undefined") IdentifyLine.groupStrokesIntoLines();
        if (typeof LinesRasterizer !== "undefined") {
          LinesRasterizer.clearCache();
          LinesRasterizer.rasterizeAllLines();
        }
        return;
      }
    } else if (delta.action === "remove") {
      // Restore a removed stroke — apply it back to a deeper snapshot
      var strokes = JSON.parse(JSON.stringify(strokeSaver.getStrokes()));
      strokes.splice(delta.index, 0, delta.stroke);
      _undoStack.pop();
      _redoStack.push({ snapshot: JSON.parse(JSON.stringify(strokes)), strokeCount: strokes.length });
      _deltaBuffer.splice(d, 1);
      strokeSaver.strokes = strokes;
      strokeSaver.currentStroke = null;
      redrawAllStrokes();
      if (typeof IdentifyLine !== "undefined") IdentifyLine.groupStrokesIntoLines();
      if (typeof LinesRasterizer !== "undefined") {
        LinesRasterizer.clearCache();
        LinesRasterizer.rasterizeAllLines();
      }
      return;
    }
  }

  // No deltas at top level — fall back to previous checkpoint
  _undoStack.pop();
  if (_undoStack.length === 0) {
    strokeSaver.strokes = [];
    strokeSaver.currentStroke = null;
    redrawAllStrokes();
    if (typeof LinesRasterizer !== "undefined") {
      LinesRasterizer.clearCache();
      LinesRasterizer.rasterizeAllLines();
    }
    return;
  }

  var prevState = _undoStack[_undoStack.length - 1];
  strokeSaver.strokes = JSON.parse(JSON.stringify(prevState.snapshot));
  strokeSaver.currentStroke = null;
  _deltaBuffer = []; // clear deltas when jumping to checkpoint
  redrawAllStrokes();
  if (typeof IdentifyLine !== "undefined") IdentifyLine.groupStrokesIntoLines();
  if (typeof LinesRasterizer !== "undefined") {
    LinesRasterizer.clearCache();
    LinesRasterizer.rasterizeAllLines();
  }
}

/**
 * Redo: apply the top of _redoStack forward.
 */
function redoStroke() {
  if (_redoStack.length === 0) return;
  var next = _redoStack[_redoStack.length - 1];
  strokeSaver.strokes = JSON.parse(JSON.stringify(next.snapshot));
  strokeSaver.currentStroke = null;

  // Push current state onto undo stack before applying redo
  pushCheckpoint();

  _redoStack.pop();
  redrawAllStrokes();
  if (typeof IdentifyLine !== "undefined") IdentifyLine.groupStrokesIntoLines();
  if (typeof LinesRasterizer !== "undefined") {
    LinesRasterizer.clearCache();
    LinesRasterizer.rasterizeAllLines();
  }
}

// ── Stroke smoother instance ──────────────────────────────────────
var strokeSmoother = new StrokeSmoother();
strokeSmoother.opts.size = (window.penWidth !== undefined) ? window.penWidth : 12;

var SHOW_RAW_POINTS = false;
var rawPoints = [];
var _rafPending = false;
var _pendingRawPoints = null;
var _pendingColor = null;

function resize() {
  var w = fgCanvas.clientWidth;
  var h = fgCanvas.clientHeight;
  bgCanvas.width = w * dpr;
  bgCanvas.height = h * dpr;
  fgCanvas.width = w * dpr;
  fgCanvas.height = h * dpr;

  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  window.redrawAllStrokes();
}

function redrawForeground() {
  fgCtx.clearRect(0, 0, fgCanvas.width / dpr, fgCanvas.height / dpr);
  fgCtx.drawImage(bgCanvas, 0, 0, fgCanvas.width / dpr, fgCanvas.height / dpr);
}

function drawRawPoints(ctx, pts) {
  if (!pts || pts.length === 0) return;
  for (var i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 50, 50, 0.7)";
    ctx.fill();
  }
}

function renderLiveStroke(rawPts, color) {
  if (!rawPts || rawPts.length < 2) return;
  redrawForeground();
  if (SHOW_RAW_POINTS) drawRawPoints(fgCtx, rawPts);
  var outline = strokeSmoother.smooth(rawPts);
  strokeSmoother.render(fgCtx, outline, color);
}

function finalizeStroke(rawPts, color) {
  if (!rawPts || rawPts.length < 2) return;
  if (SHOW_RAW_POINTS) drawRawPoints(bgCtx, rawPts);
  var outline = strokeSmoother.smooth(rawPts);
  strokeSmoother.render(bgCtx, outline, color);
  redrawForeground();
}

function drawDot(x, y, color) {
  var size = strokeSmoother.opts.size || 12;
  bgCtx.beginPath();
  bgCtx.arc(x, y, size / 2, 0, Math.PI * 2);
  bgCtx.fillStyle = color || "#000000";
  bgCtx.fill();
  redrawForeground();
}

function redrawAllStrokes() {
  bgCtx.clearRect(0, 0, bgCanvas.width / dpr, bgCanvas.height / dpr);
  var strokes = strokeSaver.getStrokes();
  for (var i = 0; i < strokes.length; i++) {
    var st = strokes[i];
    if (st.outlinePoints && st.outlinePoints.length >= 3 && st.color) {
      strokeSmoother.render(bgCtx, st.outlinePoints, st.color);
    }
  }
  redrawForeground();
}

function dotStrokeOutline(x, y, size) {
  var radius = size / 2;
  if (radius < 1) radius = 1;
  var segments = 16;
  var outline = [];
  for (var i = 0; i <= segments; i++) {
    var angle = (i / segments) * Math.PI * 2;
    outline.push({ x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius });
  }
  return outline;
}

function requestLiveStroke(rawPts, color) {
  _pendingRawPoints = rawPts;
  _pendingColor = color;
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(function () {
      _rafPending = false;
      if (_pendingRawPoints) {
        renderLiveStroke(_pendingRawPoints, _pendingColor);
      }
    });
  }
}

// ── Pointer event handlers ────────────────────────────────────────

fgCanvas.addEventListener("pointerdown", function (e) {
  if (!penBtn?.classList.contains("active")) return;
  isDrawing = true;
  rawPoints = [];
  rawPoints.push({ x: e.offsetX, y: e.offsetY, pressure: e.pressure || 0.5 });
  strokeSaver.startStroke(e.offsetX, e.offsetY, e.pressure || 0.5, fgCanvas.clientWidth, fgCanvas.clientHeight);
});

fgCanvas.addEventListener("pointermove", function (e) {
  if (!isDrawing || !penBtn?.classList.contains("active")) return;
  rawPoints.push({ x: e.offsetX, y: e.offsetY, pressure: e.pressure || 0.5 });
  requestLiveStroke(rawPoints, window.penColor || "#000000");
  strokeSaver.addPoint(e.offsetX, e.offsetY, e.pressure || 0.5, fgCanvas.clientWidth, fgCanvas.clientHeight);
});

fgCanvas.addEventListener("pointerup", function () {
  if (isDrawing) {
    // Check if it's time for a checkpoint
    _strokeCounterForCheckpoints++;
    if (_strokeCounterForCheckpoints >= CHECKPOINT_INTERVAL) {
      pushCheckpoint();
      _strokeCounterForCheckpoints = 0;
    } else {
      // Store delta instead of full snapshot
      var strokes = strokeSaver.getStrokes();
      pushDelta("add", strokes.length - 1);
    }

    var color = window.penColor || "#000000";
    if (rawPoints.length === 1) {
      var dotSize = strokeSmoother.opts.size || 12;
      drawDot(rawPoints[0].x, rawPoints[0].y, color);
      var dotOutline = dotStrokeOutline(rawPoints[0].x, rawPoints[0].y, dotSize);
      strokeSaver.endStroke(dotOutline, color);
    } else if (rawPoints.length >= 2) {
      var outline = strokeSmoother.smooth(rawPoints);
      finalizeStroke(rawPoints, color);
      strokeSaver.endStroke(outline, color);
    }

    if (typeof IdentifyLine !== "undefined") {
      IdentifyLine.finalizeStroke();
    }
  }
  isDrawing = false;
  rawPoints = [];
});

fgCanvas.addEventListener("pointerleave", function () {
  if (isDrawing) {
    _strokeCounterForCheckpoints++;
    if (_strokeCounterForCheckpoints >= CHECKPOINT_INTERVAL) {
      pushCheckpoint();
      _strokeCounterForCheckpoints = 0;
    } else {
      var strokes = strokeSaver.getStrokes();
      pushDelta("add", strokes.length - 1);
    }

    var color = window.penColor || "#000000";
    if (rawPoints.length === 1) {
      var dotSize = strokeSmoother.opts.size || 12;
      drawDot(rawPoints[0].x, rawPoints[0].y, color);
      var dotOutline = dotStrokeOutline(rawPoints[0].x, rawPoints[0].y, dotSize);
      strokeSaver.endStroke(dotOutline, color);
    } else if (rawPoints.length >= 2) {
      var outline = strokeSmoother.smooth(rawPoints);
      finalizeStroke(rawPoints, color);
      strokeSaver.endStroke(outline, color);
    }

    if (typeof IdentifyLine !== "undefined") {
      IdentifyLine.finalizeStroke();
    }
  }
  isDrawing = false;
  rawPoints = [];
});

// ── Global API ─────────────────────────────────────────────────────
window.redrawAllStrokes = redrawAllStrokes;
window.redrawForeground = redrawForeground;
window.undoStroke = undoStroke;
window.redoStroke = redoStroke;

// Clear all strokes from the canvas
window.clearAllStrokes = function () {
  if (strokeSaver.getStrokes().length === 0) return;
  pushCheckpoint(); // save before clearing
  strokeSaver.clear();
  bgCtx.clearRect(0, 0, bgCanvas.width / dpr, bgCanvas.height / dpr);
  redrawForeground();
  _deltaBuffer = [];
  if (typeof IdentifyLine !== "undefined") {
    IdentifyLine.groupStrokesIntoLines();
  }
  if (typeof LatexPredictor !== "undefined" && LatexPredictor.clearPredictions) {
    LatexPredictor.clearPredictions();
  }
  // Re-rasterize to clear stale cached rasterized images
  if (typeof LinesRasterizer !== "undefined") {
    LinesRasterizer.clearCache();
    LinesRasterizer.rasterizeAllLines();
  }
  showToastFn("Canvas cleared");
};

// Export canvas content as a PNG file
window.exportCanvasPNG = function () {
  var expCanvas = document.createElement("canvas");
  expCanvas.width = bgCanvas.width;
  expCanvas.height = bgCanvas.height;
  var expCtx = expCanvas.getContext("2d");
  expCtx.fillStyle = "#ffffff";
  expCtx.fillRect(0, 0, expCanvas.width, expCanvas.height);
  expCtx.drawImage(bgCanvas, 0, 0);
  expCtx.drawImage(fgCanvas, 0, 0);

  var link = document.createElement("a");
  link.download = "whiteboard_" + new Date().toISOString().slice(0, 19).replace(/[:-]/g, "") + ".png";
  link.href = expCanvas.toDataURL("image/png");
  link.click();
  showToastFn("Canvas exported as PNG");
};

function showToastFn(msg) {
  var toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = "block";
  toast.className = "toast show";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () {
    toast.style.display = "none";
    toast.className = "toast";
  }, 2000);
}

// Pen button click handler
penBtn.addEventListener("click", function () {
  if (!penBtn.classList.contains("active")) {
    penBtn.classList.add("active");
    var eraserBtn = document.getElementById("eraser");
    if (eraserBtn) eraserBtn.classList.remove("active");
    fgCanvas.style.cursor = "crosshair";
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", function (e) {
  var tag = document.activeElement?.tagName || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    strokeSaver.debugLog();
  }

  // Undo: Ctrl+Z (Cmd+Z on Mac)
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoStroke();
  }

  // Redo: Ctrl+Shift+Z or Ctrl+Y
  if (((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) ||
      ((e.ctrlKey || e.metaKey) && e.key === "y")) {
    e.preventDefault();
    redoStroke();
  }
});

window.addEventListener("resize", resize);
resize();
