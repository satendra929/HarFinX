import { test } from "node:test";
import assert from "node:assert/strict";
import { REASONING_HISTORY, reasoningProfile } from "../src/reasoning.ts";
import { loadConfig } from "../src/config.ts";

test("profiles: Ollama drops earlier reasoning and has a thinking-off switch; Anthropic keeps it and has none", () => {
  const o = reasoningProfile("ollama");
  assert.equal(o.history, "drop");
  assert.deepEqual(o.thinkingOff, { reasoning_effort: "none" });
  const a = reasoningProfile("anthropic");
  assert.equal(a.history, "keep");
  assert.equal(a.thinkingOff, undefined);
});

test("the history policy can be overridden only where the provider allows it", () => {
  for (const h of REASONING_HISTORY) assert.equal(reasoningProfile("ollama", h).history, h);
  assert.deepEqual(reasoningProfile("ollama", "keep").thinkingOff, { reasoning_effort: "none" }); // the switch survives an override
  assert.equal(reasoningProfile("ollama").history, "drop"); // an override does not leak into the default profile
  assert.equal(reasoningProfile("anthropic", "keep").history, "keep");
  assert.throws(() => reasoningProfile("anthropic", "drop"), /REASONING_HISTORY=drop is not supported for PROVIDER=anthropic/);
  assert.throws(() => reasoningProfile("anthropic", "latest"), /not supported/);
});

test("REASONING_HISTORY in the environment is validated; unset means the profile default", () => {
  const saved = process.env.REASONING_HISTORY;
  try {
    delete process.env.REASONING_HISTORY;
    assert.equal(loadConfig().reasoningHistory, undefined);
    process.env.REASONING_HISTORY = " Latest ";
    assert.equal(loadConfig().reasoningHistory, "latest");
    process.env.REASONING_HISTORY = "sometimes";
    assert.throws(() => loadConfig(), /REASONING_HISTORY must be "drop", "latest" or "keep"/);
  } finally {
    if (saved === undefined) delete process.env.REASONING_HISTORY;
    else process.env.REASONING_HISTORY = saved;
  }
});
