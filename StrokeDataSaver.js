// StrokeDataSaver.js - Plain JS version for browser
// Saves pen stroke data with normalized coordinates and metadata
// Central repository for all stroke data, including renderable outline geometry

class StrokeDataSaver {
  constructor() {
    this.strokes = [];
    this.currentStroke = null;
    this.strokeCounter = 0;
    this.strokeStartTimes = new Map();
  }

  // Begin a new stroke
  startStroke(rawX, rawY, pressure, canvasWidth, canvasHeight) {
    var id = 'stroke_' + (++this.strokeCounter) + '_' + Date.now();
    var now = Date.now();

    this.currentStroke = {
      id: id,
      points: [{
        x: Math.max(0, Math.min(1, rawX / canvasWidth)),
        y: Math.max(0, Math.min(1, rawY / canvasHeight)),
        t: 0,
        pressure: pressure || 0.5
      }],
      startTime: now,
      rawPoints: [{ x: rawX, y: rawY, pressure: pressure || 0.5 }],
      outlinePoints: null,
      color: null
    };

    return id;
  }

  // Add a point to the current stroke
  addPoint(rawX, rawY, pressure, canvasWidth, canvasHeight) {
    if (!this.currentStroke) return;

    this.currentStroke.points.push({
      x: Math.max(0, Math.min(1, rawX / canvasWidth)),
      y: Math.max(0, Math.min(1, rawY / canvasHeight)),
      t: Date.now() - this.currentStroke.startTime,
      pressure: pressure || 0.5
    });

    this.currentStroke.rawPoints.push({
      x: rawX,
      y: rawY,
      pressure: pressure || 0.5
    });
  }

