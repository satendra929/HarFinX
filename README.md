# HarFinX

**Har**ness for **Fin**ance e**X**perts: an open-source (MIT) AI agent harness for financial workflows, built for analysts working on their own computer. It runs on the Pi agent core (`pi-ai` + `pi-agent-core`), is model-agnostic, and is local-first.

> Early stage (v0.0.1). Expect rough edges. Check any figure against its cited source.

## What it does

- Terminal chat with a local model (through Ollama) about your financial files.
- Two tools: `read_file` reads text files (csv, txt, md, json) from a single workspace folder, and `calculate` is an exact decimal calculator. Excel and PDF are not supported yet.
- Numbers you can trace: the model is told never to do arithmetic itself. Every figure it states should be copied from your file or your question, or come out of `calculate`, which works on numbers copied from the file as printed.
- Guards: one fixed folder, limits per question, and file access switched off for cloud models by default.
- An audit log: every session is written to a local JSONL file.

## Requirements (Windows)

1. **Node.js 22** or newer.
2. **Ollama for Windows**: <https://ollama.com>
3. A model: `ollama pull gemma4:12b` (about 8 GB, the default). `ollama pull qwen3:14b` (about 9 GB; fits a 12 GB GPU at 8k context) also works; see "Choosing a model".
4. A **user environment variable** `OLLAMA_CONTEXT_LENGTH=8192`, then restart Ollama. Without it Ollama silently drops older turns of the conversation.

## Quick start

```
npm install
copy .env.example .env
npm start
```

Put the files you want to work with in `workspace/` (created on first run, and git-ignored), then name them in your question, for example: `Using income-statement.csv, what was the FY2024 operating margin?`

```
npm start                                       # chat
npm start -- "Explain EBITDA in two sentences"  # one-off answer, for scripts
npm test                                        # tests (no model needed)
npm run typecheck
```

Chat commands: `/model` lists or switches the model, `/new` clears the conversation, `exit` quits. Ctrl+C stops a running answer; at the prompt it quits.

## Choosing a model

HarFinX works with local models served by Ollama. Two are set up with short names: `gemma` (`gemma4:12b`, about 8 GB, the default) and `qwen` (`qwen3:14b`, about 9 GB). Any other installed Ollama tag also works by its full name.

- **Per run:** `npm start -- --model qwen` (chat) or `npm start -- --model qwen "your question"` (one answer).
- **In chat:** `/model` lists the installed models and marks the one in use; `/model qwen`, `/model gemma4:12b` or `/model 2` switches for the rest of the session. The conversation continues; `/new` starts a fresh one.
- **As your default:** set `OLLAMA_MODEL=qwen` in `.env`.

A model that is not installed gives the `ollama pull` command to run. Different models can answer differently, so check figures against the source whichever you use.

## The calculator

`calculate` takes numbers copied from the file exactly as printed (`"11,503"`, `"(473)"`, `"3.06%"`) plus expressions, and returns the values to quote. It uses exact decimal arithmetic (no floating-point surprises), rounds half away from zero like Excel, never rounds intermediate values unless asked, and has no `eval`. Functions: `sum avg min max abs round sqrt pow ratio pct_change cagr`, each with a stated definition that the answer should repeat. It warns when an input is not found in the file text read so far or in your question, and when rounding to the requested decimals changes a value by more than 1% (for example a rate shown as `0.1` instead of `10.3%`). Unit words (million, thousand) are rejected on purpose: copy the number as printed and let the calculator convert.

After every answer, HarFinX checks each figure in it and prints one `[check]` line. A figure is traced if it appears in the file the model read, in your question, or in a `calculate` result; years and list numbers are not counted as figures. A dim line means every figure traced. A yellow line lists the figures that could not be traced (for example a number the model took from memory), so you can verify them against the source. This tells you whether a figure is traceable, not whether it is right: a wrong row or period still passes. The check only warns; it never changes or blocks an answer. The same check can be run over saved audit logs (`npm run eval:provenance`).

## Safety

- **One folder.** The harness can access only the folder set by `WORKSPACE_DIR` (default `workspace/`). It is fixed at startup, and the model never supplies it. The harness refuses to start if the folder is a drive root, or is, or contains, your home folder or the project folder.
- **Limits per question.** At most 8 tool calls, 5,000 characters per tool result, and 12,000 characters of file text in total (the calculator is exempt from the text budget). Tool calls are printed as yellow `[guard]` lines, and model text is stripped of terminal escape codes so it cannot imitate them.
- **File contents are untrusted.** A file can contain text that tries to steer the model. The guards limit what the model can reach, not what it says.
- **Cloud models** get no file access unless you set `ALLOW_CLOUD_FILES=1`, because file contents would be sent to the provider.
- **Model quirks are handled.** With local models, the model's earlier reasoning is not sent back to it by default (with Qwen3 it made some answers appear only inside the hidden reasoning; `REASONING_HISTORY` in `.env` changes this). With any model, if a reply finishes with no answer text and no tool call, it is discarded and asked once more, with thinking off where the provider allows it (you will see a `[repair]` line). A reply that loops tool calls is cut off while it streams (a `[stopped]` line) and retried once. A model that stops responding gives a plain-language timeout message.

## Audit log

Every session writes a new file, `audit/session-<timestamp>-<id>.jsonl` (folder set by `AUDIT_DIR`), with one JSON record per line: the system prompt, your question, each model message with token counts, each tool call and result (including the calculator's full-precision values), every guard decision, any repair or cut-off, and how the run ended. The file is append-only and local, and the folder is git-ignored. It contains full questions, answers and file contents, so treat it like your data. If a write fails, the run stops. The harness refuses to start if `AUDIT_DIR` overlaps the workspace, so the model cannot read the log.

## Evaluation

`eval/` holds a small harness for the public FinanceBench open sample, run in "evidence-provided" mode (the evidence passage is given as a file). It downloads the dataset on demand (a public, non-commercial file that is not included here), runs questions through the real CLI, and writes result files for grading plus a provenance report. Scores are not comparable to published FinanceBench numbers.

## Using Claude (optional, paid)

Edit `.env`:

```
PROVIDER=anthropic
ANTHROPIC_API_KEY=<a Console API key>
```

A Claude Pro/Max subscription cannot be used: Anthropic's terms allow subscription logins only in Anthropic's own apps. HarFinX accepts only a Console API key and refuses to start if `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` or an `sk-ant-oat…` key is present. With this provider your prompts go to Anthropic's API. Development and testing currently focus on local models.

## Privacy

Local Ollama keeps everything on your machine, and no identifying headers are sent.

## Layout

- `src/config.ts`: loads `.env`, validates settings
- `src/model.ts`: the single place a provider is chosen
- `src/modelChoice.ts`: short model names, the `--model` flag, the list of installed models
- `src/workspace.ts`: the one allowed folder and confined file reads
- `src/guard.ts`: per-question limits on tool use
- `src/tools/readFile.ts`, `src/tools/calculate.ts`: the two tools
- `src/calc/`: the calculator engine (numbers, parser, evaluator, functions)
- `src/provenance.ts`: classifies the figures in an answer
- `src/check.ts`: the live `[check]` line built on it
- `src/reasoning.ts`: the one place for provider-specific reasoning ("thinking") settings
- `src/payload.ts`, `src/repair.ts`, `src/runaway.ts`, `src/errors.ts`: protections for model quirks and friendly errors
- `src/audit.ts`: the append-only audit log
- `src/cli.ts`: chat loop and one-off mode
- `eval/`: the FinanceBench harness
- `test/`: tests

## License

MIT. See [LICENSE](LICENSE).
