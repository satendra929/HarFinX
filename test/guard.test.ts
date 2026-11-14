import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_NOW, cleanForTerminal, createGuard, safeForLog } from "../src/guard.ts";

const make = (over = {}) => {
  const logs: string[] = [];
  const guard = createGuard({ maxCallsPerRun: 2, maxOutputChars: 10, maxTotalChars: 15, log: (l) => logs.push(l), ...over });
  return { guard, logs };
};
const before = (name = "t") => ({ toolCall: { name } }) as any;
const after = (text: string) => ({ result: { content: [{ type: "text", text }] } }) as any;

test("calls over the cap are refused softly the first time: no trip, and the model is told to answer (no digits in that text)", async () => {
  const { guard } = make();
  guard.startRun();
  guard.onReply();
  guard.onToolStart("t", {});
  guard.onToolStart("t", {});
  assert.equal(await guard.beforeToolCall(before()), undefined);
  guard.onToolStart("t", {});
  assert.equal(guard.tripped, undefined);
  const r = await guard.beforeToolCall(before());
  assert.equal(r?.block, true);
  assert.equal(r?.terminate, undefined); // the loop goes on: the model gets a reply to answer in
  assert.equal(r?.reason, ANSWER_NOW);
  assert.doesNotMatch(ANSWER_NOW, /[0-9]/);
  assert.match(guard.blocked!, /tool-call limit/);
});

test("a refusal in a later reply stops the question; beforeToolCall then blocks and terminates", async () => {
  const { guard, logs } = make();
  guard.startRun();
  guard.onReply();
  for (let i = 0; i < 3; i++) guard.onToolStart("t", {});
  assert.equal(guard.tripped, undefined);
  guard.onReply(); // the model answered with another call instead of text
  guard.onToolStart("t", {});
  assert.match(guard.tripped!, /tool-call limit/);
  const r = await guard.beforeToolCall(before());
  assert.equal(r?.block, true);
  assert.equal(r?.terminate, true);
  assert.ok(logs.some((l) => l.startsWith("blocked")));
});

test("several over-limit calls in the same reply are all soft", async () => {
  const { guard } = make();
  guard.startRun();
  guard.onReply();
  for (let i = 0; i < 4; i++) {
    guard.onToolStart("t", {});
    if (i >= 2) assert.equal((await guard.beforeToolCall(before()))?.terminate, undefined);
  }
  assert.equal(guard.tripped, undefined);
});

test("calls past twice the limit always stop the question, even within one reply (a loop cannot go on)", () => {
  const { guard } = make();
  guard.startRun();
  guard.onReply();
  for (let i = 0; i < 5; i++) guard.onToolStart("t", {});
  assert.match(guard.tripped!, /tool-call limit/);
});

test("the calculator may run over the call limit after a soft stop, up to twice the limit", async () => {
  const { guard } = make({ budgetExempt: ["calculate"] });
  guard.startRun();
  guard.onReply();
  for (let i = 0; i < 2; i++) guard.onToolStart("read_page", {});
  guard.onToolStart("calculate", {}); // call 3: over the limit, but exempt
  assert.equal(await guard.beforeToolCall(before("calculate")), undefined);
  assert.equal(guard.blocked, undefined);
  guard.onToolStart("read_page", {}); // call 4: refused softly
  assert.equal((await guard.beforeToolCall(before("read_page")))?.block, true);
  assert.equal(guard.tripped, undefined);
  guard.onToolStart("calculate", {}); // call 5: past twice the limit
  assert.ok(guard.tripped);
});

test("counters reset on a new run", async () => {
  const { guard } = make();
  guard.startRun();
  guard.onReply();
  for (let i = 0; i < 5; i++) guard.onToolStart("t", {});
  assert.ok(guard.tripped);
  guard.startRun();
  assert.equal(guard.tripped, undefined);
  assert.equal(guard.blocked, undefined);
  guard.onReply();
  for (let i = 0; i < 3; i++) guard.onToolStart("t", {});
  assert.equal(guard.tripped, undefined); // the soft-stop memory was cleared too
  assert.equal(await guard.beforeToolCall(before()).then((r) => r?.terminate), undefined);
});

test("truncates oversize output", async () => {
  const { guard } = make();
  guard.startRun();
  const r = await guard.afterToolCall(after("x".repeat(50)));
  const text = (r!.content![0] as any).text as string;
  assert.ok(text.startsWith("x".repeat(10)));
  assert.match(text, /truncated/);
  assert.equal(await guard.afterToolCall(after("short")), undefined); // untouched output: no override
});

test("blocks further calls after the total output budget is spent", async () => {
  const { guard } = make();
  guard.startRun();
  await guard.afterToolCall(after("a".repeat(8)));
  assert.equal(await guard.beforeToolCall(before()), undefined);
  await guard.afterToolCall(after("b".repeat(8)));
  const r = await guard.beforeToolCall(before());
  assert.equal(r?.block, true);
  assert.equal(r?.terminate, undefined); // soft: the model may still answer
  assert.equal(r?.reason, ANSWER_NOW);
  assert.match(guard.blocked!, /output limit/);
  guard.onReply(); // a later reply asks again: now the question is stopped
  const again = await guard.beforeToolCall(before());
  assert.equal(again?.terminate, true);
  assert.match(guard.tripped!, /output limit/);
});

test("emits structured events: call, tripped (once), blocked, truncated", async () => {
  const events: any[] = [];
  const { guard } = make({ onEvent: (e: any) => events.push(e) });
  guard.startRun();
  guard.onReply();
  for (let i = 0; i < 6; i++) guard.onToolStart("t", {});
  assert.deepEqual(events.filter((e) => e.kind === "call").map((e) => e.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(events.filter((e) => e.kind === "tripped").length, 1); // reported once, not on every extra call
  await guard.beforeToolCall(before("t"));
  assert.ok(events.some((e) => e.kind === "blocked" && e.tool === "t"));
  guard.startRun();
  await guard.afterToolCall({ toolCall: { name: "t" }, result: { content: [{ type: "text", text: "x".repeat(50) }] } } as any);
  assert.ok(events.some((e) => e.kind === "truncated" && e.originalChars === 50 && e.maxChars === 10));
});

test("terminal text loses escape codes and control characters but keeps newlines and tabs", () => {
  const s = cleanForTerminal("ok\n\tline\u001b[33m[guard] fake\u001b[0m\r\u0007\u009b");
  assert.doesNotMatch(s, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.ok(s.includes("\n\t"));
  assert.ok(s.startsWith("ok\n\tline"));
});

test("logged text has no terminal control characters and is truncated", () => {
  const s = safeForLog({ path: "a\u001b[31mred\u0007\u009b" + "z".repeat(500) });
  assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(s.length <= 201);
});
