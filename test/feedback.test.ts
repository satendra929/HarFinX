import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuard } from "../src/guard.ts";
import { COUNTER_FROM, budgetNote, callLimitMessage, emptyAnswerHint, loopMessage, oneLine, searchResultLine, toolLine } from "../src/feedback.ts";

test("oneLine: control characters, newlines and tabs become spaces; whitespace collapses", () => {
  assert.equal(oneLine("a\nb\tc\r\nd"), "a b c d");
  assert.equal(oneLine("  spaced   out  "), "spaced out");
  assert.equal(oneLine("x\u001b[31mred\u001b[0m"), "x [31mred [0m"); // ESC removed; what is left is harmless text
  assert.equal(oneLine("a\u0000b\u007fc\u009bd"), "a b c d");
});

test("oneLine: bidi marks, zero-width characters, separators, soft hyphen and BOM cannot survive", () => {
  for (const c of ["\u202e", "\u202a", "\u2066", "\u2069", "\u200b", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u2028", "\u2029", "\u061c", "\u180e"]) {
    const out = oneLine(`file${c}name.pdf`);
    assert.equal(out, "file name.pdf", `U+${c.codePointAt(0)!.toString(16)}`);
  }
});

test("oneLine: lone surrogates are removed, pairs (emoji, rare characters) stay, and cutting never splits a pair", () => {
  assert.equal(oneLine("a\ud800b"), "a b");
  assert.equal(oneLine("a\udc00b"), "a b");
  assert.equal(oneLine("gain 📈 up"), "gain 📈 up");
  const cut = oneLine("📈".repeat(10), 4);
  assert.equal(cut, "📈📈📈…");
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut));
});

test("oneLine: cuts long text with an ellipsis, handles non-strings and tiny limits", () => {
  assert.equal(oneLine("abcdefghij", 5), "abcd…");
  assert.equal(oneLine("abcde", 5), "abcde");
  assert.equal(oneLine(undefined), "");
  assert.equal(oneLine(null), "");
  assert.equal(oneLine(42), "42");
  assert.equal(oneLine({ a: 1 }), "[object Object]");
  assert.equal(oneLine("abc", 1), "…");
  assert.equal(oneLine("\n\n"), "");
});

test("toolLine: each tool names its target", () => {
  assert.equal(toolLine("read_page", { path: "filings/X.pdf", page: 68 }, 1, 8), "→ read page 68 of filings/X.pdf");
  assert.equal(toolLine("read_page", { path: "filings/X.pdf", page: 68, part: 2 }, 1, 8), "→ read page 68 (part 2) of filings/X.pdf");
  assert.equal(toolLine("read_page", { path: "x.pdf", page: 3, part: 1 }, 1, 8), "→ read page 3 of x.pdf");
  assert.equal(toolLine("search", { path: "filings/X.pdf", query: "inventory balance" }, 1, 8), '→ search "inventory balance" in filings/X.pdf');
  assert.equal(toolLine("search", { query: "supply chain" }, 1, 8), '→ search "supply chain"');
  assert.equal(toolLine("list_files", {}, 1, 8), "→ list files");
  assert.equal(toolLine("read_file", { path: "notes.txt" }, 1, 8), "→ read notes.txt");
  assert.equal(toolLine("read_file", { path: "notes.txt", offset: 4000 }, 1, 8), "→ read notes.txt from character 4000");
  assert.equal(toolLine("read_file", { path: "notes.txt", offset: 0 }, 1, 8), "→ read notes.txt");
});

test("toolLine: calculate shows the expressions (so it is visible the model did not do the arithmetic)", () => {
  assert.equal(toolLine("calculate", { inputs: { a: "1" }, steps: [{ name: "m", expr: "op / sales" }, { name: "g", expr: "m * 100" }] }, 1, 8), "→ calculate  op / sales; m * 100");
  assert.equal(toolLine("calculate", { inputs: {}, expr: "avg(a, b)" }, 1, 8), "→ calculate  avg(a, b)");
  assert.equal(toolLine("calculate", { help: true }, 1, 8), "→ calculate");
  assert.equal(toolLine("calculate", { steps: [{ name: "m" }] }, 1, 8), "→ calculate");
});

test("toolLine: an unknown tool shows its name and first text argument; odd arguments never throw", () => {
  assert.equal(toolLine("web_lookup", { q: "rates", n: 3 }, 1, 8), "→ web_lookup  rates");
  assert.equal(toolLine("noargs", undefined, 1, 8), "→ noargs");
  assert.equal(toolLine("read_page", null, 1, 8), "→ read page  of ?");
  assert.equal(toolLine("read_page", "text", 1, 8), "→ read page  of ?");
});

test("toolLine: model-controlled text cannot add a line, move the cursor or reorder the line", () => {
  const evil = toolLine("read_page", { path: "a\n\u001b[2J\u202epdf.exe\r", page: "1\n2" }, 1, 8);
  assert.ok(!/[\n\r\u001b\u202e]/.test(evil));
  assert.equal(evil.split("\n").length, 1);
  assert.ok(!/[\n\r\u001b]/.test(toolLine("search", { query: "q\n→ fake line\u001b[0m" }, 1, 8)));
});

test("toolLine: the call count shows only near the limit and never past it", () => {
  const at = (n: number) => toolLine("list_files", {}, n, 8);
  assert.equal(COUNTER_FROM, 0.75);
  for (let n = 1; n <= 5; n++) assert.ok(!at(n).includes("call"), `n=${n}`);
  assert.ok(at(6).endsWith("(call 6 of 8)"));
  assert.ok(at(8).endsWith("(call 8 of 8)"));
  assert.ok(!at(9).includes("call"), "never 'call 9 of 8'");
  assert.ok(!toolLine("list_files", {}, 1, 0).includes("call"));
  assert.ok(toolLine("list_files", {}, 3, 4).endsWith("(call 3 of 4)"));
});

