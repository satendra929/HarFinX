import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, checkText, maskLabels } from "../src/provenance.ts";
import { LineMarker, RefNumbers, markLine } from "../src/refs.ts";
import { buildSources, formatSources, placeKey } from "../src/sources.ts";

const mark = (m: string) => `<${m}>`; // visible in the assertions

function page(l: Ledger, file: string, p: number, lines: string[]): void {
  l.addSource(`${file} p.${p}`, lines.join("\n"), { file, page: p, pageLines: lines, lineOffset: 0 });
}
const A = ["Merchandise inventories  |  5,818  |  5,923", "Total current assets  |  19,815  |  18,000"];
const B = ["Net sales  |  46,298  |  51,761"];
function ledger(): Ledger {
  const l = new Ledger();
  l.addUser("What were inventories?");
  page(l, "filings/a.pdf", 1, A);
  page(l, "filings/a.pdf", 2, B);
  return l;
}

test("a figure read from a page gets a mark after it (after its scale word, before the full stop); the same page keeps its number", () => {
  const l = ledger();
  const refs = new RefNumbers();
  assert.equal(markLine("Inventories were $5,818 million.", l, refs, mark), "Inventories were $5,818 million<[1]>.");
  assert.equal(markLine("Again: 5,818.", l, refs, mark), "Again: 5,818<[1]>.");
  assert.equal(markLine("Sales were 46,298 and 5,923.", l, refs, mark), "Sales were 46,298<[2]> and 5,923<[1]>.");
  assert.deepEqual(refs.order, [placeKey({ file: "filings/a.pdf", page: 1 }), placeKey({ file: "filings/a.pdf", page: 2 })]);
});

test("a figure on two read pages gets both numbers; one on more pages than the list shows gets none", () => {
  const l = ledger();
  page(l, "filings/a.pdf", 3, ["Other  |  5,818"]);
  const refs = new RefNumbers();
  assert.equal(markLine("5,818", l, refs, mark), "5,818<[1][2]>");
  page(l, "filings/a.pdf", 4, ["Other  |  5,818"]);
  page(l, "filings/a.pdf", 5, ["Other  |  5,818"]);
  assert.equal(markLine("5,818", l, new RefNumbers(), mark), "5,818"); // four pages: listed as 'many', not marked
});

test("no mark for years, the user's own numbers, untraced figures, or text without numbers", () => {
  const l = ledger();
  page(l, "filings/a.pdf", 3, ["Fiscal year 2022 results", "Sales 777"]);
  l.addUser("Assume growth of 4.5%");
  const refs = new RefNumbers();
  assert.equal(markLine("In 2022 growth of 4.5% gave 123,456.", l, refs, mark), "In 2022 growth of 4.5% gave 123,456.");
  assert.equal(markLine("No figures here.", l, refs, mark), "No figures here.");
  assert.equal(refs.order.length, 0);
});

test("a page or note label is not a figure: the mark goes after the real figure, not after '45' in 'p. 45'", () => {
  const l = new Ledger();
  page(l, "filings/a.pdf", 1, ["Revenue  |  45"]);
  const refs = new RefNumbers();
  assert.equal(markLine("See p. 45 of the 10-K: revenue was 45.", l, refs, mark), "See p. 45 of the 10-K: revenue was 45<[1]>.");
  assert.equal(markLine("Note 45 and filings/a.pdf: 45", l, refs, mark), "Note 45 and filings/a.pdf: 45<[1]>");
});

test("markdown emphasis closing right after the figure stays next to it; a figure followed by a letter is skipped", () => {
  const l = ledger();
  const refs = new RefNumbers();
  assert.equal(markLine("Inventories: **$5,818 million** and `5,923`.", l, refs, mark), "Inventories: **$5,818 million**<[1]> and `5,923`<[1]>.");
  assert.equal(markLine("About 5,818x the size", l, refs, mark), "About 5,818x the size");
});

test("a figure that cannot be found as written (a Unicode minus) is skipped, never placed by guess", () => {
  const l = new Ledger();
  page(l, "filings/a.pdf", 1, ["Acquisitions  |  (1,220)  |  4,000"]);
  const refs = new RefNumbers();
  assert.equal(markLine("A change of −1,220 and 4,000.", l, refs, mark), "A change of −1,220 and 4,000<[1]>.");
});

test("at most the list's limit of places is numbered; a figure of a place with no number gets none", () => {
  const l = ledger();
  const refs = new RefNumbers(1);
  assert.equal(markLine("5,818 then 46,298.", l, refs, mark), "5,818<[1]> then 46,298.");
  assert.equal(refs.order.length, 1);
  refs.reset();
  assert.equal(refs.order.length, 0);
});

test("maskLabels keeps every position: labels become spaces of the same length", () => {
  const t = "See p. 45 of filings/a.pdf (10-K): 45";
  const m = maskLabels(t);
  assert.equal(m.length, t.length);
  assert.equal(m.lastIndexOf("45"), t.lastIndexOf("45"));
  assert.ok(!m.includes("a.pdf") && !m.includes("p. 45"));
});

