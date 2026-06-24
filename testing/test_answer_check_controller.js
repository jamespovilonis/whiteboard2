#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const resultElement = { hidden: true, className: "answer-check-result", textContent: "" };
const questionElement = { textContent: "" };
const promptElement = { dataset: { questionId: "simple_x_equals_yz" } };
const requests = [];
const localValues = {};
const context = {
  console,
  Promise,
  JSON,
  localStorage: {
    getItem(key) { return localValues[key] || null; },
    setItem(key, value) { localValues[key] = value; }
  },
  document: {
    getElementById(id) {
      if (id === "answer-check-result") return resultElement;
      if (id === "equation-question") return questionElement;
      return null;
    },
    querySelector(selector) {
      return selector === ".equation-prompt" ? promptElement : null;
    }
  },
  AnswerPredictionStore: {
    getLines() {
      return [{ lineIndex: 0, candidates: [{ rank: 1, latex: "z+y=x" }] }];
    }
  },
  fetch(url, options) {
    requests.push({ url, options });
    if (url.endsWith("/answer-check/questions/random")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: "simple_exponent",
          prompt: "Write c as the sum of a squared and b squared."
        })
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ correct: true, matchedRank: 1 })
    });
  }
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "AnswerCheck", "AnswerCheckController.js"), "utf8"),
  context
);

async function main() {
  context.AnswerCheckController.setServerUrl("http://localhost:8000");
  const question = await context.AnswerCheckController.loadRandomQuestion();
  assert.strictEqual(question.id, "simple_exponent");
  assert.strictEqual(promptElement.dataset.questionId, "simple_exponent");
  assert.strictEqual(questionElement.textContent, "Write c as the sum of a squared and b squared.");
  assert.strictEqual(localValues["whiteboard.previousQuestionId"], "simple_exponent");

  const response = await context.AnswerCheckController.check();
  assert.strictEqual(response.correct, true);
  assert.strictEqual(resultElement.textContent, "Correct");
  assert.strictEqual(resultElement.className, "answer-check-result correct");
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[1].url, "http://localhost:8000/answer-check");
  const payload = JSON.parse(requests[1].options.body);
  assert.strictEqual(payload.questionId, "simple_exponent");
  assert.strictEqual(payload.lines[0].candidates[0].latex, "z+y=x");

  context.AnswerCheckController.reset();
  assert.strictEqual(resultElement.hidden, true);
  console.log("Answer check controller targeted tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
