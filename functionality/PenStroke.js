// PenStroke.js
// Two-canvas architecture for real-time perfect-freehand smoothing.
//
// Architecture improvements:
//   - DPR (Retina) support: scales canvas backing store by devicePixelRatio
//   - Resize preserves strokes (calls redrawAllStrokes)
//   - Single-tap draws a dot
//   - Undo/redo hooks (strokeSaver undo stack)
//   - requestAnimationFrame throttling for live stroke rendering

// ---- Canvas setup ----
var bgCanvas = document.getElementById("whiteboard-bg");
var bgCtx = bgCanvas.getContext("2d");

var fgCanvas = document.getElementById("whiteboard");
var fgCtx = fgCanvas.getContext("2d");

var penBtn = document.getElementById("pen");

var isDrawing = false;

// DPR scale factor
var dpr = window.devicePixelRatio || 1;

// Stroke data saver instance (also exposed globally for IdentifyLine.js)
window.strokeSaver = new StrokeDataSaver();
var strokeSaver = window.strokeSaver;

// Undo history stack (array of cloned strokes arrays)
window._undoStack = [];
window._redoStack = [];
var MAX_UNDO = 50;

// Push current state onto undo stack before a destructive operation
function pushUndo() {
  window._redoStack = [];
  window._undoStack.push(JSON.parse(JSON.stringify(strokeSaver.getStrokes())));
  if (window._undoStack.length > MAX_UNDO) {
    window._undoStack.shift();
  }
}

// Stroke smoother instance (configurable defaults live in StrokeSmoother.js)
var strokeSmoother = new StrokeSmoother();

// Size is synced from PenSizeColor (if loaded) or defaults to smoother's built-in
strokeSmoother.opts.size = (window.penWidth !== undefined) ? window.penWidth : 12;

// Toggle: set to false to hide raw red-dot input points, true to show them
var SHOW_RAW_POINTS = false;

// Buffer of raw canvas-coordinate points for the current in-progress stroke
var rawPoints = [];

// requestAnimationFrame throttle for live stroke rendering
var _rafPending = false;
var _pendingRawPoints = null;
var _pendingColor = null;

function resize() {
  // Size both canvases to match the container, accounting for DPR
  var w = fgCanvas.clientWidth;
  var h = fgCanvas.clientHeight;
  bgCanvas.width = w * dpr;
  bgCanvas.height = h * dpr;
  fgCanvas.width = w * dpr;
  fgCanvas.height = h * dpr;

  // Scale contexts by DPR
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Redraw all strokes from the strokeSaver (preserves strokes on resize)
  window.redrawAllStrokes();
}

// Redraw the foreground canvas from the background (persists all completed strokes)
function redrawForeground() {
  fgCtx.clearRect(0, 0, fgCanvas.width / dpr, fgCanvas.height / dpr);
  fgCtx.drawImage(bgCanvas, 0, 0, fgCanvas.width / dpr, fgCanvas.height / dpr);
}

// Draw raw input points as small red dots for comparison
function drawRawPoints(ctx, pts) {
  if (!pts || pts.length === 0) return;
  for (var i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 50, 50, 0.7)";
    ctx.fill();
  }
}

// Render the smoothed in-progress stroke + raw points onto the foreground canvas
function renderLiveStroke(rawPts, color) {
  if (!rawPts || rawPts.length < 2) return;

  // Restore background first
  redrawForeground();

  // Draw raw input points (red dots) for comparison
  if (SHOW_RAW_POINTS) drawRawPoints(fgCtx, rawPts);

  // Smooth and render the current raw points on top
  var outline = strokeSmoother.smooth(rawPts);
  strokeSmoother.render(fgCtx, outline, color);
}

// Render a final stroke + raw points onto the background canvas (persistent)
function finalizeStroke(rawPts, color) {
  if (!rawPts || rawPts.length < 2) return;

  // Draw raw input points for comparison (controlled by SHOW_RAW_POINTS)
  if (SHOW_RAW_POINTS) drawRawPoints(bgCtx, rawPts);

  var outline = strokeSmoother.smooth(rawPts);
  strokeSmoother.render(bgCtx, outline, color);

  // Update foreground to show the newly finalized stroke
  redrawForeground();
}

