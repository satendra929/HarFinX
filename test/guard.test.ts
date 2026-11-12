import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanForTerminal, createGuard, safeForLog } from "../src/guard.ts";

const make = (over = {}) => {
  const logs: string[] = [];
  const guard = createGuard({ maxCallsPerRun: 2, maxOutputChars: 10, maxTotalChars: 15, log: (l) => logs.push(l), ...over });
  return { guard, logs };
};
const before = (name = "t") => ({ toolCall: { name } }) as any;
const after = (text: string) => ({ result: { content: [{ type: "text", text }] } }) as any;

test("allows calls under the cap, trips above it", () => {
  const { guard } = make();
  guard.startRun();
  guard.onToolStart("t", {});
  guard.onToolStart("t", {});
  assert.equal(guard.tripped, undefined);
  guard.onToolStart("t", {});
  assert.match(guard.tripped!, /tool-call limit/);
});

test("beforeToolCall blocks and terminates once tripped", async () => {
  const { guard, logs } = make();
  guard.startRun();
  assert.equal(await guard.beforeToolCall(before()), undefined);
  for (let i = 0; i < 3; i++) guard.onToolStart("t", {});
  const r = await guard.beforeToolCall(before());
  assert.equal(r?.block, true);
  assert.equal(r?.terminate, true);
  assert.ok(logs.some((l) => l.startsWith("blocked")));
});

test("counters reset on a new run", async () => {
  const { guard } = make();
  guard.startRun();
  for (let i = 0; i < 3; i++) guard.onToolStart("t", {});
  assert.ok(guard.tripped);
  guard.startRun();
  assert.equal(guard.tripped, undefined);
  assert.equal(await guard.beforeToolCall(before()), undefined);
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
  assert.match(r!.reason!, /output limit/);
});

test("emits structured events: call, tripped (once), blocked, truncated", async () => {
  const events: any[] = [];
  const { guard } = make({ onEvent: (e: any) => events.push(e) });
  guard.startRun();
  for (let i = 0; i < 4; i++) guard.onToolStart("t", {});
  assert.deepEqual(events.filter((e) => e.kind === "call").map((e) => e.n), [1, 2, 3, 4]);
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
