import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, extractNumbers, isNonFigure, normalise, tokenMatches, type NumToken, type Rec } from "../src/provenance.ts";

const tok = (s: string): NumToken => extractNumbers(normalise(s))[0];
const PAGE = ["Consolidated Balance Sheets", "(in millions)", "| 2023 | 2022", "Merchandise inventories | 5,818 | 5,923", "Total current assets | 19,815 | 17,504", "Cost of sales | 41,748 | 42,000"];

test("addSource with meta: each figure remembers its original row, file, page and the question that showed it", () => {
  const l = new Ledger();
  l.addUser("What are inventories?");
  l.addSource("a.pdf p.68", PAGE.slice(3).join("\n"), { file: "filings/a.pdf", page: 68, pageLines: PAGE, lineOffset: 3 });
  const [r] = l.findAll(tok("5,818"));
  assert.equal(r.where?.row, "Merchandise inventories | 5,818 | 5,923");
  assert.equal(r.where?.rowFound, true);
  assert.equal(r.where?.file, "filings/a.pdf");
  assert.equal(r.where?.page, 68);
  assert.equal(r.where?.q, 1);
  assert.equal(r.where?.lineNo, 3); // index in the full page: offset 3 + line 0 of the part
  assert.equal(r.where?.pageLines, PAGE);
  assert.equal(l.findAll(tok("19,815"))[0].where?.lineNo, 4);
});

test("a row keeps its original text even where the figure checker blanks labels (FY2021, December 31, 2018)", () => {
  const l = new Ledger();
  l.addSource("f p.1", "FY2021 revenue | 1,234\nBalance at December 31, 2018 | 9,999", { file: "f.pdf", page: 1 });
  assert.equal(l.findAll(tok("1,234"))[0].where?.row, "FY2021 revenue | 1,234");
  assert.equal(l.findAll(tok("9,999"))[0].where?.row, "Balance at December 31, 2018 | 9,999");
});

test("the same figure on two rows of one page keeps both rows; adding the same text again adds nothing", () => {
  const text = "Total revenue | 5,000\nTotal assets | 5,000";
  const l = new Ledger();
  l.addSource("f p.1", text, { file: "f.pdf", page: 1 });
  l.addSource("f p.1", text, { file: "f.pdf", page: 1 }); // read again
  const rows = l.findAll(tok("5,000")).map((r) => r.where?.row);
  assert.deepEqual(rows, ["Total revenue | 5,000", "Total assets | 5,000"]);
});

test("find still returns the first record (the user's own figure) while findAll returns every record, including the page's", () => {
  const l = new Ledger();
  l.addUser("compare 5,818 with last year");
  l.addSource("a.pdf p.68", "Inventories | 5,818", { file: "a.pdf", page: 68 });
  assert.equal(l.find(tok("5,818"))?.origin, "U");
  assert.deepEqual(l.findAll(tok("5,818")).map((r) => r.origin), ["U", "S"]);
  assert.equal(l.findAll(tok("5,818")).filter((r) => r.where).length, 1); // only the page record has a place
});

test("records added without meta behave as before (no place, same dedupe)", () => {
  const l = new Ledger();
  l.addSource("income.txt", "Net sales 11,503");
  l.addSource("income.txt", "Net sales 11,503");
  const all = l.findAll(tok("11,503"));
  assert.equal(all.length, 1);
  assert.equal(all[0].where, undefined);
});

test("rows are found when normalising merges lines (a page label that spans a newline)", () => {
  const l = new Ledger();
  l.addSource("f p.1", "see page\n12 for notes\nRevenue | 5,000", { file: "f.pdf", page: 1 });
  assert.equal(l.findAll(tok("5,000"))[0].where?.row, "Revenue | 5,000");
});

test("rows stay right when normalising removes newlines: the same figure on an earlier row does not steal a later row (a date or page label that wraps)", () => {
  const l = new Ledger();
  l.addSource("f p.1", "Cash | 5,818 | 1\nAs of December\n31, 2023 we had\nInventories | 5,818 | 5,923", { file: "f.pdf", page: 1 });
  assert.deepEqual(l.findAll(tok("5,818")).map((r) => r.where?.row), ["Cash | 5,818 | 1", "Inventories | 5,818 | 5,923"]);
});

test("rows stay right when several lines vanish at once and the same figure sits on many rows", () => {
  const text = ["Row A | 7,000", "See Note", "12 and", "page", "40, and December", "31, 2022 and", "Row B | 7,000", "Row C | 7,000 | 8,000"].join("\n");
  const l = new Ledger();
  l.addSource("f p.1", text, { file: "f.pdf", page: 1, pageLines: text.split("\n"), lineOffset: 10 });
  const all = l.findAll(tok("7,000"));
  assert.deepEqual(all.map((r) => r.where?.row), ["Row A | 7,000", "Row B | 7,000", "Row C | 7,000 | 8,000"]);
  assert.deepEqual(all.map((r) => r.where?.lineNo), [10, 16, 17]);
  assert.equal(l.findAll(tok("8,000"))[0].where?.row, "Row C | 7,000 | 8,000");
});

