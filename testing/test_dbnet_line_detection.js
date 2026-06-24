#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function stroke(id, xMin, yMin, xMax, yMax) {
  return {
    id,
    canvasBbox: { xMin, yMin, xMax, yMax },
    rawPoints: [],
    outlinePoints: [
      { x: xMin, y: yMin }, { x: xMax, y: yMin },
      { x: xMax, y: yMax }, { x: xMin, y: yMax }
    ]
  };
}

function loadIdentify(strokes, times) {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "CanvasSegmentation", "IdentifyLineDBNet.js"),
    "utf8"
  );
  const context = {
    console,
    Promise,
    Object,
    Math,
    Number,
    isFinite,
    setTimeout,
    clearTimeout,
    strokeSaver: {
      getStrokes: () => strokes,
      strokeStartTimes: new Map(times)
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.IdentifyLineDBNet;
}

const temporalStrokes = [
  stroke("a", 0, 0, 10, 10),
  stroke("b", 100, 0, 110, 10),
  stroke("c", 300, 0, 310, 10)
];
const temporal = loadIdentify(temporalStrokes, [["a", 0], ["b", 500], ["c", 2500]]);
temporal.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10 });
assert.strictEqual(temporal.getLineGroups().length, 2, "strokes within one second form one batch");
assert.strictEqual(temporal.getLineGroups()[0].strokes.length, 2);

const catchmentStrokes = [
  stroke("a", 0, 0, 10, 10),
  stroke("b", 55, 0, 65, 10),
  stroke("c", 110, 0, 120, 10)
];
const catchment = loadIdentify(catchmentStrokes, [["a", 0], ["b", 2000], ["c", 4000]]);
catchment.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10 });
assert.strictEqual(catchment.getLineGroups().length, 1, "catchment merging is transitive");

const lineStrokes = [stroke("top", 0, 0, 20, 10), stroke("bottom", 0, 50, 20, 60)];
const splitter = loadIdentify(lineStrokes, [["top", 0], ["bottom", 100]]);
splitter.configure({ minVerticalOverlapRatio: 0.25 });
const candidate = splitter.getLineGroups()[0];
const split = splitter.splitCandidate(candidate, [
  { bbox: { xMin: 0, yMin: 0, xMax: 20, yMax: 10 } },
  { bbox: { xMin: 0, yMin: 50, xMax: 20, yMax: 60 } }
]);
assert.strictEqual(split.length, 2, "two DBNet bands produce two lines");
assert.deepStrictEqual(Array.from(split[0].strokeIds), ["top"]);
assert.deepStrictEqual(Array.from(split[1].strokeIds), ["bottom"]);

const oneBand = splitter.splitCandidate(candidate, [
  { bbox: { xMin: 0, yMin: 0, xMax: 20, yMax: 60 } }
]);
assert.strictEqual(oneBand.length, 1, "one DBNet band preserves the candidate");
assert.strictEqual(oneBand[0].strokes.length, 2);

const delayedFractionStrokes = [
  stroke("numerator", 290, 200, 310, 230),
  stroke("bar", 270, 242, 330, 248),
  stroke("denominator", 290, 255, 315, 285)
];
const delayedFraction = loadIdentify(delayedFractionStrokes, [
  ["numerator", 0], ["bar", 2500], ["denominator", 2700]
]);
delayedFraction.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10 });
assert.strictEqual(
  delayedFraction.getLineGroups().length,
  1,
  "adaptive catchment merges a fraction completed after a pause"
);
const fractionCandidate = delayedFraction.getLineGroups()[0];
const fractionDetections = [
  { bbox: { xMin: 288, yMin: 198, xMax: 312, yMax: 232 } },
  { bbox: { xMin: 285, yMin: 253, xMax: 318, yMax: 287 } }
];
const protectedFraction = delayedFraction.splitCandidate(fractionCandidate, fractionDetections);
assert.strictEqual(protectedFraction.length, 1, "fraction bridge prevents vertical splitting");
assert.strictEqual(protectedFraction[0].strokes.length, 3);

const alternatives = splitter.candidateAlternatives(candidate, [
  { bbox: { xMin: 0, yMin: 0, xMax: 20, yMax: 10 } },
  { bbox: { xMin: 0, yMin: 50, xMax: 20, yMax: 60 } }
]);
assert.strictEqual(alternatives.length, 3, "whole candidate is retained beside two split lines");
assert.strictEqual(alternatives[0].strokes.length, 2);

// Full lifecycle: recognize one line, add an overlapping second line, then
// alter the first line. New merged stroke sets must produce new DBNet keys,
// while unchanged split children retain stable identities.
const lifecycleStrokes = [stroke("equation_one", 0, 0, 120, 18)];
const lifecycleTimes = [["equation_one", 0]];
const lifecycle = loadIdentify(lifecycleStrokes, lifecycleTimes);
lifecycle.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10 });
const firstBase = lifecycle.buildBaseCandidates()[0];
const firstKey = lifecycle.candidateCacheKey(firstBase);
const firstId = firstBase.candidateId;

