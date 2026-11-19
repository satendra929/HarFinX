import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, checkText, extractNumbers, normalise, unverified } from "../src/provenance.ts";

const nums = (s: string) => extractNumbers(normalise(s));
const canon = (s: string) => nums(s).map((t) => t.canon);
const classes = (text: string, ledger: Ledger) => checkText(text, ledger).map((c) => `${c.token.raw}=${c.cls}`);

const SOURCE = `Net sales 11,503 11,303 14,082
Operating income 1,306 509 2,112
Interest income 11 15 21
Segment (473) EPS 1.30 "up to 90 employees" 90% stake costs of approximately $5.5 billion`;

function ledger(user = "Round to one decimal. Assume 5% growth."): Ledger {
  const l = new Ledger();
  l.addSource("income.txt", SOURCE);
  l.addUser(user);
  return l;
}

test("extracts the number formats found in financial text", () => {
  const t = nums("$1,233 and (473) and 3.06% and (6) % and 5,466,312 and $5.5 billion and -2,278");
  assert.deepEqual(t.map((x) => x.canon), ["1233", "473", "3.06", "6", "5466312", "5.5", "2278"]);
  assert.equal(t[0].money, true);
  assert.equal(t[2].percent, true);
  assert.equal(t[2].decimals, 2);
  assert.equal(t[3].percent, true); // "(6) %"
  assert.equal(t[5].scale, "billion");
});

test("Unicode tricks are normalised: fullwidth digits, zero-width characters, minus sign", () => {
  assert.deepEqual(canon("１２３"), ["123"]); // fullwidth 123
  assert.deepEqual(canon("1​234"), ["1234"]); // zero-width space inside a number
  assert.deepEqual(canon("loss of −5.5"), ["5.5"]); // U+2212 minus
  assert.deepEqual(canon("11.35\\%"), ["11.35"]);
});

test("LaTeX wrappers do not hide or invent numbers", () => {
  const t = nums("$\\frac{1,306}{11,503} \\times 100 = 11.35\\%$");
  assert.deepEqual(t.map((x) => x.canon), ["1306", "11503", "100", "11.35"]);
  assert.equal(t[3].percent, true);
});

test("labels are not figures: fiscal labels, file names, forms, dates, row and character refs, ordinals", () => {
  const text = "FY2021 vs FY20, Q1 and 2H; see eval/fb-00001.txt (10-K, 10-Q), row 12, rows 3-5, characters 0-1775, December 31, 2018, the 3rd quarter";
  assert.deepEqual(canon(text), []);
});

test("source numbers pass, derived numbers are unverified", () => {
  const out = classes("2019: 1,306 / 11,503 = 11.35%, so the average is 13.6% on sales of $14,082", ledger());
  assert.deepEqual(out, ["2019=K", "1,306=S", "11,503=S", "11.35%=X", "13.6%=X", "$14,082=S"]);
});

test("a figure cannot claim more precision than its source: 15.0 is not the integer 15", () => {
  assert.deepEqual(classes("Rate was 15.0%", ledger()), ["15.0%=X"]);
  assert.deepEqual(classes("It is 15", ledger()), ["15=S"]);
  assert.deepEqual(classes("EPS was 1.3", ledger()), ["1.3=S"]); // fewer decimals than "1.30" is fine
});

test("constants are K only as bare integers: 10 passes, 10% and 10.0 do not", () => {
  assert.deepEqual(classes("times 100 over 12 months", ledger()), ["100=K", "12=K"]);
  assert.deepEqual(classes("10% remains", ledger()), ["10%=X"]); // a derived percent must not hide behind the constant 10
  assert.deepEqual(classes("10.0 remains", ledger()), ["10.0=X"]);
  assert.deepEqual(classes("about $70 million", ledger()), ["$70 million=X"]);
});

test("percent figures never match a plain integer, only a percent or decimal source number", () => {
  assert.deepEqual(classes("90% was incurred", ledger()), ["90%=S"]); // source has "90%"
  const l = new Ledger();
  l.addSource("s", "up to 90 employees");
  assert.deepEqual(classes("90% of staff", l), ["90%=X"]);
});

test("scale words: a unit label on a source figure is fine, a conflicting scale is not", () => {
  assert.deepEqual(classes("costs $5.5 billion", ledger()), ["$5.5 billion=S"]);
  assert.deepEqual(classes("costs $5.5B and 5.5", ledger()), ["$5.5B=S", "5.5=S"]); // B = billion
  assert.deepEqual(classes("costs $5.5 million", ledger()), ["$5.5 million=X"]); // source says billion
  // statements give their scale in a header, so the source figure has no scale word of its own
  assert.deepEqual(classes("current assets of $11,503 million and $1,306M", ledger()), ["$11,503 million=S", "$1,306M=S"]);
  // ...but converting to another unit changes the digits, and that is a calculation
  assert.deepEqual(classes("or $11.5 billion", ledger()), ["$11.5 billion=X"]);
});

