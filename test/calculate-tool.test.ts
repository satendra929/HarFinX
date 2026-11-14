import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTool } from "../src/tools/calculate.ts";
import { readFileTool, shownSlice, CHUNK_CHARS } from "../src/tools/readFile.ts";
import { Ledger, checkText } from "../src/provenance.ts";
import { createGuard } from "../src/guard.ts";
import { D, displayLossPercent } from "../src/calc/num.ts";

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
  const finance = (await run(tool, { help: "finance" })).content[0].text;
  for (const name of ["gross_margin", "operating_margin", "net_margin", "current_ratio", "working_capital"]) assert.ok(finance.includes(name + "("), name);
  assert.match((await run(tool, { help: "nonsense" })).content[0].text, /Categories: core, growth, finance/);
});

test("finance functions: the answer is traced to the calculator and the definition is returned", async () => {
  const ledger = withSource("Net sales 11,503 Gross profit 5,200 Current assets 9,100 Current liabilities (6,500)");
  const tool = calculateTool(ledger);
  const r = await run(tool, { inputs: { gp: "5,200", s: "11,503", ca: "9,100", cl: "6,500" }, steps: [
    { name: "gross_margin", expr: "gross_margin(gp, s)", dp: 1, pct: true },
    { name: "current_ratio", expr: "current_ratio(ca, cl)", dp: 2 },
    { name: "working_capital", expr: "working_capital(ca, cl)" },
  ] });
  const text = r.content[0].text;
  assert.match(text, /gross_margin = 45\.2%/);
  assert.match(text, /current_ratio = 1\.40/);
  assert.match(text, /working_capital = 2,?600/);
  assert.match(text, /definitions: .*gross_margin\(gross_profit, revenue\) = gross_profit \/ revenue/);
  assert.match(text, /current_ratio\(current_assets, current_liabilities\) = /);
  assert.deepEqual(checkText("The gross margin was 45.2% and the current ratio 1.40.", ledger).map((c) => c.cls), ["C", "C"]);
});

test("tool is sequential and its prompt footprint stays small", () => {
  for (const shape of ["steps", "expr"] as const) {
    const tool = calculateTool(new Ledger(), shape);
    assert.equal(tool.name, "calculate");
    assert.equal(tool.executionMode, "sequential");
    const size = tool.description.length + JSON.stringify(tool.parameters).length;
    assert.ok(size < 2600, `${shape}: ${size} characters`);
    assert.ok(size < 1950, `${shape}: ${size} characters (the budget with the finance functions; raise it only on purpose)`);
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

// ---- display rounding must not distort the value (a rate shown as 0.1 instead of 10.3%) ----

const marginCall = (avgPct: boolean) => ({
  inputs: { op19: "1,306", op20: "509", op21: "2,112", sales19: "11,503", sales20: "11,303", sales21: "14,082" },
  steps: [
    { name: "margin19", expr: "op19 / sales19", dp: 1, pct: true },
    { name: "margin20", expr: "op20 / sales20", dp: 1, pct: true },
    { name: "margin21", expr: "op21 / sales21", dp: 1, pct: true },
    { name: "avg_margin", expr: "(margin19 + margin20 + margin21) / 3", dp: 1, ...(avgPct ? { pct: true } : {}) },
  ],
});
const marginSource = "Net sales 11,503 11,303 14,082 Operating income 1,306 509 2,112";

test("a rate shown as a plain number with few decimals is reported to the model, with the fix", async () => {
  const r = await run(calculateTool(withSource(marginSource)), marginCall(false));
  const text = r.content[0].text;
  assert.match(text, /avg_margin = 0\.1 /);
  assert.match(text, /WARNING: step "avg_margin": shows 0\.1 but the exact value is 0\.102848862643; rounding changed it by 2\.8%/);
  assert.match(text, /set pct:true/);
  assert.equal(r.details.warnings.length, 1); // the three percent steps round by well under 1%
  assert.match(r.details.steps[3].value, /^0\.10284886264/); // the exact value is still returned and logged
  assert.equal(r.details.steps[3].shown, "0.1"); // the display itself is unchanged
});

test("the same call with pct:true on the average is clean", async () => {
  const r = await run(calculateTool(withSource(marginSource)), marginCall(true));
  assert.match(r.content[0].text, /avg_margin = 10\.3%/);
  assert.doesNotMatch(r.content[0].text, /WARNING/);
});

test("rounding a small value to zero is reported; unrounded values and ordinary roundings are not", async () => {
  const tool = () => calculateTool(withSource("a 4 b 10,000 c 1,234.567"));
  const small = await run(tool(), { inputs: { a: "4", b: "10,000" }, steps: [{ name: "r", expr: "a / b", dp: 2 }] });
  assert.match(small.content[0].text, /WARNING: step "r": shows 0\.00 but the exact value is 0\.0004; rounding changed it by 100\.0%/);
  const plain = await run(tool(), { inputs: { a: "4", b: "10,000" }, steps: [{ name: "r", expr: "a / b" }] }); // no dp: 12 significant digits
  assert.doesNotMatch(plain.content[0].text, /WARNING/);
  const ordinary = await run(tool(), { inputs: { c: "1,234.567" }, steps: [{ name: "r", expr: "c", dp: 1 }] });
  assert.doesNotMatch(ordinary.content[0].text, /WARNING/);
});

test("displayLossPercent: the 1% limit, percent display, zero and no-decimals cases", () => {
  const x = new D("0.102848862643");
  assert.equal(displayLossPercent(x, 1, false), "2.8");
  assert.equal(displayLossPercent(x, 1, true), undefined); // 10.3 vs 10.2849: 0.2%
  assert.equal(displayLossPercent(new D(0), 1, false), undefined);
  assert.equal(displayLossPercent(x, undefined, false), undefined); // 12 significant digits
  assert.equal(displayLossPercent(new D("1.01"), 0, false), undefined); // 0.99%: just inside
  assert.equal(displayLossPercent(new D("0.99"), 0, false), "1.0"); // 1.01%: just outside
  assert.equal(displayLossPercent(new D("-0.0004"), 2, false), "100.0"); // sign does not matter
});

test("a percent with no dp defaults to one decimal, and that rounding is checked too", async () => {
  const tool = calculateTool(withSource("a 4 b 10,000"));
  const r = await run(tool, { inputs: { a: "4", b: "10,000" }, steps: [{ name: "r", expr: "a / b", pct: true }] });
  assert.match(r.content[0].text, /r = 0\.0%/);
  assert.match(r.content[0].text, /WARNING: step "r": shows 0\.0% but the exact value is 0\.0004 \(a fraction\); rounding changed it by 100\.0%/);
  assert.doesNotMatch(r.content[0].text, /set pct:true/); // already a percent: the advice is only about decimals
});
