import { test } from "node:test";
import assert from "node:assert/strict";
import { answerlessReply, lastReasoning, repairAnswerless } from "../src/repair.ts";
import { makePayloadHook } from "../src/payload.ts";

const asst = (content: object[], stopReason = "stop") => ({ role: "assistant", stopReason, content });
const think = (t: string) => ({ type: "thinking", thinking: t });
const text = (t: string) => ({ type: "text", text: t });
const call = { type: "toolCall", name: "calculate", arguments: {} };

test("a finished reply without answer text or tool call is classified; every other shape is not", () => {
  assert.equal(answerlessReply([asst([think("The answer is 5.")])]), "reasoning_only");
  assert.equal(answerlessReply([asst([think("x"), text("   ")])]), "reasoning_only"); // whitespace text is no text
  assert.equal(answerlessReply([asst([think("x")], "length")]), "reasoning_only"); // thinking used up the output budget
  assert.equal(answerlessReply([asst([])]), "empty"); // e.g. the server dropped a malformed tool call, thinking off
  assert.equal(answerlessReply([asst([think("  ")])]), "empty");
  assert.equal(answerlessReply([asst([text("")], "length")]), "empty");
  assert.equal(answerlessReply([{ role: "assistant", stopReason: "stop" }]), "empty"); // no content array at all
  assert.equal(answerlessReply([asst([think("x"), text("The answer is 5.")])]), undefined);
  assert.equal(answerlessReply([asst([text("cut off mid-sentence")], "length")]), undefined); // the user saw text
  assert.equal(answerlessReply([asst([think("x"), call])]), undefined); // a tool call is a legitimate turn
  assert.equal(answerlessReply([asst([think("x")], "toolUse")]), undefined);
  assert.equal(answerlessReply([asst([think("x")], "error")]), undefined); // errors are reported, not retried
  assert.equal(answerlessReply([asst([], "aborted")]), undefined);
  assert.equal(answerlessReply([{ role: "user", content: "hi" }]), undefined);
  assert.equal(answerlessReply([{ role: "toolResult", content: [] }]), undefined);
  assert.equal(answerlessReply([]), undefined);
  assert.equal(lastReasoning([asst([think("a"), think("b")])]), "a\nb");
  assert.equal(lastReasoning([asst([])]), "");
});

test("detection keys off the shape of the reply only, never the model or provider", () => {
  const reply = (extra: object) => [{ role: "assistant", stopReason: "stop", content: [think("hidden answer")], ...extra }];
  for (const extra of [{ provider: "ollama", model: "qwen3:14b" }, { provider: "anthropic", model: "claude-x" }, { provider: "other", model: "no-reasoning-model" }, {}]) {
    assert.equal(answerlessReply(reply(extra)), "reasoning_only");
  }
});

test("repair drops the reply, continues once with thinking off, and always switches the flag back", async () => {
  const flagLog: boolean[] = [];
  let continued = 0;
  const agent: any = {
    state: { messages: [{ role: "user", content: "q" }, asst([think("answer")])] },
    continue: async () => {
      continued++;
      agent.state.messages = [...agent.state.messages, asst([text("proper answer")])];
    },
  };
  assert.equal(await repairAnswerless(agent, (on) => flagLog.push(on)), true);
  assert.equal(continued, 1);
  assert.deepEqual(flagLog, [true, false]);
  assert.equal(agent.state.messages.length, 2); // user + the new reply; the bad one is gone
  assert.equal(answerlessReply(agent.state.messages), undefined);

  // nothing to repair: no continue, no flag change
  const ok: any = { state: { messages: [asst([think("x"), text("fine")])] }, continue: async () => { throw new Error("must not run"); } };
  assert.equal(await repairAnswerless(ok, () => assert.fail("flag must not change")), false);

  // an empty reply (no reasoning either) is repaired the same way
  let again = 0;
  const empty: any = {
    state: { messages: [{ role: "user", content: "q" }, asst([])] },
    continue: async () => {
      again++;
      empty.state.messages = [...empty.state.messages, asst([text("ok")])];
    },
  };
  assert.equal(await repairAnswerless(empty, () => {}), true);
  assert.equal(again, 1);
  assert.equal(empty.state.messages.length, 2);

  // continue() failing still resets the flag
  const flags: boolean[] = [];
  const boom: any = { state: { messages: [asst([think("x")])] }, continue: async () => { throw new Error("boom"); } };
  await assert.rejects(() => repairAnswerless(boom, (on) => flags.push(on)), /boom/);
  assert.deepEqual(flags, [true, false]);
});

test("payload hook: drops replayed reasoning by default and adds the profile's thinking-off fields only on the retry", () => {
  const payload = { model: "m", messages: [{ role: "assistant", reasoning: "r", content: null }] };
  let noThink = false;
  const hook = makePayloadHook({ thinkingOff: { reasoning_effort: "none" }, noThink: () => noThink }) as (p: unknown) => any;
  assert.equal(hook(payload).messages[0].reasoning, undefined);
  assert.equal(hook(payload).reasoning_effort, undefined);
  noThink = true;
  assert.equal(hook(payload).reasoning_effort, "none");
  assert.equal(hook(payload).model, "m");
  assert.equal((makePayloadHook({ history: "keep" }) as (p: unknown) => any)(payload).messages[0].reasoning, "r");

  // a provider without a thinking switch: the retry request is left exactly as it was built
  const plain = makePayloadHook({ history: "keep", noThink: () => true });
  assert.equal(plain(payload), payload);
  // another server's switch is merged as given: no field name is hard-coded in the hook
  const other = makePayloadHook({ history: "keep", thinkingOff: { chat_template_kwargs: { enable_thinking: false } }, noThink: () => true }) as (p: unknown) => any;
  assert.deepEqual(other(payload).chat_template_kwargs, { enable_thinking: false });
  assert.equal(other(payload).reasoning_effort, undefined);
});
