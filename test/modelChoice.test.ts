import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasOf, DEFAULT_OLLAMA_MODEL, findInstalled, MODEL_ALIASES, parseArgs, parseInstalled, resolveModel } from "../src/modelChoice.ts";
import { loadConfig } from "../src/config.ts";
import { reasoningProfile } from "../src/reasoning.ts";

test("short names resolve to Ollama tags; other names pass through; names are trimmed and case-insensitive for aliases", () => {
  assert.equal(resolveModel("qwen"), "qwen3:14b");
  assert.equal(resolveModel(" Gemma "), "gemma4:12b");
  assert.equal(resolveModel("llama3.1:8b"), "llama3.1:8b");
  assert.equal(aliasOf("gemma4:12b"), "gemma");
  assert.equal(aliasOf("llama3.1:8b"), undefined);
  for (const tag of Object.values(MODEL_ALIASES)) assert.match(tag, /:/); // every alias names a full tag
});

test("parseArgs: --model is read at the start only; the rest is the question", () => {
  assert.deepEqual(parseArgs([]), { model: undefined, prompt: "" });
  assert.deepEqual(parseArgs(["What", "is", "EBITDA?"]), { model: undefined, prompt: "What is EBITDA?" });
  assert.deepEqual(parseArgs(["--model", "gemma", "What", "is", "EBITDA?"]), { model: "gemma", prompt: "What is EBITDA?" });
  assert.deepEqual(parseArgs(["--model=qwen"]), { model: "qwen", prompt: "" }); // no question: chat mode
  assert.deepEqual(parseArgs(["Explain", "--model", "x"]), { model: undefined, prompt: "Explain --model x" }); // not at the start: part of the question
});

test("parseArgs: a missing value or an unknown option is an error, not a question", () => {
  assert.match(parseArgs(["--model"]).error!, /needs a model name/);
  assert.match(parseArgs(["--model", "--other"]).error!, /needs a model name/);
  assert.match(parseArgs(["--model="]).error!, /needs a model name/);
  assert.match(parseArgs(["--fast", "hi"]).error!, /Unknown option --fast/);
});

test("parseInstalled reads Ollama's tag list and tolerates odd bodies", () => {
  assert.deepEqual(parseInstalled({ models: [{ name: "qwen3:14b" }, { name: "gemma4:12b" }, { size: 1 }, null] }), ["qwen3:14b", "gemma4:12b"]);
  assert.deepEqual(parseInstalled({}), []);
  assert.deepEqual(parseInstalled(null), []);
});

test("findInstalled matches a list number, a short name, a tag, or a name served with :latest", () => {
  const installed = ["qwen3:14b", "gemma4:12b", "mistral:latest"];
  assert.equal(findInstalled("2", installed), "gemma4:12b");
  assert.equal(findInstalled("gemma", installed), "gemma4:12b");
  assert.equal(findInstalled("qwen3:14b", installed), "qwen3:14b");
  assert.equal(findInstalled("mistral", installed), "mistral:latest");
  assert.equal(findInstalled("9", installed), undefined);
  assert.equal(findInstalled("0", installed), undefined);
  assert.equal(findInstalled("phi4", installed), undefined);
  assert.equal(findInstalled("gemma", ["qwen3:14b"]), undefined); // a known short name that is not installed
});

test("the default model is gemma4:12b", () => {
  assert.equal(DEFAULT_OLLAMA_MODEL, "gemma4:12b");
});

test("loadConfig: the --model override wins over OLLAMA_MODEL; both accept short names", () => {
  const saved = process.env.OLLAMA_MODEL;
  try {
    delete process.env.OLLAMA_MODEL;
    // a local .env file may set OLLAMA_MODEL again through process.loadEnvFile(); only the override is asserted then
    assert.equal(loadConfig({ model: "qwen" }).ollamaModel, "qwen3:14b");
    process.env.OLLAMA_MODEL = "qwen";
    assert.equal(loadConfig().ollamaModel, "qwen3:14b");
    assert.equal(loadConfig({ model: "gemma" }).ollamaModel, "gemma4:12b");
    assert.equal(loadConfig({ model: "llama3.1:8b" }).ollamaModel, "llama3.1:8b");
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = saved;
  }
});

test("reasoning profile by model: Gemma has no thinking-off switch; other Ollama models keep the provider default", () => {
  const gemma = reasoningProfile("ollama", undefined, "gemma4:12b");
  assert.equal(gemma.history, "drop");
  assert.equal(gemma.thinkingOff, undefined);
  assert.equal(reasoningProfile("ollama", "latest", "gemma4:12b").history, "latest"); // the history override still applies
  assert.deepEqual(reasoningProfile("ollama", undefined, "qwen3:14b").thinkingOff, { reasoning_effort: "none" });
  assert.deepEqual(reasoningProfile("ollama").thinkingOff, { reasoning_effort: "none" }); // no model given: provider default
  assert.equal(reasoningProfile("anthropic", undefined, "gemma-looking-name").history, "keep"); // families are per provider
});
