// StrokeSmoother.js
// Optimized perfect-freehand stroke smoothing.
// Produces smooth, pressure-sensitive outlines from raw pointer input.

// ════════════════════════════════════════════════════════════════════
//  CONFIGURABLE PARAMETERS  (edit these to tune the stroke feel)
// ════════════════════════════════════════════════════════════════════
var SMOOTHER_DEFAULTS = {
  size: 12,              // base stroke width in CSS pixels
  thinning: 0.5,        // how much pressure affects width (0 = none, 1 = full)
  smoothing: 0.7,       // Catmull-Rom tension (0 = tight to original, 1 = max curve)
  streamline: 0.7,      // moving-average jitter reduction (0 = none, 0.99 = max lag)
  startTaper: 1,        // number of points to taper at the start (0 = no taper)
  endTaper: 1,          // number of points to taper at the end (0 = no taper)
  cap: true,            // whether to draw rounded caps at stroke ends
};
// ════════════════════════════════════════════════════════════════════

function StrokeSmoother(options) {
  this.opts = {};
  var defaults = SMOOTHER_DEFAULTS;
  for (var key in defaults) {
    if (defaults.hasOwnProperty(key)) {
      this.opts[key] = (options && options.hasOwnProperty(key)) ? options[key] : defaults[key];
    }
  }
}

// ----- public smoothing entry point -----
// points: array of {x, y, pressure} in canvas coordinates
// returns: array of {x, y} forming a closed polygon (suitable for ctx.fill())
StrokeSmoother.prototype.smooth = function (points) {
  if (!points || points.length < 2) return [];

  var opts = this.opts;

  // 1. Clone input points
  var pts = new Array(points.length);
  for (var i = 0; i < points.length; i++) {
    pts[i] = { x: points[i].x, y: points[i].y, pressure: points[i].pressure || 0.5 };
  }

  // 2. Streamline – exponential moving average to reduce jitter
  if (opts.streamline > 0 && pts.length > 1) {
    streamlinePoints(pts, opts.streamline);
  }

  // 3. Catmull-Rom spline interpolation for smooth curves
  if (opts.smoothing > 0 && pts.length > 2) {
    pts = catmullRomSpline(pts, opts.smoothing);
  }

  // 4. Compute thickness per point based on pressure and thinning
  var thicknessResult = computeThicknesses(pts, opts);
  var thicknesses = thicknessResult.array;
  var startFullThickness = thicknessResult.startFull;
  var endFullThickness = thicknessResult.endFull;

  // 5. Build outline (left + right chains with perpendicular offsets)
  var outline = buildOutline(pts, thicknesses, opts, startFullThickness, endFullThickness);

  return outline;
};

// ----- streamline: exponential moving average (in-place) -----
function streamlinePoints(pts, amount) {
  var factor = 1 - amount;
  for (var i = 1; i < pts.length; i++) {
    var prev = pts[i - 1];
    var curr = pts[i];
    curr.x = prev.x + (curr.x - prev.x) * factor;
    curr.y = prev.y + (curr.y - prev.y) * factor;
  }
}

// ----- Catmull-Rom spline: produces smooth curves through all control points -----
// Returns a dense array of interpolated points that form a smooth curve.
function catmullRomSpline(pts, tension) {
  var numSegments = pts.length - 1;
  // Adaptive sampling: more segments for longer strokes, scaled by tension
  var samplesPerSegment = Math.max(2, Math.round(4 + tension * 8));
  var totalPoints = numSegments * samplesPerSegment + 1;
  var result = new Array(totalPoints);

  for (var i = 0; i < numSegments; i++) {
    var p0 = pts[Math.max(0, i - 1)];
    var p1 = pts[i];
    var p2 = pts[i + 1];
    var p3 = pts[Math.min(pts.length - 1, i + 2)];

    for (var j = 0; j < samplesPerSegment; j++) {
      var t = j / samplesPerSegment;
      var t2 = t * t;
      var t3 = t2 * t;

      // Catmull-Rom interpolation formula
      var x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );

      var y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );

      var pressure = p1.pressure + (p2.pressure - p1.pressure) * t;

      var idx = i * samplesPerSegment + j;
      result[idx] = { x: x, y: y, pressure: pressure };
    }
  }

  // Last point
  var last = pts[pts.length - 1];
  result[totalPoints - 1] = { x: last.x, y: last.y, pressure: last.pressure };

  return result;
}

// ----- compute thickness for each point -----
function computeThicknesses(pts, opts) {
  var baseSize = opts.size;
  var thinning = opts.thinning;
  var startTaper = opts.startTaper;
  var endTaper = opts.endTaper;
  var len = pts.length;

  var thicknesses = new Array(len);

  // Compute the full (pre-taper) thickness for the first and last points,
  // to be used for the semicircular caps so they aren't shrunk by tapering.
  var startFull = baseSize * (0.5 + ((pts[0].pressure || 0.5) - 0.5) * Math.max(0, thinning));
  startFull = Math.max(startFull, baseSize * 0.1);
  var endFull = baseSize * (0.5 + ((pts[len - 1].pressure || 0.5) - 0.5) * Math.max(0, thinning));
  endFull = Math.max(endFull, baseSize * 0.1);

  for (var i = 0; i < len; i++) {
    var p = pts[i];
    var t = 0.5; // default (mid) pressure

    // Base thickness from pressure, scaled by thinning factor
    if (thinning > 0) {
      var pVal = p.pressure || 0.5;
      t = 0.5 + (pVal - 0.5) * thinning;
      t = Math.max(0.1, Math.min(1, t));
    }

    var thickness = baseSize * t;

    // Apply taper at ends
    if (startTaper > 0 && i < startTaper) {
      thickness *= i / startTaper;
    }
    if (endTaper > 0 && i >= len - endTaper) {
      thickness *= (len - 1 - i) / endTaper;
    }

    // Ensure minimum thickness for visibility
    if (thickness < 0.5) thickness = 0.5;

    thicknesses[i] = thickness;
  }

  return { array: thicknesses, startFull: startFull, endFull: endFull };
}