lifecycleStrokes.push(stroke("equation_two", 5, 27, 125, 45));
lifecycleTimes.push(["equation_two", 2500]);
// The VM's timing map was copied at load time; use explicit stroke timestamps
// for subsequent lifecycle additions.
lifecycleStrokes[1].startTime = 2500;
lifecycleStrokes[1].endTime = 2600;
const mergedBase = lifecycle.buildBaseCandidates()[0];
assert.strictEqual(mergedBase.strokes.length, 2, "overlapping second line merges with saved box");
assert.notStrictEqual(lifecycle.candidateCacheKey(mergedBase), firstKey, "merged box forces a new DBNet key");

const mergedAlternatives = lifecycle.candidateAlternatives(mergedBase, [
  { bbox: { xMin: 0, yMin: 0, xMax: 120, yMax: 18 } },
  { bbox: { xMin: 5, yMin: 27, xMax: 125, yMax: 45 } }
]);
assert.strictEqual(mergedAlternatives.length, 3);
assert.strictEqual(mergedAlternatives[1].candidateId, firstId, "unchanged original line keeps its identity");

lifecycleStrokes.push(stroke("equation_one_edit", 30, 4, 45, 14));
lifecycleStrokes[2].startTime = 5000;
lifecycleStrokes[2].endTime = 5100;
const alteredBase = lifecycle.buildBaseCandidates()[0];
assert.notStrictEqual(
  lifecycle.candidateCacheKey(alteredBase),
  lifecycle.candidateCacheKey(mergedBase),
  "altering a merged box forces DBNet to run again"
);
const alteredAlternatives = lifecycle.candidateAlternatives(alteredBase, [
  { bbox: { xMin: 0, yMin: 0, xMax: 120, yMax: 18 } },
  { bbox: { xMin: 5, yMin: 27, xMax: 125, yMax: 45 } }
]);
assert.ok(
  alteredAlternatives[1].strokeIds.includes("equation_one_edit"),
  "altered line receives a new stroke signature for CoMER"
);
assert.strictEqual(
  alteredAlternatives[2].candidateId,
  mergedAlternatives[2].candidateId,
  "unaltered neighboring line keeps its CoMER cache identity"
);

const eliminationStrokes = [];
const eliminationTimes = [];
for (let row = 0; row < 5; row++) {
  for (let glyph = 0; glyph < 3; glyph++) {
    const id = `row_${row}_glyph_${glyph}`;
    eliminationStrokes.push(stroke(id, glyph * 18, row * 27, glyph * 18 + 12, row * 27 + 18));
    eliminationTimes.push([id, row * 100 + glyph * 20]);
  }
}
const elimination = loadIdentify(eliminationStrokes, eliminationTimes);
elimination.configure({ minVerticalOverlapRatio: 0.25 });
const eliminationCandidate = elimination.getLineGroups()[0];
const underSegmentedDbnet = [
  { bbox: { xMin: 0, yMin: 0, xMax: 48, yMax: 18 } },
  { bbox: { xMin: 0, yMin: 27, xMax: 48, yMax: 45 } },
  { bbox: { xMin: 0, yMin: 54, xMax: 48, yMax: 72 } },
  { bbox: { xMin: 0, yMin: 81, xMax: 48, yMax: 126 } }
];
const refinedRows = elimination.chooseLineBands(
  eliminationCandidate,
  elimination.clusterDetections(underSegmentedDbnet)
);
assert.strictEqual(refinedRows.length, 5, "vector rows refine four DBNet bands into five algebra lines");
const eliminationAlternatives = elimination.candidateAlternatives(
  eliminationCandidate,
  underSegmentedDbnet
);
assert.strictEqual(eliminationAlternatives.length, 6, "five rows plus one unsplit safety candidate");
assert.ok(eliminationAlternatives.slice(1).every((line) => line.profiles[0] === "dbnet-line"));

