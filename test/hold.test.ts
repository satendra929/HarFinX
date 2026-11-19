import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply, finalAnswerText, isRepairMessage, ReplyHold } from "../src/hold.ts";

const text = (t: string) => ({ type: "text", text: t });
const call = { type: "toolCall", id: "c1", name: "read_page", arguments: {} };

test("classifyReply: aborted and error replies are partial, whatever they contain", () => {
  assert.equal(classifyReply({ stopReason: "aborted", content: [text("x")] }), "partial");
  assert.equal(classifyReply({ stopReason: "error", content: [text("x"), call] }), "partial");
  assert.equal(classifyReply({ stopReason: "aborted", content: [call] }), "partial"); // a loop of calls is not hidden
});

test("classifyReply: a tool call makes working text; everything else is the answer", () => {
  assert.equal(classifyReply({ stopReason: "toolUse", content: [text("draft"), call] }), "working");
  assert.equal(classifyReply({ stopReason: "toolUse", content: [] }), "working");
  assert.equal(classifyReply({ stopReason: "stop", content: [text("a"), call] }), "working"); // a call part is enough
  assert.equal(classifyReply({ stopReason: "stop", content: [text("a")] }), "answer");
  assert.equal(classifyReply({ stopReason: "length", content: [text("a")] }), "answer"); // cut at the output cap
  assert.equal(classifyReply({ stopReason: "pending", content: [text("a")] }), "answer"); // no stop reason is silently dropped
  assert.equal(classifyReply({ stopReason: "deferred", content: [text("a")] }), "answer");
  assert.equal(classifyReply({ content: [] }), "answer");
  assert.equal(classifyReply({ stopReason: "stop", content: [{ type: "thinking", thinking: "t" }] }), "answer"); // no text: nothing to show, handled by recover
});

test("finalAnswerText: only the answer replies of the current question, text blocks only", () => {
  const messages = [
    { role: "user", content: "q1" },
    { role: "assistant", stopReason: "stop", content: [text("old answer")] },
    { role: "user", content: "q2" },
    { role: "assistant", stopReason: "toolUse", content: [text("a draft"), call] },
    { role: "toolResult", content: [text("page text")] },
    { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "t" }, text("first"), text("second")] },
  ];
  assert.equal(finalAnswerText(messages), "first\nsecond");
  assert.equal(finalAnswerText([{ role: "user", content: "q" }]), "");
  assert.equal(finalAnswerText([{ role: "user", content: "q" }, { role: "assistant", stopReason: "error", content: [text("cut")] }]), ""); // a partial reply is not an answer
});

test("ReplyHold: text waits until it is taken, and taking empties it", () => {
  const h = new ReplyHold();
  h.push("ab");
  h.push("cd");
  assert.equal(h.length, 4);
  assert.equal(h.take(), "abcd");
  assert.equal(h.take(), "");
});

test("finalAnswerText: a repair message does not start a question, and the last answer reply is the answer", () => {
  const repair = { role: "user", content: "fix", harness: "repair" };
  const messages = [
    { role: "user", content: "q" },
    { role: "assistant", stopReason: "stop", content: [text("first draft 5.6%")] },
    repair,
    { role: "assistant", stopReason: "toolUse", content: [text("working"), call] },
    { role: "toolResult", content: [text("5.7%")] },
    { role: "assistant", stopReason: "stop", content: [text("final 5.7%")] },
  ];
  assert.equal(finalAnswerText(messages), "final 5.7%");
  assert.equal(isRepairMessage(repair), true);
  assert.equal(isRepairMessage(messages[0]), false);
  assert.equal(isRepairMessage(undefined), false);
});
