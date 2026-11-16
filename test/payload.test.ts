import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReasoningHistory } from "../src/payload.ts";

const payload = () => ({
  model: "qwen3:14b",
  stream: true,
  tools: [{ type: "function", function: { name: "calculate" } }],
  messages: [
    { role: "system", content: "sys", reasoning: "keep: not an assistant message" },
    { role: "user", content: "q" },
    { role: "assistant", content: null, reasoning: "thinking 1", tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "file text" },
    { role: "assistant", content: "text", reasoning_content: "thinking 2", reasoning_text: "thinking 3", reasoning_details: [{ type: "reasoning.text", text: "thinking 4" }], tool_calls: [{ id: "b" }] },
  ],
});

test("removes reasoning fields from assistant messages only, keeping tool calls and content", () => {
  const out: any = applyReasoningHistory(payload(), "drop");
  assert.equal(out.messages[2].reasoning, undefined);
  assert.equal(out.messages[4].reasoning_content, undefined);
  assert.equal(out.messages[4].reasoning_text, undefined);
  assert.equal(out.messages[4].reasoning_details, undefined);
  assert.equal(out.messages[2].content, null);
  assert.equal(out.messages[2].tool_calls[0].function.name, "read_file");
  assert.equal(out.messages[4].content, "text");
  assert.equal(out.messages[0].reasoning, "keep: not an assistant message"); // non-assistant untouched
  assert.deepEqual(out.tools, payload().tools);
  assert.equal(out.model, "qwen3:14b");
  assert.equal(out.stream, true);
});

test("does not mutate its input and tolerates odd payloads", () => {
  const p = payload();
  applyReasoningHistory(p, "drop");
  assert.equal(p.messages[2].reasoning, "thinking 1");
  assert.equal(applyReasoningHistory(undefined as never, "drop"), undefined);
  assert.deepEqual(applyReasoningHistory({ model: "x" } as never, "drop"), { model: "x" });
});

const loop = () => ({
  model: "m",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1", reasoning: "r-old" },
    { role: "user", content: "q2" },
    { role: "assistant", content: null, reasoning: "r1", tool_calls: [{ id: "a" }] },
    { role: "tool", tool_call_id: "a", content: "x" },
    { role: "assistant", content: null, reasoning_content: "r2", tool_calls: [{ id: "b" }] },
    { role: "tool", tool_call_id: "b", content: "y" },
  ],
});
const reasoningOf = (p: any) => p.messages.map((m: any) => m.reasoning ?? m.reasoning_content ?? null);

test("reasoning-history policies: keep changes nothing, drop removes all, latest keeps only the most recent reply's", () => {
  const p = loop();
  assert.equal(applyReasoningHistory(p, "keep"), p); // same object: nothing rebuilt
  assert.deepEqual(reasoningOf(applyReasoningHistory(loop(), "keep")), [null, null, "r-old", null, "r1", null, "r2", null]);
  assert.deepEqual(reasoningOf(applyReasoningHistory(loop(), "drop")), [null, null, null, null, null, null, null, null]);
  assert.deepEqual(reasoningOf(applyReasoningHistory(loop(), "latest")), [null, null, null, null, null, null, "r2", null]);
  // tool calls, content and other roles survive every policy
  for (const h of ["keep", "drop", "latest"] as const) {
    const out: any = applyReasoningHistory(loop(), h);
    assert.deepEqual(out.messages.map((m: any) => m.role), loop().messages.map((m) => m.role));
    assert.deepEqual(out.messages[6].tool_calls, [{ id: "b" }]);
    assert.equal(out.messages[2].content, "a1");
  }
  assert.deepEqual(p, loop()); // input not mutated
});

test("latest never keeps the reasoning behind an earlier question's answer", () => {
  // first request of a new question: the last assistant message is the PREVIOUS final answer
  const next = { messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1", reasoning: "r-old" }, { role: "user", content: "q2" }] };
  assert.deepEqual(reasoningOf(applyReasoningHistory(next, "latest")), [null, null, null]);
  assert.deepEqual(reasoningOf(applyReasoningHistory(next, "keep")), [null, "r-old", null]);
});

test("reasoning-history policies leave payloads of another shape alone (for example a provider with content blocks)", () => {
  const blocks = { model: "c", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "tool_use", id: "1" }] }] };
  assert.deepEqual(applyReasoningHistory(structuredClone(blocks), "drop"), blocks); // signed blocks inside content are not touched
  assert.equal(applyReasoningHistory(null as never, "drop"), null);
  assert.deepEqual(applyReasoningHistory({ messages: [null, "odd"] } as never, "latest"), { messages: [null, "odd"] });
});
