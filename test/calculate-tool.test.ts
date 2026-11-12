import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTool } from "../src/tools/calculate.ts";
import { readFileTool, shownSlice, CHUNK_CHARS } from "../src/tools/readFile.ts";
import { Ledger, checkText } from "../src/provenance.ts";
import { createGuard } from "../src/guard.ts";

const run = (tool: ReturnType<typeof calculateTool>, params: object) => tool.execute("id", params as never, undefined as never) as Promise<{ content: { text: string }[]; details: any }>;
const withSource = (text: string) => {
  const l = new Ledger();
  l.addSource("income.txt", text);
  return l;
};

test("steps shape: computes, returns shown values and definitions, and registers the results as verified", async () => {
  const ledger = withSource("Net sales 11,503 11,303 Operating income 1,306 509");
  const tool = calculateTool(ledger);
  const r = await run(tool, { inputs: { s19: "11,503", o19: "1,306", s20: "11,303", o20: "509" }, steps: [
    { name: "m19", expr: "o19 / s19", dp: 2, pct: true },
    { name: "m20", expr: "o20 / s20", dp: 2, pct: true },
    { name: "mean", expr: "avg(m19, m20)", dp: 1, pct: true },
  ] });
  const text = r.content[0].text;
  assert.match(text, /m19 = 11\.35%/);
  assert.match(text, /m20 = 4\.50%/);
  assert.match(text, /mean = 7\.9%/);
  assert.match(text, /definitions: avg\(a, b, \.\.\.\) = arithmetic mean/);
  assert.match(text, /Quote the returned `shown` values exactly/);
  assert.doesNotMatch(text, /WARNING/);
  assert.equal(r.details.steps[2].shown, "7.9%");
  assert.equal(r.details.rounding, "half away from zero");
  // the answer may now quote the calculated figures, but not an invented one
  const cls = checkText("margins 11.35%, 4.50%, average 7.9%, not 13.6%", ledger).map((c) => `${c.token.raw}=${c.cls}`);
  assert.deepEqual(cls, ["11.35%=C", "4.50%=C", "7.9%=C", "13.6%=X"]);
});

test("expr shape: one expression with dp and pct", async () => {
  const tool = calculateTool(withSource("revenue 4,200 5,100"), "expr");
  const r = await run(tool, { inputs: { a: "4,200", b: "5,100" }, expr: "pct_change(a, b)", dp: 1, pct: true });
  assert.match(r.content[0].text, /result = 21\.4%/);
  await assert.rejects(() => run(tool, { inputs: {} }), /give `expr`/);
});

test("inputs and literals not found in the source or question produce warnings, not silent acceptance", async () => {
  const tool = calculateTool(withSource("Net sales 11,503"));
  const r = await run(tool, { inputs: { s: "11,503", made_up: "1,223" }, steps: [{ name: "x", expr: "s + made_up + 12.5 + 100" }] });
  const text = r.content[0].text;
  assert.match(text, /WARNING: input "made_up" = "1,223" was not found/);
  assert.match(text, /WARNING: step "x": the number 12\.5/);
  assert.doesNotMatch(text, /input "s"/); // the real source number passes
  assert.doesNotMatch(text, /number 100 /); // bare constants are fine
  assert.equal(r.details.warnings.length, 2);
});

test("user-supplied numbers are valid inputs", async () => {
  const ledger = withSource("x");
  ledger.addUser("Assume 5% growth on 1,000");
  const r = await run(calculateTool(ledger), { inputs: { g: "5%", base: "1,000" }, steps: [{ name: "next", expr: "base * (1 + g)", dp: 0 }] });
  assert.doesNotMatch(r.content[0].text, /WARNING/);
  assert.match(r.content[0].text, /next = 1050/);
});

test("errors reach the model as readable messages", async () => {
  const tool = calculateTool(withSource("x"));
  await assert.rejects(() => run(tool, { inputs: { a: "5 million" }, steps: [{ name: "r", expr: "a" }] }), /Unit words/);
  await assert.rejects(() => run(tool, { steps: [{ name: "r", expr: "1 / 0" }] }), /division by zero/);
  await assert.rejects(() => run(tool, { steps: [{ name: "r", expr: "zz + 1" }] }), /unknown name "zz"/);
  await assert.rejects(() => run(tool, {}), /give `steps`/);
});

test("help lists definitions without calculating", async () => {
  const tool = calculateTool(new Ledger());
  assert.match((await run(tool, { help: "cagr" })).content[0].text, /\(end \/ begin\) \^ \(1 \/ years\) - 1/);
  assert.match((await run(tool, { help: "growth" })).content[0].text, /pct_change/);
});

test("tool is sequential and its prompt footprint stays small (8k context)", () => {
  for (const shape of ["steps", "expr"] as const) {
    const tool = calculateTool(new Ledger(), shape);
    assert.equal(tool.name, "calculate");
    assert.equal(tool.executionMode, "sequential");
    const size = tool.description.length + JSON.stringify(tool.parameters).length;
    assert.ok(size < 2600, `${shape}: ${size} characters`);
  }
});

test("guard: calculate keeps working after the output budget is spent; read_file does not", async () => {
  const g = createGuard({ maxCallsPerRun: 20, maxOutputChars: 100, maxTotalChars: 50, log: () => {}, budgetExempt: ["calculate"] });
  g.startRun();
  await g.afterToolCall({ toolCall: { name: "read_file" }, result: { content: [{ type: "text", text: "x".repeat(60) }] } } as never);
  assert.equal((await g.beforeToolCall({ toolCall: { name: "read_file" } } as never))?.block, true);
  assert.equal(await g.beforeToolCall({ toolCall: { name: "calculate" } } as never), undefined);
  // calculate output does not eat the budget either
  g.startRun();
  await g.afterToolCall({ toolCall: { name: "calculate" }, result: { content: [{ type: "text", text: "y".repeat(90) }] } } as never);
  assert.equal(await g.beforeToolCall({ toolCall: { name: "read_file" } } as never), undefined);
});

test("shownSlice: a number cut by a chunk edge is excluded there and included whole in the next chunk", () => {
  const text = "ab 1,306 cd";
  assert.equal(shownSlice(text, 0, 6), "ab "); // "1,3|06": partial token held back
  assert.equal(shownSlice(text, 6, 11), "1,306 cd"); // continues from the start of the split token
  assert.equal(shownSlice(text, 0, text.length), text);
  assert.equal(shownSlice("aaaa", 0, 2), "aaaa".slice(0, 2)); // one giant token: keep what we have
});

test("read_file feeds the ledger with what the model was shown, across chunks", async () => {
  const filler = "x ".repeat((CHUNK_CHARS - 6) / 2); // 3,994 chars
  const text = filler + "1,306,000 end 2,278";
  const ws = { root: "/w", readText: async () => text };
  const ledger = new Ledger();
  const tool = readFileTool(ws as never, (p, t) => ledger.addSource(p, t));
  await tool.execute("a", { path: "f.txt", offset: 0 } as never, undefined as never);
  assert.deepEqual(checkText("1,306,000", ledger).map((c) => c.cls), ["X"]); // cut at the edge: not yet shown in full
  await tool.execute("b", { path: "f.txt", offset: CHUNK_CHARS } as never, undefined as never);
  assert.deepEqual(checkText("1,306,000 and 2,278", ledger).map((c) => c.cls), ["S", "S"]);
});
