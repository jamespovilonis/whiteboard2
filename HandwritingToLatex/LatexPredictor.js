// LatexPredictor.js - Rasterizes handwritten lines and sends them to the CoMER, SAN, and CAN servers
// for recognition, then displays predicted LaTeX with candidate lists and confidence scores.

var LatexPredictor = (function () {
  var SERVER_URLS = {
    comer: "http://localhost:8000",
    san: "http://localhost:8001",
    can: "http://localhost:8002"
  };
  var _predictionPanel = null;
  var _statusDots = { comer: null, san: null, can: null };
  var _serverHealthOk = { comer: false, san: false, can: false };
  var _recognizing = false; // guard against concurrent recognitions

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Initialize references to DOM elements. Call once on load.
   */
  function init() {
    _predictionPanel = document.getElementById("prediction-panel");
    _statusDots.comer = document.getElementById("serverStatus-comer");
    _statusDots.san = document.getElementById("serverStatus-san");
    _statusDots.can = document.getElementById("serverStatus-can");
    if (_predictionPanel) _predictionPanel.innerHTML = "";
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
    if (_recognizing) {
      showToast("Already recognizing...", false);
      return;
    }

    if (typeof LinesRasterizer === "undefined") {
      showToast("LinesRasterizer not loaded", true);
      return;
    }

    // Check server health first
    if (!isServerOnline("comer") && !isServerOnline("san") && !isServerOnline("can")) {
      showToast("All servers are offline. Start them first.", true);
      return;
    }

    // Get rasterized lines (re-rasterize fresh)
    var lines = LinesRasterizer.rasterizeAllLines();
    if (!lines || lines.length === 0) {
      showToast("No handwriting detected. Draw something first!", false);
      return;
    }

    _recognizing = true;

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
    var promises = processWithConcurrency(lines, 2);

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
  function processWithConcurrency(lines, limit) {
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
          sendLineToServers(lines[i], i).then(function () {
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
    var url = SERVER_URLS[name] + "/health";
    fetch(url, { method: "GET" })
      .then(function (resp) { return resp.json(); })
      .then(function () {
        _serverHealthOk[name] = true;
        updateStatusDot(name, true);
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

  // ── Send one line to the servers ────────────────────────────────────

  function sendLineToServers(lineData, lineIndex) {
    var dataUrl = lineData.dataUrl;
    if (!dataUrl) {
      console.error("Line " + lineIndex + ": empty dataUrl, skipping");
      renderRow(lineIndex, { comer: null, san: null });
      return Promise.resolve(null);
    }

    return fetch(dataUrl)
      .then(function (resp) { return resp.blob(); })
      .then(function (blob) {
        if (!blob || blob.size === 0) {
          throw new Error("Rasterized image is empty (0 bytes)");
        }

        var comerPromise = sendToServer("comer", blob, lineIndex);
        var sanPromise = sendToServer("san", blob, lineIndex);
        var canPromise = sendToServer("can", blob, lineIndex);

        return Promise.all([comerPromise, sanPromise, canPromise]).then(function (results) {
          renderRow(lineIndex, {
            comer: results[0],
            san: results[1],
            can: results[2]
          });
        });
      })
      .catch(function (err) {
        console.error("Line " + lineIndex + " recognition failed:", err);
        renderRow(lineIndex, { comer: null, san: null, can: null });
        return null;
      });
  }

  /**
   * Send image to a single server and return a result object:
   *   { latex: string, candidates: [{latex, score, log_prob?}], confidence: number }
   * or null on failure / server offline.
   */
  function sendToServer(serverName, blob, lineIndex) {
    if (!isServerOnline(serverName)) {
      return Promise.resolve(null);
    }

    var formData = new FormData();
    formData.append("file", blob, "line_" + lineIndex + ".png");

    return fetch(SERVER_URLS[serverName] + "/recognize", { method: "POST", body: formData })
      .then(function (resp) {
        if (!resp.ok) {
          console.warn(serverName + " responded with status " + resp.status);
          return null;
        }
        return resp.json();
      })
      .then(function (data) {
        if (!data) return null;

        var latex = "";
        if (data.top && data.top.latex) {
          latex = data.top.latex;
        } else if (data.candidates && data.candidates.length > 0) {
          latex = data.candidates[0].latex;
        }

        if (!latex) return null;

        var candidates = data.candidates || [];
        var confidence = computeConfidence(candidates);

        return {
          latex: latex,
          candidates: candidates,
          confidence: confidence
        };
      })
      .catch(function (err) {
        console.error(serverName + " recognition failed:", err);
        return null;
      });
  }

  /**
   * Compute a [0,1] confidence for the top candidate.
   *
   * For CoMER (beam search): scores are length-normalized log-probs.
   *   We softmax over the displayed candidates' scores to get the top
   *   candidate's relative probability mass.
   *
   * For SAN (greedy): the score is already a per-step geometric-mean
   *   probability in [0,1]. No transformation needed.
   */
  function computeConfidence(candidates) {
    if (!candidates || candidates.length === 0) return 0;

    // If there is only one candidate, check if its score is already in [0,1].
    // SAN uses greedy decoding with per-step confidence, so scores are
    // already probabilities in (0,1].
    if (candidates.length === 1) {
      var s = candidates[0].score;
      if (typeof s === "number" && s >= 0 && s <= 1) {
        return s;
      }
      // Fallback: single CoMER candidate → always 1.0
      return 1.0;
    }

    // Multi-candidate beam search (CoMER): scores are log-probs.
    // Softmax over the displayed candidates to get relative probability.
    var scores = candidates.map(function (c) { return c.score; });
    var maxScore = Math.max.apply(null, scores);
    var exps = scores.map(function (s) { return Math.exp(s - maxScore); });
    var sumExps = exps.reduce(function (a, b) { return a + b; }, 0);
    if (sumExps <= 0) return 1.0 / candidates.length;
    return exps[0] / sumExps;
  }

  // ── Render predictions in the right panel ───────────────────────────

  function renderRow(lineIndex, predictions) {
    if (!_predictionPanel) return;

    var row = document.createElement("div");
    row.className = "prediction-row";
    row.dataset.lineIndex = lineIndex;

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

    // CoMER column
    var comerCol = createModelColumn("CoMER", predictions.comer);
    columnsContainer.appendChild(comerCol);

    // SAN column
    var sanCol = createModelColumn("SAN", predictions.san);
    columnsContainer.appendChild(sanCol);

    // CAN column
    var canCol = createModelColumn("CAN", predictions.can);
    columnsContainer.appendChild(canCol);

    row.appendChild(columnsContainer);

    _predictionPanel.appendChild(row);
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
          scoreSpan.textContent = "—";
        }
        candRow.appendChild(scoreSpan);

        // Relative probability bar (only for multi-candidate)
        if (result.candidates.length > 1) {
          var relPct = computeRelativeProb(result.candidates, i);
          var barWrap = document.createElement("span");
          barWrap.className = "candidate-prob-bar";
          var bar = document.createElement("span");
          bar.className = "candidate-prob-fill";
          bar.style.width = relPct + "%";
          barWrap.appendChild(bar);
          candRow.appendChild(barWrap);

          var probSpan = document.createElement("span");
          probSpan.className = "candidate-prob-pct";
          probSpan.textContent = Math.round(relPct) + "%";
          probSpan.title = "Relative probability among shown candidates";
          candRow.appendChild(probSpan);
        } else {
          // Placeholder to keep alignment
          var spacer = document.createElement("span");
          spacer.className = "candidate-prob-bar";
          spacer.style.opacity = "0";
          candRow.appendChild(spacer);

          var spacer2 = document.createElement("span");
          spacer2.className = "candidate-prob-pct";
          spacer2.style.opacity = "0";
          spacer2.textContent = "—";
          candRow.appendChild(spacer2);
        }

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
   * Compute relative probability of the i-th candidate among displayed
   * candidates using softmax over their log-prob scores.
   */
  function computeRelativeProb(candidates, idx) {
    if (!candidates || candidates.length <= 1) return 100;
    var scores = candidates.map(function (c) { return c.score; });
    var maxScore = Math.max.apply(null, scores);
    var exps = scores.map(function (s) { return Math.exp(s - maxScore); });
    var sumExps = exps.reduce(function (a, b) { return a + b; }, 0);
    if (sumExps <= 0) return 100 / candidates.length;
    return (exps[idx] / sumExps) * 100;
  }

  /**
   * Clear all predictions from the panel.
   */
  function clearPredictions() {
    if (_predictionPanel) _predictionPanel.innerHTML = "";
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
    checkServerHealth: checkServerHealth,
    clearPredictions: clearPredictions,
    init: init
  };
})();