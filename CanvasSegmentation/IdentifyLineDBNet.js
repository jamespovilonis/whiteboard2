// IdentifyLineDBNet.js
// Pause-based stroke batching, fixed catchment-zone merging, and DBNet splitting.

var IdentifyLineDBNet = (function () {
  var _config = {
    idleDelayMs: 1000,
    horizontalPadding: 50,
    verticalPadding: 10,
    requestTimeoutMs: 10000,
    minVerticalOverlapRatio: 0.25
  };
  var _serverUrl = "";
  var _lineGroups = [];
  var _lineCandidates = [];
  var _showBoxes = false;
  var _active = false;
  var _resultCache = {};
  var _activeFlush = null;
  var _version = 0;
  var boxCanvas = null;
  var boxCtx = null;

  function configure(options) {
    options = options || {};
    Object.keys(_config).forEach(function (key) {
      if (options[key] !== undefined) _config[key] = Number(options[key]);
    });
    if (options.apiUrl !== undefined) setServerUrl(options.apiUrl);
    groupStrokesIntoLines();
    return getConfig();
  }

  function setActive(active) {
    _active = !!active;
    if (boxCanvas) boxCanvas.style.display = _active ? "block" : "none";
    if (!_active && boxCtx) boxCtx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
  }

  function getConfig() {
    return Object.assign({}, _config, { apiUrl: _serverUrl });
  }

  function setServerUrl(url) {
    var next = url || "";
    if (_serverUrl !== next) {
      _serverUrl = next.replace(/\/$/, "");
      _resultCache = {};
    }
  }

  function computeTightBbox(strokes) {
    if (!strokes || strokes.length === 0) return null;
    var xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (var i = 0; i < strokes.length; i++) {
      var box = strokes[i].canvasBbox;
      if (!box) continue;
      xMin = Math.min(xMin, box.xMin);
      yMin = Math.min(yMin, box.yMin);
      xMax = Math.max(xMax, box.xMax);
      yMax = Math.max(yMax, box.yMax);
    }
    if (!isFinite(xMin)) return null;
    return { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax };
  }

  function computeExpandedBbox(strokes) {
    var box = computeTightBbox(strokes);
    if (!box) return null;
    // A fixed 10px vertical zone is too small when a student pauses after a
    // numerator and adds the fraction bar/denominator later. Scale with the
    // current ink height while keeping the configured value as the floor.
    var inkHeight = Math.max(1, box.yMax - box.yMin);
    var verticalPadding = Math.max(
      _config.verticalPadding,
      Math.min(40, inkHeight * 0.5)
    );
    return {
      xMin: box.xMin - _config.horizontalPadding,
      yMin: box.yMin - verticalPadding,
      xMax: box.xMax + _config.horizontalPadding,
      yMax: box.yMax + verticalPadding
    };
  }

  function bboxesOverlap(a, b) {
    return !!a && !!b && a.xMin <= b.xMax && a.xMax >= b.xMin &&
      a.yMin <= b.yMax && a.yMax >= b.yMin;
  }

  function strokeTime(stroke, index) {
    if (typeof strokeSaver !== "undefined" && strokeSaver.strokeStartTimes) {
      var saved = strokeSaver.strokeStartTimes.get(stroke.id);
      if (saved !== undefined) return saved;
    }
    // Stable fallback for imported/test strokes without timing metadata.
    return index * Math.max(1, _config.idleDelayMs);
  }

  function buildTemporalBatches(strokes) {
    var batches = [];
    var current = null;
    var previousEndTime = null;
    for (var i = 0; i < strokes.length; i++) {
      if (!strokes[i].canvasBbox) continue;
      var startTime = strokes[i].startTime !== undefined ? strokes[i].startTime : strokeTime(strokes[i], i);
      if (!current || previousEndTime === null || startTime - previousEndTime > _config.idleDelayMs) {
        current = { strokes: [] };
        batches.push(current);
      }
      current.strokes.push(strokes[i]);
      previousEndTime = strokes[i].endTime !== undefined ? strokes[i].endTime : startTime;
    }
    return batches;
  }

  function boxesCanMerge(a, b) {
    var tightA = computeTightBbox(a.strokes);
    var tightB = computeTightBbox(b.strokes);
    var catchA = computeExpandedBbox(a.strokes);
    var catchB = computeExpandedBbox(b.strokes);
    return bboxesOverlap(tightA, catchB) || bboxesOverlap(tightB, catchA);
  }

  function mergeCatchmentBatches(batches) {
    var groups = batches.map(function (batch) { return { strokes: batch.strokes.slice() }; });
    var changed = true;
    while (changed) {
      changed = false;
      outer: for (var i = 0; i < groups.length; i++) {
        for (var j = i + 1; j < groups.length; j++) {
          if (boxesCanMerge(groups[i], groups[j])) {
            groups[i].strokes = groups[i].strokes.concat(groups[j].strokes);
            groups.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
    return groups;
  }

  function strokeSetKey(strokes) {
    return strokes.map(function (stroke) { return String(stroke.id); }).sort().join("|");
  }

  function candidateFromStrokes(strokes, suffix, profile) {
    var key = strokeSetKey(strokes);
    var id = "dbnet_" + key + (suffix || "");
    var groupingProfile = profile || "dbnet";
    return {
      id: id,
      candidateId: id,
      profile: groupingProfile,
      profiles: [groupingProfile],
      strokes: strokes,
      strokeIds: strokes.map(function (stroke) { return String(stroke.id); }),
      strokeSetKey: key,
      tightBbox: computeTightBbox(strokes),
      expandedBbox: computeExpandedBbox(strokes),
      conflicts: []
    };
  }

  function candidateCacheKey(candidate) {
    var b = candidate.tightBbox;
    return candidate.strokeSetKey + "::" + [b.xMin, b.yMin, b.xMax, b.yMax].map(function (n) {
      return Math.round(n * 10) / 10;
    }).join(",");
  }

  function verticalOverlapRatio(a, b) {
    if (!a || !b) return 0;
    var overlap = Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin));
    var smaller = Math.min(a.yMax - a.yMin, b.yMax - b.yMin);
    return smaller > 0 ? overlap / smaller : 0;
  }

  function clusterDetections(detections) {
    var bands = (detections || []).filter(function (item) {
      return item && item.bbox && item.bbox.yMax > item.bbox.yMin;
    }).map(function (item) {
      return { bbox: Object.assign({}, item.bbox), detections: [item] };
    }).sort(function (a, b) { return a.bbox.yMin - b.bbox.yMin; });

    var changed = true;
    while (changed) {
      changed = false;
      outer: for (var i = 0; i < bands.length; i++) {
        for (var j = i + 1; j < bands.length; j++) {
          if (verticalOverlapRatio(bands[i].bbox, bands[j].bbox) >= _config.minVerticalOverlapRatio) {
            var a = bands[i].bbox, b = bands[j].bbox;
            bands[i].bbox = {
              xMin: Math.min(a.xMin, b.xMin), yMin: Math.min(a.yMin, b.yMin),
              xMax: Math.max(a.xMax, b.xMax), yMax: Math.max(a.yMax, b.yMax)
            };
            bands[i].detections = bands[i].detections.concat(bands[j].detections);
            bands.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
    return bands.sort(function (a, b) { return a.bbox.yMin - b.bbox.yMin; });
  }

  function splitCandidate(candidate, detections) {
    var bands = chooseLineBands(candidate, clusterDetections(detections));
    if (bands.length <= 1) return [candidate];
    if (containsFractionBridge(candidate, bands)) return [candidate];

    var assigned = bands.map(function () { return []; });
    for (var s = 0; s < candidate.strokes.length; s++) {
      var stroke = candidate.strokes[s];
      var box = stroke.canvasBbox;
      var bestIndex = 0;
      var bestOverlap = -1;
      var bestDistance = Infinity;
      var centerY = (box.yMin + box.yMax) / 2;
      for (var b = 0; b < bands.length; b++) {
        var band = bands[b].bbox;
        var overlap = Math.max(0, Math.min(box.yMax, band.yMax) - Math.max(box.yMin, band.yMin));
        var distance = Math.abs(centerY - (band.yMin + band.yMax) / 2);
        if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
          bestIndex = b;
          bestOverlap = overlap;
          bestDistance = distance;
        }
      }
      assigned[bestIndex].push(stroke);
    }

    var lines = [];
    for (var i = 0; i < assigned.length; i++) {
      // Identity follows ink membership, not DBNet's current band index. An
      // unchanged line therefore keeps its candidateId when a nearby line is
      // added and the enclosing candidate is re-segmented.
      if (assigned[i].length > 0) {
        lines.push(candidateFromStrokes(assigned[i], "", "dbnet-line"));
      }
    }
    if (lines.length <= 1) return [candidate];
    return lines.sort(function (a, b) { return a.tightBbox.yMin - b.tightBbox.yMin; });
  }

  function horizontalOverlapRatio(a, b) {
    var overlap = Math.max(0, Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin));
    var smallerWidth = Math.min(a.xMax - a.xMin, b.xMax - b.xMin);
    return smallerWidth > 0 ? overlap / smallerWidth : 0;
  }

  function bboxUnion(a, b) {
    return {
      xMin: Math.min(a.xMin, b.xMin), yMin: Math.min(a.yMin, b.yMin),
      xMax: Math.max(a.xMax, b.xMax), yMax: Math.max(a.yMax, b.yMax)
    };
  }

  /**
   * DBNet occasionally joins tightly spaced algebra rows. Vector strokes give
   * us a second, resolution-independent signal: real rows have clustered Y
   * centers and meaningful horizontal extent. This refinement is used only
   * when it finds more credible rows than DBNet.
   */
  function clusterStrokeRows(candidate) {
    var strokes = (candidate.strokes || []).filter(function (stroke) {
      return stroke && stroke.canvasBbox;
    });
    if (strokes.length === 0) return [];
    var heights = strokes.map(function (stroke) {
      return Math.max(1, stroke.canvasBbox.yMax - stroke.canvasBbox.yMin);
    }).sort(function (a, b) { return a - b; });
    var medianHeight = heights[Math.floor(heights.length / 2)];
    var centerThreshold = Math.max(8, medianHeight * 0.8);
    var rows = [];

    strokes.slice().sort(function (a, b) {
      return (a.canvasBbox.yMin + a.canvasBbox.yMax) -
        (b.canvasBbox.yMin + b.canvasBbox.yMax);
    }).forEach(function (stroke) {
      var box = stroke.canvasBbox;
      var center = (box.yMin + box.yMax) / 2;
      var best = null;
      var bestDistance = Infinity;
      for (var i = 0; i < rows.length; i++) {
        var rowCenter = (rows[i].bbox.yMin + rows[i].bbox.yMax) / 2;
        var distance = Math.abs(center - rowCenter);
        if ((verticalOverlapRatio(box, rows[i].bbox) >= 0.15 || distance <= centerThreshold) &&
            distance < bestDistance) {
          best = rows[i];
          bestDistance = distance;
        }
      }
      if (best) {
        best.bbox = bboxUnion(best.bbox, box);
        best.strokes.push(stroke);
      } else {
        rows.push({ bbox: Object.assign({}, box), strokes: [stroke], detections: [] });
      }
    });

    rows.sort(function (a, b) { return a.bbox.yMin - b.bbox.yMin; });
    var maxWidth = rows.reduce(function (value, row) {
      return Math.max(value, row.bbox.xMax - row.bbox.xMin);
    }, 1);
    return rows.filter(function (row) {
      var width = row.bbox.xMax - row.bbox.xMin;
      return row.strokes.length >= 3 ||
        (row.strokes.length >= 2 && width >= maxWidth * 0.28);
    });
  }

  function chooseLineBands(candidate, detectedBands) {
    var strokeRows = clusterStrokeRows(candidate);
    if (strokeRows.length > detectedBands.length && strokeRows.length > 1) {
      return strokeRows;
    }
    return detectedBands;
  }

  /**
   * Fractions are vertically arranged but must remain one CoMER crop. Treat a
   * long horizontal stroke with ink both above and below it as a structural
   * bridge, provided DBNet also found bands on both sides of the stroke.
   */
  function containsFractionBridge(candidate, bands) {
    if (!candidate || !candidate.strokes || bands.length < 2) return false;
    var candidateBox = computeTightBbox(candidate.strokes);
    var candidateWidth = candidateBox ? Math.max(1, candidateBox.xMax - candidateBox.xMin) : 1;
    for (var i = 0; i < candidate.strokes.length; i++) {
      var bar = candidate.strokes[i].canvasBbox;
      if (!bar) continue;
      var width = bar.xMax - bar.xMin;
      var height = Math.max(1, bar.yMax - bar.yMin);
      if (width / height < 3) continue;
      // Equals signs and operation markers are short local bars. A fraction
      // bar should be a dominant horizontal structure within the candidate,
      // even when the full expression also contains a right-hand side.
      if (width < candidateWidth * 0.22) continue;

      var barY = (bar.yMin + bar.yMax) / 2;
      var inkAbove = false, inkBelow = false;
      for (var s = 0; s < candidate.strokes.length; s++) {
        if (s === i || !candidate.strokes[s].canvasBbox) continue;
        var strokeBox = candidate.strokes[s].canvasBbox;
        var strokeY = (strokeBox.yMin + strokeBox.yMax) / 2;
        if (horizontalOverlapRatio(bar, strokeBox) < 0.2) continue;
        if (strokeY < barY - height * 0.25) inkAbove = true;
        if (strokeY > barY + height * 0.25) inkBelow = true;
      }
      if (!inkAbove || !inkBelow) continue;

      var bandAbove = false, bandBelow = false;
      for (var b = 0; b < bands.length; b++) {
        var band = bands[b].bbox;
        if (horizontalOverlapRatio(bar, band) < 0.2) continue;
        var bandY = (band.yMin + band.yMax) / 2;
        if (bandY < barY) bandAbove = true;
        if (bandY > barY) bandBelow = true;
      }
      if (bandAbove && bandBelow) return true;
    }
    return false;
  }

  function candidateAlternatives(candidate, detections) {
    var split = splitCandidate(candidate, detections);
    if (split.length <= 1) return [candidate];
    // Keep the whole crop as an overlapping alternative. CoMER's global cover
    // can then choose a structural fraction or the separate DBNet lines.
    var parent = Object.assign({}, candidate, {
      profile: "dbnet-parent",
      profiles: ["dbnet-parent"]
    });
    return [parent].concat(split);
  }

  function buildBaseCandidates() {
    if (typeof strokeSaver === "undefined") return [];
    var strokes = strokeSaver.getStrokes() || [];
    var merged = mergeCatchmentBatches(buildTemporalBatches(strokes));
    return merged.filter(function (group) { return group.strokes.length > 0; }).map(function (group) {
      return candidateFromStrokes(group.strokes, "");
    });
  }

  function groupStrokesIntoLines() {
    var base = buildBaseCandidates();
    var lines = [];
    for (var i = 0; i < base.length; i++) {
      var cached = _resultCache[candidateCacheKey(base[i])];
      var alternatives = cached ? candidateAlternatives(base[i], cached) : [base[i]];
      lines = lines.concat(alternatives);
    }
    lines.sort(function (a, b) {
      return a.tightBbox.yMin - b.tightBbox.yMin || a.tightBbox.xMin - b.tightBbox.xMin;
    });
    _lineGroups = lines;
    _lineCandidates = lines.slice();
    if (_showBoxes) drawLineBoxes();
    return _lineGroups;
  }

  function rasterizeCandidate(candidate) {
    var tight = candidate.tightBbox;
    var originX = Math.floor(tight.xMin - _config.horizontalPadding);
    var originY = Math.floor(tight.yMin - _config.verticalPadding);
    var width = Math.max(1, Math.ceil(tight.xMax + _config.horizontalPadding) - originX);
    var height = Math.max(1, Math.ceil(tight.yMax + _config.verticalPadding) - originY);
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.translate(-originX, -originY);
    ctx.fillStyle = "#000";
    for (var i = 0; i < candidate.strokes.length; i++) {
      var outline = candidate.strokes[i].outlinePoints;
      if (!outline || outline.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(outline[0].x, outline[0].y);
      for (var j = 1; j < outline.length; j++) ctx.lineTo(outline[j].x, outline[j].y);
      ctx.closePath();
      ctx.fill();
    }
    return { canvas: canvas, originX: originX, originY: originY };
  }

  function canvasBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode DBNet candidate crop"));
      }, "image/png");
    });
  }

  function requestDetections(candidate) {
    var crop = rasterizeCandidate(candidate);
    return canvasBlob(crop.canvas).then(function (blob) {
      var body = new FormData();
      body.append("file", blob, "candidate.png");
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, _config.requestTimeoutMs) : null;
      return fetch(_serverUrl + "/segment-lines", {
        method: "POST",
        body: body,
        signal: controller ? controller.signal : undefined
      }).then(function (response) {
        if (!response.ok) throw new Error("DBNet endpoint returned " + response.status);
        return response.json();
      }).finally(function () { if (timer) clearTimeout(timer); });
    }).then(function (payload) {
      return (payload.detections || []).map(function (item) {
        var box = item.bbox;
        return Object.assign({}, item, {
          bbox: {
            xMin: box.xMin + crop.originX, yMin: box.yMin + crop.originY,
            xMax: box.xMax + crop.originX, yMax: box.yMax + crop.originY
          },
          polygon: (item.polygon || []).map(function (point) {
            return [point[0] + crop.originX, point[1] + crop.originY];
          })
        });
      });
    });
  }

  function documentSignature() {
    if (typeof strokeSaver === "undefined") return "";
    return strokeSaver.getStrokes().map(function (stroke) { return stroke.id; }).join("|");
  }

  function flushPendingGroups() {
    if (_activeFlush) return _activeFlush;
    var signature = documentSignature();
    var version = ++_version;
    var candidates = buildBaseCandidates();
    var requests = candidates.map(function (candidate) {
      var key = candidateCacheKey(candidate);
      if (_resultCache[key]) return Promise.resolve();
      return requestDetections(candidate).then(function (detections) {
        _resultCache[key] = detections;
      }).catch(function (error) {
        // Preserve the unsplit candidate on model/network failure.
        console.warn("DBNet segmentation fallback:", error.message || error);
        _resultCache[key] = [];
      });
    });
    _activeFlush = Promise.all(requests).then(function () {
      if (version === _version && signature === documentSignature()) groupStrokesIntoLines();
      return _lineGroups;
    }).finally(function () { _activeFlush = null; });
    return _activeFlush;
  }

  function finalizeStroke() {
    _version += 1;
    return groupStrokesIntoLines();
  }

  function getLineGroups() { return _lineGroups; }
  function getLineCandidates() { return _lineCandidates; }
  function getLinePartitions() {
    return { dbnet: _lineCandidates.map(function (line) { return line.candidateId; }) };
  }
  function getLinesForRecognition() {
    return groupStrokesIntoLines().map(function (line, index) {
      return { lineIndex: index, strokes: line.strokes.map(function (stroke) { return stroke.rawPoints; }) };
    });
  }

  function drawLineBoxes() {
    if (!_active || !boxCtx || !boxCanvas) return;
    boxCtx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
    for (var i = 0; i < _lineGroups.length; i++) {
      var tight = _lineGroups[i].tightBbox;
      var expanded = _lineGroups[i].expandedBbox;
      boxCtx.setLineDash([3, 6]);
      boxCtx.strokeStyle = "rgba(30,120,255,.35)";
      boxCtx.strokeRect(expanded.xMin, expanded.yMin, expanded.xMax - expanded.xMin, expanded.yMax - expanded.yMin);
      boxCtx.setLineDash([6, 4]);
      boxCtx.strokeStyle = "rgba(0,180,0,.8)";
      boxCtx.strokeRect(tight.xMin, tight.yMin, tight.xMax - tight.xMin, tight.yMax - tight.yMin);
    }
    boxCtx.setLineDash([]);
  }

  function toggleBoxes() {
    if (!_active) return;
    _showBoxes = !_showBoxes;
    if (_showBoxes) drawLineBoxes();
    else if (boxCtx) boxCtx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
  }

  function init() {
    var container = document.querySelector(".canvas-container");
    if (!container) return;
    boxCanvas = document.createElement("canvas");
    boxCanvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:10";
    boxCanvas.width = container.clientWidth;
    boxCanvas.height = container.clientHeight;
    container.appendChild(boxCanvas);
    boxCtx = boxCanvas.getContext("2d");
    document.addEventListener("keydown", function (event) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (_active && (event.key === "b" || event.key === "B") && tag !== "INPUT" && tag !== "TEXTAREA") toggleBoxes();
    });
    setActive(_active);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  return {
    configure: configure,
    getConfig: getConfig,
    setServerUrl: setServerUrl,
    setActive: setActive,
    groupStrokesIntoLines: groupStrokesIntoLines,
    flushPendingGroups: flushPendingGroups,
    finalizeStroke: finalizeStroke,
    getLineGroups: getLineGroups,
    getLineCandidates: getLineCandidates,
    getLinePartitions: getLinePartitions,
    getLinesForRecognition: getLinesForRecognition,
    drawLineBoxes: drawLineBoxes,
    toggleBoxes: toggleBoxes,
    computeExpandedBbox: computeExpandedBbox,
    computeTightBbox: computeTightBbox,
    verticalOverlapRatio: verticalOverlapRatio,
    clusterDetections: clusterDetections,
    splitCandidate: splitCandidate,
    containsFractionBridge: containsFractionBridge,
    candidateAlternatives: candidateAlternatives,
    clusterStrokeRows: clusterStrokeRows,
    chooseLineBands: chooseLineBands,
    buildBaseCandidates: buildBaseCandidates,
    candidateCacheKey: candidateCacheKey
  };
})();
