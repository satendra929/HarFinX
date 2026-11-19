import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, extractNumbers, normalise, type NumToken } from "../src/provenance.ts";
import { buildCitationList, calcEntryLines, citeFigure, formulaOf, narrowRecs, stepFor, unitScale } from "../src/cite.ts";
import { RefNumbers, markLine } from "../src/refs.ts";
import { parse, printNode, substitute } from "../src/calc/parse.ts";
import { CLOSING_LINE, placeKey, type Located } from "../src/sources.ts";

const tok = (s: string): NumToken => extractNumbers(normalise(s))[0];

function page(l: Ledger, file: string, n: number, lines: string[]): void {
  l.addSource(`${file} p.${n}`, lines.join("\n"), { file, page: n, pageLines: lines, lineOffset: 0 });
}
function calc(l: Ledger, call: number, inputs: Record<string, string>, steps: { name: string; expr: string; value: string; shown: string; pct?: boolean; literals?: string[]; calls?: string[] }[]): void {
  const named = Object.entries(inputs).map(([name, literal]) => ({ name, literal }));
  for (const s of steps) l.addCalc(s.name, s.value, s.shown, s.pct ?? false, { call, expr: s.expr, inputs: named, literals: s.literals ?? [], calls: s.calls ?? [] });
}
const BS = ["Consolidated Balance Sheets", "(in millions)", "As of December 31  |  2022  |  2021", "Total current assets  |  57,517  |  52,574", "Total current liabilities  |  45,101  |  43,029"];

function working(): Ledger {
  const l = new Ledger();
  l.addUser("What was working capital?");
  page(l, "filings/p.pdf", 61, BS);
  calc(l, 1, { ca: "57,517", cl: "45,101" }, [{ name: "wc", expr: "ca - cl", value: "12416", shown: "12,416" }]);
  return l;
}

test("exempt: a year, a list number, a constant and a name are not figures and get no mark", () => {
  const l = working();
  for (const s of ["2022", "10", "100", "3M"]) assert.equal(citeFigure(tok(s), l).kind, "exempt", s);
});

test("a quote: a value printed on a row the model read, cited to that place", () => {
  const l = working();
  const c = citeFigure(tok("$57,517 million"), l);
  assert.equal(c.kind, "quote");
  if (c.kind === "quote") assert.deepEqual(c.keys, ["filings/p.pdf#61"]);
});

test("a calculation: a figure equal to a step's shown text; its keys are the calculation first, then the places of its operands", () => {
  const l = working();
  const c = citeFigure(tok("$12,416 million"), l);
  assert.equal(c.kind, "calc");
  if (c.kind === "calc") {
    assert.equal(c.step.name, "wc");
    assert.deepEqual(c.keys, ["calc:1:wc", "filings/p.pdf#61"]);
    assert.deepEqual(c.operands.map((o) => [o.name, o.how]), [["ca", "page"], ["cl", "page"]]);
  }
});

test("a calculation wins over a page row that happens to print the same digits", () => {
  const l = working();
  page(l, "filings/p.pdf", 62, ["Other table", "Something  |  12,416  |  1"]);
  assert.equal(citeFigure(tok("12,416"), l).kind, "calc");
});

test("a percent is not the twin of a plain ratio; it is when the expression itself multiplies by 100", () => {
  const l = new Ledger();
  l.addUser("q");
  page(l, "f.pdf", 1, ["T", "(in millions)", "Quick assets  |  800  |  1", "Current liabilities  |  509  |  2"]);
  calc(l, 1, { a: "800", b: "509" }, [{ name: "ratio", expr: "a / b", value: "1.5717", shown: "1.57" }]);
  assert.equal(citeFigure(tok("1.57"), l).kind, "calc");
  assert.notEqual(citeFigure(tok("1.57%"), l).kind, "calc"); // "1.57%" is the model's own conversion of the ratio
  const m = new Ledger();
  m.addUser("q");
  page(m, "f.pdf", 1, ["T", "(in millions)", "Sales  |  1,000  |  1", "Cost  |  887  |  2"]);
  calc(m, 1, { s: "1,000", c: "887" }, [{ name: "margin", expr: "(s - c) / s * 100", value: "11.3", shown: "11.3", literals: ["100"] }]);
  assert.equal(citeFigure(tok("11.3%"), m).kind, "calc");
});

