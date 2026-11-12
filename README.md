# HarFinX

**Har**ness for **Fin**ance e**X**perts: an open-source (MIT) AI agent harness for financial workflows, built for analysts working on their own computer. It runs on the Pi agent core (`pi-ai` + `pi-agent-core`), is model-agnostic, and is local-first.

> Early stage (v0.0.1). Expect rough edges. Check any figure against its cited source.

## What it does

- Terminal chat with a local model (through Ollama) about your financial files.
- One read-only tool: the model can read text files (csv, txt, md, json) from a single workspace folder. Excel and PDF are not supported yet.
- Guards: one fixed folder, limits per question, and file access switched off for cloud models by default.
- An audit log: every session is written to a local JSONL file.

## Requirements (Windows)

1. **Node.js 22** or newer.
2. **Ollama for Windows**: <https://ollama.com>
3. A model: `ollama pull qwen3:14b` (about 9 GB; fits a 12 GB GPU at 8k context). For more speed or a longer context use `qwen3:8b` and set `OLLAMA_MODEL=qwen3:8b` in `.env`.
4. A **user environment variable** `OLLAMA_CONTEXT_LENGTH=8192`, then restart Ollama. Without it Ollama silently drops older turns of the conversation.

## Quick start

```
npm install
copy .env.example .env
npm start
```

Put the files you want to work with in `workspace/` (created on first run, and git-ignored), then name them in your question, for example: `Using income-statement.csv, what was EBITDA for FY2024?`

```
npm start                                       # chat
npm start -- "Explain EBITDA in two sentences"  # one-off answer, for scripts
npm test                                        # tests (no model needed)
npm run typecheck
```

Chat commands: `/new` clears the conversation, `exit` quits. Ctrl+C stops a running answer; at the prompt it quits.

## Safety

- **One folder.** The harness can access only the folder set by `WORKSPACE_DIR` (default `workspace/`). It is fixed at startup, and the model never supplies it. The harness refuses to start if the folder is missing, a drive root, or is, or contains, your home folder or the project folder.
- **Limits per question.** At most 8 tool calls, 5,000 characters per tool result, and 12,000 characters of tool output in total. Tool calls are printed as yellow `[guard]` lines, and model text is stripped of terminal escape codes so it cannot imitate them.
- **File contents are untrusted.** A file can contain text that tries to steer the model. The guards limit what the model can reach, not what it says.
- **Cloud models** get no file access unless you set `ALLOW_CLOUD_FILES=1`, because file contents would be sent to the provider.

## Audit log

Every session writes a new file, `audit/session-<timestamp>-<id>.jsonl` (folder set by `AUDIT_DIR`), with one JSON record per line: the system prompt, your question, each model message with token counts, each tool call and result, every guard decision, and how the run ended. The file is append-only and local, and the folder is git-ignored. It contains full questions, answers and file contents, so treat it like your data. If a write fails, the run stops. The harness refuses to start if `AUDIT_DIR` overlaps the workspace, so the model cannot read the log.

## Using Claude (optional, paid)

Edit `.env`:

```
PROVIDER=anthropic
ANTHROPIC_API_KEY=<a Console API key>
```

A Claude Pro/Max subscription cannot be used: Anthropic's terms allow subscription logins only in Anthropic's own apps. HarFinX accepts only a Console API key and refuses to start if `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` or an `sk-ant-oat…` key is present. With this provider your prompts go to Anthropic's API.

## Privacy

Local Ollama keeps everything on your machine, and no identifying headers are sent.

## Layout

- `src/config.ts`: loads `.env`, validates settings
- `src/model.ts`: the single place a provider is chosen
- `src/workspace.ts`: the one allowed folder and confined file reads
- `src/guard.ts`: per-question limits on tool use
- `src/tools/readFile.ts`: the read-only file tool
- `src/audit.ts`: the append-only audit log
- `src/cli.ts`: chat loop and one-off mode
- `test/`: tests

## License

MIT. See [LICENSE](LICENSE).
