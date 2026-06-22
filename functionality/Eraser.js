// Eraser.js
// Eraser tool for deleting whole pen strokes by intersecting their outline polygons.
// Uses the same two-canvas architecture and stroke data stored in StrokeDataSaver.

// ---- Tool setup ----
var eraserBtn = document.getElementById("eraser");
var eraserSize = 20; // radius of the eraser in CSS pixels
var eraserColor = "rgba(200, 200, 220, 0.5)"; // visual feedback color

var isErasing = false;
var eraserPoints = []; // raw pointer points during the current erase gesture

// Last position where we checked for intersections (for distance optimization)
var lastCheckedPosition = null;
var MIN_ERASE_DISTANCE = 8; // minimum pixels of movement before re-checking intersections

// Shared StrokeSmoother instance for the eraser (created once, not per check)
var _eraserSmoother = null;

function getEraserSmoother() {
  if (!_eraserSmoother) {
    _eraserSmoother = new StrokeSmoother({
      size: eraserSize,
      thinning: 0,      // no pressure variation
      smoothing: 0.5,   // moderate smoothing
      streamline: 0.7,  // some streamlining
      startTaper: 0,
      endTaper: 0,
      cap: true
    });
  }
  return _eraserSmoother;
}

// ---- Tool activation ----
// Toggle eraser tool on/off (deactivates pen when active)
function activateEraser() {
  eraserBtn.classList.add("active");
  // Deactivate pen when eraser is active
  var penBtn = document.getElementById("pen");
  if (penBtn) penBtn.classList.remove("active");
  fgCanvas.style.cursor = "none"; // hide default cursor, we'll draw custom circle
}

function deactivateEraser() {
  eraserBtn.classList.remove("active");
  fgCanvas.style.cursor = "crosshair";
}

eraserBtn.addEventListener("click", function () {
  if (eraserBtn.classList.contains("active")) {
    deactivateEraser();
  } else {
    activateEraser();
  }
});

// ---- Pointer event handlers ----
fgCanvas.addEventListener("pointerdown", function (e) {
  if (!eraserBtn?.classList.contains("active")) return;
  isErasing = true;

  // Clear eraser points buffer
  eraserPoints = [];
  lastCheckedPosition = null;

  // Record first point with timestamp
  eraserPoints.push({
    x: e.offsetX,
    y: e.offsetY,
    pressure: e.pressure || 0.5,
    time: Date.now()
  });
});

fgCanvas.addEventListener("pointermove", function (e) {
  // If eraser tool is active but not currently pressing, show cursor preview
  if (eraserBtn?.classList.contains("active") && !isErasing) {
    // Draw a single-frame preview of the eraser circle on the foreground
    if (typeof window.redrawForeground === "function") window.redrawForeground();
    fgCtx.beginPath();
    fgCtx.arc(e.offsetX, e.offsetY, eraserSize / 2, 0, Math.PI * 2);
    fgCtx.strokeStyle = "rgba(180, 180, 200, 0.6)";
    fgCtx.lineWidth = 2;
    fgCtx.stroke();
    fgCtx.fillStyle = "rgba(180, 180, 200, 0.15)";
    fgCtx.fill();
    return;
  }

  if (!isErasing || !eraserBtn?.classList.contains("active")) return;

  // Record point with timestamp
  eraserPoints.push({
    x: e.offsetX,
    y: e.offsetY,
    pressure: e.pressure || 0.5,
    time: Date.now()
  });

  // Distance optimization: only check for intersections if we've moved enough
  var shouldCheckIntersection = false;
  if (lastCheckedPosition === null) {
    shouldCheckIntersection = true;
  } else {
    var dx = e.offsetX - lastCheckedPosition.x;
    var dy = e.offsetY - lastCheckedPosition.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= MIN_ERASE_DISTANCE) {
      shouldCheckIntersection = true;
    }
  }

  if (shouldCheckIntersection) {
    // Perform real-time erase using current accumulated path
    performErase();
    lastCheckedPosition = { x: e.offsetX, y: e.offsetY };
  }

  // Visual feedback: draw a single circle at the current cursor position
  if (typeof window.redrawForeground === "function") window.redrawForeground();
  fgCtx.beginPath();
  fgCtx.arc(e.offsetX, e.offsetY, eraserSize / 2, 0, Math.PI * 2);
  fgCtx.strokeStyle = "rgba(180, 180, 200, 0.6)";
  fgCtx.lineWidth = 2;
  fgCtx.stroke();
  fgCtx.fillStyle = "rgba(180, 180, 200, 0.15)";
  fgCtx.fill();
});

fgCanvas.addEventListener("pointerup", function () {
  if (isErasing && eraserBtn?.classList.contains("active")) {
    performErase();
  }
  isErasing = false;
  eraserPoints = [];
  lastCheckedPosition = null;
  // Redraw foreground to remove eraser visual feedback
  if (typeof window.redrawForeground === "function") window.redrawForeground();
});

