# HarFinX

**Har**ness for **Fin**ance e**X**perts: an open-source (MIT) AI agent harness for financial workflows, built for analysts working on their own computer. It runs on the Pi agent core (`pi-ai` + `pi-agent-core`), is model-agnostic, and is local-first.

> Early stage (v0.0.1). Expect rough edges. Check any figure against its cited source.

## What it does

- **Chat about your files.** A terminal chat with a local model (through Ollama) that can read the files in one workspace folder. The current implementation relies on local models; support for larger remote models through an API key is under development (see below).
- **Filings.** Ask questions about PDF filings and reports (10-K, 10-Q, earnings releases). The agent finds the right pages, reads them, and cites the file and page. Text-based PDFs only; Excel and HTML filings are not supported yet.
- **Exact arithmetic.** The model never does maths itself. A decimal calculator does it, on numbers copied from your file, with standard definitions for common measures such as margins, liquidity and leverage ratios, growth rates and free cash flow.
- **Traceable figures.** Every figure in an answer should be a quote from a page the model read, a calculator result, or a number from your question. Each is marked with a citation that shows where it came from.
- **Optional skills.** You can add your own procedures as plain Markdown files (the open Agent Skills format), for example how you like two filings compared. The model loads one only when the task matches. Skills contain instructions only: no code, no extra tools, and they cannot change any safety rule.
- **Safe by default.** One fixed read-only workspace folder, limits on every question, no file access for cloud models, and a local audit log of every session.

## How it compares

Same question, three tools, 15 Nov 2026: *Which business segment of 3M was the most profitable in 2022?* The harness had the 3M 2022 10-K in its workspace.

![Google, Bing and HarFinX answering the same question](assets/comparison-3m-segment.png)

| | Answer | Checked against the filing (10-K p.25) | Shows where it read it |
|---|---|---|---|
| Google AI Overview | Health Care, $1.876 billion | Segment right, figure wrong (printed: $1,815 million) | Links to a website |
| Bing AI Overview | Safety and Industrial | Wrong (it earned $1,199 million) | Links to websites, no figures |
| HarFinX (local model) | Health Care, $1,815 million | Right | File, page and the matching row |

One question is an illustration, not a benchmark.

## Requirements (Windows)

1. **Node.js 22** or newer.
2. **Ollama for Windows**: <https://ollama.com>
3. A model: `ollama pull gemma4:12b` (about 8 GB, the default; fits a 12 GB GPU). `qwen3:14b` also works, but on a 12 GB GPU use an 8k context with it.
4. The context window, set in **both** places, then restart Ollama: the user environment variable `OLLAMA_CONTEXT_LENGTH=16384` (use `8192` for `qwen3:14b`) and the "Context length" in the Ollama app's settings. The harness warns if Ollama is running a different size, because Ollama silently drops the oldest text when the window is too small.

## Quick start

```
npm install
copy .env.example .env
npm start
```

Put your files in `workspace/` (created on first run, git-ignored) and ask, for example: `What was the company's net working capital at the end of 2021?`

```
npm start                                       # chat
npm start -- "Explain EBITDA in two sentences"  # one-off answer, for scripts
npm test                                        # tests (no model needed)
npm run typecheck
```

In chat, `/model` lists or switches the model, `/files` lists the workspace, `/skills` lists loaded skills, `/context` shows how much of the earlier conversation the model sees, `/new` clears the conversation, and `exit` quits. Ctrl+C stops a running answer. Settings live in `.env`; every option is explained in `.env.example`.

## Choosing a model

Two models have short names: `gemma` (the default) and `qwen`. Any installed Ollama tag also works by its full name. Pick one per run with `npm start -- --model qwen`, switch in chat with `/model`, or set `OLLAMA_MODEL` in `.env`. Models answer differently, so check figures against the source whichever you use.

## How answers are checked

- **Figure check.** Before an answer is shown, each figure is checked against the pages read, the calculator and your question. If one cannot be traced, the model gets one chance to fix it. A figure that still cannot be traced is left out with a note (or shown with a warning if you set `FIGURE_FALLBACK=warn`).
- **Citations.** A mark such as `[1]` follows each figure that can be cited. The list under the answer gives the file, page, heading, units and the matching row, or for a calculation the formula and the rows its inputs came from.
- **Traceable is not the same as right.** A citation shows that a figure was printed or calculated, not that the row, period or definition is the one you meant. Confirm on the page.

## Safety and privacy

- **One folder.** Only the workspace folder (default `workspace/`) is readable, fixed at startup and never chosen by the model.
- **Limits per question.** A cap on tool calls and on how much text is read. At a limit the model is asked to answer from what it has; if it keeps asking for more, the question is stopped.
- **Untrusted file contents.** Text inside a file is treated as data, not instructions.
- **Chat memory.** In a long chat the model sees a shortened view of earlier turns. Your full conversation and the audit log are never shortened.
- **Audit log.** Each session writes a local, append-only record of questions, answers, tool calls and guard decisions (`AUDIT_DIR`, default `audit/`). It contains your data, so treat it as such.
- **Local by default.** With Ollama everything stays on your machine and no identifying headers are sent.

## Remote models (optional, paid)

HarFinX is built and tested around local models. Support for larger remote models through an API key is still under development and less tested. To try it, set `PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`. Your prompts then leave your machine, so file access is off by default for remote models. See `.env.example` for the options.

## Evaluation

`eval/` holds a small harness for the public FinanceBench open sample. It downloads the dataset on demand (a public, non-commercial file that is not included here), runs questions through the real CLI, and writes result files for grading. Scores are not comparable to published FinanceBench numbers.

## Layout

`src/` is the harness (`tools/` the tools, `documents/` PDF reading and search, `calc/` the calculator, `skills/` the skills loader, `cli.ts` the chat loop, `engine.ts` the work around one question); `eval/` is the evaluation harness; `test/` holds the tests.

## License

MIT. See [LICENSE](LICENSE).