// Draw a single dot (for single-tap / very short strokes)
function drawDot(x, y, color) {
  var size = strokeSmoother.opts.size || 12;
  bgCtx.beginPath();
  bgCtx.arc(x, y, size / 2, 0, Math.PI * 2);
  bgCtx.fillStyle = color || "#000000";
  bgCtx.fill();
  redrawForeground();
}

// Redraw all completed strokes from strokeSaver data onto the background canvas
function redrawAllStrokes() {
  // Clear the background canvas (DPR-aware)
  bgCtx.clearRect(0, 0, bgCanvas.width / dpr, bgCanvas.height / dpr);

  // Redraw every stored stroke
  var strokes = strokeSaver.getStrokes();
  for (var i = 0; i < strokes.length; i++) {
    var st = strokes[i];
    if (st.outlinePoints && st.outlinePoints.length >= 3 && st.color) {
      strokeSmoother.render(bgCtx, st.outlinePoints, st.color);
    }
  }

  // Refresh foreground
  redrawForeground();
}

// Generate a circular polygon outline for a single-point dot stroke
// Returns an array of {x, y} points forming a circle suitable for strokeSaver persistence
function dotStrokeOutline(x, y, size) {
  var radius = size / 2;
  if (radius < 1) radius = 1;
  var segments = 16;
  var outline = [];
  for (var i = 0; i <= segments; i++) {
    var angle = (i / segments) * Math.PI * 2;
    outline.push({
      x: x + Math.cos(angle) * radius,
      y: y + Math.sin(angle) * radius
    });
  }
  return outline;
}

// Throttled version of renderLiveStroke for pointermove
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

fgCanvas.addEventListener("pointerdown", function (e) {
  if (!penBtn?.classList.contains("active")) return;
  isDrawing = true;

  // Clear raw points buffer for the new stroke
  rawPoints = [];

  // Record first raw point
  rawPoints.push({
    x: e.offsetX,
    y: e.offsetY,
    pressure: e.pressure || 0.5
  });

  // Start recording stroke data
  strokeSaver.startStroke(
    e.offsetX,
    e.offsetY,
    e.pressure || 0.5,
    fgCanvas.clientWidth,
    fgCanvas.clientHeight
  );
});

fgCanvas.addEventListener("pointermove", function (e) {
  if (!isDrawing || !penBtn?.classList.contains("active")) return;

  // Record raw point
  rawPoints.push({
    x: e.offsetX,
    y: e.offsetY,
    pressure: e.pressure || 0.5
  });

  // Real-time smoothed preview (throttled via rAF)
  requestLiveStroke(rawPoints, window.penColor || "#000000");

  // Record point data
  strokeSaver.addPoint(
    e.offsetX,
    e.offsetY,
    e.pressure || 0.5,
    fgCanvas.clientWidth,
    fgCanvas.clientHeight
  );
});

fgCanvas.addEventListener("pointerup", function () {
  if (isDrawing) {
    pushUndo();
    var color = window.penColor || "#000000";

    if (rawPoints.length === 1) {
      // Single tap: draw a dot
      var dotSize = strokeSmoother.opts.size || 12;
      drawDot(rawPoints[0].x, rawPoints[0].y, color);
      // Create a proper polygon outline for the dot (small circle) so it persists on redraw
      var dotOutline = dotStrokeOutline(rawPoints[0].x, rawPoints[0].y, dotSize);
      strokeSaver.endStroke(dotOutline, color);
    } else if (rawPoints.length >= 2) {
      // Compute outline once, reuse for both finalize and storage
      var outline = strokeSmoother.smooth(rawPoints);
      finalizeStroke(rawPoints, color);
      strokeSaver.endStroke(outline, color);
    }

    // Group strokes into lines after each stroke ends
    if (typeof IdentifyLine !== "undefined") {
      IdentifyLine.finalizeStroke();
    }
  }
  isDrawing = false;
  rawPoints = [];
});