test("LineMarker: whole lines come out marked, the unfinished tail waits, a figure split across pieces is marked once whole", () => {
  const l = ledger();
  const lm = new LineMarker((line) => markLine(line, l, new RefNumbers(), mark), (t) => `(${t})`);
  assert.equal(lm.push("Inventories were $5,8"), "");
  assert.equal(lm.push("18 million.\nSales were 46"), "Inventories were $5,818 million<[1]>.\n");
  assert.equal(lm.flush(true), "Sales were 46"); // 46 alone is not in the ledger: no mark
  lm.push("tail 5,818");
  assert.equal(lm.flush(false), "(tail 5,818)"); // text that was cut off is shown as it is, never marked
  assert.equal(lm.flush(true), "");
});

test("LineMarker: several lines in one piece; blank lines pass through", () => {
  const l = ledger();
  const refs = new RefNumbers();
  const lm = new LineMarker((line) => markLine(line, l, refs, mark), (t) => t);
  assert.equal(lm.push("a 5,818\n\nb 46,298\n"), "a 5,818<[1]>\n\nb 46,298<[2]>\n");
});

test("the list holds exactly the numbered places, in their numbers; the marks and the list agree", () => {
  const l = ledger();
  const answer = "Sales were 46,298 and inventories 5,818.";
  const refs = new RefNumbers();
  assert.equal(markLine(answer, l, refs, mark), "Sales were 46,298<[1]> and inventories 5,818<[2]>.");
  const tokens = checkText(answer, l).map((c) => c.token);
  const list = buildSources(tokens, [], l, refs.order);
  assert.deepEqual(list.entries.map((e) => [e.ref, e.page]), [[1, 2], [2, 1]]); // the page of sales first
  const lines = formatSources(list);
  assert.ok(lines.some((x) => x.startsWith("  [1]  filings/a.pdf  p.2")));
  assert.ok(lines.some((x) => x.startsWith("  [2]  filings/a.pdf  p.1")));
});

test("a place without a number is not listed; the list never holds a number the answer does not carry (calculator inputs aside)", () => {
  const l = ledger();
  const answer = "5,818 then 46,298.";
  const refs = new RefNumbers(1);
  markLine(answer, l, refs, mark);
  const list = buildSources(checkText(answer, l).map((c) => c.token), [], l, refs.order);
  assert.deepEqual(list.entries.map((e) => [e.ref, e.page]), [[1, 1]]);
});

test("a calculator input read from another page is listed after the numbered places, with the next number", () => {
  const l = ledger();
  const answer = "Inventories were 5,818.";
  const refs = new RefNumbers();
  markLine(answer, l, refs, mark);
  const inputs = checkText("46,298", l).map((c) => c.token); // the model gave 46,298 to the calculator
  const list = buildSources(checkText(answer, l).map((c) => c.token), inputs, l, refs.order);
  assert.deepEqual(list.entries.map((e) => [e.ref, e.page, e.rows[0].figures[0].calcInput === true]), [[1, 1, false], [2, 2, true]]);
});

test("a company name such as 3M is not a figure for the marks or the list; an amount with a currency sign, decimals or a spaced scale word still is", () => {
  const l = new Ledger();
  page(l, "filings/a.pdf", 1, ["Net income attributable to 3M  |  5,349", "Cost  |  $3M  |  3.5M  |  3 million"]);
  const refs = new RefNumbers();
  assert.equal(markLine("3M earned 5,349.", l, refs, mark), "3M earned 5,349<[1]>.");
  assert.equal(markLine("Cost was $3M.", l, refs, mark), "Cost was $3M<[1]>.");
  assert.equal(markLine("Or 3.5M, or 3 million.", l, refs, mark), "Or 3.5M<[1]>, or 3 million<[1]>.");
  const list = buildSources(checkText("3M earned 5,349.", l).map((c) => c.token), [], l, refs.order);
  assert.ok(list.entries.every((e) => e.rows.every((r) => r.figures.every((f) => f.raw !== "3M"))));
});

test("a figure inside a code or a word is not where the mark goes: the mark follows the standalone occurrence", () => {
  const l = new Ledger();
  page(l, "filings/a.pdf", 1, ["Headcount  |  5818"]);
  const refs = new RefNumbers();
  assert.equal(markLine("Code X5818 means headcount of 5818.", l, refs, mark), "Code X5818 means headcount of 5818<[1]>.");
});

test("the figures the marks were made from are kept, so the list can be built from them; reset clears them with the numbers", () => {
  const l = ledger();
  const refs = new RefNumbers();
  markLine("Sales were 46,298.", l, refs, mark);
  markLine("No figures.", l, refs, mark);
  assert.deepEqual(refs.seen.map((t) => t.raw), ["46,298"]);
  refs.reset();
  assert.deepEqual([refs.order.length, refs.seen.length], [0, 0]);
});
