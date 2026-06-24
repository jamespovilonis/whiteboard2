# AnswerCheck

The whiteboard stores the five highest-ranked unique CoMER candidates for every
recognized line. The final line is treated as the submitted answer. Each of its
five candidates is compared with the reviewed answer in `questions.py`; any
semantic match produces `Correct`.

The default checker is deterministic and local. It normalizes common CoMER
LaTeX, parses expressions with SymPy, compares equation residuals, accepts
nonzero constant scalings, and compares real solution sets for univariate
equations.

Gemma is only a fallback for candidates the deterministic parser cannot
understand. It is disabled by default. Enable it when the local Ollama service
is running:

```sh
ANSWER_CHECK_OLLAMA_FALLBACK=1 bash server/start_server.sh
```

The default fallback model is `gemma4:e2b`. Override it with
`ANSWER_CHECK_OLLAMA_MODEL` or override the endpoint with
`ANSWER_CHECK_OLLAMA_URL`.
