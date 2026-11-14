import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ANSWER_NOW, createGuard } from "../src/guard.ts";

// The guard inside a real Pi agent, wired the way the CLI wires it: a scripted model makes one tool call per reply
// ("call") or answers ("text:..."). A limit must refuse softly first, so the model can still answer.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: object[], stopReason: string) => ({ role: "assistant", content, api: "openai-completions", provider: "any", model: "fake", usage, stopReason, timestamp: Date.now() });

function run(script: string[], limits: { maxCallsPerRun: number; maxTotalChars?: number }, toolText = "page text") {
  const seen: string[][] = []; // what each request saw as tool results
  let requests = 0;
  const model: any = { id: "fake", name: "fake", api: "openai-completions", provider: "any", baseUrl: "http://x", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 8192, maxTokens: 4096 };
  const streamFn = (_m: unknown, ctx: any, options?: { signal?: AbortSignal }) => {
    seen.push((ctx.messages as any[]).filter((m) => m.role === "toolResult").map((m) => m.content.map((b: any) => b.text).join("")));
    const step = script[requests++] ?? "text:late";
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const call = (name: string, n: number) => ({ type: "toolCall", id: `c${requests}-${n}`, name, arguments: {} });
      const calls = step === "call" ? [call("read_page", 0)] : step === "mixed" ? [call("calculate", 0), call("read_page", 1)] : undefined; // "mixed": an allowed call and one that may be refused, in one reply
      const content = calls ?? [{ type: "text", text: step.slice(5) }];
      stream.push({ type: "start", partial: asst([], "pending") } as never);
      if (options?.signal?.aborted) {
        stream.push({ type: "error", reason: "aborted", error: asst([], "aborted") } as never); // a real stream stops when the run is aborted
        return stream.end();
      }
      stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: asst(content, calls ? "toolUse" : "stop") } as never);
      stream.end();
    });
    return stream;
  };
  let toolRuns = 0;
  const tool: any = { name: "read_page", label: "r", description: "d", parameters: { type: "object", properties: {} }, execute: async () => (toolRuns++, { content: [{ type: "text", text: toolText }], details: {} }) };
  const calc: any = { name: "calculate", label: "c", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "1" }], details: {} }) };
  const guard = createGuard({ maxCallsPerRun: limits.maxCallsPerRun, maxOutputChars: 5000, maxTotalChars: limits.maxTotalChars ?? 12000, log: () => {}, budgetExempt: ["calculate"] });
  const agent = new Agent({ initialState: { systemPrompt: "", model, tools: [tool, calc] }, streamFn: streamFn as never, beforeToolCall: guard.beforeToolCall, afterToolCall: guard.afterToolCall, identity: { attribution: null } });
  guard.attach(agent); // the same wiring the CLI uses
  guard.startRun();
  const last = () => agent.state.messages.at(-1) as any;
  return { agent, guard, seen, toolRuns: () => toolRuns, last };
}

test("call limit: the call over the limit is refused with the answer-now text and the model's next reply answers", async () => {
  const r = run(["call", "call", "call", "text:The figure is on the page."], { maxCallsPerRun: 2 });
  await r.agent.prompt("question");
  assert.equal(r.toolRuns(), 2); // the third call was refused, not run
  assert.equal(r.guard.tripped, undefined);
  assert.ok(r.guard.blocked); // the CLI shows the "answer may be incomplete" note from this
  assert.equal(r.last().role, "assistant");
  assert.equal(r.last().content[0].text, "The figure is on the page.");
  assert.ok(r.seen.at(-1)!.includes(ANSWER_NOW)); // the model saw the refusal as a tool result
});

test("call limit: a model that ignores the refusal and calls again is stopped", async () => {
  const r = run(["call", "call", "call", "call", "text:never reached"], { maxCallsPerRun: 2 });
  await r.agent.prompt("question");
  assert.ok(r.guard.tripped);
  assert.equal(r.toolRuns(), 2);
  assert.notEqual(r.last().content?.[0]?.text, "never reached");
});

test("output budget: refused softly after the budget is spent, and the model can still answer", async () => {
  const r = run(["call", "call", "text:Answer from page one."], { maxCallsPerRun: 8, maxTotalChars: 15 }, "x".repeat(10));
  await r.agent.prompt("question");
  assert.equal(r.toolRuns(), 2);
  assert.equal(r.guard.tripped, undefined);
  assert.equal(r.last().content[0].text, "Answer from page one.");
});

test("output budget: refused softly, then a further call in the next reply stops the question", async () => {
  const r = run(["call", "call", "call", "call", "text:never"], { maxCallsPerRun: 8, maxTotalChars: 15 }, "x".repeat(10));
  await r.agent.prompt("question");
  assert.ok(r.guard.tripped);
  assert.match(r.guard.tripped!, /output limit/);
});

test("a refusal inside a batch whose other call ran stops the question: the model is not asked again", async () => {
  // output budget spent after two reads; the third read is refused softly; the next reply asks for calculate AND read_page
  const r = run(["call", "call", "call", "mixed", "text:late answer"], { maxCallsPerRun: 8, maxTotalChars: 15 }, "x".repeat(10));
  await r.agent.prompt("question");
  assert.ok(r.guard.tripped);
  assert.match(r.guard.tripped!, /output limit/);
  assert.notEqual(r.last().content?.[0]?.text, "late answer"); // before the fix the loop went on and the model wrote this
});
