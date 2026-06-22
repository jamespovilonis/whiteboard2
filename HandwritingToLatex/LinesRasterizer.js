// LinesRasterizer.js
// Rasterizes each line group identified by IdentifyLine.js into standalone canvas images.
// Each rasterized line is a cropped + padded PNG of the ink within that line's bounding box.
// Includes caching: reuses rasterized lines when strokes haven't changed since last recognition.

var LinesRasterizer = (function () {
  var _rasterizedLines = [];
  var _padding = 20; // px padding around tight bbox of each line

  // ── Cache system ───────────────────────────────────────────────────
  // Key: "lineIndex_totalStrokeCount"
  // Value: { dataUrl, canvasImage }  (cached rasterization result)
  var _cache = {};

  function clearCache() {
    _cache = {};
  }

  /**
   * Compute a cache key from the current stroke state.
   * If strokes change, all cached entries become invalid.
   */
  function getStrokeCountKey() {
    if (typeof strokeSaver !== "undefined" && strokeSaver) {
      return strokeSaver.getStrokes().length;
    }
    return -1; // sentinel: no strokes available yet
  }

  /**
   * Check if the cache is still valid for the current stroke state.
   */
  function isCacheValid() {
    // Cache is always valid as long as the total stroke count hasn't changed.
    // The first line (index 0) captures this globally — if stroke count
    // matches, none of the lines' strokes could have changed either.
    return _cache["0_strokeCount"] !== undefined;
  }

  // ── public ──────────────────────────────────────────────────────
  function setPadding(px) {
    _padding = Math.max(0, px | 0);
  }

  function getRasterizedLines() {
    return _rasterizedLines.slice();
  }

  function clear() {
    _rasterizedLines = [];
  }

  // ── core ────────────────────────────────────────────────────────

  /**
   * Rasterize one line group into an offscreen <canvas>.
   */
  function rasterizeLine(strokes, tightBbox) {
    var minX = Math.floor(tightBbox.xMin);
    var minY = Math.floor(tightBbox.yMin);
    var maxX = Math.ceil(tightBbox.xMax);
    var maxY = Math.ceil(tightBbox.yMax);

    var cw = (maxX - minX) + 2 * _padding;
    var ch = (maxY - minY) + 2 * _padding;

    if (cw <= 0 || ch <= 0) cw = ch = 1;

    // Scale canvas by devicePixelRatio so the rasterized PNG has the same
    // resolution as the on-screen rendering.
    var dpr = window.devicePixelRatio || 1;

    var canvas = document.createElement("canvas");
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);

    // Translate so the tight bbox origin maps to (padding, padding)
    ctx.translate(_padding - minX, _padding - minY);

    // Draw each stroke's outline polygon onto this canvas.
    // Always render in black (#000000) for maximum-contrast ink.
    for (var i = 0; i < strokes.length; i++) {
      var stroke = strokes[i];
      var outline = stroke.outlinePoints;
      if (!outline || outline.length < 3) continue;

      ctx.beginPath();
      ctx.moveTo(outline[0].x, outline[0].y);
      for (var j = 1; j < outline.length; j++) {
        ctx.lineTo(outline[j].x, outline[j].y);
      }
      ctx.closePath();

      ctx.fillStyle = "#000000";
      ctx.fill();
    }

    var dataUrl = canvas.toDataURL("image/png");

    return {
      canvasImage: canvas,
      dataUrl: dataUrl,
      bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY },
      padding: _padding
    };
  }

  /**
   * Rasterize all line groups currently tracked by IdentifyLine.
   * Uses caching to skip re-rasterizing unchanged lines.
   * @returns {Array} array of { lineIndex, canvasImage, dataUrl, bbox, padding }
   */
  function rasterizeAllLines() {
    clear();

    // Access IdentifyLine's internal strokeGroups (array of { strokes, tightBbox })
    var groups = null;
    if (typeof IdentifyLine !== "undefined" && IdentifyLine.getLineGroups) {
      groups = IdentifyLine.getLineGroups();
    }

    if (!groups || groups.length === 0) return _rasterizedLines;

    // Check cache: first line in group always exists and its key stores stroke count
    var hasCachedFirstLine = _cache["0_strokeCount"] !== undefined;

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var strokeCount = getStrokeCountKey();
      var cacheKey = i + "_strokeCount_" + strokeCount;

      if (_cache[cacheKey]) {
        // Cache hit: use cached rasterization
        var item = _cache[cacheKey];
        item.lineIndex = i;
        _rasterizedLines.push(item);
      } else {
        // Cache miss: re-rasterize
        var result = rasterizeLine(group.strokes, group.tightBbox);
        result.lineIndex = i;

        // Cache the result using stroke count as version key
        _cache[cacheKey] = {
          dataUrl: result.dataUrl,
          canvasImage: result.canvasImage
        };

        _rasterizedLines.push(result);
      }
    }

    // Store the current stroke count in the first line's cache key for validation
    if (_rasterizedLines.length > 0) {
      _cache["0_strokeCount"] = strokeCount;
    }

    return _rasterizedLines;
  }

  // ── debug visualization ────────────────────────────────────────
  var _debugContainer = null;

  function ensureDebugContainer() {
    if (_debugContainer && _debugContainer.parentNode) return _debugContainer;

    _debugContainer = document.createElement("div");
    _debugContainer.id = "lines-rasterizer-debug";
    _debugContainer.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:9999;" +
      "background:#fff;border:1px solid #ccc;border-radius:6px;padding:12px;" +
      "max-width:90vw;max-height:80vh;overflow:auto;font-family:sans-serif;font-size:12px;";

    var title = document.createElement("div");
    title.style.cssText = "font-weight:bold;margin-bottom:6px;color:#333;";
    title.textContent = "Lines Rasterizer (debug)";
    _debugContainer.appendChild(title);

    // Close button
    var closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = "float:right;background:none;border:none;font-size:16px;cursor:pointer;color:#999;";
    closeBtn.onclick = function () {
      _debugContainer.parentNode.removeChild(_debugContainer);
      _debugContainer = null;
    };
    title.appendChild(closeBtn);

    var info = document.createElement("div");
    info.id = "rasterizer-info";
    info.style.cssText = "margin-bottom:8px;color:#666;";
    _debugContainer.appendChild(info);

    // Thumbnails container
    var thumbWrap = document.createElement("div");
    thumbWrap.id = "rasterizer-thumbs";
    thumbWrap.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";
    _debugContainer.appendChild(thumbWrap);

    document.body.appendChild(_debugContainer);
    return _debugContainer;
  }

  function renderDebugThumbnails() {
    var info = document.getElementById("rasterizer-info");
    var thumbWrap = document.getElementById("rasterizer-thumbs");

    if (!info || !thumbWrap) return;

    info.textContent = "Rasterized lines: " + _rasterizedLines.length;
    thumbWrap.innerHTML = "";

    for (var i = 0; i < _rasterizedLines.length; i++) {
      var item = _rasterizedLines[i];

      // Thumbnail canvas (scaled down preview)
      var srcCanvas = item.canvasImage;
      var previewMaxW = 200;
      var scale = Math.min(1, previewMaxW / srcCanvas.width);
      var pw = Math.round(srcCanvas.width * scale);
      var ph = Math.round(srcCanvas.height * scale);

      var thumb = document.createElement("canvas");
      thumb.width = pw;
      thumb.height = ph;
      thumb.style.cssText = "border:1px solid #aaa;border-radius:3px;background:#fff;display:block;";
      thumb.getContext("2d").drawImage(srcCanvas, 0, 0, pw, ph);

      var label = document.createElement("div");
      label.style.cssText = "text-align:center;font-size:11px;margin-top:4px;color:#555;";
      label.textContent =
        "Line " + item.lineIndex + " (" + srcCanvas.width + "x" + srcCanvas.height + ")";

      var wrapper = document.createElement("div");
      wrapper.style.cssText = "text-align:center;";
      wrapper.appendChild(thumb);
      wrapper.appendChild(label);
      thumbWrap.appendChild(wrapper);
    }
  }

  // ── auto-trigger: rasterize after each finalizeStroke ────────────
  function registerAutoRasterize() {
    if (typeof IdentifyLine !== "undefined" && IdentifyLine.finalizeStroke) {
      var orig = IdentifyLine.finalizeStroke;
      if (!orig._rasterizerWrapped) {
        // Wrap the existing finalizeStroke to also rasterize
        IdentifyLine.finalizeStroke = function () {
          var result = orig.apply(this, arguments);
          rasterizeAllLines();
          return result;
        };
        IdentifyLine.finalizeStroke._rasterizerWrapped = true;
      }
    }
  }

  // ── keyboard trigger: press 'L' to manually rasterize ───────────
  document.addEventListener("keydown", function (e) {
    if (e.key === "l" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var tag = document.activeElement?.tagName || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      var lines = rasterizeAllLines();
      ensureDebugContainer();
      renderDebugThumbnails();
    }
  });

  // Auto-register on load if IdentifyLine is already available
  registerAutoRasterize();

  // ── expose public API ───────────────────────────────────────────
  return {
    rasterizeAllLines: rasterizeAllLines,
    getRasterizedLines: getRasterizedLines,
    clear: clear,
    clearCache: clearCache,
    setPadding: setPadding,
    registerAutoRasterize: registerAutoRasterize,
    renderDebugThumbnails: renderDebugThumbnails
  };
})();
