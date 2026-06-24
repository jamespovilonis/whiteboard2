#!/usr/bin/env node

const assert = require("assert");
const path = require("path");

const store = require(path.join(__dirname, "..", "AnswerCheck", "PredictionStore.js"));

store.clear();
const sixCandidates = Array.from({ length: 6 }, (_, index) => ({
  latex: `x=${index}`,
  score: -index,
  confidence: 1 / 6
}));

store.upsertLine(1, "line-b", sixCandidates);
store.upsertLine(0, "line-a", [{ latex: "x=y+z", score: -0.1, confidence: 0.9 }]);

let lines = store.getLines();
assert.deepStrictEqual(lines.map((line) => line.lineIndex), [0, 1]);
assert.strictEqual(lines[1].candidates.length, 5);
assert.deepStrictEqual(lines[1].candidates.map((candidate) => candidate.rank), [1, 2, 3, 4, 5]);
assert.ok(lines[1].candidates.every((candidate) => candidate.model === "comer"));

lines[0].candidates[0].latex = "mutated";
assert.strictEqual(store.getLines()[0].candidates[0].latex, "x=y+z");

store.upsertLine(0, "line-a-v2", [{ latex: "z+y=x" }]);
lines = store.getLines();
assert.strictEqual(lines.length, 2);
assert.strictEqual(lines[0].signature, "line-a-v2");
assert.strictEqual(lines[0].candidates[0].latex, "z+y=x");

store.clear();
assert.deepStrictEqual(store.getLines(), []);
console.log("Prediction store targeted tests passed.");