fgCanvas.addEventListener("pointerleave", function () {
  if (isDrawing) {
    pushUndo();
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

// Expose globally for other modules
window.redrawAllStrokes = redrawAllStrokes;
window.redrawForeground = redrawForeground;

// Clear all strokes from the canvas
window.clearAllStrokes = function () {
  if (strokeSaver.getStrokes().length === 0) return;
  pushUndo();
  strokeSaver.clear();
  bgCtx.clearRect(0, 0, bgCanvas.width / dpr, bgCanvas.height / dpr);
  redrawForeground();
  if (typeof IdentifyLine !== "undefined") {
    IdentifyLine.groupStrokesIntoLines();
  }
  // Clear prediction panel
  if (typeof LatexPredictor !== "undefined" && LatexPredictor.clearPredictions) {
    LatexPredictor.clearPredictions();
  }
  showToastFn("Canvas cleared");
};

// Export canvas content as a PNG file
window.exportCanvasPNG = function () {
  // Create a temporary canvas that composites bg + fg strokes.
  // Both expCanvas and the source canvases are already DPR-scaled,
  // so drawImage at (0,0) without extra scaling is correct.
  var expCanvas = document.createElement("canvas");
  expCanvas.width = bgCanvas.width;
  expCanvas.height = bgCanvas.height;
  var expCtx = expCanvas.getContext("2d");

  // White background
  expCtx.fillStyle = "#ffffff";
  expCtx.fillRect(0, 0, expCanvas.width, expCanvas.height);

  // Draw both canvases (they are already DPR-scaled to the same size)
  expCtx.drawImage(bgCanvas, 0, 0);
  expCtx.drawImage(fgCanvas, 0, 0);

  var link = document.createElement("a");
  link.download = "whiteboard_" + new Date().toISOString().slice(0, 19).replace(/[:-]/g, "") + ".png";
  link.href = expCanvas.toDataURL("image/png");
  link.click();
  showToastFn("Canvas exported as PNG");
};

// Simple toast helper
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

// Undo/redo functions exposed globally
window.undoStroke = function () {
  var stack = window._undoStack;
  if (stack.length === 0) return;
  var curState = JSON.parse(JSON.stringify(strokeSaver.getStrokes()));
  window._redoStack.push(curState);
  var prevState = stack.pop();
  strokeSaver.strokes = prevState;
  strokeSaver.currentStroke = null;
  redrawAllStrokes();
  if (typeof IdentifyLine !== "undefined") {
    IdentifyLine.groupStrokesIntoLines();
  }
};

window.redoStroke = function () {
  var stack = window._redoStack;
  if (stack.length === 0) return;
  var curState = JSON.parse(JSON.stringify(strokeSaver.getStrokes()));
  window._undoStack.push(curState);
  var nextState = stack.pop();
  strokeSaver.strokes = nextState;
  strokeSaver.currentStroke = null;
  redrawAllStrokes();
  if (typeof IdentifyLine !== "undefined") {
    IdentifyLine.groupStrokesIntoLines();
  }
};

// Pen button click handler: activate pen, deactivate eraser
penBtn.addEventListener("click", function () {
  if (!penBtn.classList.contains("active")) {
    penBtn.classList.add("active");
    // Deactivate eraser if active
    var eraserBtn = document.getElementById("eraser");
    if (eraserBtn) eraserBtn.classList.remove("active");
    fgCanvas.style.cursor = "crosshair";
  }
});

// Press 's' to dump stroke data to console
document.addEventListener("keydown", function (e) {
  var tag = document.activeElement?.tagName || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    strokeSaver.debugLog();
  }

  // Undo: Ctrl+Z (Cmd+Z on Mac)
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    if (typeof window.undoStroke === "function") window.undoStroke();
  }

  // Redo: Ctrl+Shift+Z or Ctrl+Y
  if (((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) ||
      ((e.ctrlKey || e.metaKey) && e.key === "y")) {
    e.preventDefault();
    if (typeof window.redoStroke === "function") window.redoStroke();
  }
});

window.addEventListener("resize", resize);
resize();