test("a percent is never cited to a source number printed with a currency sign", () => {
  const l = new Ledger();
  l.addUser("q");
  page(l, "f.pdf", 1, ["Earnings", "Diluted EPS  |  $2.30  |  $2.10"]);
  assert.equal(citeFigure(tok("2.3%"), l).kind, "uncited");
});

test("an operand that was never printed makes the calculated figure uncited; so does a number written in the expression", () => {
  const l = new Ledger();
  l.addUser("q");
  page(l, "f.pdf", 1, ["T", "(in millions)", "Sales  |  8,890  |  1"]);
  calc(l, 1, { s: "8,890", x: "999" }, [{ name: "r", expr: "s - x", value: "7891", shown: "7,891" }]);
  const c = citeFigure(tok("7,891"), l);
  assert.equal(c.kind, "uncited");
  const l2 = new Ledger();
  l2.addUser("q");
  page(l2, "f.pdf", 1, ["T", "(in millions)", "Sales  |  8,890  |  1"]);
  calc(l2, 1, { s: "8,890" }, [{ name: "r", expr: "s * 0.41", value: "3644.9", shown: "3,644.9", literals: ["0.41"] }]);
  assert.equal(citeFigure(tok("3,644.9"), l2).kind, "uncited"); // 0.41 is the model's own conversion of 41%
  const l3 = new Ledger();
  l3.addUser("q");
  page(l3, "f.pdf", 1, ["T", "(in millions)", "Sales  |  8,890  |  1"]);
  calc(l3, 1, { s: "8,890" }, [{ name: "r", expr: "s * 100", value: "889000", shown: "889,000", literals: ["100"] }]);
  assert.equal(citeFigure(tok("889,000"), l3).kind, "calc"); // a plain constant is fine
});

test("an operand that is the shown value of an earlier calculation resolves to it; one from the question resolves to the question", () => {
  const l = working();
  calc(l, 2, { w: "12,416", rev: "100,000" }, [{ name: "share", expr: "w / rev", value: "0.12416", shown: "12.4%", pct: true }]);
  page(l, "filings/p.pdf", 3, ["Income", "Revenue  |  100,000  |  1"]);
  const c = citeFigure(tok("12.4%"), l);
  assert.equal(c.kind, "calc");
  if (c.kind === "calc") assert.deepEqual(c.operands.map((o) => o.how), ["calc", "page"]);
  const q = new Ledger();
  q.addUser("Assume revenue of 5,000 and costs of 3,000.");
  calc(q, 1, { r: "5,000", c: "3,000" }, [{ name: "m", expr: "r - c", value: "2000", shown: "2,000" }]);
  const cq = citeFigure(tok("2,000"), q);
  assert.equal(cq.kind, "calc");
  if (cq.kind === "calc") assert.deepEqual(cq.operands.map((o) => o.how), ["question", "question"]);
});

test("calculation keys are chat-wide: two calls with the same step name are different entries; the last matching step is used", () => {
  const l = working();
  calc(l, 2, { ca: "57,517", cl: "45,101" }, [{ name: "wc", expr: "ca - cl", value: "12416", shown: "12,416" }]);
  assert.equal(stepFor(tok("12,416"), l)?.meta?.call, 2);
  const c = citeFigure(tok("12,416"), l);
  assert.equal(c.kind === "calc" && c.keys[0], "calc:2:wc");
});