const denseStepStrokes = [
  stroke("r0_2", 132, 112, 184, 156),
  stroke("r0_x", 202, 112, 258, 158),
  stroke("r0_plus", 278, 103, 330, 158),
  stroke("r0_3", 354, 111, 410, 158),
  stroke("r0_eq_top", 434, 111, 484, 119),
  stroke("r0_eq_bottom", 434, 126, 483, 134),
  stroke("r0_11a", 514, 105, 550, 158),
  stroke("r0_11b", 560, 105, 597, 158),
  stroke("r1_minus_left", 183, 187, 208, 192),
  stroke("r1_3_left", 226, 164, 276, 206),
  stroke("r1_minus_right", 304, 183, 329, 188),
  stroke("r1_3_right", 352, 164, 397, 206),
  stroke("r2_2", 175, 230, 232, 279),
  stroke("r2_x", 252, 229, 306, 278),
  stroke("r2_eq_top", 318, 237, 368, 245),
  stroke("r2_eq_bottom", 317, 252, 367, 260),
  stroke("r2_8", 392, 227, 444, 279),
  stroke("r3_div_left", 201, 289, 248, 347),
  stroke("r3_2_left", 255, 294, 312, 345),
  stroke("r3_div_right", 329, 285, 376, 346),
  stroke("r3_2_right", 384, 296, 437, 346),
  stroke("r4_x", 231, 356, 291, 403),
  stroke("r4_eq_top", 307, 357, 357, 366),
  stroke("r4_eq_bottom", 307, 372, 356, 381),
  stroke("r4_4", 384, 355, 437, 403)
];
const denseStepTimes = denseStepStrokes.map((item, index) => [item.id, index * 10]);
const denseSteps = loadIdentify(denseStepStrokes, denseStepTimes);
denseSteps.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const denseStepCandidate = denseSteps.getLineGroups()[0];
const denseUnderSegmentedDbnet = [
  { bbox: { xMin: 119, yMin: 83, xMax: 612, yMax: 215 } },
  { bbox: { xMin: 159, yMin: 202, xMax: 460, yMax: 418 } }
];
assert.strictEqual(
  denseSteps.containsFractionBridge(
    denseStepCandidate,
    denseSteps.clusterDetections(denseUnderSegmentedDbnet)
  ),
  false,
  "short equals/minus bars do not protect a dense algebra stack as a fraction"
);
const denseStepSplit = denseSteps.splitCandidate(denseStepCandidate, denseUnderSegmentedDbnet);
assert.strictEqual(denseStepSplit.length, 5, "dense algebra with intermediate steps splits into five rows");
assert.strictEqual(
  JSON.stringify(denseStepSplit.map((line) => line.strokes.length)),
  JSON.stringify([8, 4, 5, 4, 4]),
  "dense split preserves the intended row memberships"
);

const interleavedDenseOrder = [
  "r0_2", "r2_2", "r4_x", "r1_minus_left", "r3_div_left",
  "r0_x", "r2_x", "r4_eq_top", "r1_3_left", "r3_2_left",
  "r0_plus", "r2_eq_top", "r4_eq_bottom", "r1_minus_right", "r3_div_right",
  "r0_3", "r2_eq_bottom", "r4_4", "r1_3_right", "r3_2_right",
  "r0_eq_top", "r2_8", "r0_eq_bottom", "r0_11a", "r0_11b"
];
const denseById = Object.fromEntries(denseStepStrokes.map((item) => [item.id, item]));
const interleavedDenseStrokes = interleavedDenseOrder.map((id) => denseById[id]);
for (let i = 0; i < interleavedDenseStrokes.length; i++) {
  interleavedDenseStrokes[i].startTime = i * 160;
  interleavedDenseStrokes[i].endTime = i * 160 + 20;
}
const interleavedDense = loadIdentify(
  interleavedDenseStrokes,
  interleavedDenseStrokes.map((item, index) => [item.id, index * 160])
);
interleavedDense.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const interleavedCandidate = interleavedDense.buildBaseCandidates()[0];
const interleavedSplit = interleavedDense.splitCandidate(interleavedCandidate, denseUnderSegmentedDbnet);
assert.strictEqual(
  interleavedSplit.length,
  5,
  "dense algebra splits into rows even when strokes are drawn in interleaved temporal order"
);

const fractionWithRhsStrokes = [
  stroke("frac_num_x", 122, 100, 148, 128),
  stroke("frac_num_minus", 154, 112, 182, 117),
  stroke("frac_num_one", 190, 98, 212, 130),
  stroke("frac_bar", 110, 145, 228, 152),
  stroke("frac_den_x", 122, 166, 148, 194),
  stroke("frac_den_plus", 154, 166, 182, 194),
  stroke("frac_den_one", 190, 164, 212, 196),
  stroke("frac_eq_top", 252, 130, 300, 138),
  stroke("frac_eq_bottom", 252, 150, 300, 158),
  stroke("frac_rhs_5", 326, 122, 360, 178)
];
const fractionWithRhs = loadIdentify(
  fractionWithRhsStrokes,
  fractionWithRhsStrokes.map((item, index) => [item.id, index * 10])
);
fractionWithRhs.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const fractionWithRhsCandidate = fractionWithRhs.getLineGroups()[0];
const fractionWithRhsDetections = [
  { bbox: { xMin: 118, yMin: 96, xMax: 216, yMax: 132 } },
  { bbox: { xMin: 118, yMin: 162, xMax: 216, yMax: 198 } },
  { bbox: { xMin: 248, yMin: 122, xMax: 364, yMax: 180 } }
];
assert.strictEqual(
  fractionWithRhs.splitCandidate(fractionWithRhsCandidate, fractionWithRhsDetections).length,
  1,
  "stacked fraction with right-hand side remains one math line"
);

console.log("DBNet line detection tests passed.");
