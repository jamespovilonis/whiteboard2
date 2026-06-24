// Sends stored CoMER candidates to the lightweight semantic checker.
var AnswerCheckController = (function () {
  var _serverUrl = "";
  var _questionId = "simple_x_equals_yz";
  var _requestVersion = 0;
  var _questionLoadPromise = null;

  function setServerUrl(url) {
    _serverUrl = url || "";
  }

  function setQuestionId(questionId) {
    if (_questionId !== questionId) _questionLoadPromise = null;
    _questionId = questionId;
  }

  function applyQuestion(question) {
    var element = typeof document === "undefined" ? null : document.getElementById("equation-question");
    if (element && question && question.prompt) element.textContent = question.prompt;
    var prompt = typeof document === "undefined" ? null : document.querySelector(".equation-prompt");
    if (prompt && question && question.id) prompt.dataset.questionId = question.id;
    if (question && question.id) _questionId = question.id;
    return question;
  }

  function loadQuestion() {
    if (_questionLoadPromise) return _questionLoadPromise;
    _questionLoadPromise = fetch(_serverUrl + "/answer-check/questions/" + encodeURIComponent(_questionId))
      .then(function (response) {
        if (!response.ok) throw new Error("Question endpoint returned " + response.status);
        return response.json();
      })
      .then(applyQuestion)
      .catch(function (error) {
        // The reviewed prompt is also present in the initial HTML, so a failed
        // metadata request does not prevent the whiteboard from being used.
        console.error("Question loading failed:", error);
        return null;
      });
    return _questionLoadPromise;
  }

  function loadRandomQuestion() {
    if (_questionLoadPromise) return _questionLoadPromise;
    var previousQuestionId = null;
    if (typeof localStorage !== "undefined") {
      previousQuestionId = localStorage.getItem("whiteboard.previousQuestionId");
    }
    var url = _serverUrl + "/answer-check/questions/random";
    if (previousQuestionId) url += "?exclude=" + encodeURIComponent(previousQuestionId);
    _questionLoadPromise = fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error("Random question endpoint returned " + response.status);
        return response.json();
      })
      .then(function (question) {
        if (question && question.id && typeof localStorage !== "undefined") {
          localStorage.setItem("whiteboard.previousQuestionId", question.id);
        }
        return applyQuestion(question);
      })
      .catch(function (error) {
        console.error("Random question loading failed:", error);
        return null;
      });
    return _questionLoadPromise;
  }

  function resultElement() {
    return typeof document === "undefined" ? null : document.getElementById("answer-check-result");
  }

  function render(status) {
    var element = resultElement();
    if (!element) return;
    element.hidden = false;
    element.className = "answer-check-result " + status;
    element.textContent = status === "checking" ? "Checking…" :
      (status === "correct" ? "Correct" : "Incorrect");
  }

  function reset() {
    _requestVersion += 1;
    var element = resultElement();
    if (!element) return;
    element.hidden = true;
    element.className = "answer-check-result";
    element.textContent = "";
  }

  function check() {
    if (typeof AnswerPredictionStore === "undefined") return Promise.resolve(null);
    var lines = AnswerPredictionStore.getLines();
    if (!lines.length) {
      reset();
      return Promise.resolve(null);
    }

    var version = ++_requestVersion;
    render("checking");
    return fetch(_serverUrl + "/answer-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: _questionId, lines: lines })
    }).then(function (response) {
      if (!response.ok) throw new Error("Answer checker returned " + response.status);
      return response.json();
    }).then(function (result) {
      if (version !== _requestVersion) return result;
      render(result && result.correct ? "correct" : "incorrect");
      return result;
    }).catch(function (error) {
      if (version === _requestVersion) render("incorrect");
      console.error("Answer checking failed:", error);
      return null;
    });
  }

  return {
    setServerUrl: setServerUrl,
    setQuestionId: setQuestionId,
    loadQuestion: loadQuestion,
    loadRandomQuestion: loadRandomQuestion,
    check: check,
    reset: reset
  };
})();