test("a scale word that contradicts the page's unit leaves the figure uncited; a matching one is a quote", () => {
  const l = working();
  assert.equal(citeFigure(tok("$57,517 billion"), l).kind, "uncited");
  assert.equal(citeFigure(tok("$57,517 million"), l).kind, "quote");
  assert.equal(citeFigure(tok("57,517"), l).kind, "quote"); // no scale word: nothing to contradict
  assert.equal(unitScale("(in millions, except per share)"), "million");
  assert.equal(unitScale("(in thousands and millions)"), undefined);
  assert.equal(unitScale("As of December 31"), undefined);
});

test("two rows with the same value: the row whose label shares words with the sentence is chosen; nothing shared keeps both; the question is the fallback", () => {
  const l = new Ledger();
  l.addUser("What were notes due 2031?");
  page(l, "f.pdf", 5, ["Debt", "(in millions)", "Notes due 2026  |  1,500  |  1", "Notes due 2031  |  1,500  |  2", "Revolver  |  1,500  |  3"]);
  const recs = (): Located[] => l.findAll(tok("1,500")).filter((r): r is Located => r.where !== undefined);
  assert.deepEqual(narrowRecs(recs(), ["The revolver balance was 1,500."]).map((r) => r.where.row.split("|")[0].trim()), ["Revolver"]);
  assert.deepEqual(narrowRecs(recs(), ["Notes due 2031 were 1,500."]).map((r) => r.where.row.split("|")[0].trim()), ["Notes due 2031"]); // the year breaks the tie between two "notes" rows
  assert.equal(narrowRecs(recs(), ["It was 1,500."]).length, 3); // nothing in the sentence names a row
  assert.deepEqual(narrowRecs(recs(), ["It was 1,500.", "What were notes due 2031?"]).map((r) => r.where.row.split("|")[0].trim()), ["Notes due 2031"]); // the question names it
});

test("formula: names become the printed numbers, a negative input reads (-473), parentheses survive a substitution, a function adds its definition", () => {
  const l = new Ledger();
  l.addUser("q");
  calc(l, 1, { a: "100", b: "(473)", c: "7" }, [{ name: "r", expr: "a - (b + c)", value: "566", shown: "566" }]);
  assert.equal(formulaOf(l.calcRecs[0], l).text, "566 = 100 - ((-473) + 7)");
  const f = new Ledger();
  f.addUser("q");
  calc(f, 1, { o: "3,694", n: "6,043" }, [{ name: "g", expr: "pct_change(o, n)", value: "0.636", shown: "63.6%", pct: true, calls: ["pct_change"] }]);
  const fm = formulaOf(f.calcRecs[0], f);
  assert.equal(fm.text, "63.6% = pct_change(3,694; 6,043)");
  assert.ok(fm.definitions.length === 1 && /pct_change/.test(fm.definitions[0]));
});

test("formula: an earlier step is inlined with parentheses; a chain that is too long keeps the step names and says what each is", () => {
  const l = new Ledger();
  l.addUser("q");
  calc(l, 1, { a: "10", b: "4", c: "3" }, [
    { name: "s", expr: "b + c", value: "7", shown: "7" },
    { name: "d", expr: "a - s", value: "3", shown: "3" },
  ]);
  assert.equal(formulaOf(l.calcRecs[1], l).text, "3 = 10 - (4 + 3)");
  const long = new Ledger();
  long.addUser("q");
  const nm = (i: number) => `a_very_long_input_name_${i}`;
  const inputs = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [nm(i), `${i}23,456,789,012`]));
  calc(long, 1, inputs, [
    { name: "first", expr: [1, 2, 3].map(nm).join(" + "), value: "6000000", shown: "6,000,000" },
    { name: "second", expr: [4, 5, 6].map(nm).join(" + "), value: "15000000", shown: "15,000,000" },
    { name: "total", expr: "first + second", value: "21000000", shown: "21,000,000" },
  ]);
  const f = formulaOf(long.calcRecs[2], long);
  assert.ok(f.text.length <= 110);
  assert.ok(f.where.length >= 1 && f.where.length <= 2);
});