fgCanvas.addEventListener("pointerleave", function () {
  if (isErasing && eraserBtn?.classList.contains("active")) {
    performErase();
  }
  isErasing = false;
  eraserPoints = [];
  lastCheckedPosition = null;
  if (typeof window.redrawForeground === "function") window.redrawForeground();
});

// ---- Erase logic: detect and remove intersecting strokes ----
function performErase() {
  if (eraserPoints.length < 2) return;

  // Build the eraser outline polygon using the shared smoother
  var pts = eraserPoints.map(function (p) {
    return { x: p.x, y: p.y, pressure: 1.0 };
  });

  var eraserSmoother = getEraserSmoother();
  var eraserOutline = eraserSmoother.smooth(pts);
  if (eraserOutline.length < 3) return;

  // Compute eraser bounding box for quick rejection
  var eBbox = computePolygonBbox(eraserOutline);

  // Check each stroke for intersection
  var strokes = strokeSaver.getStrokes();
  var toRemove = [];

  for (var i = 0; i < strokes.length; i++) {
    var st = strokes[i];
    if (!st.outlinePoints || st.outlinePoints.length < 3) continue;

    // Quick reject: bounding boxes don't overlap
    if (st.canvasBbox && !bboxOverlap(eBbox, st.canvasBbox)) continue;

    // Precise check: polygon-polygon intersection
    if (polygonsIntersect(eraserOutline, st.outlinePoints)) {
      toRemove.push(i);
    }
  }

  // Remove intersecting strokes and redraw
  if (toRemove.length > 0) {
    // Push undo before removing
    if (typeof window._undoStack !== "undefined") {
      window._redoStack = [];
      window._undoStack.push(JSON.parse(JSON.stringify(strokeSaver.getStrokes())));
      if (window._undoStack.length > 50) window._undoStack.shift();
    }
    strokeSaver.removeStrokes(toRemove);
    window.redrawAllStrokes();

    // Re-group lines and re-rasterize to reflect the removed strokes
    if (typeof IdentifyLine !== "undefined") {
      IdentifyLine.groupStrokesIntoLines();
    }
    if (typeof LinesRasterizer !== "undefined") {
      LinesRasterizer.clearCache();
      LinesRasterizer.rasterizeAllLines();
    }
  }
}

// ---- Geometry utilities ----

// Compute axis-aligned bounding box of a polygon
function computePolygonBbox(poly) {
  var xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (var i = 0; i < poly.length; i++) {
    var p = poly[i];
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  return { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax };
}

// Test if two axis-aligned bounding boxes overlap
function bboxOverlap(a, b) {
  return a.xMin <= b.xMax && a.xMax >= b.xMin &&
         a.yMin <= b.yMax && a.yMax >= b.yMin;
}

// Check if two line segments (p1->p2 and p3->p4) intersect (including endpoints)
function segmentsIntersect(p1, p2, p3, p4) {
  var d1x = p2.x - p1.x;
  var d1y = p2.y - p1.y;
  var d2x = p4.x - p3.x;
  var d2y = p4.y - p3.y;

  var cross = d1x * d2y - d1y * d2x;

  // If cross product is near zero, segments are parallel
  if (Math.abs(cross) < 1e-10) return false;

  var dx = p3.x - p1.x;
  var dy = p3.y - p1.y;

  var t = (dx * d2y - dy * d2x) / cross;
  var u = (dx * d1y - dy * d1x) / cross;

  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Test if a point is inside a polygon using ray casting
function pointInPolygon(point, poly) {
  var x = point.x, y = point.y;
  var inside = false;

  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i].x, yi = poly[i].y;
    var xj = poly[j].x, yj = poly[j].y;

    var intersect = ((yi > y) !== (yj > y)) &&
                    (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }

  return inside;
}

// Check if two polygons intersect (edge crossing OR containment)
function polygonsIntersect(polyA, polyB) {
  // Test every edge of polyA against every edge of polyB
  for (var i = 0; i < polyA.length; i++) {
    var a1 = polyA[i];
    var a2 = polyA[(i + 1) % polyA.length];

    for (var j = 0; j < polyB.length; j++) {
      var b1 = polyB[j];
      var b2 = polyB[(j + 1) % polyB.length];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  // If no edges cross, check if any vertex of one polygon is inside the other
  // (handles one polygon fully contained within the other)
  for (var k = 0; k < polyA.length; k++) {
    if (pointInPolygon(polyA[k], polyB)) {
      return true;
    }
  }

  for (var k = 0; k < polyB.length; k++) {
    if (pointInPolygon(polyB[k], polyA)) {
      return true;
    }
  }

  return false;
}

// ---- Keyboard shortcut ----
document.addEventListener("keydown", function (e) {
  // Guard: require plain 'e' press (no Shift, Ctrl, Meta, Alt)
  if (e.key === "e" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    var tag = document.activeElement?.tagName || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (eraserBtn?.classList.contains("active")) {
      deactivateEraser();
    } else {
      activateEraser();
    }
  }
});
