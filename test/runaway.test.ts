import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { detectRunaway, guardRunaway, replyChars } from "../src/runaway.ts";
import { retryWithoutThinking } from "../src/repair.ts";
import { friendlyError } from "../src/errors.ts";

const call = (name: string, args: object = {}) => ({ type: "toolCall", id: Math.random().toString(36).slice(2), name, arguments: args });

test("detectRunaway: normal replies pass, loops are caught, a still-streaming last block is ignored", () => {
  assert.equal(detectRunaway(undefined, 8), undefined);
  assert.equal(detectRunaway([{ type: "thinking", thinking: "x" }, call("read_file", { path: "a" })], 8), undefined);
  // different calls, even many of them below the cap
  assert.equal(detectRunaway(Array.from({ length: 8 }, (_, i) => call("read_file", { path: `f${i}` })), 8), undefined);
  // too many calls in one reply
  assert.match(detectRunaway(Array.from({ length: 9 }, (_, i) => call("read_file", { path: `f${i}` })), 8)!, /9 tool calls in one reply \(limit 8\)/);
  // the same call repeated: the third finished identical block triggers it (the last block may still be streaming)
  const a = { inputs: { x: "1" }, steps: [{ name: "r", expr: "x" }] };
  assert.equal(detectRunaway([call("calculate", a), call("calculate", a), call("calculate", a)], 8), undefined); // last one ignored
  assert.match(detectRunaway([call("calculate", a), call("calculate", a), call("calculate", a), call("calculate", { z: 1 })], 8)!, /same calculate call repeated 3 times/);
  // identical name but different arguments is fine
  assert.equal(detectRunaway([call("calculate", { a: 1 }), call("calculate", { a: 2 }), call("calculate", { a: 3 }), call("calculate", { a: 4 })], 8), undefined);
});

// ---- integration: a scripted model streaming into a real Pi agent ----
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: object[], stopReason: string) => ({ role: "assistant", content, api: "openai-completions", provider: "ollama", model: "fake", usage, stopReason, timestamp: Date.now() });
const tick = () => new Promise((r) => setImmediate(r));

/** Request 1..n: each entry is "loop" (streams tool calls forever until aborted) or a text answer. Records each request's payload hook input. */
function scriptedAgent(script: ("loop" | "ramble" | string)[]) {
  const seen = { requests: 0, toolRuns: 0, streamedCalls: 0, rambleChunks: 0 };
  const model: any = { id: "fake", name: "fake", api: "openai-completions", provider: "ollama", baseUrl: "http://x", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 8192, maxTokens: 4096 };
  const streamFn = (_m: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
    const step = script[seen.requests++] ?? "late answer";
    const stream = createAssistantMessageEventStream();
    (async () => {
      stream.push({ type: "start", partial: asst([], "pending") } as never);
      if (step === "loop") {
        const content: any[] = [];
        for (let i = 0; i < 60; i++) {
          if (options?.signal?.aborted) {
            stream.push({ type: "error", reason: "aborted", error: asst(content, "aborted") } as never);
            return stream.end();
          }
          const c = call("calculate", { inputs: { a: "1" }, steps: [{ name: "r", expr: "a" }] });
          content.push(c);
          seen.streamedCalls++;
          stream.push({ type: "toolcall_start", contentIndex: content.length - 1, partial: asst([...content], "pending") } as never);
          stream.push({ type: "toolcall_end", contentIndex: content.length - 1, toolCall: c, partial: asst([...content], "pending") } as never);
          await tick();
        }
        stream.push({ type: "done", reason: "toolUse", message: asst(content, "toolUse") } as never);
      } else if (step === "ramble") {
        // reasoning in circles: 100 characters per chunk, 2,000 chunks unless cut off
        const block = { type: "thinking", thinking: "" };
        stream.push({ type: "thinking_start", contentIndex: 0, partial: asst([{ ...block }], "pending") } as never);
        for (let i = 0; i < 2000; i++) {
          if (options?.signal?.aborted) {
            stream.push({ type: "error", reason: "aborted", error: asst([{ ...block }], "aborted") } as never);
            return stream.end();
          }
          const delta = "So the answer is 5,466.31 million. But the exact value is 5,466,312 thousand, so check once more.. ";
          block.thinking += delta;
          seen.rambleChunks++;
          stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: asst([{ ...block }], "pending") } as never);
          await tick();
        }
        stream.push({ type: "done", reason: "stop", message: asst([{ ...block }], "stop") } as never);
      } else {
        stream.push({ type: "done", reason: "stop", message: asst([{ type: "text", text: step }], "stop") } as never);
      }
      stream.end();
    })();
    return stream;
  };
  const tool: any = { name: "calculate", label: "c", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ((seen.toolRuns++), { content: [{ type: "text", text: "ok" }], details: {} }) };
  const agent = new Agent({ initialState: { systemPrompt: "", model, tools: [tool] }, streamFn: streamFn as never, identity: { attribution: null } });
  return { agent, seen };
}