  // Finalize the current stroke: compute bbox, store outline and color
  endStroke(outline, color) {
    if (!this.currentStroke || this.currentStroke.points.length === 0) {
      this.currentStroke = null;
      return null;
    }

    // Store the outline polygon (canvas-coordinate points) and color for rendering
    this.currentStroke.outlinePoints = outline || null;
    this.currentStroke.color = color || '#000000';

    // Store the start time for future dt computation
    this.strokeStartTimes.set(this.currentStroke.id, this.currentStroke.startTime);

    var pts = this.currentStroke.points;

    // Compute bounding box from normalized points
    var xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < xMin) xMin = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.x > xMax) xMax = p.x;
      if (p.y > yMax) yMax = p.y;
    }
    var bbox = { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax };

    // Compute canvas-coordinate bounding box from outline points (for intersection tests)
    var canvasBbox = null;
    if (outline && outline.length > 0) {
      var cxMin = Infinity, cyMin = Infinity, cxMax = -Infinity, cyMax = -Infinity;
      for (var j = 0; j < outline.length; j++) {
        var op = outline[j];
        if (op.x < cxMin) cxMin = op.x;
        if (op.y < cyMin) cyMin = op.y;
        if (op.x > cxMax) cxMax = op.x;
        if (op.y > cyMax) cyMax = op.y;
      }
      canvasBbox = { xMin: cxMin, yMin: cyMin, xMax: cxMax, yMax: cyMax };
    }

    // Compute relations to the previous stroke (if any)
    var prev = this.strokes.length > 0 ? this.strokes[this.strokes.length - 1] : null;
    var relationsToPrev = prev
      ? this.computeRelations(bbox, this.currentStroke.startTime, prev)
      : { dx: 0, dy: 0, dt: 0, overlapRatio: 0 };

    var group = {
      id: this.currentStroke.id,
      points: pts,
      rawPoints: this.currentStroke.rawPoints,
      outlinePoints: this.currentStroke.outlinePoints,
      color: this.currentStroke.color,
      canvasBbox: canvasBbox,
      bbox: bbox,
      relationsToPrev: relationsToPrev
    };

    this.strokes.push(group);
    this.currentStroke = null;
    return group;
  }

  // Remove strokes at the given indices (sorts descending to avoid index shifting)
  removeStrokes(indices) {
    if (!indices || indices.length === 0) return [];

    // Sort indices descending so we splice from the end
    var sorted = indices.slice().sort(function (a, b) { return b - a; });
    var removed = [];

    for (var i = 0; i < sorted.length; i++) {
      var idx = sorted[i];
      if (idx >= 0 && idx < this.strokes.length) {
        removed.push(this.strokes.splice(idx, 1)[0]);
      }
    }

    return removed;
  }

  // Get all saved strokes
  getStrokes() {
    return this.strokes;
  }

  // Get the number of stored strokes
  getStrokeCount() {
    return this.strokes.length;
  }

  // Clear all saved strokes
  clear() {
    this.strokes = [];
    this.currentStroke = null;
    this.strokeCounter = 0;
    this.strokeStartTimes.clear();
  }

  // Log all stroke data nicely to the console
  debugLog() {
    console.log('=== Stroke Data Dump ===');
    console.log('Total strokes: ' + this.strokes.length);
    for (var s = 0; s < this.strokes.length; s++) {
      var st = this.strokes[s];
      console.group('Stroke: ' + st.id);
      console.log('Points: ' + st.points.length);
      console.log('Color: ' + st.color);
      console.log('BBox: [' +
        st.bbox.xMin.toFixed(3) + ', ' + st.bbox.yMin.toFixed(3) + '] \u2192 [' +
        st.bbox.xMax.toFixed(3) + ', ' + st.bbox.yMax.toFixed(3) + ']');
      console.log('Canvas BBox: [' +
        (st.canvasBbox ? st.canvasBbox.xMin.toFixed(1) : '?') + ', ' +
        (st.canvasBbox ? st.canvasBbox.yMin.toFixed(1) : '?') + '] \u2192 [' +
        (st.canvasBbox ? st.canvasBbox.xMax.toFixed(1) : '?') + ', ' +
        (st.canvasBbox ? st.canvasBbox.yMax.toFixed(1) : '?') + ']');
      console.log('Relations to prev: dx=' + st.relationsToPrev.dx.toFixed(4) +
        ', dy=' + st.relationsToPrev.dy.toFixed(4) +
        ', dt=' + st.relationsToPrev.dt + 'ms' +
        ', overlap=' + st.relationsToPrev.overlapRatio.toFixed(4));
      var pointsStr = '';
      for (var p = 0; p < st.points.length; p++) {
        var pt = st.points[p];
        pointsStr += '(' + pt.x.toFixed(3) + ',' + pt.y.toFixed(3) +
          ',t=' + pt.t + ',p=' + pt.pressure.toFixed(2) + ') ';
      }
      console.log('Points: ' + pointsStr);
      console.groupEnd();
    }
    console.log('=== End Stroke Data ===');
  }

  // Compute relations between current and previous stroke
  computeRelations(currBbox, currStartTime, prev) {
    var cx = (currBbox.xMin + currBbox.xMax) / 2;
    var cy = (currBbox.yMin + currBbox.yMax) / 2;
    var px = (prev.bbox.xMin + prev.bbox.xMax) / 2;
    var py = (prev.bbox.yMin + prev.bbox.yMax) / 2;

    var dx = cx - px;
    var dy = cy - py;

    var prevStartTime = this.strokeStartTimes.get(prev.id);
    var dt = prevStartTime !== undefined ? currStartTime - prevStartTime : 0;

    var overlapRatio = this.computeIoU(currBbox, prev.bbox);

    return { dx: dx, dy: dy, dt: dt, overlapRatio: overlapRatio };
  }

  // Compute Intersection over Union of two bounding boxes
  computeIoU(a, b) {
    var xMin = Math.max(a.xMin, b.xMin);
    var yMin = Math.max(a.yMin, b.yMin);
    var xMax = Math.min(a.xMax, b.xMax);
    var yMax = Math.min(a.yMax, b.yMax);

    var interW = Math.max(0, xMax - xMin);
    var interH = Math.max(0, yMax - yMin);
    var inter = interW * interH;

    var areaA = (a.xMax - a.xMin) * (a.yMax - a.yMin);
    var areaB = (b.xMax - b.xMin) * (b.yMax - b.yMin);
    var union = areaA + areaB - inter;

    return union > 0 ? inter / union : 0;
  }
}