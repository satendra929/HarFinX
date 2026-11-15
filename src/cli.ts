// The terminal side of HarFinX: arguments, configuration, the chat loop and its commands. The work around a question
// (agent, tools, guard, checks, references, audit) is in src/engine.ts, so it can run in tests with a scripted model.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isLoopbackUrl, loadConfig, withoutCredentials } from "./config.ts";
import { createModelFor } from "./model.ts";
import { aliasOf, findInstalled, listInstalledModels, parseArgs, resolveModel } from "./modelChoice.ts";
import { ensureWorkspaceDir, openWorkspace, PROJECT_ROOT } from "./workspace.ts";
import { createAuditLog } from "./audit.ts";
import { reasoningProfile } from "./reasoning.ts";
import { friendlyError } from "./errors.ts";
import { serverContext } from "./ollamaContext.ts";
import { createEngine, dim } from "./engine.ts";

// Clickable page references (OSC 8 links) only in terminals known to support them; elsewhere the escape codes would print as junk.
const linkSupported = !!process.stdout.isTTY && !!(process.env.WT_SESSION || process.env.TERM_PROGRAM === "vscode");

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) throw new Error(parsed.error);
  const cfg = loadConfig({ model: parsed.model });
  if (parsed.model && cfg.provider !== "ollama") throw new Error("--model applies to local Ollama models. For the Anthropic provider, set ANTHROPIC_MODEL in .env.");
  // `models` and `modelId` change when the user switches model with /model (Ollama only).
  let { models, model } = createModelFor(cfg);
  let modelId = cfg.provider === "ollama" ? cfg.ollamaModel : cfg.anthropicModel;
  // Provider- and model-specific reasoning settings live in one place (src/reasoning.ts); REASONING_HISTORY overrides the policy.
  const reasoning = reasoningProfile(cfg.provider, cfg.reasoningHistory, modelId);

  // The single folder the harness may touch. Refuses to start if it is missing or too broad.
  // Tools receive this handle; nothing else may read user files.
  const created = ensureWorkspaceDir(cfg.workspaceDir);
  if (created) console.log(dim(`Created workspace folder: ${created}`));
  const workspace = openWorkspace(cfg.workspaceDir);

  // Audit log: every write must succeed. On failure the run is aborted and nothing further runs
  // without a record (fail closed).
  const audit = createAuditLog(cfg.auditDir, workspace.root);

  // File access only for models on this machine unless explicitly allowed: file contents would go to the cloud provider, or to an Ollama server elsewhere.
  const modelIsLocal = cfg.provider === "ollama" && isLoopbackUrl(cfg.ollamaBaseUrl);
  const filesEnabled = modelIsLocal || cfg.allowCloudFiles;

  const version = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
  const engine = createEngine({
    provider: cfg.provider,
    model,
    modelId,
    reasoning,
    streamFn: (m, c, o) => models.streamSimple(m, c, o), // reads the current `models`, so /model can swap it
    workspace,
    audit,
    filesEnabled,
    calcShape: cfg.calcShape,
    statementTool: cfg.statementTool,
    context: cfg.context,
    chat: !parsed.prompt,
    links: linkSupported,
    serverContext: cfg.provider === "ollama" ? (id) => serverContext(cfg.ollamaBaseUrl, id) : undefined,
    sessionStart: {
      harness: version,
      node: process.version,
      provider: cfg.provider,
      ...(cfg.provider === "ollama" ? { ollamaBaseUrl: withoutCredentials(cfg.ollamaBaseUrl) } : {}),
      workspace: workspace.root,
    },
  });
  const { ask, record } = engine;

  // /model: list the models installed in Ollama, or switch to one for the rest of the session. The conversation
  // continues; the reasoning settings follow the new model. Only at the prompt, never during an answer.
  async function modelCommand(arg: string): Promise<void> {
    if (cfg.provider !== "ollama") {
      console.log("Model switching covers local Ollama models only. For the Anthropic provider, set ANTHROPIC_MODEL in .env.");
      return;
    }
    let installed: string[];
    try {
      installed = await listInstalledModels(cfg.ollamaBaseUrl);
    } catch (err) {
      console.error(`Could not list the installed models: ${friendlyError(err instanceof Error ? err.message : String(err), cfg.provider, modelId)}`);
      return;
    }
    if (!arg) {
      console.log("Installed models:");
      installed.forEach((m, i) => {
        const short = aliasOf(m);
        console.log(`  ${i + 1}. ${m}${short ? ` (${short})` : ""}${m === modelId ? "   <- in use" : ""}`);
      });
      console.log(dim("Switch with /model <number, short name or tag>, for example /model gemma"));
      return;
    }
    const target = findInstalled(arg, installed);
    if (!target) {
      console.error(/^\d+$/.test(arg) ? `There is no model number ${arg}. Type /model to see the list.` : `"${arg}" is not installed. Install it with: ollama pull ${resolveModel(arg)}`);
      return;
    }
    if (target === modelId) {
      console.log(dim(`Already using ${modelId}.`));
      return;
    }
    const next = createModelFor({ ...cfg, ollamaModel: target });
    models = next.models;
    modelId = target;
    engine.useModel(next.model, target, reasoningProfile(cfg.provider, cfg.reasoningHistory, target));
    console.log(dim(`Now using ${modelId}. The conversation continues; /new starts a fresh one.`));
  }

  // One-off mode: npm start -- [--model name] "question"
  if (parsed.prompt) {
    process.exitCode = (await ask(parsed.prompt)) ? 0 : 1;
    record("session_end");
    return;
  }

  // Chat mode
  if (!cfg.envFileFound) console.log(dim("No .env found; using defaults. Copy .env.example to .env to change settings."));
  console.log(`HarFinX chat —${cfg.provider}/${modelId}`);
  console.log(
    modelIsLocal
      ? dim("Model: local (nothing leaves this machine)")
      : cfg.provider === "ollama"
        ? "Model: REMOTE Ollama server (prompts and any file contents are sent to it)"
        : "Model: CLOUD (prompts and any file contents are sent to the provider)",
  );
  console.log(
    filesEnabled
      ? dim(`Workspace (only folder the harness may read): ${workspace.root}`)
      : "File access: OFF for models that are not on this machine (set ALLOW_CLOUD_FILES=1 to allow; file contents would be sent to the provider)",
  );
  console.log(dim(`Audit log: ${audit.path}`));
  console.log(dim("Commands: /model (list or switch the model), /context (memory level), /new (clear conversation), exit. Ctrl+C stops an answer; at the prompt it quits.\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    if (!engine.stop()) rl.close();
  });
  const auditStopped = (): boolean => {
    const err = engine.auditError();
    if (err) console.error(`Audit log write failed (${err}). Stopping: nothing runs without a record.`);
    return !!err;
  };

  while (true) {
    let line: string;
    try {
      line = (await rl.question("you> ")).trim();
    } catch {
      break; // readline closed (Ctrl+C at the prompt, or end of input)
    }
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    if (line === "/model" || line.startsWith("/model ")) {
      await modelCommand(line.slice("/model".length).trim());
      if (auditStopped()) break;
      continue;
    }
    if (line === "/context" || line.startsWith("/context ")) {
      engine.contextCommand(line.slice("/context".length).trim());
      if (auditStopped()) break;
      continue;
    }
    if (line === "/new") {
      engine.newConversation();
      if (auditStopped()) break;
      console.log(dim("Conversation cleared."));
      continue;
    }
    process.stdout.write("\n");
    await ask(line);
    process.stdout.write("\n");
    if (engine.auditError()) break; // ask() already reported it
  }
  record("session_end");
  rl.close();
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
