import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { recoverReply } from "../src/recover.ts";
import { guardRunaway } from "../src/runaway.ts";

// A scripted model streaming into a real Pi agent. Each request takes the next step of the script:
//   "loop"   the same tool call over and over (until cut off)      "ramble" reasoning in circles (until cut off)
//   "think"  a finished reply holding reasoning only                "empty"  a finished reply holding nothing
//   anything else: a finished reply with that answer text
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: object[], stopReason: string) => ({ role: "assistant", content, api: "openai-completions", provider: "any", model: "fake", usage, stopReason, timestamp: Date.now() });
const tick = () => new Promise((r) => setImmediate(r));

function harness(script: string[], opts: { canSwitchThinkingOff?: boolean; noAnswerHint?: () => string } = {}) {
  const log = { requests: 0, noThinkAtRequest: [] as boolean[], toolRuns: 0, events: [] as string[], said: [] as string[], shown: [] as string[] };
  let noThink = false;
  let halted = false;
  let runaway: string | undefined;
  const model: any = { id: "fake", name: "fake", api: "openai-completions", provider: "any", baseUrl: "http://x", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 8192, maxTokens: 4096 };
  const streamFn = (_m: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
    const step = script[log.requests++] ?? "late answer";
    log.noThinkAtRequest.push(noThink);
    const stream = createAssistantMessageEventStream();
    (async () => {
      stream.push({ type: "start", partial: asst([], "pending") } as never);
      if (step === "loop" || step === "ramble") {
        const content: any[] = step === "ramble" ? [{ type: "thinking", thinking: "" }] : [];
        for (let i = 0; i < 500; i++) {
          if (options?.signal?.aborted) {
            stream.push({ type: "error", reason: "aborted", error: asst(structuredClone(content), "aborted") } as never);
            return stream.end();
          }
          if (step === "ramble") {
            content[0].thinking += "So the answer is 5. But check once more. ".repeat(5);
            stream.push({ type: "thinking_delta", contentIndex: 0, delta: "x", partial: asst(structuredClone(content), "pending") } as never);
          } else {
            const c = { type: "toolCall", id: `c${i}`, name: "calculate", arguments: { a: "1" } };
            content.push(c);
            stream.push({ type: "toolcall_end", contentIndex: content.length - 1, toolCall: c, partial: asst([...content], "pending") } as never);
          }
          await tick();
        }
        stream.push({ type: "done", reason: "stop", message: asst(content, "stop") } as never);
      } else {
        const content = step === "think" ? [{ type: "thinking", thinking: "The answer is 5." }] : step === "empty" ? [] : [{ type: "text", text: step }];
        stream.push({ type: "done", reason: "stop", message: asst(content, "stop") } as never);
      }
      stream.end();
    })();
    return stream;
  };
  const tool: any = { name: "calculate", label: "c", description: "d", parameters: { type: "object", properties: {} }, execute: async () => (log.toolRuns++, { content: [{ type: "text", text: "ok" }], details: {} }) };
  const agent = new Agent({ initialState: { systemPrompt: "", model, tools: [tool] }, streamFn: streamFn as never, identity: { attribution: null } });
  guardRunaway(agent, 8, (r) => (runaway = r), 2000);
  const hooks = {
    takeRunaway: () => {
      const r = runaway;
      runaway = undefined;
      return r;
    },
    halted: () => halted,
    setNoThink: (on: boolean) => (noThink = on),
    canSwitchThinkingOff: opts.canSwitchThinkingOff ?? true,
    record: (type: string) => void log.events.push(type),
    say: (line: string) => void log.said.push(line),
    showReasoning: (t: string) => void log.shown.push(t),
    noAnswerHint: opts.noAnswerHint,
  };
  const ask = async () => {
    await agent.prompt("question");
    return recoverReply(agent, hooks);
  };
  const lastText = () => ((agent.state.messages.at(-1) as any).content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { agent, log, ask, lastText, halt: () => (halted = true), noThink: () => noThink };
}

test("a good first reply: no retry, nothing recorded", async () => {
  const h = harness(["The answer is 5."]);
  assert.deepEqual(await h.ask(), {});
  assert.equal(h.log.requests, 1);
  assert.deepEqual(h.log.events, []);
  assert.deepEqual(h.log.said, []);
});

test("a reasoning-only reply or an empty reply is retried once with thinking off and recovers", async () => {
  for (const bad of ["think", "empty"]) {
    const h = harness([bad, "The answer is 5."]);
    assert.deepEqual(await h.ask(), {});
    assert.equal(h.log.requests, 2);
    assert.deepEqual(h.log.noThinkAtRequest, [false, true]); // only the retry has thinking off
    assert.equal(h.noThink(), false); // and the switch is back on afterwards
    assert.deepEqual(h.log.events, ["repair"]);
    assert.equal(h.lastText(), "The answer is 5.");
    assert.equal(h.agent.state.messages.filter((m: any) => m.role === "assistant").length, 1); // the bad reply is gone
    assert.match(h.log.said[0], /asking again without thinking/);
  }
});

test("still no answer after the one retry: never a second retry; the reasoning that was seen is shown", async () => {
  const h = harness(["think", "empty", "must never be requested"]);
  assert.deepEqual(await h.ask(), {});
  assert.equal(h.log.requests, 2);
  assert.deepEqual(h.log.events, ["repair", "repair_failed"]);
  assert.deepEqual(h.log.shown, ["The answer is 5."]); // from the FIRST reply: the retry came back empty

  const none = harness(["empty", "empty", "must never be requested"]);
  await none.ask();
  assert.equal(none.log.requests, 2);
  assert.deepEqual(none.log.shown, []);
  assert.match(none.log.said.at(-1)!, /returned no answer/);
  assert.equal(none.log.said.at(-1), "[the model returned no answer; ask again, or rephrase the question]"); // no hook: the default advice

  const hinted = harness(["empty", "empty"], { noAnswerHint: () => "it used 7 of 8 tool calls without reaching an answer" });
  await hinted.ask();
  assert.equal(hinted.log.said.at(-1), "[the model returned no answer; it used 7 of 8 tool calls without reaching an answer]");
});

test("a looping reply (tool calls or reasoning in circles) is retried once; nothing from it runs", async () => {
  for (const bad of ["loop", "ramble"]) {
    const h = harness([bad, "The answer is 5."]);
    assert.deepEqual(await h.ask(), {});
    assert.equal(h.log.requests, 2);
    assert.deepEqual(h.log.noThinkAtRequest, [false, true]);
    assert.deepEqual(h.log.events, ["runaway_retry"]);
    assert.equal(h.log.toolRuns, 0);
    assert.equal(h.lastText(), "The answer is 5.");
  }
});

test("retries never chain: loop then no answer, and no answer then loop, both stop after two requests", async () => {
  const a = harness(["ramble", "think", "must never be requested"]);
  assert.deepEqual(await a.ask(), {});
  assert.equal(a.log.requests, 2);
  assert.deepEqual(a.log.events, ["runaway_retry", "repair_failed"]);
  assert.deepEqual(a.log.shown, ["The answer is 5."]);

  const b = harness(["think", "loop", "must never be requested"]);
  const out = await b.ask();
  assert.match(out.stuck!, /same calculate call repeated|tool calls in one reply/);
  assert.equal(b.log.requests, 2);
  assert.deepEqual(b.log.events, ["repair", "runaway_failed"]);
  assert.equal(b.log.toolRuns, 0);

  const c = harness(["loop", "loop", "must never be requested"]);
  assert.ok((await c.ask()).stuck);
  assert.equal(c.log.requests, 2);
  assert.deepEqual(c.log.events, ["runaway_retry", "runaway_failed"]);
});

test("after a user abort, guard trip or audit failure nothing is retried", async () => {
  for (const bad of ["think", "empty", "ramble"]) {
    const h = harness([bad, "must never be requested"]);
    h.halt();
    assert.deepEqual(await h.ask(), {});
    assert.equal(h.log.requests, 1);
    assert.deepEqual(h.log.events, []);
  }
});

test("a provider without a thinking switch gets a plain retry, worded as such", async () => {
  const h = harness(["think", "The answer is 5."], { canSwitchThinkingOff: false });
  await h.ask();
  assert.equal(h.log.requests, 2);
  assert.match(h.log.said[0], /asking again$/);
  assert.equal(h.lastText(), "The answer is 5.");
});
