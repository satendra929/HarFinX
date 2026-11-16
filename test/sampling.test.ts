import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelFor } from "../src/model.ts";
import { loadConfig, parseTemperature } from "../src/config.ts";

test("OLLAMA_TEMPERATURE: a number from 0 to 2, unset means the model's own default", () => {
  assert.equal(parseTemperature(undefined), undefined);
  assert.equal(parseTemperature("  "), undefined);
  assert.equal(parseTemperature("0"), 0);
  assert.equal(parseTemperature("0.3"), 0.3);
  assert.equal(parseTemperature("2"), 2);
  for (const bad of ["-0.1", "2.5", "warm", "1e0", ".5"]) assert.throws(() => parseTemperature(bad), /OLLAMA_TEMPERATURE must be a number from 0 to 2/);
});

/** The JSON body Pi would send to Ollama, captured by a fetch that never reaches the network. */
async function requestBody(temperature: number | undefined): Promise<Record<string, unknown>> {
  const cfg = { ...loadConfig({}), provider: "ollama" as const, ollamaTemperature: temperature };
  const { models, model } = createModelFor(cfg);
  let body: Record<string, unknown> = {};
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    throw new Error("offline test: no request is sent");
  }) as typeof globalThis.fetch;
  const stream = models.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, { fetch } as never);
  for await (const _ of stream) {
    // drain: the stream ends with an error event
  }
  return body;
}

test("the temperature reaches the request body, and nothing is sent when it is unset", async () => {
  assert.equal((await requestBody(0.2)).temperature, 0.2);
  const plain = await requestBody(undefined);
  assert.ok(Array.isArray(plain.messages)); // the request was built and captured
  assert.equal("temperature" in plain, false);
});
