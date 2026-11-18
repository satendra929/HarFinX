import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_NOW, createGuard, MAX_FREE_REPEATS, REPEATED_CALL, type GuardEvent } from "../src/guard.ts";
import { callKey } from "../src/callKey.ts";

const make = (over = {}) => {
  const logs: string[] = [];
  const events: GuardEvent[] = [];
  const guard = createGuard({ maxCallsPerRun: 8, maxOutputChars: 1000, maxTotalChars: 100000, log: (l) => logs.push(l), onEvent: (e) => events.push(e), callKey, budgetExempt: ["calculate"], ...over });
  return { guard, logs, events };
};
const ctx = (name: string, args: object, isError = false) => ({ toolCall: { name, arguments: args }, args: { ignored: "the hooks must key on the call's own arguments" }, isError, result: { content: [{ type: "text", text: "ok" }] } }) as any;

/** One call as the agent runs it: start event, the before hook, and (when it ran) the after hook. */
async function run(guard: ReturnType<typeof createGuard>, name: string, args: object, isError = false) {
  guard.onToolStart(name, args);
  const b = await guard.beforeToolCall(ctx(name, args));
  if (!b?.block) await guard.afterToolCall(ctx(name, args, isError));
  return b;
}
const search = { path: "a.pdf", query: "total net sales" };

test("an identical call after a successful one is not run, is not counted and is not a budget refusal", async () => {
  const { guard, events } = make();
  guard.startRun();
  guard.onReply();
  assert.equal(await run(guard, "search", search), undefined);
  assert.equal(guard.calls, 1);
  const r = await run(guard, "search", { ...search, query: "Total Net Sales" });
  assert.equal(r?.block, true);
  assert.equal(r?.reason, REPEATED_CALL);
  assert.equal(r?.terminate, undefined);
  assert.doesNotMatch(REPEATED_CALL, /[0-9]/);
  assert.equal(guard.calls, 1); // not counted
  assert.equal(guard.blocked, undefined); // no budget note, no soft stop
  assert.equal(guard.tripped, undefined);
  assert.deepEqual(events.filter((e) => e.kind === "repeat"), [{ kind: "repeat", tool: "search", free: true }]);
});

test("only the first repeats are free: later ones count, so a loop still reaches the call limit and stops", async () => {
  const { guard, events } = make({ maxCallsPerRun: 3 });
  guard.startRun();
  guard.onReply();
  await run(guard, "search", search); // call 1
  for (let i = 0; i < MAX_FREE_REPEATS; i++) await run(guard, "search", search);
  assert.equal(guard.calls, 1);
  const r = await run(guard, "search", search); // counted: call 2, still a repeat
  assert.equal(r?.reason, REPEATED_CALL);
  assert.equal(guard.calls, 2);
  assert.equal(events.filter((e) => e.kind === "repeat" && !e.free).length, 1);
  await run(guard, "search", search); // call 3
  guard.onReply();
  const over = await run(guard, "search", search); // call 4 > limit: the usual soft stop
  assert.equal(over?.reason, ANSWER_NOW);
  guard.onReply();
  await run(guard, "search", search); // refused in a later reply: the question stops
  assert.match(guard.tripped!, /tool-call limit/);
});

test("a failed call is not remembered, so it may be tried again", async () => {
  const { guard } = make();
  guard.startRun();
  assert.equal(await run(guard, "read_page", { path: "a.pdf", page: 3 }, true), undefined);
  assert.equal(await run(guard, "read_page", { path: "a.pdf", page: 3 }), undefined); // runs again
  assert.equal((await run(guard, "read_page", { path: "a.pdf", page: 3 }))?.reason, REPEATED_CALL); // now it did succeed once
});

test("a call that was blocked by a limit is not remembered as done", async () => {
  const { guard } = make({ maxCallsPerRun: 1 });
  guard.startRun();
  guard.onReply();
  await run(guard, "outline", { path: "a.pdf" }); // call 1
  const over = await run(guard, "search", search); // call 2: refused, never ran
  assert.equal(over?.reason, ANSWER_NOW);
  const guard2 = make({ maxCallsPerRun: 1 }).guard;
  guard2.startRun();
  guard2.onReply();
  await run(guard2, "outline", { path: "a.pdf" });
  await run(guard2, "search", search); // refused
  guard2.startRun(); // a new question: the memory is gone
  assert.equal(await run(guard2, "search", search), undefined);
});

test("different calls are never repeats; calculate is never a repeat; a new question forgets the old calls", async () => {
  const { guard } = make();
  guard.startRun();
  await run(guard, "search", search);
  assert.equal(await run(guard, "search", { ...search, query: "net income" }), undefined);
  assert.equal(await run(guard, "search", { ...search, path: "b.pdf" }), undefined);
  assert.equal(await run(guard, "read_page", { path: "a.pdf", page: 1 }), undefined);
  assert.equal(await run(guard, "read_page", { path: "a.pdf", page: 1, part: 2 }), undefined);
  const calc = { inputs: { a: "1" }, expr: "a + 1" };
  assert.equal(await run(guard, "calculate", calc), undefined);
  assert.equal(await run(guard, "calculate", calc), undefined);
  guard.startRun();
  assert.equal(await run(guard, "search", search), undefined);
});

test("the free repeats are per question: a new question gets them again", async () => {
  const { guard, events } = make();
  guard.startRun();
  await run(guard, "search", search);
  for (let i = 0; i < MAX_FREE_REPEATS + 1; i++) await run(guard, "search", search);
  assert.equal(guard.calls, 2); // the last repeat was counted
  guard.startRun();
  await run(guard, "search", search);
  await run(guard, "search", search);
  assert.equal(guard.calls, 1);
  assert.equal(events.filter((e) => e.kind === "repeat" && e.free).length, MAX_FREE_REPEATS + 1);
});

test("a repeat after the call limit was passed (calculate may run over it) is counted, so the soft stop sees it", async () => {
  const { guard, events } = make({ maxCallsPerRun: 2 });
  guard.startRun();
  guard.onReply();
  await run(guard, "search", search); // call 1
  await run(guard, "outline", { path: "a.pdf" }); // call 2
  await run(guard, "calculate", { inputs: { a: "1" }, expr: "a" }); // call 3, exempt from the limit
  assert.equal(guard.calls, 3);
  const r = await run(guard, "search", search); // a repeat, but the limit is passed
  assert.equal(r?.reason, ANSWER_NOW); // the limit's answer-now text, not the repeat text
  assert.equal(guard.calls, 4); // counted
  assert.deepEqual(events.filter((e) => e.kind === "repeat"), [{ kind: "repeat", tool: "search", free: false }]);
  assert.match(guard.blocked!, /tool-call limit/);
  guard.onReply();
  await run(guard, "search", search); // refused again in a later reply: the question stops
  assert.match(guard.tripped!, /tool-call limit/);
});

test("without a callKey option nothing is a repeat; a tripped question keeps its own stop", async () => {
  const { guard } = make({ callKey: undefined });
  guard.startRun();
  await run(guard, "search", search);
  assert.equal(await run(guard, "search", search), undefined);

  const t = make({ maxCallsPerRun: 1 }).guard;
  t.startRun();
  t.onReply();
  await run(t, "search", search);
  t.onReply();
  await run(t, "outline", { path: "a.pdf" }); // refused
  t.onReply();
  await run(t, "outline", { path: "a.pdf" }); // refused in a later reply: tripped
  const r = await run(t, "search", search);
  assert.equal(r?.terminate, true); // the stop wins over the repeat text
  assert.equal(r?.reason, ANSWER_NOW);
});