test("printNode and substitute: precedence parentheses, unary minus, powers, calls", () => {
  const p = (s: string) => printNode(parse(s));
  assert.equal(p("a-(b+c)"), "a - (b + c)");
  assert.equal(p("(a+b)*c"), "(a + b) * c");
  assert.equal(p("a/(b*c)"), "a / (b * c)");
  assert.equal(p("-(a+b)"), "-(a + b)");
  assert.equal(p("a^b^c"), "a^b^c");
  assert.equal(p("(a^b)^c"), "(a^b)^c");
  assert.equal(p("f(a, b+1)"), "f(a; b + 1)");
  assert.equal(printNode(substitute(parse("x * y"), (n) => (n === "x" ? parse("a + b") : "5"))), "(a + b) * 5");
});

test("RefNumbers.reserve: all keys together or none, so a calculation never points at an entry that is missing", () => {
  const r = new RefNumbers(3);
  assert.deepEqual(r.reserve(["calc:1:a", "p#1"]), [1, 2]);
  assert.equal(r.reserve(["calc:2:b", "p#2", "p#3"]), undefined); // three new keys do not fit in the one place left
  assert.deepEqual(r.order, ["calc:1:a", "p#1"]); // nothing was reserved by the failed attempt
  assert.deepEqual(r.reserve(["calc:2:b", "p#1"]), [3, 2]); // a key that already has a number costs nothing
});

test("the list holds a calculation entry and the rows its operands were cited to, in their numbers, then one closing line", () => {
  const l = working();
  const refs = new RefNumbers();
  const out = markLine("Working capital was $12,416 million.", l, refs, (m) => `<${m}>`);
  assert.equal(out, "Working capital was $12,416 million<[1]>.");
  const list = buildCitationList(refs.decisions, refs.order, l);
  assert.equal(list.lines[0], "  [1]  12,416 = 57,517 - 45,101   inputs from [2]");
  assert.ok(list.lines[1].startsWith("  [2]  filings/p.pdf  p.61"));
  assert.ok(list.lines.some((x) => x.includes("[57,517]")) && list.lines.some((x) => x.includes("[45,101]")));
  assert.equal(list.lines.at(-1), CLOSING_LINE);
  assert.equal(calcEntryLines(list.calcEntries[0], l)[0], list.lines[0]);
  assert.deepEqual(list.sources.entries.map((e) => placeKey({ file: e.file, page: e.page })), ["filings/p.pdf#61"]);
});

test("a calculation that does not fit with its operands within the limit is not marked, and the list never has a dangling 'inputs from'", () => {
  const l = new Ledger();
  l.addUser("q");
  for (let p = 1; p <= 4; p++) page(l, "f.pdf", p, ["Heading " + p, "(in millions)", `Item ${p}  |  ${p}00,5  |  1`]);
  const refs = new RefNumbers(2);
  calc(l, 1, { a: "100,5", b: "200,5", c: "300,5" }, [{ name: "t", expr: "a + b + c", value: "601.5", shown: "601.5" }]);
  const out = markLine("Total 601.5 here.", l, refs, (m) => `<${m}>`);
  assert.equal(out, "Total 601.5 here."); // three places and the calculation need four numbers, the limit is two
  assert.equal(refs.order.length, 0);
});

test("a figure found on more than one page is shown with its row choice stored in the decisions", () => {
  const l = new Ledger();
  l.addUser("q");
  page(l, "f.pdf", 1, ["T", "(in millions)", "Revenue  |  5,000  |  1"]);
  page(l, "f.pdf", 2, ["U", "(in millions)", "Total assets  |  5,000  |  2"]);
  const refs = new RefNumbers();
  markLine("Total assets were 5,000.", l, refs, (m) => `<${m}>`);
  const d = refs.decisions[0];
  assert.equal(d.cited.kind, "quote");
  if (d.cited.kind === "quote") assert.deepEqual(d.cited.keys, ["f.pdf#2"]);
});