test("a looping reply is cut off while streaming, nothing runs, and one retry without thinking recovers", async () => {
  const { agent, seen } = scriptedAgent(["loop", "The answer is 5."]);
  const reasons: string[] = [];
  let noThink = false;
  guardRunaway(agent, 8, (r) => reasons.push(r));
  await agent.prompt("question");

  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /tool calls in one reply|same calculate call repeated/);
  assert.ok(seen.streamedCalls < 20, `cut off early, but streamed ${seen.streamedCalls} calls`); // far fewer than the 60 the script would send
  assert.equal(seen.toolRuns, 0); // an aborted reply executes none of its tool calls
  assert.equal((agent.state.messages.at(-1) as any).stopReason, "aborted");

  await retryWithoutThinking(agent, (on) => (noThink = on));
  assert.equal(noThink, false); // flag always reset
  const last = agent.state.messages.at(-1) as any;
  assert.equal(last.stopReason, "stop");
  assert.equal(last.content[0].text, "The answer is 5.");
  assert.equal(agent.state.messages.filter((m: any) => m.role === "assistant").length, 1); // the aborted reply was discarded
  assert.equal(agent.state.errorMessage, undefined); // no stale error after a good retry
  assert.equal(seen.requests, 2);
});

test("if the retry loops too, the guard fires again and the conversation ends without running tools", async () => {
  const { agent, seen } = scriptedAgent(["loop", "loop"]);
  const reasons: string[] = [];
  guardRunaway(agent, 8, (r) => reasons.push(r));
  await agent.prompt("question");
  await retryWithoutThinking(agent, () => {});
  assert.equal(reasons.length, 2);
  assert.equal(seen.toolRuns, 0);
  assert.equal((agent.state.messages.at(-1) as any).stopReason, "aborted");
});

test("detectRunaway: a reply longer than the size cap is caught, whatever it is made of; no cap means no size check", () => {
  const think = (n: number) => ({ type: "thinking", thinking: "x".repeat(n) });
  const text = (n: number) => ({ type: "text", text: "y".repeat(n) });
  assert.equal(replyChars([think(10), text(5), call("calculate", { a: 1 })]), 10 + 5 + '{"a":1}'.length);
  assert.equal(replyChars(undefined), 0);
  assert.equal(detectRunaway([think(1000)], 8, 3, 1000), undefined); // at the cap is fine
  assert.match(detectRunaway([think(1001)], 8, 3, 1000)!, /one reply longer than 1000 characters/);
  assert.match(detectRunaway([think(600), text(600)], 8, 3, 1000)!, /longer than 1000/); // reasoning and text add up
  assert.match(detectRunaway([call("calculate", { blob: "z".repeat(2000) })], 8, 3, 1000)!, /longer than 1000/);
  assert.equal(detectRunaway([think(50_000)], 8), undefined); // size is only checked when a cap is given
});

test("a reply that reasons in circles is cut off by the size cap and one retry recovers", async () => {
  const { agent, seen } = scriptedAgent(["ramble", "5,466.31 million"]);
  const reasons: string[] = [];
  guardRunaway(agent, 8, (r) => reasons.push(r), 5000);
  await agent.prompt("question");
  assert.deepEqual(reasons, ["one reply longer than 5000 characters"]);
  assert.ok(seen.rambleChunks < 80, `cut off early, but streamed ${seen.rambleChunks} chunks`); // 5,000 chars is 50 chunks; the script would send 2,000
  assert.equal((agent.state.messages.at(-1) as any).stopReason, "aborted");
  await retryWithoutThinking(agent, () => {});
  assert.equal((agent.state.messages.at(-1) as any).content[0].text, "5,466.31 million");
  assert.equal(seen.requests, 2);

  // without a size cap the same reply runs to its end (this is what the cap is for)
  const free = scriptedAgent(["ramble"]);
  const none: string[] = [];
  guardRunaway(free.agent, 8, (r) => none.push(r));
  await free.agent.prompt("question");
  assert.deepEqual(none, []);
  assert.equal(free.seen.rambleChunks, 2000);
});

test("a normal reply never triggers the guard", async () => {
  const { agent } = scriptedAgent(["fine"]);
  const reasons: string[] = [];
  guardRunaway(agent, 8, (r) => reasons.push(r));
  await agent.prompt("q");
  assert.deepEqual(reasons, []);
});

test("friendly errors: timeouts get a plain-language message; other cases keep their messages", () => {
  const raw = "terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT)";
  assert.match(friendlyError(raw, "ollama", "qwen3:14b"), /model stopped responding.*restart Ollama/);
  assert.doesNotMatch(friendlyError(raw, "ollama", "qwen3:14b"), /UND_ERR/);
  assert.match(friendlyError("Headers Timeout Error", "ollama", "m"), /stopped responding/);
  assert.match(friendlyError("request timed out", "anthropic", "m"), /provider timed out/);
  assert.match(friendlyError("fetch failed ECONNREFUSED", "ollama", "m"), /Cannot reach Ollama/);
  assert.match(friendlyError("model 'x' not found", "ollama", "x"), /ollama pull x/);
  assert.match(friendlyError("401 Unauthorized", "anthropic", "m"), /Authentication failed/);
  assert.equal(friendlyError("weird \u001b[31mred\u0007 error", "ollama", "m"), "weird ?[31mred? error"); // control characters neutralised
});
