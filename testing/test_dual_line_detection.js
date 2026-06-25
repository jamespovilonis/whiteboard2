#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function stroke(id, xMin, yMin, xMax, yMax) {
  return {
    id,
    canvasBbox: { xMin, yMin, xMax, yMax },
    rawPoints: [],
    outlinePoints: []
  };
}

function loadIdentifyLine(strokes) {
  const filename = path.join(__dirname, "..", "CanvasSegmentation", "IdentifyLine.js");
  const context = {
    strokeSaver: { getStrokes: () => strokes },
    console,
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.IdentifyLine;
}

function loadPredictor() {
  const filename = path.join(__dirname, "..", "HandwritingToLatex", "LatexPredictor.js");
  const context = { console, setTimeout, clearTimeout, Promise, Date, Math, Object };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.LatexPredictor;
}

function lineData(id, strokeIds, profiles, bbox) {
  return {
    candidateId: id,
    signature: id,
    strokeIds,
    profiles,
    strokeCount: strokeIds.length,
    medianStrokeHeight: 25,
    tightBbox: bbox || { xMin: 0, yMin: 0, xMax: 50, yMax: 25 }
  };
}

function prediction(latex, score) {
  return {
    comer: {
      latex,
      candidates: [{ latex, score, confidence: 1 }],
      confidence: 1,
      timedOut: false,
      selectionPenalty: 0
    }
  };
}

function main() {
  const ratioProbe = loadIdentifyLine([]);
  const boxA = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 };
  const boxAtThreshold = { xMin: 0, yMin: 8.5, xMax: 10, yMax: 18.5 };
  const boxBelowThreshold = { xMin: 0, yMin: 8.51, xMax: 10, yMax: 18.51 };
  const boxDisjoint = { xMin: 0, yMin: 11, xMax: 10, yMax: 21 };
  const ratioAtThreshold = ratioProbe.verticalOverlapRatio(boxA, boxAtThreshold);
  assert.ok(Math.abs(ratioAtThreshold - 0.15) < 1e-9);
  assert.ok(ratioProbe.verticalOverlapRatio(boxA, boxBelowThreshold) < 0.15);
  assert.strictEqual(ratioProbe.verticalOverlapRatio(boxA, boxDisjoint), 0);
  assert.strictEqual(
    ratioProbe.verticalOverlapRatio(boxA, boxAtThreshold),
    ratioProbe.verticalOverlapRatio(boxAtThreshold, boxA),
    "vertical overlap ratio must be symmetric"
  );
  assert.strictEqual(
    ratioProbe.verticalOverlapRatio(
      { xMin: 0, yMin: 0, xMax: 10, yMax: 100 },
      { xMin: 0, yMin: 85, xMax: 10, yMax: 105 }
    ),
    0.75,
    "ratio must be normalized by the smaller bbox height"
  );

  const thresholdIdentify = loadIdentifyLine([
    stroke("threshold-a", 0, 0, 10, 10),
    stroke("threshold-b", 12, 8.5, 22, 18.5)
  ]);
  thresholdIdentify.groupStrokesIntoLines();
  assert.strictEqual(thresholdIdentify.getLinePartitions().strict.length, 1,
    "the exact configured threshold should merge");

  const belowThresholdIdentify = loadIdentifyLine([
    stroke("below-a", 0, 0, 10, 10),
    stroke("below-b", 12, 8.51, 22, 18.51)
  ]);
  belowThresholdIdentify.groupStrokesIntoLines();
  assert.strictEqual(belowThresholdIdentify.getLinePartitions().strict.length, 2,
    "overlap below the configured threshold should remain split");

  const separated = [
    stroke("top", 10, 20, 200, 60),
    stroke("below", 20, 70, 65, 100)
  ];
  const identify = loadIdentifyLine(separated);
  identify.groupStrokesIntoLines();
  const partitions = identify.getLinePartitions();
  const candidates = identify.getLineCandidates();

  assert.strictEqual(partitions.loose.length, 1, "loose view should merge catchment boxes");
  assert.strictEqual(partitions.strict.length, 2, "strict view should split disjoint ink bands");
  assert.strictEqual(candidates.length, 3, "union should contain one loose and two strict candidates");
  assert.ok(candidates.some((candidate) => candidate.conflicts.length === 2));

  const sameBand = [
    stroke("a", 10, 20, 35, 60),
    stroke("b", 40, 25, 65, 55)
  ];
  const identifySame = loadIdentifyLine(sameBand);
  identifySame.groupStrokesIntoLines();
  const deduped = identifySame.getLineCandidates();
  assert.strictEqual(deduped.length, 1, "identical loose/strict stroke sets should deduplicate");
  assert.deepStrictEqual(Array.from(deduped[0].profiles).sort(), ["loose", "strict"]);

  const predictor = loadPredictor();
  const timedOutLoose = {
    comer: {
      latex: "",
      candidates: [],
      confidence: 0,
      timedOut: true,
      selectionPenalty: -1000
    }
  };
  const timeoutEntries = [
    {
      lineData: lineData("loose", ["a", "b"], ["loose"],
        { xMin: 0, yMin: 0, xMax: 100, yMax: 80 }),
      predictions: timedOutLoose
    },
    { lineData: lineData("strict-a", ["a"], ["strict"]), predictions: prediction("x=1", -1) },
    { lineData: lineData("strict-b", ["b"], ["strict"]), predictions: prediction("x=2", -1) }
  ];
  const timeoutSelection = predictor.selectCandidateCover(timeoutEntries);
  assert.deepStrictEqual(
    Array.from(timeoutSelection, (entry) => entry.lineData.candidateId).sort(),
    ["strict-a", "strict-b"]
  );

  const blobEntries = [
    {
      lineData: lineData("blob", ["a", "b"], ["loose"],
        { xMin: 0, yMin: 0, xMax: 120, yMax: 90 }),
      predictions: prediction("x 1 2", -1)
    },
    { lineData: lineData("row-a", ["a"], ["strict"]), predictions: prediction("x=1", -1) },
    { lineData: lineData("row-b", ["b"], ["strict"]), predictions: prediction("x=2", -1) }
  ];
  const blobSelection = predictor.selectCandidateCover(blobEntries);
  assert.deepStrictEqual(
    Array.from(blobSelection, (entry) => entry.lineData.candidateId).sort(),
    ["row-a", "row-b"]
  );

  const fractionEntries = [
    {
      lineData: lineData("fraction", ["n", "bar", "d"], ["loose"],
        { xMin: 0, yMin: 0, xMax: 80, yMax: 80 }),
      predictions: prediction("\\frac { 1 } { 2 }", -1)
    },
    { lineData: lineData("numerator", ["n"], ["strict"]), predictions: prediction("1", -1) },
    { lineData: lineData("bar", ["bar"], ["strict"]), predictions: prediction("-", -1) },
    { lineData: lineData("denominator", ["d"], ["strict"]), predictions: prediction("2", -1) }
  ];
  const fractionSelection = predictor.selectCandidateCover(fractionEntries);
  assert.deepStrictEqual(
    Array.from(fractionSelection, (entry) => entry.lineData.candidateId),
    ["fraction"]
  );

  const dbnetParentIds = ["r1", "r2", "r3", "r4", "r5"];
  const dbnetEntries = [{
    lineData: lineData("dbnet-parent", dbnetParentIds, ["dbnet-parent"],
      { xMin: 0, yMin: 0, xMax: 140, yMax: 150 }),
    predictions: prediction("3x-5=16+5+5", -0.5)
  }];
  for (let dbnetRow = 0; dbnetRow < dbnetParentIds.length; dbnetRow++) {
    dbnetEntries.push({
      lineData: lineData(
        "dbnet-row-" + dbnetRow,
        [dbnetParentIds[dbnetRow]],
        ["dbnet-line"],
        { xMin: 0, yMin: dbnetRow * 30, xMax: 100, yMax: dbnetRow * 30 + 20 }
      ),
      predictions: prediction(dbnetRow === 4 ? "x=7" : "x=x", -8)
    });
  }
  const dbnetSelection = predictor.selectCandidateCover(dbnetEntries);
  assert.deepStrictEqual(
    Array.from(dbnetSelection, (entry) => entry.lineData.candidateId).sort(),
    ["dbnet-row-0", "dbnet-row-1", "dbnet-row-2", "dbnet-row-3", "dbnet-row-4"],
    "a five-row DBNet cover must beat the unsplit parent even with weak line scores"
  );
  const dbnetRecognitionLines = predictor.filterLinesForRecognition(
    dbnetEntries.map((entry) => entry.lineData)
  );
  assert.deepStrictEqual(
    Array.from(dbnetRecognitionLines, (line) => line.candidateId).sort(),
    ["dbnet-row-0", "dbnet-row-1", "dbnet-row-2", "dbnet-row-3", "dbnet-row-4"],
    "CoMER recognition should skip the DBNet parent once child lines cover it"
  );

  console.log("Dual line detection and global selection tests passed.");
}

main();
