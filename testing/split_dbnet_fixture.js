#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function usage() {
  console.error("Usage: node testing/split_dbnet_fixture.js BOARD_JSON DBNET_JSON [order]");
  console.error("Orders: line-order, reverse-lines, interleaved-lines");
  process.exit(2);
}

const boardPath = process.argv[2];
const dbnetPath = process.argv[3];
const order = process.argv[4] || "line-order";
if (!boardPath || !dbnetPath) usage();

function bbox(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys)
  };
}

function contoursForOrder(lines, mode) {
  if (mode === "line-order") {
    return lines.flatMap((line, lineIndex) =>
      line.contours.map((contour) => ({ contour, lineIndex })));
  }
  if (mode === "reverse-lines") {
    return lines.slice().reverse().flatMap((line, reverseIndex) => {
      const lineIndex = lines.length - 1 - reverseIndex;
      return line.contours.map((contour) => ({ contour, lineIndex }));
    });
  }
  if (mode === "interleaved-lines") {
    const maxContours = Math.max(...lines.map((line) => line.contours.length));
    const ordered = [];
    for (let contourIndex = 0; contourIndex < maxContours; contourIndex++) {
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const contour = lines[lineIndex].contours[contourIndex];
        if (contour) ordered.push({ contour, lineIndex });
      }
    }
    return ordered;
  }
  throw new Error(`Unknown order mode: ${mode}`);
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

const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
const dbnet = JSON.parse(fs.readFileSync(dbnetPath, "utf8"));
const orderedContours = contoursForOrder(board.lines, order);
const strokes = [];
const times = [];

for (let index = 0; index < orderedContours.length; index++) {
  const item = orderedContours[index];
  const id = `fixture_${index + 1}`;
  const box = bbox(item.contour);
  const startTime = index * 120;
  strokes.push({
    id,
    canvasBbox: box,
    rawPoints: item.contour,
    outlinePoints: item.contour,
    syntheticLineIndex: item.lineIndex,
    startTime,
    endTime: startTime + 20
  });
  times.push([id, startTime]);
}

const identify = loadIdentify(strokes, times);
identify.configure({
  idleDelayMs: 1000,
  horizontalPadding: 50,
  verticalPadding: 10,
  minVerticalOverlapRatio: 0.25
});

const baseCandidates = identify.buildBaseCandidates();
const splits = [];
for (const candidate of baseCandidates) {
  const split = identify.splitCandidate(candidate, dbnet.detections || []);
  for (const line of split) {
    splits.push(line);
  }
}

const bands = identify.clusterDetections(dbnet.detections || []);
const output = {
  order,
  expectedLines: board.lines.length,
  rawDetections: (dbnet.detections || []).length,
  dbnetBands: bands.length,
  baseCandidates: baseCandidates.length,
  splitCandidates: splits.length,
  splitStrokeCounts: splits.map((line) => line.strokes.length),
  splitBboxes: splits.map((line) => line.tightBbox),
  splitSyntheticLineSets: splits.map((line) => {
    return Array.from(new Set(line.strokes.map((stroke) => stroke.syntheticLineIndex))).sort();
  })
};

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
