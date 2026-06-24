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
const alteredBases = lifecycle.buildBaseCandidates();
const alteredBase = alteredBases.find((item) => item.strokeIds.includes("equation_one_edit"));
const unchangedBase = alteredBases.find((item) => item.strokeIds.includes("equation_two"));
assert.ok(alteredBase, "child anchor catches edits to the changed line");
assert.ok(unchangedBase, "sibling line remains a separate child anchor");
assert.strictEqual(
  JSON.stringify(unchangedBase.strokeIds),
  JSON.stringify(["equation_two"]),
  "new writing near one child anchor does not pull in its sibling"
);
assert.notStrictEqual(
  lifecycle.candidateCacheKey(alteredBase),
  lifecycle.candidateCacheKey(mergedBase),
  "altering one child anchor forces DBNet to run on that local row"
);
assert.ok(
  alteredBase.strokeIds.includes("equation_one_edit"),
  "altered line receives a new stroke signature for CoMER"
);
assert.strictEqual(
  unchangedBase.candidateId,
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

const exponentStrokes = [
  stroke("exp_x1", 100, 110, 132, 150),
  stroke("exp_3", 132, 78, 150, 100),
  stroke("exp_plus", 170, 122, 204, 140),
  stroke("exp_x2", 230, 110, 262, 150),
  stroke("exp_2", 262, 78, 280, 100)
];
const exponents = loadIdentify(exponentStrokes, exponentStrokes.map((item, index) => [item.id, index * 10]));
exponents.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const exponentCandidate = exponents.getLineGroups()[0];
const exponentDbnetBands = [
  { bbox: { xMin: 130, yMin: 74, xMax: 282, yMax: 104 } },
  { bbox: { xMin: 96, yMin: 108, xMax: 206, yMax: 152 } },
  { bbox: { xMin: 228, yMin: 108, xMax: 264, yMax: 152 } }
];
assert.strictEqual(
  exponents.splitCandidate(exponentCandidate, exponentDbnetBands).length,
  1,
  "multiple superscripts attach to the expression instead of forming a separate line"
);

const exponentAndLineStrokes = exponentStrokes
  .map((item) => stroke(item.id, item.canvasBbox.xMin, item.canvasBbox.yMin, item.canvasBbox.xMax, item.canvasBbox.yMax))
  .concat([
    stroke("below_2", 105, 190, 135, 232),
    stroke("below_x", 150, 190, 184, 232),
    stroke("below_eq_top", 204, 202, 244, 210),
    stroke("below_eq_bottom", 204, 218, 244, 226),
    stroke("below_8", 270, 190, 304, 232)
  ]);
const exponentAndLine = loadIdentify(
  exponentAndLineStrokes,
  exponentAndLineStrokes.map((item, index) => [item.id, index * 10])
);
exponentAndLine.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const exponentAndLineCandidate = exponentAndLine.getLineGroups()[0];
const exponentAndLineSplit = exponentAndLine.splitCandidate(exponentAndLineCandidate, [
  { bbox: { xMin: 130, yMin: 74, xMax: 282, yMax: 104 } },
  { bbox: { xMin: 96, yMin: 108, xMax: 282, yMax: 152 } },
  { bbox: { xMin: 104, yMin: 188, xMax: 306, yMax: 234 } }
]);
assert.strictEqual(exponentAndLineSplit.length, 2, "scripts merge into their expression while the next algebra row remains split");
assert.ok(exponentAndLineSplit[0].strokeIds.includes("exp_3"));
assert.ok(exponentAndLineSplit[0].strokeIds.includes("exp_2"));
assert.ok(exponentAndLineSplit[1].strokeIds.includes("below_x"));

const operatorLimitStrokes = [
  stroke("sum_upper_n", 110, 74, 132, 96),
  stroke("sum_upper_5", 138, 72, 158, 98),
  stroke("sum_symbol", 98, 102, 164, 176),
  stroke("sum_lower_i", 112, 184, 124, 210),
  stroke("sum_lower_eq", 128, 192, 150, 204),
  stroke("sum_lower_1", 156, 184, 172, 212),
  stroke("sum_x", 188, 124, 226, 166),
  stroke("sum_plus", 248, 134, 282, 154),
  stroke("sum_2", 306, 122, 338, 168)
];
const operatorLimits = loadIdentify(operatorLimitStrokes, operatorLimitStrokes.map((item, index) => [item.id, index * 10]));
operatorLimits.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const operatorLimitCandidate = operatorLimits.getLineGroups()[0];
const operatorLimitSplit = operatorLimits.splitCandidate(operatorLimitCandidate, [
  { bbox: { xMin: 108, yMin: 70, xMax: 160, yMax: 100 } },
  { bbox: { xMin: 96, yMin: 100, xMax: 340, yMax: 178 } },
  { bbox: { xMin: 110, yMin: 182, xMax: 174, yMax: 214 } }
]);
assert.strictEqual(
  operatorLimitSplit.length,
  1,
  "summation/integral-style limits stay with the expression instead of becoming lines"
);

const underlinedOperationStrokes = [
  stroke("top_2", 100, 100, 132, 142),
  stroke("top_x", 146, 100, 180, 142),
  stroke("top_minus", 198, 120, 232, 126),
  stroke("top_1", 246, 98, 270, 144),
  stroke("top_eq_top", 292, 112, 334, 120),
  stroke("top_eq_bottom", 292, 128, 334, 136),
  stroke("top_19a", 356, 98, 380, 144),
  stroke("top_19b", 388, 100, 420, 144),
  stroke("op_plus_left", 202, 158, 230, 182),
  stroke("op_1_left", 242, 152, 262, 188),
  stroke("op_plus_right", 332, 158, 360, 182),
  stroke("op_1_right", 372, 152, 392, 188),
  stroke("op_underline_left", 198, 196, 266, 202),
  stroke("op_underline_right", 328, 196, 396, 202),
  stroke("bottom_2", 110, 230, 142, 272),
  stroke("bottom_x", 156, 230, 190, 272),
  stroke("bottom_eq_top", 214, 242, 256, 250),
  stroke("bottom_eq_bottom", 214, 258, 256, 266),
  stroke("bottom_20a", 280, 230, 312, 272),
  stroke("bottom_20b", 320, 230, 352, 272)
];
const underlinedOperation = loadIdentify(
  underlinedOperationStrokes,
  underlinedOperationStrokes.map((item, index) => [item.id, index * 10])
);
underlinedOperation.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const underlinedOperationCandidate = underlinedOperation.getLineGroups()[0];
const underlinedOperationSplit = underlinedOperation.splitCandidate(underlinedOperationCandidate, [
  { bbox: { xMin: 98, yMin: 96, xMax: 422, yMax: 146 } },
  { bbox: { xMin: 198, yMin: 150, xMax: 396, yMax: 190 } },
  { bbox: { xMin: 196, yMin: 194, xMax: 398, yMax: 204 } },
  { bbox: { xMin: 108, yMin: 228, xMax: 354, yMax: 274 } }
]);
assert.strictEqual(
  underlinedOperationSplit.length,
  3,
  "underlined in-between algebra is split as work rows, not protected as a fraction"
);
assert.ok(underlinedOperationSplit[1].strokeIds.includes("op_underline_left"));
assert.ok(underlinedOperationSplit[1].strokeIds.includes("op_underline_right"));
assert.ok(!underlinedOperationSplit[0].strokeIds.includes("op_plus_left"));
assert.ok(!underlinedOperationSplit[2].strokeIds.includes("op_plus_right"));

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
const denseAlternatives = denseSteps.candidateAlternatives(denseStepCandidate, denseUnderSegmentedDbnet);
assert.strictEqual(denseAlternatives.length, 6, "parent fallback is retained beside dense child rows");
assert.strictEqual(denseSteps.getSegmentationAnchors().length, 5, "clean DBNet splits persist child anchors");

denseStepStrokes.push(stroke("r2_edit", 458, 230, 486, 240));
denseStepStrokes[denseStepStrokes.length - 1].startTime = 5000;
denseStepStrokes[denseStepStrokes.length - 1].endTime = 5020;
const rowEditCandidates = denseSteps.buildBaseCandidates();
assert.strictEqual(rowEditCandidates.length, 5, "editing one dense row keeps sibling anchors separate");
const rowTwoEdit = rowEditCandidates.find((item) => item.strokeIds.includes("r2_edit"));
assert.ok(rowTwoEdit, "new writing near row 2 merges into row 2 anchor");
assert.strictEqual(rowTwoEdit.strokeIds.length, 6, "row 2 candidate contains only its original row plus the edit");
assert.ok(rowEditCandidates.some((item) => item.strokeIds.length === 8 && item.strokeIds.includes("r0_2")));
assert.ok(rowEditCandidates.some((item) => item.strokeIds.length === 4 && item.strokeIds.includes("r1_3_left")));

const denseBridgeStrokes = denseStepStrokes
  .filter((item) => item.id !== "r2_edit")
  .map((item) => stroke(item.id, item.canvasBbox.xMin, item.canvasBbox.yMin, item.canvasBbox.xMax, item.canvasBbox.yMax));
const denseBridge = loadIdentify(
  denseBridgeStrokes,
  denseBridgeStrokes.map((item, index) => [item.id, index * 10])
);
denseBridge.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const denseBridgeCandidate = denseBridge.getLineGroups()[0];
denseBridge.candidateAlternatives(denseBridgeCandidate, denseUnderSegmentedDbnet);
denseBridgeStrokes.push(stroke("bridge_r1_r2", 280, 209, 360, 224));
denseBridgeStrokes[denseBridgeStrokes.length - 1].startTime = 5000;
denseBridgeStrokes[denseBridgeStrokes.length - 1].endTime = 5020;
const bridgedCandidates = denseBridge.buildBaseCandidates();
const bridgedRows = bridgedCandidates.find((item) => item.strokeIds.includes("bridge_r1_r2"));
assert.ok(bridgedRows, "bridge stroke produces a local compound candidate");
assert.strictEqual(bridgedRows.strokeIds.length, 10, "bridge merges only the two nearby child rows plus new ink");
assert.ok(bridgedRows.strokeIds.includes("r1_3_left"));
assert.ok(bridgedRows.strokeIds.includes("r2_2"));
assert.strictEqual(bridgedCandidates.length, 4, "only the bridged rows are re-compounded for DBNet");

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
interleavedDense.candidateAlternatives(interleavedCandidate, denseUnderSegmentedDbnet);
interleavedDenseStrokes.push(stroke("interleaved_r2_edit", 458, 230, 486, 240));
interleavedDenseStrokes[interleavedDenseStrokes.length - 1].startTime = 6000;
interleavedDenseStrokes[interleavedDenseStrokes.length - 1].endTime = 6020;
const interleavedEditCandidates = interleavedDense.buildBaseCandidates();
assert.strictEqual(interleavedEditCandidates.length, 5, "interleaved stroke order still uses child anchors");
assert.strictEqual(
  interleavedEditCandidates.find((item) => item.strokeIds.includes("interleaved_r2_edit")).strokeIds.length,
  6,
  "interleaved row edit merges into the intended child anchor"
);

const reverseDenseStrokes = denseBridgeStrokes
  .filter((item) => item.id !== "bridge_r1_r2")
  .map((item) => stroke(item.id, item.canvasBbox.xMin, item.canvasBbox.yMin, item.canvasBbox.xMax, item.canvasBbox.yMax))
  .reverse();
for (let i = 0; i < reverseDenseStrokes.length; i++) {
  reverseDenseStrokes[i].startTime = i * 10;
  reverseDenseStrokes[i].endTime = i * 10 + 5;
}
const reverseDense = loadIdentify(
  reverseDenseStrokes,
  reverseDenseStrokes.map((item, index) => [item.id, index * 10])
);
reverseDense.configure({ idleDelayMs: 1000, horizontalPadding: 50, verticalPadding: 10, minVerticalOverlapRatio: 0.25 });
const reverseCandidate = reverseDense.buildBaseCandidates()[0];
assert.strictEqual(reverseDense.splitCandidate(reverseCandidate, denseUnderSegmentedDbnet).length, 5);
reverseDense.candidateAlternatives(reverseCandidate, denseUnderSegmentedDbnet);
reverseDenseStrokes.push(stroke("reverse_r2_edit", 458, 230, 486, 240));
reverseDenseStrokes[reverseDenseStrokes.length - 1].startTime = 6000;
reverseDenseStrokes[reverseDenseStrokes.length - 1].endTime = 6020;
const reverseEditCandidates = reverseDense.buildBaseCandidates();
assert.strictEqual(reverseEditCandidates.length, 5, "reverse temporal order still uses child anchors");
assert.strictEqual(
  reverseEditCandidates.find((item) => item.strokeIds.includes("reverse_r2_edit")).strokeIds.length,
  6,
  "reverse-order row edit merges into the intended child anchor"
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
fractionWithRhs.candidateAlternatives(fractionWithRhsCandidate, fractionWithRhsDetections);
assert.strictEqual(fractionWithRhs.getSegmentationAnchors().length, 1, "fraction stores one whole-candidate anchor");
assert.strictEqual(fractionWithRhs.getSegmentationAnchors()[0].strokeIds.length, 10);

console.log("DBNet line detection tests passed.");
