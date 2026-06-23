// IdentifyLine.js - Groups strokes into lines based on dynamic catchment zones
// Uses proportional expansion: ±50% width horizontally, ±10% height vertically

var IdentifyLine = (function () {
  // Current line groups
  var _lineGroups = [];

  // Track if line boxes should be visible
  var _showBoxes = false;

  // Temporary box overlay canvas (separate layer to avoid redrawing strokes)
  var boxCanvas = null;
  var boxCtx = null;

  function init() {
    // Create overlay canvas for line boxes
    boxCanvas = document.createElement('canvas');
    boxCanvas.style.position = 'absolute';
    boxCanvas.style.top = '0';
    boxCanvas.style.left = '0';
    boxCanvas.style.pointerEvents = 'none';
    boxCanvas.style.zIndex = '10';

    var container = document.querySelector('.canvas-container');
    if (container) {
      container.appendChild(boxCanvas);
      boxCtx = boxCanvas.getContext('2d');
      resizeBoxCanvas();
    }

    // Listen for 'b' key to toggle line boxes
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var tag = document.activeElement?.tagName || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        toggleBoxes();
      }
    });

    window.addEventListener('resize', function () {
      resizeBoxCanvas();
    });
  }

  function resizeBoxCanvas() {
    if (!boxCanvas) return;
    var container = document.querySelector('.canvas-container');
    if (!container) return;
    boxCanvas.width = container.clientWidth;
    boxCanvas.height = container.clientHeight;
    // Redraw boxes if visible
    if (_showBoxes && _lineGroups.length > 0) {
      drawLineBoxes();
    }
  }

  /**
   * Compute the expanded bbox for a set of strokes.
   * Expansion is proportional to the combined bounding box of those strokes:
   *   - Horizontal: ±50% of width
   *   - Vertical: ±10% of height
   */
  function computeExpandedBbox(strokes) {
    if (!strokes || strokes.length === 0) return null;

    var xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (var i = 0; i < strokes.length; i++) {
      var bbox = strokes[i].canvasBbox;
      if (!bbox) continue;
      if (bbox.xMin < xMin) xMin = bbox.xMin;
      if (bbox.yMin < yMin) yMin = bbox.yMin;
      if (bbox.xMax > xMax) xMax = bbox.xMax;
      if (bbox.yMax > yMax) yMax = bbox.yMax;
    }

    var width = xMax - xMin;
    var height = yMax - yMin;

    // Proportional catchment zones
    var hPad = width * 0.5;
    var vPad = Math.max(height * 0.10, 10); // minimum 10px vertical padding for visibility

    return {
      xMin: xMin - hPad,
      yMin: yMin - vPad,
      xMax: xMax + hPad,
      yMax: yMax + vPad
    };
  }

  /**
   * Check if two expanded bboxes overlap.
   */
  function bboxesOverlap(a, b) {
    if (!a || !b) return false;
    return !(a.xMax < b.xMin || a.xMin > b.xMax || a.yMax < b.yMin || a.yMin > b.yMax);
  }

  /**
   * Main grouping algorithm:
   * Start each stroke in its own group, then iteratively merge any two groups
   * whose expanded catchment zones overlap. This handles forwards, backwards,
   * and bridge (transitive) merges: a new stroke that overlaps two previously
   * separate groups will fuse them all into one line.
   */
  function groupStrokesIntoLines() {
    var allStrokes = strokeSaver.getStrokes();
    if (!allStrokes || allStrokes.length === 0) {
      _lineGroups = [];
      return _lineGroups;
    }

    // Seed one group per stroke (skip strokes without canvasBbox)
    _lineGroups = [];
    for (var i = 0; i < allStrokes.length; i++) {
      var stroke = allStrokes[i];
      if (!stroke.canvasBbox) continue;
      _lineGroups.push({
        strokes: [stroke],
        expandedBbox: computeExpandedBbox([stroke]),
        tightBbox: computeTightBbox([stroke])
      });
    }

    // Iteratively merge any overlapping groups until stable
    var merged = true;
    while (merged) {
      merged = false;
      for (var a = 0; a < _lineGroups.length; a++) {
        for (var b = a + 1; b < _lineGroups.length; b++) {
          if (bboxesOverlap(_lineGroups[a].expandedBbox, _lineGroups[b].expandedBbox)) {
            // Merge group b into group a
            _lineGroups[a].strokes = _lineGroups[a].strokes.concat(_lineGroups[b].strokes);
            // Recompute bboxes for the merged group (catchment zone may now be larger)
            _lineGroups[a].expandedBbox = computeExpandedBbox(_lineGroups[a].strokes);
            _lineGroups[a].tightBbox = computeTightBbox(_lineGroups[a].strokes);
            // Remove group b
            _lineGroups.splice(b, 1);
            merged = true;
            // Restart scan: the enlarged catchment may overlap a third group
            a = _lineGroups.length; // break outer loop
            break;
          }
        }
      }
    }

    // Rebuild stroke arrays in temporal order and assign final ids/bboxes
    for (var g = 0; g < _lineGroups.length; g++) {
      var group = _lineGroups[g];
      // Build a set of stroke ids in this group for O(1) lookup
      var idSet = {};
      for (var s = 0; s < group.strokes.length; s++) {
        idSet[group.strokes[s].id] = true;
      }
      // Rebuild in temporal order from allStrokes
      var ordered = [];
      for (var t = 0; t < allStrokes.length; t++) {
        if (idSet[allStrokes[t].id]) {
          ordered.push(allStrokes[t]);
        }
      }
      group.strokes = ordered;
      group.id = 'line_' + g;
      group.expandedBbox = computeExpandedBbox(group.strokes);
      group.tightBbox = computeTightBbox(group.strokes);
    }

    return _lineGroups;
  }

  /**
   * Compute tight (non-expanded) bbox from strokes.
   */
  function computeTightBbox(strokes) {
    if (!strokes || strokes.length === 0) return null;
    var xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (var i = 0; i < strokes.length; i++) {
      var bbox = strokes[i].canvasBbox;
      if (!bbox) continue;
      if (bbox.xMin < xMin) xMin = bbox.xMin;
      if (bbox.yMin < yMin) yMin = bbox.yMin;
      if (bbox.xMax > xMax) xMax = bbox.xMax;
      if (bbox.yMax > yMax) yMax = bbox.yMax;
    }
    return { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax };
  }

  /**
   * Draw dashed bounding boxes around each detected line group.
   */
  function drawLineBoxes() {
    if (!boxCtx || _lineGroups.length === 0) return;

    // Clear box canvas
    boxCtx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);

    for (var i = 0; i < _lineGroups.length; i++) {
      var group = _lineGroups[i];
      if (!group.tightBbox) continue;

      var b = group.tightBbox;
      var x = Math.max(0, Math.round(b.xMin));
      var y = Math.max(0, Math.round(b.yMin));
      var w = Math.round(b.xMax - b.xMin);
      var h = Math.round(b.yMax - b.yMin);

      // Skip if bbox is too small to draw meaningfully
      if (w < 2 || h < 2) continue;

      // Draw tight bbox box in green
      boxCtx.strokeStyle = 'rgba(0, 180, 0, 0.7)';
      boxCtx.lineWidth = 1.5;
      boxCtx.setLineDash([6, 4]);
      boxCtx.strokeRect(x, y, w, h);

      // Draw expanded catchment zone in blue (behind tight bbox)
      if (group.expandedBbox) {
        var e = group.expandedBbox;
        var ex = Math.max(0, Math.round(e.xMin));
        var ey = Math.max(0, Math.round(e.yMin));
        var ew = Math.round(e.xMax - e.xMin);
        var eh = Math.round(e.yMax - e.yMin);

        boxCtx.strokeStyle = 'rgba(30, 120, 255, 0.25)';
        boxCtx.lineWidth = 1;
        boxCtx.setLineDash([3, 6]);
        boxCtx.strokeRect(ex, ey, ew, eh);

        // Fill catchment zone with subtle color
        boxCtx.fillStyle = 'rgba(30, 120, 255, 0.04)';
        boxCtx.fillRect(ex, ey, ew, eh);
      }
    }

    boxCtx.setLineDash([]);
  }

  /**
   * Toggle visibility of line boxes.
   */
  function toggleBoxes() {
    _showBoxes = !_showBoxes;
    if (_showBoxes) {
      // Group strokes first if not already done
      groupStrokesIntoLines();
      drawLineBoxes();
      showToast('Line boxes shown (press B to hide)');
    } else {
      if (boxCtx) boxCtx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
      showToast('Line boxes hidden');
    }
  }

  /**
   * Finalize: re-group strokes after a new stroke ends.
   */
  function finalizeStroke() {
    _lineGroups = groupStrokesIntoLines();

    if (_showBoxes) {
      drawLineBoxes();
    }

    return _lineGroups;
  }

  /**
   * Get current line groups.
   */
  function getLineGroups() {
    return _lineGroups;
  }

  /**
   * Get lines for recognition: array of {lineIndex, strokes}.
   */
  function getLinesForRecognition() {
    var lines = groupStrokesIntoLines();
    var result = [];
    for (var i = 0; i < lines.length; i++) {
      result.push({
        lineIndex: i,
        strokes: lines[i].strokes.map(function (s) { return s.rawPoints; })
      });
    }
    return result;
  }

  /**
   * Simple toast notification.
   */
  function showToast(msg) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(function () {
      toast.style.display = 'none';
    }, 1500);
  }

  // Initialize on DOM load
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    groupStrokesIntoLines: groupStrokesIntoLines,
    finalizeStroke: finalizeStroke,
    drawLineBoxes: drawLineBoxes,
    toggleBoxes: toggleBoxes,
    getLineGroups: getLineGroups,
    getLinesForRecognition: getLinesForRecognition,
    computeExpandedBbox: computeExpandedBbox
  };
})();