// ----- build the outline polygon from points and per-point thicknesses -----
function buildOutline(pts, thicknesses, opts, startFullThickness, endFullThickness) {
  var len = pts.length;
  if (len < 2) return [];

  // Pre-allocate arrays
  var left = new Array(len);
  var right = new Array(len);

  for (var i = 0; i < len; i++) {
    var half = thicknesses[i] / 2;

    // Compute normalized perpendicular direction
    var px, py;
    if (i === 0) {
      var dx = pts[1].x - pts[0].x;
      var dy = pts[1].y - pts[0].y;
      var mag = Math.sqrt(dx * dx + dy * dy) || 1;
      px = -dy / mag;
      py = dx / mag;
    } else if (i === len - 1) {
      var dx = pts[i].x - pts[i - 1].x;
      var dy = pts[i].y - pts[i - 1].y;
      var mag = Math.sqrt(dx * dx + dy * dy) || 1;
      px = -dy / mag;
      py = dx / mag;
    } else {
      // Average incoming and outgoing segment normals for smoother transitions
      var dx1 = pts[i].x - pts[i - 1].x;
      var dy1 = pts[i].y - pts[i - 1].y;
      var mag1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
      var px1 = -dy1 / mag1;
      var py1 = dx1 / mag1;

      var dx2 = pts[i + 1].x - pts[i].x;
      var dy2 = pts[i + 1].y - pts[i].y;
      var mag2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
      var px2 = -dy2 / mag2;
      var py2 = dx2 / mag2;

      // Average and re-normalize
      px = (px1 + px2) * 0.5;
      py = (py1 + py2) * 0.5;
      var mag = Math.sqrt(px * px + py * py) || 1;
      px /= mag;
      py /= mag;
    }

    // Left edge: perpendicular offset to the "left" of direction
    left[i] = { x: pts[i].x + px * half, y: pts[i].y + py * half };
    // Right edge: offset to the "right" (negative perpendicular)
    right[i] = { x: pts[i].x - px * half, y: pts[i].y - py * half };
  }

  // Build the full outline polygon
  var outline = [];
  var capSegs = opts.cap ? 8 : 0;

  // Start with the left chain
  for (var i = 0; i < len; i++) {
    outline.push(left[i]);
  }

  // End cap: semicircle bulging forward (along stroke direction)
  if (capSegs > 0 && len > 1) {
    var lastHalf = endFullThickness / 2;
    if (lastHalf > 0.5) {
      // direction at the last point
      var edx = pts[len - 1].x - pts[len - 2].x;
      var edy = pts[len - 1].y - pts[len - 2].y;
      var eAngle = Math.atan2(edy, edx);
      addCap(outline, pts[len - 1], lastHalf, eAngle, false, capSegs);
    }
  }

  // Add the right chain in reverse
  for (var i = len - 1; i >= 0; i--) {
    outline.push(right[i]);
  }

  // Start cap: semicircle bulging backward (opposite stroke direction)
  if (capSegs > 0 && len > 1) {
    var firstHalf = startFullThickness / 2;
    if (firstHalf > 0.5) {
      // direction at the first point
      var sdx = pts[1].x - pts[0].x;
      var sdy = pts[1].y - pts[0].y;
      var sAngle = Math.atan2(sdy, sdx);
      addCap(outline, pts[0], firstHalf, sAngle, true, capSegs);
    }
  }

  return outline;
}

// ----- add a semicircular cap at a given center point -----
// directionAngle: the stroke direction angle at the endpoint (radians, from atan2)
// isStart: true for start cap (bulges backward), false for end cap (bulges forward)
function addCap(outline, center, radius, directionAngle, isStart, segments) {
  var startAngle, endAngle;

  if (isStart) {
    // Start cap: sweep from right side through backward to left side.
    //   right side = directionAngle - PI/2,  left side = directionAngle + PI/2
    // Add 2*PI to right side so the clockwise sweep (-PI) reaches left side via backward.
    startAngle = directionAngle - Math.PI / 2 + 2 * Math.PI; // = directionAngle + 3*PI/2
    endAngle   = directionAngle + Math.PI / 2;
  } else {
    // End cap: sweep from left side through forward to right side.
    //   left side = directionAngle + PI/2,  right side = directionAngle - PI/2
    startAngle = directionAngle + Math.PI / 2;
    endAngle   = directionAngle - Math.PI / 2;
  }

  for (var i = 0; i <= segments; i++) {
    var angle = startAngle + (endAngle - startAngle) * (i / segments);
    outline.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    });
  }
}

// ----- helper to render the outline onto a canvas context -----
StrokeSmoother.prototype.render = function (ctx, outline, color) {
  if (!outline || outline.length < 3) return;

  ctx.beginPath();
  ctx.moveTo(outline[0].x, outline[0].y);
  for (var i = 1; i < outline.length; i++) {
    ctx.lineTo(outline[i].x, outline[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
};