test("a figure repeated on one row maps to that row each time; figures on different rows keep their order", () => {
  const l = new Ledger();
  l.addSource("f p.1", "Both | 9 | 9\nNext | 9", { file: "f.pdf", page: 1 });
  assert.deepEqual(l.findAll(tok("9")).map((r) => r.where?.row), ["Both | 9 | 9", "Next | 9"]);
});

test("when no single line holds the figure as the ledger read it (a scale word on the next line), a snippet is kept and marked not found", () => {
  const l = new Ledger();
  l.addSource("f p.1", "Revenue 11,503\nmillion more", { file: "f.pdf", page: 1 });
  const [r] = l.findAll(tok("11,503 million"));
  assert.equal(r.where?.rowFound, false);
  assert.match(r.where!.row, /11,503/);
});

test("a figure that cannot be placed (a scale word on the next line joined it) does not stop the figures after it from being placed", () => {
  const l = new Ledger();
  l.addSource("f p.1", "Revenue 11,503\nmillion more\nCash | 7,777 | 1\nDebt | 8,888", { file: "f.pdf", page: 1 });
  assert.equal(l.findAll(tok("11,503 million"))[0].where?.rowFound, false);
  const cash = l.findAll(tok("7,777"))[0];
  assert.equal(cash.where?.rowFound, true);
  assert.equal(cash.where?.row, "Cash | 7,777 | 1");
  assert.equal(l.findAll(tok("8,888"))[0].where?.row, "Debt | 8,888");
});

test("a failure while locating rows never stops the figures from being recorded", () => {
  const boom = new Proxy({}, { get: () => { throw new Error("boom"); } }) as never;
  const l = new Ledger();
  l.addSource("f p.1", "Revenue | 5,000", boom);
  const [r] = l.findAll(tok("5,000"));
  assert.ok(r);
  assert.equal(r.where, undefined);
  assert.equal(l.find(tok("5,000"))?.origin, "S");
});

test("question counter: addUser counts, reset starts over; figures are tagged with the question that showed them", () => {
  const l = new Ledger();
  assert.equal(l.question, 0);
  l.addUser("one");
  l.addSource("f p.1", "A | 1,111", { file: "f.pdf", page: 1 });
  l.addUser("two");
  l.addSource("f p.2", "B | 2,222", { file: "f.pdf", page: 2 });
  assert.equal(l.question, 2);
  assert.equal(l.findAll(tok("1,111"))[0].where?.q, 1);
  assert.equal(l.findAll(tok("2,222"))[0].where?.q, 2);
  l.reset();
  assert.equal(l.question, 0);
  assert.equal(l.findAll(tok("1,111")).length, 0);
});

const rec = (over: Partial<Rec>): Rec => ({ raw: "15", decimals: 0, percent: false, origin: "S", label: "x", ...over });

test("tokenMatches: decimals, percent and scale rules (the rules find() always had)", () => {
  assert.equal(tokenMatches(tok("15.0"), rec({})), false); // more decimals than the source
  assert.equal(tokenMatches(tok("15"), rec({ raw: "15.0", decimals: 1 })), true);
  assert.equal(tokenMatches(tok("15%"), rec({})), false); // a percent never matches a plain integer
  assert.equal(tokenMatches(tok("15%"), rec({ percent: true })), true);
  assert.equal(tokenMatches(tok("15%"), rec({ raw: "0.15", decimals: 2 })), true);
  assert.equal(tokenMatches(tok("$5.5 million"), rec({ raw: "5.5", decimals: 1, scale: "billion" })), false);
  assert.equal(tokenMatches(tok("$7,453 million"), rec({ raw: "7,453" })), true); // a unit label on top of a bare source number
  assert.equal(tokenMatches(tok("$5.5 million"), rec({ raw: "5.5", decimals: 1, scale: "million" })), true);
});

test("isNonFigure: list numbers, bare years and constants are not figures; real figures are", () => {
  assert.equal(isNonFigure(tok("2023")), true);
  assert.equal(isNonFigure(tok("100")), true);
  assert.equal(isNonFigure(tok("1. First item")), true);
  assert.equal(isNonFigure(tok("5,818")), false);
  assert.equal(isNonFigure(tok("2023%")), false);
  assert.equal(isNonFigure(tok("10.0")), false);
});
