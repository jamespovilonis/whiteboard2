// PenStroke.js
// Two-canvas architecture for real-time perfect-freehand smoothing.
// Per-stroke-snapshot undo/redo (each stroke creates a full snapshot).

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

// ── Per-stroke undo/redo ──────────────────────────────────────────
// Each stroke (or clear) pushes a full snapshot onto the undo stack.
// Undo pops the last snapshot and pushes the current state onto the redo stack.
// Redo reverses the operation.
var UNDO_MAX = 100;
var _undoStack = [];          // array of {snapshot: strokesArr}
var _redoStack = [];          // same structure

function pushUndoState() {
  var curStrokes = strokeSaver.getStrokes();
  var snapshot = JSON.parse(JSON.stringify(curStrokes));
  _undoStack.push({
    snapshot: snapshot,
    strokeCounter: strokeSaver.strokeCounter,
    strokeStartTimes: Array.from(strokeSaver.strokeStartTimes)
  });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  // Any new action invalidates the redo stack
  _redoStack = [];
}

function restoreState(entry) {
  strokeSaver.strokes = JSON.parse(JSON.stringify(entry.snapshot));
  strokeSaver.currentStroke = null;
  strokeSaver.strokeCounter = entry.strokeCounter || 0;
  strokeSaver.strokeStartTimes = new Map(entry.strokeStartTimes || []);
}

/**
 * Undo: pop the last snapshot off the undo stack and restore it.
 * The current state is pushed onto the redo stack first.
 */
function undoStroke() {
  if (_undoStack.length === 0) return;

  // Save current state for redo before popping
  var curStrokes = strokeSaver.getStrokes();
  _redoStack.push({
    snapshot: JSON.parse(JSON.stringify(curStrokes)),
    strokeCounter: strokeSaver.strokeCounter,
    strokeStartTimes: Array.from(strokeSaver.strokeStartTimes)
  });
  if (_redoStack.length > UNDO_MAX) _redoStack.shift();

  var entry = _undoStack.pop();
  restoreState(entry);

  redrawAllStrokes();
  if (typeof IdentifyLine !== "undefined") IdentifyLine.groupStrokesIntoLines();
  if (typeof LinesRasterizer !== "undefined") {
    LinesRasterizer.clearCache();
    LinesRasterizer.rasterizeAllLines();
  }
  if (typeof RealtimeRecognitionScheduler !== "undefined") {
    RealtimeRecognitionScheduler.resetRecognizedCache();
    RealtimeRecognitionScheduler.notifyStrokeChange("undo");
  }
}

/**
 * Redo: restore the last undone state from the redo stack.
 */
function redoStroke() {
  if (_redoStack.length === 0) return;

  // Save current state for undo before applying redo
  var curStrokes = strokeSaver.getStrokes();
  _undoStack.push({
    snapshot: JSON.parse(JSON.stringify(curStrokes)),
    strokeCounter: strokeSaver.strokeCounter,
    strokeStartTimes: Array.from(strokeSaver.strokeStartTimes)
  });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();

  var entry = _redoStack.pop();
  restoreState(entry);

  redrawAllStrokes();
  if (typeof IdentifyLine !== "undefined") IdentifyLine.groupStrokesIntoLines();
  if (typeof LinesRasterizer !== "undefined") {
    LinesRasterizer.clearCache();
    LinesRasterizer.rasterizeAllLines();
  }
  if (typeof RealtimeRecognitionScheduler !== "undefined") {
    RealtimeRecognitionScheduler.resetRecognizedCache();
    RealtimeRecognitionScheduler.notifyStrokeChange("redo");
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
  e.preventDefault();
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

function finalizeCurrentStroke() {
  if (!isDrawing) return;
  var color = window.penColor || "#000000";

  // Push undo state BEFORE adding the stroke so undoing
  // restores the state without this stroke.
  pushUndoState();

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
  if (typeof RealtimeRecognitionScheduler !== "undefined") {
    RealtimeRecognitionScheduler.notifyStrokeChange("pen");
  }
  isDrawing = false;
  rawPoints = [];
}

fgCanvas.addEventListener("pointerup", function () {
  if (isDrawing) {
    finalizeCurrentStroke();
  }
  isDrawing = false;
  rawPoints = [];
});

fgCanvas.addEventListener("pointerleave", function () {
  if (isDrawing) {
    finalizeCurrentStroke();
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
  pushUndoState(); // save before clearing
  strokeSaver.clear();
  bgCtx.clearRect(0, 0, bgCanvas.width / dpr, bgCanvas.height / dpr);
  redrawForeground();
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
  if (typeof RealtimeRecognitionScheduler !== "undefined") {
    RealtimeRecognitionScheduler.resetRecognizedCache();
    RealtimeRecognitionScheduler.notifyStrokeChange("clear");
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
    var mouseBtn = document.getElementById("mouse");
    if (eraserBtn) eraserBtn.classList.remove("active");
    if (mouseBtn) mouseBtn.classList.remove("active");
    fgCanvas.style.cursor = "crosshair";
    if (typeof updateToolbarToggleIcon === "function") updateToolbarToggleIcon();
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