// RealtimeRecognitionScheduler.js
// Pause-aware, near-real-time handwriting recognition scheduler.
//
// The scheduler is intentionally conservative: it waits until the student has
// paused after a stroke/erase/undo/redo, recognizes only changed line images,
// and uses line/document versions so stale responses cannot overwrite newer
// writing.

var RealtimeRecognitionScheduler = (function () {
  var _config = {
    enabled: true,
    idleDelayMs: 1000,
    minRunGapMs: 1200,
    maxConcurrentLines: 1,
    models: ["comer"],
    showPendingRows: true
  };

  var _timer = null;
  var _documentVersion = 0;
  var _lastRunStartedAt = 0;
  var _lastRecognizedSignatureByLine = {};
  var _running = false;
  var _rerunRequested = false;
  var _activeAbortController = null;

  function configure(opts) {
    if (!opts) return getConfig();
    for (var key in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, key)) {
        _config[key] = opts[key];
      }
    }
    if (!_config.models || _config.models.length === 0) {
      _config.models = ["comer"];
    }
    return getConfig();
  }

  function getConfig() {
    return {
      enabled: !!_config.enabled,
      idleDelayMs: _config.idleDelayMs,
      minRunGapMs: _config.minRunGapMs,
      maxConcurrentLines: _config.maxConcurrentLines,
      models: _config.models.slice(),
      showPendingRows: !!_config.showPendingRows
    };
  }

  function setEnabled(enabled) {
    _config.enabled = !!enabled;
    if (!_config.enabled) {
      clearTimeout(_timer);
      _timer = null;
    }
  }

  function notifyStrokeChange(reason) {
    _documentVersion += 1;
    if (typeof IdentifyLine !== "undefined" && IdentifyLine.cancelPendingFlush) {
      IdentifyLine.cancelPendingFlush();
    }
    if (_activeAbortController) {
      try {
        _activeAbortController.abort();
      } catch (error) {
        // Ignore controller state races; the queued rerun below owns recovery.
      }
    }
    if (!_config.enabled) return;

    clearTimeout(_timer);
    _timer = setTimeout(function () {
      runIfIdle(reason || "change", _documentVersion);
    }, Math.max(0, _config.idleDelayMs || 0));
  }

  function resetRecognizedCache() {
    _lastRecognizedSignatureByLine = {};
  }

  function getChangedLines(lines) {
    var changed = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineIndex = line.lineIndex !== undefined ? line.lineIndex : i;
      var signature = line.signature || line.lineId || ("line_" + lineIndex + "_unknown");
      var stableKey = line.candidateId || signature;
      if (_lastRecognizedSignatureByLine[stableKey] !== signature) {
        changed.push(line);
      }
    }
    return changed;
  }

  function markLinesRecognized(lines) {
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineIndex = line.lineIndex !== undefined ? line.lineIndex : i;
      var signature = line.signature || line.lineId || ("line_" + lineIndex + "_unknown");
      var stableKey = line.candidateId || signature;
      _lastRecognizedSignatureByLine[stableKey] = signature;
    }
  }

  function runIfIdle(reason, scheduledVersion) {
    if (!_config.enabled) return Promise.resolve({ skipped: true, reason: "disabled" });
    if (scheduledVersion !== _documentVersion) {
      return Promise.resolve({ skipped: true, reason: "stale_timer" });
    }
    if (typeof IdentifyLine !== "undefined" && IdentifyLine.flushPendingGroups) {
      return Promise.resolve(IdentifyLine.flushPendingGroups()).then(function () {
        if (scheduledVersion !== _documentVersion) {
          return { skipped: true, reason: "stale_segmentation" };
        }
        return runPrepared(reason, scheduledVersion);
      });
    }
    return runPrepared(reason, scheduledVersion);
  }

  function runPrepared(reason, scheduledVersion) {
    if (!_config.enabled) return Promise.resolve({ skipped: true, reason: "disabled" });
    if (scheduledVersion !== _documentVersion) {
      return Promise.resolve({ skipped: true, reason: "stale_timer" });
    }
    if (_running) {
      _rerunRequested = true;
      return Promise.resolve({ skipped: true, reason: "already_running" });
    }
    if (typeof LinesRasterizer === "undefined" || typeof LatexPredictor === "undefined") {
      return Promise.resolve({ skipped: true, reason: "dependencies_missing" });
    }

    var now = Date.now();
    var elapsedSinceRun = now - _lastRunStartedAt;
    if (_lastRunStartedAt && elapsedSinceRun < _config.minRunGapMs) {
      clearTimeout(_timer);
      _timer = setTimeout(function () {
        runIfIdle(reason, _documentVersion);
      }, _config.minRunGapMs - elapsedSinceRun);
      return Promise.resolve({ skipped: true, reason: "cooldown" });
    }

    var lines = LinesRasterizer.rasterizeAllLines();
    if (LatexPredictor.filterLinesForRecognition) {
      lines = LatexPredictor.filterLinesForRecognition(lines);
    }
    var changed = getChangedLines(lines || []);
    if (changed.length === 0) {
      return Promise.resolve({ skipped: true, reason: "unchanged" });
    }

    var runVersion = _documentVersion;
    var runAbortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    _activeAbortController = runAbortController;
    _running = true;
    _lastRunStartedAt = Date.now();

    // Selection needs the complete candidate graph. LatexPredictor caches
    // unchanged candidate recognitions, so only new stroke sets hit CoMER.
    return LatexPredictor.recognizeLines(lines, {
      models: _config.models,
      concurrency: Math.max(1, _config.maxConcurrentLines || 1),
      replaceExisting: true,
      activatePanel: true,
      stage: "realtime",
      abortSignal: runAbortController ? runAbortController.signal : null,
      shouldContinue: function () {
        return runVersion === _documentVersion &&
          (!runAbortController || !runAbortController.signal.aborted);
      },
      shouldRender: function () {
        return runVersion === _documentVersion;
      }
    }).then(function (result) {
      if (runVersion === _documentVersion) {
        markLinesRecognized(lines);
      }
      return {
        skipped: false,
        reason: reason,
        recognizedLineCount: changed.length,
        version: runVersion,
        result: result
      };
    }).finally(function () {
      if (_activeAbortController === runAbortController) {
        _activeAbortController = null;
      }
      _running = false;
      if (_rerunRequested || runVersion !== _documentVersion) {
        _rerunRequested = false;
        notifyStrokeChange("queued_change");
      }
    });
  }

  function getState() {
    return {
      documentVersion: _documentVersion,
      running: _running,
      rerunRequested: _rerunRequested,
      lastRunStartedAt: _lastRunStartedAt,
      recognizedSignatures: Object.assign({}, _lastRecognizedSignatureByLine),
      config: getConfig()
    };
  }

  if (typeof window !== "undefined") {
    window.addEventListener("whiteboard:realtime-config", function (event) {
      if (event && event.detail) configure(event.detail);
    });
  }

  return {
    configure: configure,
    getConfig: getConfig,
    setEnabled: setEnabled,
    notifyStrokeChange: notifyStrokeChange,
    resetRecognizedCache: resetRecognizedCache,
    getChangedLines: getChangedLines,
    markLinesRecognized: markLinesRecognized,
    runIfIdle: runIfIdle,
    getState: getState
  };
})();
