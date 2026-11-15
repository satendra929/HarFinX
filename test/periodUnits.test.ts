import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, extractNumbers, normalise } from "../src/provenance.ts";
import { periodFindings, periodUnitsCheck, questionYear, tokensOf, unitsFindings } from "../src/periodUnits.ts";

const toks = (s: string) => extractNumbers(normalise(s));
function ledgerOf(page: string, file = "a.pdf", n = 1): Ledger {
  const l = new Ledger();
  const lines = page.split("\n");
  l.addSource(`${file} p.${n}`, page, { file, page: n, pageLines: lines, lineOffset: 0 });
  return l;
}
const PAGE = ["Consolidated Statements of Income", "(in millions)", "Year ended December 31  |  2022  |  2021", "Net sales  |  32,765  |  31,009", "Net income  |  5,921  |  5,100"].join("\n");

test("questionYear: one year yes; none, two, or a change/comparison word no", () => {
  assert.equal(questionYear("What was net income in FY2022?"), "2022");
  assert.equal(questionYear("What was net income?"), undefined);
  assert.equal(questionYear("Net income in 2022 and 2021?"), undefined);
  assert.equal(questionYear("How did net income change in 2022?"), undefined);
  assert.equal(questionYear("Revenue growth for 2022"), undefined);
  assert.equal(questionYear("Does the company have an improving free cash flow conversion as of FY2022?"), undefined);
  assert.equal(questionYear("Is the gross margin profile better in 2022?"), undefined);
});

test("period: a figure under the other year's column is flagged; the named year's column is silent", () => {
  const ledger = ledgerOf(PAGE);
  const wrong = periodFindings("What were net sales in 2022?", toks("31,009"), ledger);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].detail, "31,009 is printed under the 2021 column; the question names 2022");
  assert.deepEqual(periodFindings("What were net sales in 2022?", toks("32,765"), ledger), []);
});

test("period: silent without a year in the question, with two years, for a figure on two places, or when the heading has another cell count", () => {
  const ledger = ledgerOf(PAGE);
  assert.deepEqual(periodFindings("What were net sales?", toks("31,009"), ledger), []);
  assert.deepEqual(periodFindings("Compare 2022 with 2021 net sales", toks("31,009"), ledger), []);
  const twice = ledgerOf(PAGE + "\nOther  |  31,009  |  1");
  assert.deepEqual(periodFindings("What were net sales in 2022?", toks("31,009"), twice), []);
  const three = ledgerOf(["Year ended  |  2022  |  2021  |  2020", "Net sales  |  32,765  |  31,009"].join("\n"));
  assert.deepEqual(periodFindings("What were net sales in 2022?", toks("31,009"), three), []); // 3 headings, 2 cells
  const none = ledgerOf("Net sales  |  32,765  |  31,009");
  assert.deepEqual(periodFindings("What were net sales in 2022?", toks("31,009"), none), []); // no heading found
  assert.deepEqual(periodFindings("What were net sales in 2019?", toks("31,009"), ledger), []); // the named year is not a column
});

test("units: inputs from pages in millions and thousands are flagged once; the same scale and percents are silent", () => {
  const l = new Ledger();
  const a = ["(in millions)", "Year ended  |  2022  |  2021", "Net income  |  5,921  |  5,100"];
  const b = ["(in thousands)", "Year ended  |  2022  |  2021", "Weighted shares  |  812,345  |  800,111"];
  l.addSource("a.pdf p.1", a.join("\n"), { file: "a.pdf", page: 1, pageLines: a, lineOffset: 0 });
  l.addSource("a.pdf p.2", b.join("\n"), { file: "a.pdf", page: 2, pageLines: b, lineOffset: 0 });
  const f = unitsFindings(tokensOf(["5,921", "812,345"]), l);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "units");
  assert.match(f[0].detail, /5,921 is stated in millions; 812,345 is stated in thousands/);
  assert.deepEqual(unitsFindings(tokensOf(["5,921", "5,100"]), l), []);
  assert.deepEqual(unitsFindings(tokensOf(["5,921"]), l), []);
});

test("periodUnitsCheck joins both and an empty ledger gives nothing", () => {
  assert.deepEqual(periodUnitsCheck("q 2022", toks("31,009"), tokensOf(["1"]), new Ledger()), []);
  const l = ledgerOf(PAGE);
  assert.equal(periodUnitsCheck("What were net sales in 2022?", toks("31,009"), [], l).length, 1);
});
