// IdentifyLine.js - Groups strokes into lines based on dynamic catchment zones
// Produces loose expanded-box groups and stricter vertical-overlap groups.

var IdentifyLine = (function () {
  var STRICT_MIN_VERTICAL_OVERLAP_RATIO = 0.15;

  // Current line groups
  var _lineGroups = [];
  var _lineCandidates = [];
  var _linePartitions = { loose: [], strict: [] };

  // Track if line boxes should be visible
  var _showBoxes = false;
  var _active = true;

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
        if (!_active) return;
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
   *   - Horizontal: ±35% of width
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
    var hPad = width * 0.35;
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

  function verticalOverlapRatio(a, b) {
    if (!a || !b) return 0;
    var overlap = Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin));
    var smallerHeight = Math.min(a.yMax - a.yMin, b.yMax - b.yMin);
    return smallerHeight > 0 ? overlap / smallerHeight : 0;
  }

  function groupsCanMerge(a, b, profile) {
    if (!bboxesOverlap(a.expandedBbox, b.expandedBbox)) return false;
    if (profile === 'strict') {
      return verticalOverlapRatio(a.tightBbox, b.tightBbox) >=
        STRICT_MIN_VERTICAL_OVERLAP_RATIO;
    }
    return true;
  }

  function strokeSetKey(strokes) {
    var ids = [];
    for (var i = 0; i < strokes.length; i++) {
      ids.push(String(strokes[i].id));
    }
    ids.sort();
    return ids.join('|');
  }

  function finalizeGroups(groups, allStrokes, profile) {
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var idSet = {};
      for (var s = 0; s < group.strokes.length; s++) {
        idSet[group.strokes[s].id] = true;
      }

      var ordered = [];
      for (var t = 0; t < allStrokes.length; t++) {
        if (idSet[allStrokes[t].id]) ordered.push(allStrokes[t]);
      }
      group.strokes = ordered;
      group.profile = profile;
      group.strokeIds = ordered.map(function (stroke) { return String(stroke.id); });
      group.strokeSetKey = strokeSetKey(ordered);
      group.id = profile + '_' + group.strokeSetKey;
      group.expandedBbox = computeExpandedBbox(group.strokes);
      group.tightBbox = computeTightBbox(group.strokes);
    }
    return groups;
  }

  function buildGroups(allStrokes, profile) {
    var groups = [];
    for (var i = 0; i < allStrokes.length; i++) {
      var stroke = allStrokes[i];
      if (!stroke.canvasBbox) continue;
      groups.push({
        strokes: [stroke],
        expandedBbox: computeExpandedBbox([stroke]),
        tightBbox: computeTightBbox([stroke])
      });
    }

    var merged = true;
    while (merged) {
      merged = false;
      for (var a = 0; a < groups.length; a++) {
        for (var b = a + 1; b < groups.length; b++) {
          if (groupsCanMerge(groups[a], groups[b], profile)) {
            groups[a].strokes = groups[a].strokes.concat(groups[b].strokes);
            groups[a].expandedBbox = computeExpandedBbox(groups[a].strokes);
            groups[a].tightBbox = computeTightBbox(groups[a].strokes);
            groups.splice(b, 1);
            merged = true;
            a = groups.length;
            break;
          }
        }
      }
    }
    return finalizeGroups(groups, allStrokes, profile);
  }

  function buildCandidateSet(looseGroups, strictGroups) {
    var byStrokeSet = {};
    var candidates = [];
    var partitions = { loose: [], strict: [] };

    function addGroup(group, profile) {
      var key = group.strokeSetKey;
      var candidate = byStrokeSet[key];
      if (!candidate) {
        candidate = {
          id: 'candidate_' + key,
          candidateId: 'candidate_' + key,
          strokeSetKey: key,
          strokeIds: group.strokeIds.slice(),
          strokes: group.strokes,
          tightBbox: group.tightBbox,
          expandedBbox: group.expandedBbox,
          profiles: [],
          conflicts: []
        };
        byStrokeSet[key] = candidate;
        candidates.push(candidate);
      }
      if (candidate.profiles.indexOf(profile) === -1) candidate.profiles.push(profile);
      partitions[profile].push(candidate.candidateId);
    }

    for (var i = 0; i < looseGroups.length; i++) addGroup(looseGroups[i], 'loose');
    for (var j = 0; j < strictGroups.length; j++) addGroup(strictGroups[j], 'strict');

    for (var a = 0; a < candidates.length; a++) {
      var strokeLookup = {};
      for (var s = 0; s < candidates[a].strokeIds.length; s++) {
        strokeLookup[candidates[a].strokeIds[s]] = true;
      }
      for (var b = a + 1; b < candidates.length; b++) {
        var conflicts = false;
        for (var k = 0; k < candidates[b].strokeIds.length; k++) {
          if (strokeLookup[candidates[b].strokeIds[k]]) {
            conflicts = true;
            break;
          }
        }
        if (conflicts) {
          candidates[a].conflicts.push(candidates[b].candidateId);
          candidates[b].conflicts.push(candidates[a].candidateId);
        }
      }
    }

    _lineCandidates = candidates;
    _linePartitions = partitions;
  }

  /**
   * Build both complete grouping views, then expose their deduplicated union as
   * recognition candidates. The loose groups remain the legacy display groups.
   */
  function groupStrokesIntoLines() {
    var allStrokes = strokeSaver.getStrokes();
    if (!allStrokes || allStrokes.length === 0) {
      _lineGroups = [];
      _lineCandidates = [];
      _linePartitions = { loose: [], strict: [] };
      return _lineGroups;
    }

    var looseGroups = buildGroups(allStrokes, 'loose');
    var strictGroups = buildGroups(allStrokes, 'strict');
    _lineGroups = looseGroups;
    buildCandidateSet(looseGroups, strictGroups);

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
    if (!_active) return;
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

  function getLineCandidates() {
    return _lineCandidates;
  }

  function getLinePartitions() {
    return {
      loose: _linePartitions.loose.slice(),
      strict: _linePartitions.strict.slice()
    };
  }

  function setStrictMinVerticalOverlapRatio(value) {
    var parsed = Number(value);
    if (!isFinite(parsed) || parsed < 0 || parsed > 1) return;
    STRICT_MIN_VERTICAL_OVERLAP_RATIO = parsed;
    if (typeof strokeSaver !== 'undefined') groupStrokesIntoLines();
  }

  function getStrictMinVerticalOverlapRatio() {
    return STRICT_MIN_VERTICAL_OVERLAP_RATIO;
  }

  function setActive(active) {
    _active = !!active;
    if (boxCanvas) boxCanvas.style.display = _active ? 'block' : 'none';
    if (!_active && boxCtx) boxCtx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
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
    getLineCandidates: getLineCandidates,
    getLinePartitions: getLinePartitions,
    setStrictMinVerticalOverlapRatio: setStrictMinVerticalOverlapRatio,
    getStrictMinVerticalOverlapRatio: getStrictMinVerticalOverlapRatio,
    setActive: setActive,
    getLinesForRecognition: getLinesForRecognition,
    computeExpandedBbox: computeExpandedBbox,
    verticalOverlapRatio: verticalOverlapRatio
  };
})();

// Stable reference used when runtime configuration switches segmentation modes.
var IdentifyLineGeometric = IdentifyLine;
