import { test } from "node:test";
import assert from "node:assert/strict";
import { contextFromPs, contextMismatchWarning, ollamaRoot, serverContext } from "../src/ollamaContext.ts";

const ps = (models: unknown[]) => ({ models });
const fakeFetch = (respond: () => Promise<Response> | Response): typeof fetch => (async () => respond()) as unknown as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("ollamaRoot: strips the OpenAI-style /v1 suffix and trailing slashes only", () => {
  assert.equal(ollamaRoot("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(ollamaRoot(" http://localhost:11434/v1/ "), "http://localhost:11434");
  assert.equal(ollamaRoot("http://host:1234"), "http://host:1234");
  assert.equal(ollamaRoot("http://host:1234/v1beta"), "http://host:1234/v1beta");
});

test("contextFromPs: finds the loaded model by name or model, and ignores bad shapes", () => {
  assert.equal(contextFromPs(ps([{ name: "gemma4:12b", context_length: 8192 }]), "gemma4:12b"), 8192);
  assert.equal(contextFromPs(ps([{ name: "x", model: "gemma4:12b", context_length: 16384 }]), "gemma4:12b"), 16384);
  assert.equal(contextFromPs(ps([{ name: "qwen3:latest", context_length: 4096 }]), "qwen3"), 4096); // a tag-less id is listed as :latest
  assert.equal(contextFromPs(ps([{ name: "qwen3:14b", context_length: 4096 }]), "qwen3"), undefined); // but not as another tag
  assert.equal(contextFromPs(ps([{ name: "qwen3:14b", context_length: 8192 }]), "gemma4:12b"), undefined); // another model is loaded
  assert.equal(contextFromPs(ps([]), "gemma4:12b"), undefined); // nothing loaded
  assert.equal(contextFromPs(ps([{ name: "gemma4:12b" }]), "gemma4:12b"), undefined); // older server: no field
  assert.equal(contextFromPs(ps([{ name: "gemma4:12b", context_length: "8192" }]), "gemma4:12b"), undefined);
  assert.equal(contextFromPs(ps([{ name: "gemma4:12b", context_length: 0 }]), "gemma4:12b"), undefined);
  for (const bad of [null, undefined, 5, "x", {}, { models: "no" }]) assert.equal(contextFromPs(bad, "gemma4:12b"), undefined);
});

test("serverContext: returns the server's figure; every failure gives undefined and never throws", async () => {
  assert.equal(await serverContext("http://localhost:11434/v1", "gemma4:12b", fakeFetch(() => json(ps([{ name: "gemma4:12b", context_length: 8192 }])))), 8192);
  assert.equal(await serverContext("http://x/v1", "gemma4:12b", fakeFetch(() => json({}, 404))), undefined);
  assert.equal(await serverContext("http://x/v1", "gemma4:12b", fakeFetch(() => new Response("not json", { status: 200 }))), undefined);
  assert.equal(await serverContext("http://x/v1", "gemma4:12b", fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")))), undefined);
  const hang: typeof fetch = ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  assert.equal(await serverContext("http://x/v1", "gemma4:12b", hang, 30), undefined); // a hung server cannot stall an answer
});

test("serverContext: asks the /api/ps endpoint of the server root", async () => {
  let seen = "";
  const spy: typeof fetch = (async (url: unknown) => {
    seen = String(url);
    return json(ps([]));
  }) as unknown as typeof fetch;
  await serverContext("http://localhost:11434/v1", "m", spy);
  assert.equal(seen, "http://localhost:11434/api/ps");
});

test("contextMismatchWarning: silent when the figures agree or the server cannot say; otherwise names both and the fix", () => {
  assert.equal(contextMismatchWarning(16384, 16384, "m"), undefined);
  assert.equal(contextMismatchWarning(16384, undefined, "m"), undefined);
  const w = contextMismatchWarning(16384, 8192, "gemma4:12b")!;
  assert.match(w, /^\[context\] Ollama is running gemma4:12b with a 8192-token window, not the 16384 the harness expected/);
  assert.match(w, /OLLAMA_CONTEXT_LENGTH/);
  assert.match(w, /Using 8192 for this session/);
});
