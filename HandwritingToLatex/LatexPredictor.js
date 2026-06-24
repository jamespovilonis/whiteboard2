// LatexPredictor.js - Rasterizes handwritten lines and sends them to a single unified server
// for recognition (CoMER, SAN, or CAN), then displays predicted LaTeX with candidate lists
// and confidence scores.

var LatexPredictor = (function () {
  // ── Configurable server URL ────────────────────────────────────────
  // Default: empty string = same origin (frontend and API on the same server).
  // Override via config.json or ?apiUrl= URL parameter.
  var _serverUrl = "";
  var _predictionPanel = null;
  var _statusDots = { comer: null };
  var _serverHealthOk = { comer: false };
  var _recognizing = false; // guard against concurrent recognitions
  var _enabledModels = ["comer"];
  var _recognitionTimeoutMs = 3000;
  var _candidatePredictionCache = {};

  // Debounce cooldown (ms) — rapid clicks coalesce into one recognition
  var _lastRecognizeTime = 0;
  var DEBOUNCE_MS = 500;

  // ── Public API ──────────────────────────────────────────────────────

  function setServerUrl(url) {
    if (_serverUrl !== url) {
      _serverUrl = url;
      clearRecognitionCache();
    }
  }

  function setEnabledModels(models) {
    _enabledModels = normalizeModels(models || ["comer"]);
    if (_predictionPanel && !_predictionPanel.querySelector(".prediction-row")) {
      renderEmptyState();
    }
  }

  function setRecognitionTimeoutMs(timeoutMs) {
    var parsed = Number(timeoutMs);
    if (isFinite(parsed) && parsed >= 100) {
      _recognitionTimeoutMs = parsed;
      clearRecognitionCache();
    }
  }

  function renderEmptyState() {
    if (!_predictionPanel) return;

    _predictionPanel.innerHTML = "";
    var emptyState = document.createElement("div");
    emptyState.className = "prediction-panel-empty prediction-welcome";

    var title = document.createElement("div");
    title.className = "prediction-welcome-title";
    title.textContent = "Model predictions";
    emptyState.appendChild(title);

    var hint = document.createElement("div");
    hint.className = "prediction-welcome-hint";
    hint.textContent = "Write an equation to see live results.";
    emptyState.appendChild(hint);

    var models = document.createElement("div");
    models.className = "prediction-model-placeholders";
    for (var i = 0; i < _enabledModels.length; i++) {
      var model = document.createElement("div");
      model.className = "prediction-model-placeholder";
      model.textContent = _enabledModels[i];
      models.appendChild(model);
    }
    emptyState.appendChild(models);
    _predictionPanel.appendChild(emptyState);
  }

  /**
   * Initialize references to DOM elements. Call once on load.
   */
  function init() {
    _predictionPanel = document.getElementById("prediction-panel");
    _statusDots.comer = document.getElementById("serverStatus-comer");
    if (_predictionPanel) {
      _predictionPanel.classList.add("active");
      renderEmptyState();
    }
    // Do an initial health check right away
    checkServerHealth("comer");
    // Re-check server health every 30 seconds (bounded polling)
    setInterval(function () {
      checkServerHealth("comer");
    }, 30000);
  }

  /**
   * Main recognition entry point. Called from the recognize button click handler.
   */
  function recognize(segmentationReady) {
    // Debounce: ignore rapid clicks within cooldown window
    var now = Date.now();
    if (now - _lastRecognizeTime < DEBOUNCE_MS) return;
    _lastRecognizeTime = now;

    if (_recognizing) {
      showToast("Already recognizing...", false);
      return;
    }

    if (typeof LinesRasterizer === "undefined") {
      showToast("LinesRasterizer not loaded", true);
      return;
    }

    if (!segmentationReady && typeof IdentifyLine !== "undefined" && IdentifyLine.flushPendingGroups) {
      _recognizing = true;
      return Promise.resolve(IdentifyLine.flushPendingGroups()).then(function () {
        _recognizing = false;
        _lastRecognizeTime = 0;
        return recognize(true);
      }).catch(function (error) {
        _recognizing = false;
        _lastRecognizeTime = 0;
        console.warn("DBNet segmentation fallback:", error);
        return recognize(true);
      });
    }

    // Check server health first
    var hasOnlineEnabledModel = false;
    for (var h = 0; h < _enabledModels.length; h++) {
      if (isServerOnline(_enabledModels[h])) hasOnlineEnabledModel = true;
    }
    if (!hasOnlineEnabledModel) {
      showToast("Configured recognition models are offline. Start the model server first.", true);
      return;
    }

    // Get rasterized lines (re-rasterize fresh)
    var lines = LinesRasterizer.rasterizeAllLines();
    if (!lines || lines.length === 0) {
      showToast("No handwriting detected. Draw something first!", false);
      return;
    }

    _recognizing = true;

    // Activate the right-side panel only after the user explicitly checks/recognizes.
    if (_predictionPanel) _predictionPanel.classList.add("active");

    // Add spinning class to recognize button
    var recognizeBtn = document.getElementById("recognize");
    if (recognizeBtn) recognizeBtn.classList.add("spinning");

    // Show loading state
    showToast("Recognizing " + lines.length + " line" + (lines.length > 1 ? "s" : "") + "...", false);

    // Clear previous predictions and show placeholder
    if (_predictionPanel) _predictionPanel.innerHTML = "";
    var emptyMsg = document.createElement("div");
    emptyMsg.className = "prediction-panel-empty";
    emptyMsg.textContent = "Recognizing...";
    _predictionPanel.appendChild(emptyMsg);

    // Recognize both grouping views, then render only the globally selected
    // non-overlapping stroke cover.
    recognizeCandidateLines(lines, {
      models: _enabledModels,
      concurrency: 2,
      replaceExisting: false,
      clearPanel: true
    }).then(function () {
      // Remove placeholder after all done
      var placeholder = _predictionPanel.querySelector(".prediction-panel-empty");
      if (placeholder) placeholder.parentNode.removeChild(placeholder);
      showToast("Recognition complete!", false, "success");
    }).catch(function (err) {
      console.error("Recognition pipeline error:", err);
      showToast("Error during recognition: " + err.message, true);
    }).finally(function () {
      _recognizing = false;
      if (recognizeBtn) recognizeBtn.classList.remove("spinning");
    });
  }

  /**
   * Process an array of line recognition tasks with a concurrency limit.
   */
  function processWithConcurrency(lines, limit, options) {
    options = options || {};
    var nextIdx = 0;
    var total = lines.length;
    var results = new Array(total);

    function worker() {
      return new Promise(function (resolve, reject) {
        function step() {
          var i = nextIdx++;
          if (i >= total) {
            resolve();
            return;
          }
          var lineIndex = lines[i].lineIndex !== undefined ? lines[i].lineIndex : i;
          var lineOptions = {};
          for (var key in options) {
            if (Object.prototype.hasOwnProperty.call(options, key)) {
              lineOptions[key] = options[key];
            }
          }
          lineOptions.pendingOrdinal = i + 1;
          lineOptions.pendingTotal = total;
          sendLineToServers(lines[i], lineIndex, lineOptions).then(function (predictions) {
            results[i] = predictions;
            step();
          }).catch(function (err) {
            console.error("Line " + i + " failed, continuing:", err);
            step();
          });
        }
        step();
      });
    }

    var workers = [];
    var spawnCount = Math.min(limit, total);
    for (var w = 0; w < spawnCount; w++) {
      workers.push(worker());
    }
    return Promise.all(workers).then(function () { return results; });
  }

  function bracesAreBalanced(latex) {
    var depth = 0;
    for (var i = 0; i < latex.length; i++) {
      if (latex.charAt(i) === '{') depth += 1;
      if (latex.charAt(i) === '}') depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0;
  }

  function latexSyntaxScore(latex) {
    if (typeof katex === "undefined" || typeof katex.renderToString !== "function") return 0;
    try {
      katex.renderToString(latex, { throwOnError: true });
      return 0.4;
    } catch (err) {
      return -3;
    }
  }

  function scoreLineCandidate(lineData, predictions) {
    var result = predictions && predictions.comer;
    if (!result) return -100;
    if (result.failed) return typeof result.selectionPenalty === "number" ?
      result.selectionPenalty : -1000;
    if (result.timedOut) return typeof result.selectionPenalty === "number" ?
      result.selectionPenalty : -1000;

    var latex = String(result.latex || "").trim();
    if (!latex) return -50;

    // CoMER's score is length-normalized again here so crops of very different
    // sizes can be compared. Keep it bounded so syntax/spatial evidence still
    // matters when choosing the global stroke cover.
    var tokenCount = Math.max(1, latex.split(/\s+/).length);
    var rawScore = result.candidates && result.candidates[0] &&
      typeof result.candidates[0].score === "number" ?
      result.candidates[0].score / tokenCount : -4;
    rawScore = Math.max(-20, Math.min(2, rawScore));

    var score = rawScore * 0.35;
    score -= 0.45; // partition-complexity cost per selected crop
    score += bracesAreBalanced(latex) ? 0.2 : -4;
    score += latexSyntaxScore(latex);
    if (/[=<>]/.test(latex)) score += 0.2;
    if (/[+\-=^_]\s*$/.test(latex) || /^\s*[=+]/.test(latex)) score -= 2;

    var structural = /\\(frac|sum|int|prod|sqrt|begin)|[\^_][\s{]/.test(latex);
    if (structural) score += 1.5;
    if ((lineData.strokeCount || 0) <= 2 && latex.replace(/\s+/g, '').length <= 2) {
      score -= 0.75;
    }

    var tight = lineData.tightBbox || {};
    var height = Number(tight.yMax) - Number(tight.yMin);
    if (height > 0 && lineData.medianStrokeHeight > 0) {
      // A very tall crop is often the loose detector absorbing multiple rows.
      // Structural LaTeX reduces this penalty for legitimate 2-D expressions.
      var spread = height / lineData.medianStrokeHeight;
      if (spread > 2.5) score -= (spread - 2.5) * (structural ? 0.15 : 0.5);
    }

    return score + (typeof result.selectionPenalty === "number" ?
      result.selectionPenalty : 0);
  }

  function candidatesOverlap(a, b) {
    var ids = {};
    for (var i = 0; i < a.strokeIds.length; i++) ids[a.strokeIds[i]] = true;
    for (var j = 0; j < b.strokeIds.length; j++) {
      if (ids[b.strokeIds[j]]) return true;
    }
    return false;
  }

  function strokeSetContains(container, contained) {
    var ids = {};
    for (var i = 0; i < container.strokeIds.length; i++) ids[container.strokeIds[i]] = true;
    for (var j = 0; j < contained.strokeIds.length; j++) {
      if (!ids[contained.strokeIds[j]]) return false;
    }
    return true;
  }

  /**
   * Select the highest-scoring exact stroke cover. This permits a hybrid of
   * loose and strict groups while forbidding candidates that share ink.
   */
  function selectCandidateCover(entries) {
    if (!entries || entries.length === 0) return [];
    var allStrokeIds = [];
    var seenStroke = {};
    var byStroke = {};

    for (var i = 0; i < entries.length; i++) {
      var lineData = entries[i].lineData;
      entries[i].selectionScore = scoreLineCandidate(lineData, entries[i].predictions);
      for (var s = 0; s < lineData.strokeIds.length; s++) {
        var strokeId = lineData.strokeIds[s];
        if (!seenStroke[strokeId]) {
          seenStroke[strokeId] = true;
          allStrokeIds.push(strokeId);
        }
        if (!byStroke[strokeId]) byStroke[strokeId] = [];
        byStroke[strokeId].push(entries[i]);
      }
    }


    // Penalize a loose-only crop in proportion to how many strict components
    // it swallowed. Legitimate 2-D structures can recover this cost through
    // the structural-LaTeX bonus; unstructured multi-row blobs cannot.
    for (var candidateIndex = 0; candidateIndex < entries.length; candidateIndex++) {
      var candidateProfiles = entries[candidateIndex].lineData.profiles;
      if (candidateProfiles.indexOf('loose') === -1 ||
          candidateProfiles.indexOf('strict') !== -1) continue;
      var strictComponents = 0;
      for (var strictIndex = 0; strictIndex < entries.length; strictIndex++) {
        if (entries[strictIndex].lineData.profiles.indexOf('strict') === -1) continue;
        if (strokeSetContains(entries[candidateIndex].lineData, entries[strictIndex].lineData)) {
          strictComponents += 1;
        }
      }
      if (strictComponents > 1) {
        entries[candidateIndex].selectionScore -= (strictComponents - 1) * 0.8;
      }
    }

    // An unsplit DBNet parent exists as a safety alternative, but when DBNet
    // (or vector-row refinement) produced a complete multi-line cover, favor
    // those line crops. CoMER is a single-expression model and its score for a
    // tall multi-row crop is not comparable to the sum of per-line scores.
    for (var parentIndex = 0; parentIndex < entries.length; parentIndex++) {
      if (entries[parentIndex].lineData.profiles.indexOf('dbnet-parent') === -1) continue;
      var dbnetComponents = 0;
      for (var lineIndex = 0; lineIndex < entries.length; lineIndex++) {
        if (entries[lineIndex].lineData.profiles.indexOf('dbnet-line') === -1) continue;
        if (strokeSetContains(entries[parentIndex].lineData, entries[lineIndex].lineData)) {
          dbnetComponents += 1;
        }
      }
      if (dbnetComponents > 1) {
        entries[parentIndex].selectionScore -= (dbnetComponents - 1) * 5;
      }
    }
    allStrokeIds.sort();

    var best = null;
    var bestScore = -Infinity;
    var explored = 0;
    var memo = {};

    function search(covered, coveredCount, selected, score) {
      if (explored++ > 4096) return;
      if (coveredCount === allStrokeIds.length) {
        if (score > bestScore ||
            (score === bestScore && (!best || selected.length < best.length))) {
          bestScore = score;
          best = selected.slice();
        }
        return;
      }

      var keyParts = [];
      for (var k = 0; k < allStrokeIds.length; k++) {
        if (covered[allStrokeIds[k]]) keyParts.push(allStrokeIds[k]);
      }
      var memoKey = keyParts.join('|');
      if (memo[memoKey] !== undefined && memo[memoKey] >= score) return;
      memo[memoKey] = score;

      var nextStroke = null;
      var choices = null;
      for (var u = 0; u < allStrokeIds.length; u++) {
        var candidateStroke = allStrokeIds[u];
        if (covered[candidateStroke]) continue;
        var available = [];
        var possible = byStroke[candidateStroke] || [];
        for (var p = 0; p < possible.length; p++) {
          var overlaps = false;
          for (var q = 0; q < selected.length; q++) {
            if (candidatesOverlap(possible[p].lineData, selected[q].lineData)) {
              overlaps = true;
              break;
            }
          }
          if (!overlaps) available.push(possible[p]);
        }
        if (choices === null || available.length < choices.length) {
          nextStroke = candidateStroke;
          choices = available;
        }
      }

      if (!nextStroke || !choices || choices.length === 0) return;
      choices.sort(function (a, b) { return b.selectionScore - a.selectionScore; });
      for (var c = 0; c < choices.length; c++) {
        var nextCovered = Object.assign({}, covered);
        var added = 0;
        var ids = choices[c].lineData.strokeIds;
        for (var n = 0; n < ids.length; n++) {
          if (!nextCovered[ids[n]]) {
            nextCovered[ids[n]] = true;
            added += 1;
          }
        }
        selected.push(choices[c]);
        search(nextCovered, coveredCount + added, selected,
          score + choices[c].selectionScore);
        selected.pop();
      }
    }

    search({}, 0, [], 0);
    if (!best) {
      best = entries.filter(function (entry) {
        return entry.lineData.profiles.indexOf('loose') !== -1;
      });
      if (best.length === 0) best = entries.slice();
    }

    best.sort(function (a, b) {
      var boxA = a.lineData.tightBbox || {};
      var boxB = b.lineData.tightBbox || {};
      return (boxA.yMin - boxB.yMin) || (boxA.xMin - boxB.xMin);
    });
    return best;
  }

  function renderCandidateResults(entries, selected, options) {
    options = options || {};
    if (_predictionPanel) _predictionPanel.innerHTML = "";
    if (typeof AnswerPredictionStore !== "undefined") AnswerPredictionStore.clear();

    var selectedById = {};
    for (var i = 0; i < selected.length; i++) {
      var entry = selected[i];
      var predictions = entry.predictions || emptyPredictions();
      selectedById[entry.lineData.candidateId] = i;
      if (predictions.comer) {
        predictions.comer.selectionScore = entry.selectionScore;
        predictions.comer.groupingProfiles = entry.lineData.profiles.slice();
      }
      if (typeof AnswerPredictionStore !== "undefined" && predictions.comer &&
          !predictions.comer.timedOut) {
        AnswerPredictionStore.upsertLine(
          i, entry.lineData.signature, predictions.comer.candidates || []
        );
      }
    }

    var categories = [
      { key: 'shared', title: 'Candidates found by both approaches', entries: [] },
      { key: 'loose', title: 'Loose detection candidates', entries: [] },
      { key: 'strict', title: 'Strict overlap candidates', entries: [] },
      { key: 'dbnet', title: 'DBNet line candidates', entries: [] }
    ];
    for (var e = 0; e < entries.length; e++) {
      var profiles = entries[e].lineData.profiles;
      if (profiles.indexOf('loose') !== -1 && profiles.indexOf('strict') !== -1) {
        categories[0].entries.push(entries[e]);
      } else if (profiles.indexOf('loose') !== -1) {
        categories[1].entries.push(entries[e]);
      } else if (profiles.indexOf('strict') !== -1) {
        categories[2].entries.push(entries[e]);
      } else {
        categories[3].entries.push(entries[e]);
      }
    }

    var displayIndex = 0;
    for (var categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
      var category = categories[categoryIndex];
      if (category.entries.length === 0) continue;
      category.entries.sort(function (a, b) {
        var boxA = a.lineData.tightBbox || {};
        var boxB = b.lineData.tightBbox || {};
        return (boxA.yMin - boxB.yMin) || (boxA.xMin - boxB.xMin);
      });

      if (_predictionPanel) {
        var heading = document.createElement('div');
        heading.className = 'prediction-candidate-heading';
        heading.textContent = category.title;
        _predictionPanel.appendChild(heading);
      }

      for (var candidateIndex = 0; candidateIndex < category.entries.length; candidateIndex++) {
        var candidateEntry = category.entries[candidateIndex];
        var candidateId = candidateEntry.lineData.candidateId;
        var selectedLineIndex = selectedById[candidateId];
        var isSelected = selectedLineIndex !== undefined;
        var overlapsSelected = false;
        if (!isSelected) {
          for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
            if (candidatesOverlap(candidateEntry.lineData, selected[selectedIndex].lineData)) {
              overlapsSelected = true;
              break;
            }
          }
        }
        renderRow(displayIndex++, candidateEntry.predictions || emptyPredictions(), {
          signature: candidateEntry.lineData.signature,
          profiles: candidateEntry.lineData.profiles,
          selectionScore: candidateEntry.selectionScore,
          stage: options.stage,
          replaceExisting: false,
          displayLabel: category.key === 'shared' ?
            'Loose + Strict candidate ' + (candidateIndex + 1) :
            (category.key === 'dbnet' ? 'DBNet line' :
              category.key.charAt(0).toUpperCase() + category.key.slice(1) + ' candidate') +
              ' ' + (candidateIndex + 1),
          isSelected: isSelected,
          selectedLineNumber: isSelected ? selectedLineIndex + 1 : null,
          overlapsSelected: overlapsSelected
        });
      }
    }
    if (typeof AnswerCheckController !== "undefined") AnswerCheckController.check();
    return selected;
  }

  function candidateCacheKey(line, models) {
    return _serverUrl + '::' +
      (line.signature || line.candidateId || line.lineId) + '::' + models.join(',');
  }

  function recognizeCandidateLines(lines, options) {
    options = options || {};
    if (!lines || lines.length === 0) return Promise.resolve([]);
    var models = normalizeModels(options.models);
    var entries = new Array(lines.length);
    var pendingLines = [];
    var pendingIndexes = [];

    for (var i = 0; i < lines.length; i++) {
      var cacheKey = candidateCacheKey(lines[i], models);
      if (_candidatePredictionCache[cacheKey]) {
        entries[i] = { lineData: lines[i], predictions: _candidatePredictionCache[cacheKey] };
      } else {
        pendingLines.push(lines[i]);
        pendingIndexes.push(i);
      }
    }

    return processWithConcurrency(pendingLines, options.concurrency || 1, {
      models: models,
      deferRender: true,
      shouldRender: options.shouldRender
    }).then(function (results) {
      for (var r = 0; r < results.length; r++) {
        var originalIndex = pendingIndexes[r];
        var predictions = results[r] || emptyPredictions();
        entries[originalIndex] = { lineData: lines[originalIndex], predictions: predictions };
        if (predictions.comer) {
          _candidatePredictionCache[candidateCacheKey(lines[originalIndex], models)] = predictions;
        }
      }
      var cacheKeys = Object.keys(_candidatePredictionCache);
      if (cacheKeys.length > 200) {
        for (var c = 0; c < cacheKeys.length - 200; c++) {
          delete _candidatePredictionCache[cacheKeys[c]];
        }
      }
      if (typeof options.shouldRender === "function" && !options.shouldRender()) return [];
      var selected = selectCandidateCover(entries);
      return renderCandidateResults(entries, selected, options);
    });
  }

  // ── Server health ───────────────────────────────────────────────────

  function isServerOnline(name) {
    return !!_serverHealthOk[name];
  }

  function checkServerHealth(name) {
    fetch(_serverUrl + "/health?model=" + name, { method: "GET" })
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        _serverHealthOk[name] = data.loaded !== false;
        updateStatusDot(name, _serverHealthOk[name]);
      })
      .catch(function () {
        _serverHealthOk[name] = false;
        updateStatusDot(name, false);
      });
  }

  function updateStatusDot(name, online) {
    var dot = _statusDots[name];
    if (!dot) return;
    if (online) {
      dot.className = "server-status online";
      dot.title = name.charAt(0).toUpperCase() + name.slice(1) + " server: online";
    } else {
      dot.className = "server-status";
      dot.title = name.charAt(0).toUpperCase() + name.slice(1) + " server: offline";
    }
  }

  // ── Send one line to all three models on the unified server ──────────

  function normalizeModels(models) {
    if (!models || models.length === 0) return ["comer"];
    var out = [];
    for (var i = 0; i < models.length; i++) {
      if (models[i] === "comer") {
        out.push(models[i]);
      }
    }
    return out.length > 0 ? out : ["comer"];
  }

  function emptyPredictions() {
    return { comer: null, san: null, can: null };
  }

  function sendLineToServers(lineData, lineIndex, options) {
    options = options || {};
    var models = normalizeModels(options.models);
    var renderOptions = {};
    for (var optKey in options) {
      if (Object.prototype.hasOwnProperty.call(options, optKey)) {
        renderOptions[optKey] = options[optKey];
      }
    }
    if (lineData && lineData.signature) renderOptions.signature = lineData.signature;
    var dataUrl = lineData.dataUrl;
    if (!dataUrl) {
      console.error("Line " + lineIndex + ": empty dataUrl, skipping");
      if (!renderOptions.deferRender) renderRow(lineIndex, emptyPredictions(), renderOptions);
      return Promise.resolve(emptyPredictions());
    }

    if (renderOptions.renderPending !== false) {
      renderPendingRow(lineIndex, "CoMER is reading this crop...", lineData, renderOptions);
    }

    return fetch(dataUrl)
      .then(function (resp) { return resp.blob(); })
      .then(function (blob) {
        if (!blob || blob.size === 0) {
          throw new Error("Rasterized image is empty (0 bytes)");
        }

        var modelPromises = [];
        for (var m = 0; m < models.length; m++) {
          modelPromises.push(sendToModel(models[m], blob, lineIndex));
        }

        return Promise.all(modelPromises).then(function (results) {
          var predictions = emptyPredictions();
          for (var r = 0; r < results.length; r++) {
            predictions[models[r]] = results[r];
          }
          if (typeof renderOptions.shouldRender === "function" &&
              !renderOptions.shouldRender(lineData, lineIndex, predictions)) {
            return predictions;
          }
          if (renderOptions.deferRender) return predictions;
          if (typeof AnswerPredictionStore !== "undefined" && predictions.comer &&
              !predictions.comer.timedOut) {
            AnswerPredictionStore.upsertLine(
              lineIndex,
              lineData && (lineData.signature || lineData.lineId),
              predictions.comer.candidates || []
            );
            if (typeof AnswerCheckController !== "undefined") {
              AnswerCheckController.check();
            }
          }
          renderRow(lineIndex, predictions, renderOptions);
          return predictions;
        });
      })
      .catch(function (err) {
        console.error("Line " + lineIndex + " recognition failed:", err);
        if (renderOptions.renderPending !== false) {
          renderPendingRow(lineIndex, "CoMER could not read this crop.", lineData, renderOptions);
        }
        if (!renderOptions.deferRender) renderRow(lineIndex, emptyPredictions(), renderOptions);
        return emptyPredictions();
      });
  }

  function recognizeLines(lines, options) {
    options = options || {};
    if (!lines || lines.length === 0) return Promise.resolve([]);

    if (_predictionPanel && options.activatePanel !== false) {
      _predictionPanel.classList.add("active");
      if (options.clearPanel) _predictionPanel.innerHTML = "";
    }

    return recognizeCandidateLines(lines, options);
  }

  function renderPendingRow(lineIndex, stage, lineData) {
    var options = arguments.length > 3 ? arguments[3] || {} : {};
    if (!_predictionPanel) return;
    _predictionPanel.classList.add("active");
    var emptyState = _predictionPanel.querySelector(".prediction-welcome");
    if (emptyState) emptyState.parentNode.removeChild(emptyState);
    var genericEmpty = _predictionPanel.querySelector(".prediction-panel-empty:not(.prediction-welcome)");
    if (genericEmpty && genericEmpty.parentNode) genericEmpty.parentNode.removeChild(genericEmpty);

    var row = document.createElement("div");
    row.className = "prediction-row prediction-pending";
    row.dataset.lineIndex = lineIndex;
    if (lineData && lineData.signature) row.dataset.signature = lineData.signature;
    if (lineData && lineData.profiles && lineData.profiles.length) {
      row.dataset.groupingProfiles = lineData.profiles.join(",");
    }

    var topRow = document.createElement("div");
    topRow.className = "prediction-pending-top";

    var badge = document.createElement("span");
    badge.className = "prediction-badge";
    var profileLabel = lineData && lineData.profiles && lineData.profiles.indexOf("dbnet-line") !== -1 ?
      "DBNet line" :
      (lineData && lineData.profiles && lineData.profiles.indexOf("dbnet-parent") !== -1 ?
        "DBNet parent" : "Line");
    var ordinal = options.pendingOrdinal && options.pendingTotal ?
      " " + options.pendingOrdinal + "/" + options.pendingTotal :
      " " + (lineIndex + 1);
    badge.textContent = profileLabel + ordinal;
    topRow.appendChild(badge);

    var spinner = document.createElement("span");
    spinner.className = "prediction-pending-spinner";
    spinner.setAttribute("aria-hidden", "true");
    topRow.appendChild(spinner);
    row.appendChild(topRow);

    if (lineData && lineData.dataUrl) {
      var previewWrap = document.createElement("div");
      previewWrap.className = "prediction-pending-preview";
      var img = document.createElement("img");
      img.src = lineData.dataUrl;
      img.alt = "Line crop being sent to CoMER";
      previewWrap.appendChild(img);
      row.appendChild(previewWrap);
    }

    var msg = document.createElement("div");
    msg.className = "realtime-pending-message";
    msg.textContent = stage || "Checking...";
    row.appendChild(msg);

    if (lineData && lineData.tightBbox) {
      var bbox = lineData.tightBbox;
      var meta = document.createElement("div");
      meta.className = "prediction-candidate-meta";
      meta.textContent = "Ink box " +
        Math.round(bbox.xMax - bbox.xMin) + " x " +
        Math.round(bbox.yMax - bbox.yMin) + " px";
      row.appendChild(meta);
    }

    replaceOrAppendRow(row, lineIndex);
  }

  /**
   * Send image to the unified server with ?model=comer|san|can param.
   * Returns { latex, candidates: [{latex, score, confidence}], model }
   * or null on failure / model not loaded.
   */
  function sendToModel(modelName, blob, lineIndex) {
    if (!isServerOnline(modelName)) {
      return Promise.resolve(null);
    }

    var formData = new FormData();
    formData.append("file", blob, "line_" + lineIndex + ".png");
    var startedAt = Date.now();
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    // The server enforces the actual model deadline. This slightly longer
    // browser timer is a fallback for network/server failures.
    var abortTimer = controller ? setTimeout(function () {
      controller.abort();
    }, _recognitionTimeoutMs + 750) : null;
    var timeoutSeconds = _recognitionTimeoutMs / 1000;
    var requestUrl = _serverUrl + "/recognize?model=" + modelName +
      "&timeout_seconds=" + encodeURIComponent(timeoutSeconds);
    var fetchOptions = { method: "POST", body: formData };
    if (controller) fetchOptions.signal = controller.signal;

    function timeoutResult(elapsedSeconds) {
      return {
        latex: "",
        candidates: [],
        confidence: 0,
        model: modelName,
        timedOut: true,
        elapsedSeconds: elapsedSeconds,
        selectionPenalty: -1000
      };
    }

    return fetch(requestUrl, fetchOptions)
      .then(function (resp) {
        return resp.json().catch(function () { return null; }).then(function (data) {
          return { response: resp, data: data };
        });
      })
      .then(function (payload) {
        var resp = payload.response;
        var data = payload.data;
        var clientElapsed = (Date.now() - startedAt) / 1000;
        var elapsed = data && typeof data.elapsedSeconds === "number" ?
          data.elapsedSeconds : clientElapsed;

        if (resp.status === 408 || (data && data.timedOut)) {
          return timeoutResult(elapsed);
        }
        if (!resp.ok) {
          console.warn(modelName + " responded with status " + resp.status);
          return {
            latex: "",
            candidates: [],
            confidence: 0,
            model: modelName,
            failed: true,
            error: data && data.detail ? String(data.detail) : "HTTP " + resp.status,
            elapsedSeconds: elapsed,
            selectionPenalty: -1000
          };
        }
        if (!data || !data.top) {
          return {
            latex: "",
            candidates: [],
            confidence: 0,
            model: modelName,
            failed: true,
            error: "Recognition returned no candidates",
            elapsedSeconds: elapsed,
            selectionPenalty: -1000
          };
        }

        var latex = data.top.latex || "";
        var candidates = data.candidates || [];

        // Add model field to each candidate so frontend knows which model produced it
        for (var i = 0; i < candidates.length; i++) {
          if (!candidates[i].model) {
            candidates[i].model = modelName;
          }
        }

        return {
          latex: latex,
          candidates: candidates,
          confidence: data.top.confidence !== undefined ? data.top.confidence : 0,
          model: modelName,
          timedOut: false,
          elapsedSeconds: elapsed,
          selectionPenalty: typeof data.selectionPenalty === "number" ?
            data.selectionPenalty : 0
        };
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          return timeoutResult((Date.now() - startedAt) / 1000);
        }
        console.error(modelName + " recognition failed:", err);
        return {
          latex: "",
          candidates: [],
          confidence: 0,
          model: modelName,
          failed: true,
          error: err && err.message ? err.message : "Network error",
          elapsedSeconds: (Date.now() - startedAt) / 1000,
          selectionPenalty: -1000
        };
      })
      .finally(function () {
        if (abortTimer) clearTimeout(abortTimer);
      });
  }

  // ── Render predictions in the right panel ───────────────────────────

  function replaceOrAppendRow(row, lineIndex) {
    var existing = _predictionPanel.querySelector('.prediction-row[data-line-index="' + lineIndex + '"]');
    if (existing && existing.parentNode) {
      existing.parentNode.replaceChild(row, existing);
    } else {
      _predictionPanel.appendChild(row);
    }
  }

  function renderRow(lineIndex, predictions, options) {
    options = options || {};
    if (!_predictionPanel) return;
    var emptyState = _predictionPanel.querySelector(".prediction-welcome");
    if (emptyState) emptyState.parentNode.removeChild(emptyState);

    var row = document.createElement("div");
    row.className = "prediction-row" +
      (options.isSelected ? " prediction-row-selected" : " prediction-row-alternative");
    row.dataset.lineIndex = lineIndex;
    row.dataset.selected = options.isSelected ? "true" : "false";
    if (options.signature) row.dataset.signature = options.signature;
    if (options.stage) row.dataset.stage = options.stage;

    // Line number badge (full width top)
    var topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";

    var badge = document.createElement("span");
    badge.className = "prediction-badge";
    badge.textContent = options.displayLabel || ("Line " + (lineIndex + 1));
    if (options.profiles && options.profiles.length) {
      row.dataset.groupingProfiles = options.profiles.join(",");
      badge.title = "Detected by " + options.profiles.join(" + ") + " grouping";
    }
    topRow.appendChild(badge);

    var totalCopyBtn = document.createElement("button");
    totalCopyBtn.textContent = "\u{1F4CB} Copy All";
    totalCopyBtn.style.cssText =
      "background:none;border:1px solid #ddd;border-radius:6px;padding:2px 8px;" +
      "font-size:11px;cursor:pointer;color:#888;";
    totalCopyBtn.title = "Copy all LaTeX to clipboard";
    totalCopyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var texts = [];
      if (predictions.comer && predictions.comer.latex) texts.push("CoMER: " + predictions.comer.latex);
      if (predictions.san && predictions.san.latex) texts.push("SAN: " + predictions.san.latex);
      if (predictions.can && predictions.can.latex) texts.push("CAN: " + predictions.can.latex);
      var fullText = texts.join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(fullText).then(function () {
          totalCopyBtn.textContent = "\u2713 Copied";
          setTimeout(function () { totalCopyBtn.textContent = "\u{1F4CB} Copy All"; }, 2000);
        });
      }
    });
    topRow.appendChild(totalCopyBtn);
    row.appendChild(topRow);

    if (options.displayLabel) {
      var candidateMeta = document.createElement("div");
      candidateMeta.className = "prediction-candidate-meta";
      if (options.isSelected) {
        candidateMeta.textContent = "✓ Selected as Line " + options.selectedLineNumber;
      } else if (options.overlapsSelected) {
        candidateMeta.textContent = "Alternative candidate · overlaps the selected interpretation";
      } else {
        candidateMeta.textContent = "Non-overlapping candidate";
      }
      if (typeof options.selectionScore === "number") {
        candidateMeta.textContent += " · score " + options.selectionScore.toFixed(2);
      }
      row.appendChild(candidateMeta);
    }

    // 3-column grid: CoMER | SAN | CAN
    var columnsContainer = document.createElement("div");
    columnsContainer.className = "prediction-columns";
    columnsContainer.style.gridTemplateColumns = "repeat(" + _enabledModels.length + ", 1fr)";

    for (var modelIdx = 0; modelIdx < _enabledModels.length; modelIdx++) {
      var key = _enabledModels[modelIdx];
      var labelName = key.charAt(0).toUpperCase() + key.slice(1);
      columnsContainer.appendChild(createModelColumn(labelName, predictions[key]));
    }

    row.appendChild(columnsContainer);

    if (options.replaceExisting) {
      replaceOrAppendRow(row, lineIndex);
    } else {
      _predictionPanel.appendChild(row);
    }
  }

  function createModelColumn(modelName, result) {
    var col = document.createElement("div");
    col.className = "prediction-col";

    // Column header + confidence bar
    var header = document.createElement("div");
    header.className = "prediction-col-header";

    var label = document.createElement("span");
    label.textContent = modelName;
    header.appendChild(label);

    if (result && typeof result.elapsedSeconds === "number") {
      var timeBadge = document.createElement("span");
      timeBadge.className = "prediction-time" + (result.timedOut ? " timed-out" : "");
      timeBadge.textContent = result.elapsedSeconds.toFixed(2) + "s";
      timeBadge.title = result.timedOut ?
        "Recognition exceeded the time limit and was penalized" :
        "Model recognition time";
      header.appendChild(timeBadge);
    }

    // Status indicator dot
    var dot = document.createElement("span");
    dot.className = "prediction-col-dot" +
      (result !== null && !result.timedOut ? " online" : "");
    header.appendChild(dot);

    // Confidence badge
    if (result && result.latex && result.confidence !== undefined) {
      var confBadge = document.createElement("span");
      confBadge.className = "prediction-conf-badge";
      var confPct = Math.round(result.confidence * 100);
      confBadge.textContent = confPct + "%";
      // Color coding
      if (result.confidence >= 0.8) {
        confBadge.className += " conf-high";
      } else if (result.confidence >= 0.4) {
        confBadge.className += " conf-mid";
      } else {
        confBadge.className += " conf-low";
      }
      confBadge.title = "Confidence in top prediction: " + confPct + "%";
      header.appendChild(confBadge);
    }

    col.appendChild(header);

    // Rendered KaTeX output
    var latexDiv = document.createElement("div");
    latexDiv.className = "prediction-latex";

    if (result && result.failed) {
      latexDiv.textContent = "(failed: " + result.error + ")";
      latexDiv.className += " prediction-failed";
    } else if (result && result.timedOut) {
      latexDiv.textContent = "(timed out after " + result.elapsedSeconds.toFixed(2) + "s)";
      latexDiv.className += " prediction-failed";
    } else if (result !== null) {
      if (result.latex) {
        if (typeof katex !== "undefined") {
          try {
            katex.render(result.latex, latexDiv, {
              throwOnError: false,
              displayMode: true
            });
          } catch (e) {
            latexDiv.textContent = result.latex;
          }
        } else {
          latexDiv.textContent = result.latex;
        }
      } else {
        latexDiv.textContent = "(empty)";
      }
    } else {
      latexDiv.textContent = "(failed)";
      latexDiv.className += " prediction-failed";
    }
    col.appendChild(latexDiv);

    // Raw LaTeX string below rendered output
    var rawSpan = document.createElement("span");
    rawSpan.className = "prediction-raw";
    rawSpan.textContent = result && result.timedOut ?
      "Candidate penalty: " + result.selectionPenalty :
      ((result && result.latex) || "(no result)");
    col.appendChild(rawSpan);

    // ── Candidates list ──────────────────────────────────────────────
    if (result && result.candidates && result.candidates.length > 0) {
      var candContainer = document.createElement("div");
      candContainer.className = "candidates-list";

      var candTitle = document.createElement("div");
      candTitle.className = "candidates-title";
      var numCands = result.candidates.length;
      if (numCands === 1) {
        candTitle.textContent = "Greedy decode";
      } else {
        candTitle.textContent = "Top " + numCands + " candidates";
      }
      candContainer.appendChild(candTitle);

      // Only show additional candidates beyond the top one, but always show the
      // top candidate's score for comparison context.
      var showCount = Math.min(result.candidates.length, 6);
      for (var i = 0; i < showCount; i++) {
        var cand = result.candidates[i];
        var candRow = document.createElement("div");
        candRow.className = "candidate-row";

        // Highlight the chosen (top) candidate
        if (i === 0) {
          candRow.className += " candidate-chosen";
        }

        // Rank
        var rankSpan = document.createElement("span");
        rankSpan.className = "candidate-rank";
        rankSpan.textContent = "#" + (i + 1);
        candRow.appendChild(rankSpan);

        // Rendered KaTeX for candidate
        var latexSpan = document.createElement("span");
        latexSpan.className = "candidate-latex";
        latexSpan.title = cand.latex;
        if (typeof katex !== "undefined") {
          try {
            katex.render(cand.latex, latexSpan, {
              throwOnError: false,
              displayMode: false
            });
          } catch (e) {
            latexSpan.textContent = cand.latex;
          }
        } else {
          latexSpan.textContent = cand.latex;
        }
        candRow.appendChild(latexSpan);

        // Score / probability
        var scoreSpan = document.createElement("span");
        scoreSpan.className = "candidate-score";
        if (result.candidates.length > 1 && typeof cand.score === "number") {
          // Multi-candidate: show log-score
          scoreSpan.textContent = cand.score.toFixed(2);
          scoreSpan.title = "Log-probability score";
        } else if (typeof cand.score === "number") {
          // Single candidate (SAN): show confidence
          scoreSpan.textContent = (cand.score * 100).toFixed(1) + "%";
          scoreSpan.title = "Per-step confidence";
        } else {
          scoreSpan.textContent = "\u2014";
        }
        candRow.appendChild(scoreSpan);

        candContainer.appendChild(candRow);
      }

      col.appendChild(candContainer);
    }

    // Copy button for this column
    if (result && result.latex) {
      var copyBtn = document.createElement("button");
      copyBtn.textContent = "\u{1F4CB} Copy";
      copyBtn.className = "prediction-col-copy";
      copyBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(result.latex).then(function () {
            copyBtn.textContent = "\u2713 Copied";
            setTimeout(function () { copyBtn.textContent = "\u{1F4CB} Copy"; }, 2000);
          });
        }
      });
      col.appendChild(copyBtn);
    }

    return col;
  }

  /**
   * Clear all predictions from the panel.
   */
  function clearPredictions() {
    if (typeof AnswerPredictionStore !== "undefined") {
      AnswerPredictionStore.clear();
    }
    if (typeof AnswerCheckController !== "undefined") {
      AnswerCheckController.reset();
    }
    if (_predictionPanel) {
      _predictionPanel.classList.add("active");
      renderEmptyState();
    }
  }

  function clearRecognitionCache() {
    _candidatePredictionCache = {};
  }

  // ── Toast helper ────────────────────────────────────────────────────

  function showToast(msg, isError, type) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.style.display = "block";
    toast.className = "toast" + (isError ? " error" : "") + (type === "success" ? " success" : "");

    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.style.display = "none";
      toast.className = "toast";
    }, 3000);
  }

  // ── Init on load ────────────────────────────────────────────────────

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────
  return {
    recognize: recognize,
    recognizeLines: recognizeLines,
    recognizeCandidateLines: recognizeCandidateLines,
    selectCandidateCover: selectCandidateCover,
    scoreLineCandidate: scoreLineCandidate,
    sendLineToServers: sendLineToServers,
    renderPendingRow: renderPendingRow,
    checkServerHealth: checkServerHealth,
    clearPredictions: clearPredictions,
    clearRecognitionCache: clearRecognitionCache,
    init: init,
    setServerUrl: setServerUrl,
    setEnabledModels: setEnabledModels,
    setRecognitionTimeoutMs: setRecognitionTimeoutMs
  };
})();
