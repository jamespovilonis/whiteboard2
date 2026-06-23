// LatexPredictor.js - Rasterizes handwritten lines and sends them to a single unified server
// for recognition (CoMER, SAN, or CAN), then displays predicted LaTeX with candidate lists
// and confidence scores.

var LatexPredictor = (function () {
  // ── Configurable server URL ────────────────────────────────────────
  // Default: empty string = same origin (frontend and API on the same server).
  // Override via config.json or ?apiUrl= URL parameter.
  var _serverUrl = "";
  var _predictionPanel = null;
  var _statusDots = { comer: null, san: null, can: null };
  var _serverHealthOk = { comer: false, san: false, can: false };
  var _recognizing = false; // guard against concurrent recognitions
  var _enabledModels = ["comer", "san", "can"];

  // Debounce cooldown (ms) — rapid clicks coalesce into one recognition
  var _lastRecognizeTime = 0;
  var DEBOUNCE_MS = 500;

  // ── Public API ──────────────────────────────────────────────────────

  function setServerUrl(url) {
    _serverUrl = url;
  }

  function setEnabledModels(models) {
    _enabledModels = normalizeModels(models || ["comer", "san", "can"]);
    if (_predictionPanel && !_predictionPanel.querySelector(".prediction-row")) {
      renderEmptyState();
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
    _statusDots.san = document.getElementById("serverStatus-san");
    _statusDots.can = document.getElementById("serverStatus-can");
    if (_predictionPanel) {
      _predictionPanel.classList.add("active");
      renderEmptyState();
    }
    // Do an initial health check right away
    checkServerHealth("comer");
    checkServerHealth("san");
    checkServerHealth("can");
    // Re-check server health every 30 seconds (bounded polling)
    setInterval(function () {
      checkServerHealth("comer");
      checkServerHealth("san");
      checkServerHealth("can");
    }, 30000);
  }

  /**
   * Main recognition entry point. Called from the recognize button click handler.
   */
  function recognize() {
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

    // Process lines with a concurrency limit of 2 to avoid overwhelming the CPU-bound models
    var promises = processWithConcurrency(lines, 2, {
      models: _enabledModels,
      replaceExisting: false
    });

    Promise.all(promises).then(function () {
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

    function worker() {
      return new Promise(function (resolve, reject) {
        function step() {
          var i = nextIdx++;
          if (i >= total) {
            resolve();
            return;
          }
          var lineIndex = lines[i].lineIndex !== undefined ? lines[i].lineIndex : i;
          sendLineToServers(lines[i], lineIndex, options).then(function () {
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
    return workers;
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
    if (!models || models.length === 0) return ["comer", "san", "can"];
    var out = [];
    for (var i = 0; i < models.length; i++) {
      if (models[i] === "comer" || models[i] === "san" || models[i] === "can") {
        out.push(models[i]);
      }
    }
    return out.length > 0 ? out : ["comer", "san", "can"];
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
      renderRow(lineIndex, emptyPredictions(), renderOptions);
      return Promise.resolve(null);
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
          renderRow(lineIndex, predictions, renderOptions);
          return predictions;
        });
      })
      .catch(function (err) {
        console.error("Line " + lineIndex + " recognition failed:", err);
        renderRow(lineIndex, emptyPredictions(), renderOptions);
        return null;
      });
  }

  function recognizeLines(lines, options) {
    options = options || {};
    if (!lines || lines.length === 0) return Promise.resolve([]);

    if (_predictionPanel && options.activatePanel !== false) {
      _predictionPanel.classList.add("active");
      if (options.clearPanel) _predictionPanel.innerHTML = "";
    }

    var limit = options.concurrency || 1;
    var promises = processWithConcurrency(lines, limit, options);
    return Promise.all(promises);
  }

  function renderPendingRow(lineIndex, stage, lineData) {
    if (!_predictionPanel) return;
    _predictionPanel.classList.add("active");
    var emptyState = _predictionPanel.querySelector(".prediction-welcome");
    if (emptyState) emptyState.parentNode.removeChild(emptyState);

    var row = document.createElement("div");
    row.className = "prediction-row prediction-pending";
    row.dataset.lineIndex = lineIndex;
    if (lineData && lineData.signature) row.dataset.signature = lineData.signature;

    var badge = document.createElement("span");
    badge.className = "prediction-badge";
    badge.textContent = "Line " + (lineIndex + 1);
    row.appendChild(badge);

    var msg = document.createElement("div");
    msg.className = "prediction-panel-empty realtime-pending-message";
    msg.textContent = stage || "Checking...";
    row.appendChild(msg);

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

    return fetch(_serverUrl + "/recognize?model=" + modelName, { method: "POST", body: formData })
      .then(function (resp) {
        if (!resp.ok) {
          console.warn(modelName + " responded with status " + resp.status);
          return null;
        }
        return resp.json();
      })
      .then(function (data) {
        if (!data || !data.top) return null;

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
          model: modelName
        };
      })
      .catch(function (err) {
        console.error(modelName + " recognition failed:", err);
        return null;
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
    row.className = "prediction-row";
    row.dataset.lineIndex = lineIndex;
    if (options.signature) row.dataset.signature = options.signature;
    if (options.stage) row.dataset.stage = options.stage;

    // Line number badge (full width top)
    var topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";

    var badge = document.createElement("span");
    badge.className = "prediction-badge";
    badge.textContent = "Line " + (lineIndex + 1);
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

    // Status indicator dot
    var dot = document.createElement("span");
    dot.className = "prediction-col-dot" + (result !== null ? " online" : "");
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

    if (result !== null) {
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
    rawSpan.textContent = (result && result.latex) || "(no result)";
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
    if (_predictionPanel) {
      _predictionPanel.classList.add("active");
      renderEmptyState();
    }
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
    sendLineToServers: sendLineToServers,
    renderPendingRow: renderPendingRow,
    checkServerHealth: checkServerHealth,
    clearPredictions: clearPredictions,
    init: init,
    setServerUrl: setServerUrl,
    setEnabledModels: setEnabledModels
  };
})();