test("sign is ignored: (473) in the source supports $473 and -473", () => {
  assert.deepEqual(classes("lowest was $473 and -473", ledger()), ["$473=S", "-473=S"]);
});

test("numbers from the user's own message are accepted as U", () => {
  assert.deepEqual(classes("at 5% growth", ledger()), ["5%=U"]);
});

test("years and list numbers are not figures; a derived 4-digit non-year is", () => {
  const text = "1. First point for 2019\n2) Second point\n- 3. Third\nThe total is 2,278 and 5818";
  assert.deepEqual(classes(text, ledger()), ["1=K", "2019=K", "2=K", "3=K", "2,278=X", "5818=X"]);
});

test("unverified() filters to X only; reset empties the ledger", () => {
  const l = ledger();
  const checked = checkText("1,306 and 99.5%", l);
  assert.deepEqual(unverified(checked).map((c) => c.token.raw), ["99.5%"]);
  l.reset();
  assert.equal(l.size, 0);
  assert.deepEqual(classes("1,306", l), ["1,306=X"]);
});

test("extraction stays fast on large hostile input (no catastrophic backtracking)", () => {
  const big = "1,2,3,4,5,6,7,8,9,".repeat(10_000) + "(((".repeat(10_000) + "9".repeat(50_000) + " $ $ $ ".repeat(10_000);
  const t0 = Date.now();
  extractNumbers(normalise(big));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test("calculator results: a quoted value must trace to the full-precision result, rounded", () => {
  const l = ledger();
  l.addCalc("margin", "0.1135355959", "11.4%", true);
  l.addCalc("total", "5818", "5818", false);
  assert.deepEqual(classes("margin is 11.4%, or 11.35% to two places, or 0.1135", l), ["11.4%=C", "11.35%=C", "0.1135=C"]);
  assert.deepEqual(classes("margin is 11.3%", l), ["11.3%=X"]); // rounds to 11.4, not 11.3
  assert.deepEqual(classes("total is $5,818 million", l), ["$5,818 million=C"]);
  assert.deepEqual(classes("total is 5,819 and 13.6%", l), ["5,819=X", "13.6%=X"]);
  // source and user numbers still win over a calculation match
  assert.deepEqual(classes("sales were 11,503", l), ["11,503=S"]);
  l.reset();
  assert.deepEqual(classes("11.4%", l), ["11.4%=X"]);
});

test("source chunks that overlap at their edges are not double counted", () => {
  const l = new Ledger();
  l.addSource("f.txt", "alpha 1,306 beta");
  l.addSource("f.txt", "1,306 beta gamma");
  assert.equal(l.size, 1);
});

test("label rules must not erase real figures: words that merely start like a month or a label word", () => {
  // regression: "Mar[a-z]*" used to treat "margin 11.35%" as the date "March 11"
  for (const text of ["margin 11.35%", "marginal 2.5%", "decrease 5%", "decline 12.5%", "novel 3.5%", "august 4.5%", "mayor 3.5%", "net line 5%"]) {
    assert.equal(nums(text).length, 1, text);
  }
  // real dates are still removed
  assert.deepEqual(canon("on March 31, 2019 and Dec. 5 and Sept 30"), []);
  assert.deepEqual(canon("as of December 31, 2018 sales were 1,306"), ["1306"]);
  // a date-like day followed by a decimal or percent is a figure, not a day
  assert.deepEqual(canon("May 5.5%"), ["5.5"]);
});

test("page and part references from filings are labels, not figures", () => {
  const text = "[page 68 of 136 in filings/LOCKHEED_2021_10K.pdf] see page 68, part 2 of 3, p.68, pp. 66-68 and also pages 66-68 (10-K)";
  assert.deepEqual(checkText(text, new Ledger()).map((c) => c.token.raw), []);
  // real figures next to such labels are still found
  const l = new Ledger();
  l.addSource("a.pdf p.68", "Total current assets 19,815");
  assert.deepEqual(checkText("Per page 68 of 136 (a.pdf p.68): total current assets were 19,815 and not 20,000.", l).map((c) => `${c.token.raw}=${c.cls}`), ["19,815=S", "20,000=X"]);
});

test("addCalc keeps how a calculation was written; stepsOfCall finds the steps of one call; findCalc and classify do not depend on it", () => {
  const l = new Ledger();
  l.addUser("q");
  const meta = { call: 7, expr: "a - b", inputs: [{ name: "a", literal: "10" }, { name: "b", literal: "4" }], literals: [], calls: [] };
  l.addCalc("diff", "6", "6", false, meta);
  l.addCalc("old", "9.5", "9.5", false); // a record without meta (older callers) still works
  assert.equal(l.calcRecs.length, 2);
  assert.deepEqual([...l.stepsOfCall(7).keys()], ["diff"]);
  assert.equal(l.stepsOfCall(8).size, 0);
  assert.equal(checkText("It was 6 and 9.5.", l).filter((c) => c.cls === "C").length, 2); // classify is unchanged by the meta
  l.reset();
  assert.equal(l.calcRecs.length, 0);
});
