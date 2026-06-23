#!/usr/bin/env node
/*
 * Targeted tests for RealtimeRecognitionScheduler.
 * Runs under Node using vm so the browser-style global var remains testable.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function loadScheduler() {
  const schedulerPath = path.join(__dirname, "..", "HandwritingToLatex", "RealtimeRecognitionScheduler.js");
  const code = fs.readFileSync(schedulerPath, "utf8");
  const context = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Object,
    Math
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: schedulerPath });
  return context.RealtimeRecognitionScheduler;
}

async function main() {
  const scheduler = loadScheduler();

  scheduler.configure({ enabled: true, idleDelayMs: 0, minRunGapMs: 0, models: ["can"], showPendingRows: false });

  const lineA = { lineIndex: 0, signature: "stroke_a::0,0,10,10", dataUrl: "data:image/png;base64,AA==" };
  const lineAAgain = { lineIndex: 0, signature: "stroke_a::0,0,10,10", dataUrl: "data:image/png;base64,AA==" };
  const lineB = { lineIndex: 1, signature: "stroke_b::0,30,10,40", dataUrl: "data:image/png;base64,AA==" };

  let changed = scheduler.getChangedLines([lineA, lineB]);
  console.log(`Expected changed count before marking: 2 | Got: ${changed.length}`);
  assert.strictEqual(changed.length, 2);

  scheduler.markLinesRecognized([lineA]);
  changed = scheduler.getChangedLines([lineAAgain, lineB]);
  console.log(`Expected changed count after marking line 0: 1 | Got: ${changed.length}`);
  assert.strictEqual(changed.length, 1);
  console.log(`Expected remaining changed line index: 1 | Got: ${changed[0].lineIndex}`);
  assert.strictEqual(changed[0].lineIndex, 1);

  scheduler.resetRecognizedCache();
  changed = scheduler.getChangedLines([lineAAgain]);
  console.log(`Expected changed count after reset: 1 | Got: ${changed.length}`);
  assert.strictEqual(changed.length, 1);

  scheduler.setEnabled(false);
  const beforeVersion = scheduler.getState().documentVersion;
  scheduler.notifyStrokeChange("disabled_test");
  const afterVersion = scheduler.getState().documentVersion;
  console.log(`Expected document version increment while disabled: ${beforeVersion + 1} | Got: ${afterVersion}`);
  assert.strictEqual(afterVersion, beforeVersion + 1);

  console.log("Realtime scheduler targeted tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});