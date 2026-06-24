// Stores the five ranked CoMER predictions for each recognized whiteboard line.
var AnswerPredictionStore = (function () {
  var MAX_CANDIDATES = 5;
  var _linesByIndex = {};

  function normalizeCandidate(candidate, index) {
    candidate = candidate || {};
    return {
      rank: index + 1,
      latex: String(candidate.latex || ""),
      score: typeof candidate.score === "number" ? candidate.score : null,
      confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
      model: "comer"
    };
  }

  function upsertLine(lineIndex, signature, candidates) {
    var normalized = (candidates || []).slice(0, MAX_CANDIDATES).map(normalizeCandidate);
    var record = {
      lineIndex: Number(lineIndex),
      lineId: signature || "line_" + lineIndex,
      signature: signature || "",
      candidates: normalized,
      updatedAt: Date.now()
    };
    _linesByIndex[String(lineIndex)] = record;
    return clone(record);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getLines() {
    return Object.keys(_linesByIndex)
      .map(function (key) { return _linesByIndex[key]; })
      .sort(function (a, b) { return a.lineIndex - b.lineIndex; })
      .map(clone);
  }

  function clear() {
    _linesByIndex = {};
  }

  return {
    MAX_CANDIDATES: MAX_CANDIDATES,
    upsertLine: upsertLine,
    getLines: getLines,
    clear: clear
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = AnswerPredictionStore;
}
