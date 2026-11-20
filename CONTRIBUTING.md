# Contributing to HarFinX

Thanks for helping. HarFinX is early-stage, so please open an issue to discuss a larger change before you build it.

## Set up

Requires Node.js 22 or newer.

```
npm install
npm test            # no model needed
npm run typecheck
```

A local model through Ollama is only needed to try the chat. Both checks above must pass before you open a pull request.

## Ground rules

- **Privacy first.** Never commit real financial data, filings you do not have the right to share, `.env`, audit logs or anything personal. Test data must be synthetic or tiny public excerpts. Do not put personal or project details in issues, logs or screenshots.
- **No outbound calls.** The harness must work with nothing leaving the machine when a local model is used. Do not add telemetry, tracking or attribution headers.
- **Figures must trace.** The model never does arithmetic; numbers come from the source as printed or from the `calculate` tool. Do not weaken the figure checker to get a cleaner result.
- **Keep it small.** ESM TypeScript, no build step, small readable modules. Add a dependency only when it is clearly needed: pin an exact version, and it must be MIT-compatible.
- **Tests.** Add or update a test for every behaviour change. Tests must run offline and without a model.
- **No model-specific code outside `src/reasoning.ts`** and `src/modelChoice.ts`.

## Pull requests

1. Fork, then branch from `main`.
2. Keep one change per pull request, with a short description of what and why.
3. Run `npm test` and `npm run typecheck`.
4. By submitting, you agree your contribution is licensed under the [MIT License](LICENSE).

## Reporting bugs and security issues

Bugs: open an issue with the steps to reproduce, your Node and Ollama versions, and the model tag. Leave out file contents and audit logs.

Security problems: do not open an issue. Follow [SECURITY.md](SECURITY.md).