test("searchResultLine: the pages returned, or none, or nothing for other shapes", () => {
  assert.equal(searchResultLine({ pages: [68, 70, 12] }), "  → p.68, p.70, p.12");
  assert.equal(searchResultLine({ pages: [] }), "  → no page matched");
  assert.equal(searchResultLine({ pages: [3, "x", 4.5, 5] }), "  → p.3, p.5");
  for (const d of [undefined, null, 5, {}, { pages: "no" }]) assert.equal(searchResultLine(d), undefined);
});

test("stop messages say what happened and what to do next", () => {
  assert.equal(callLimitMessage("tool-call limit reached (8 per question)"), "Stopped: tool-call limit reached (8 per question). The question needed more steps than the limit allows. Ask a narrower question (name the file, the statement and the year), or split it into two.");
  assert.equal(loopMessage("same calculate call repeated"), "The model got stuck in a loop and was stopped (same calculate call repeated). Ask again, or rephrase the question; a narrower question usually helps.");
  assert.equal(budgetNote("tool output limit reached (12000 characters per question)"), "[limit] tool output limit reached (12000 characters per question). The answer may be incomplete: ask about one statement or page at a time.");
});

test("stop messages never pass raw model or server text through (reasons are cleaned and cut)", () => {
  for (const m of [callLimitMessage("a\n\u001b[31mb‮"), loopMessage("x\r\ny".repeat(100)), budgetNote("q\u0000\nr")]) {
    assert.ok(!/[\n\r\u001b‮\u0000]/.test(m));
  }
  assert.ok(loopMessage("y".repeat(500)).length < 260);
});

test("emptyAnswerHint: general advice normally, a specific one after the model had used most of its calls", () => {
  assert.equal(emptyAnswerHint(0, 8), "ask again, or rephrase the question");
  assert.equal(emptyAnswerHint(5, 8), "ask again, or rephrase the question");
  assert.equal(emptyAnswerHint(6, 8), "it used 6 of 8 tool calls without reaching an answer; ask for one specific figure (name the file, the statement and the year)");
  assert.match(emptyAnswerHint(9, 8), /^it used 9 of 8 tool calls/);
  assert.equal(emptyAnswerHint(3, 0), "ask again, or rephrase the question");
});

// ---- the guard now logs only when it acts ------------------------------------------------------------------------

test("guard.blocked: the reason the first call was refused, kept for the question and cleared on the next", async () => {
  const { guard } = make({ maxTotalChars: 5, maxOutputChars: 100 });
  guard.startRun();
  assert.equal(guard.blocked, undefined);
  await guard.afterToolCall({ toolCall: { name: "read_file" }, result: { content: [{ type: "text", text: "x".repeat(50) }] } } as any); // spends the budget
  await guard.beforeToolCall({ toolCall: { name: "read_file" } } as any);
  assert.match(guard.blocked!, /tool output limit reached \(5 characters per question\)/);
  await guard.beforeToolCall({ toolCall: { name: "read_file" } } as any);
  assert.match(guard.blocked!, /tool output limit/); // the first reason stays
  guard.startRun();
  assert.equal(guard.blocked, undefined);
  assert.equal(guard.tripped, undefined);
});

test("guard.blocked: a call over the limit is blocked as a trip, not as a budget note (the CLI tells them apart by `tripped`)", async () => {
  const { guard } = make();
  guard.startRun();
  for (let i = 0; i < 3; i++) guard.onToolStart("t", {});
  await guard.beforeToolCall({ toolCall: { name: "t" } } as any);
  assert.ok(guard.tripped);
  assert.match(guard.blocked!, /tool-call limit/);
});

const make = (over = {}) => {
  const logs: string[] = [];
  const events: any[] = [];
  const guard = createGuard({ maxCallsPerRun: 2, maxOutputChars: 10, maxTotalChars: 1000, log: (l) => logs.push(l), onEvent: (e) => events.push(e), ...over });
  return { guard, logs, events };
};

test("guard: routine calls are not logged (the CLI shows them dim); they still count and still produce audit events", () => {
  const { guard, logs, events } = make();
  guard.startRun();
  guard.onToolStart("read_page", { path: "a.pdf", page: 1 });
  guard.onToolStart("search", { query: "x" });
  assert.deepEqual(logs, []);
  assert.equal(guard.calls, 2);
  assert.deepEqual(events.map((e) => e.kind), ["call", "call"]);
});

test("guard: going over the call limit is logged once (yellow in the CLI), trips, and the over-limit call is not shown as 'call 3 of 2'", () => {
  const { guard, logs, events } = make();
  guard.startRun();
  for (let i = 0; i < 4; i++) guard.onToolStart("read_page", {});
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^stopping this question: tool-call limit reached \(2 per question\); the call to "read_page" is not run$/);
  assert.ok(guard.tripped);
  assert.equal(events.filter((e) => e.kind === "tripped").length, 1);
});

test("guard: a result cut at the limit is logged", async () => {
  const { guard, logs, events } = make();
  guard.startRun();
  await guard.afterToolCall({ toolCall: { name: "read_file" }, result: { content: [{ type: "text", text: "x".repeat(50) }] } } as any);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^"read_file" result cut at 10 of 50 characters$/);
  assert.equal(events.filter((e) => e.kind === "truncated").length, 1);
});

test("guard: a blocked call is still logged", async () => {
  const { guard, logs } = make();
  guard.startRun();
  for (let i = 0; i < 3; i++) guard.onToolStart("t", {});
  logs.length = 0;
  await guard.beforeToolCall({ toolCall: { name: "t" } } as any);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^blocked "t": /);
});
