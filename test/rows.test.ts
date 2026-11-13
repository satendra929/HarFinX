import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsToText, type TextItem } from "../src/documents/rows.ts";

// Items are built like pdf.js text items: a left edge x, a baseline y (higher = higher on the page), a width, a height.
const it = (str: string, x: number, y: number, width = str.length * 4.5, height = 8.5): TextItem => ({ str, x, y, width, height });

test("a label and its values whose baselines differ by under a point stay on one row (the real split-row case)", () => {
  // The label's baseline is 0.64 pt below its values; rounding y onto a coarse grid would put them on different lines.
  const text = itemsToText([it("Other accrued liabilities (Notes 10 and 13)", 33.8, 462.71, 190), it("3,147", 483.0, 463.35, 19.1), it("3,139", 569.4, 463.35, 19.1)]);
  assert.equal(text, "Other accrued liabilities (Notes 10 and 13)  |  3,147  |  3,139");
});

test("rows come out top to bottom, cells left to right, however the items arrive", () => {
  const text = itemsToText([
    it("Accounts payable", 33.8, 480),
    it("1,612", 569.4, 480, 19.1),
    it("Total current assets", 33.8, 500),
    it("7,659", 569.4, 500, 19.1),
    it("7,453", 483.0, 500, 19.1),
    it("1,804", 483.0, 480, 19.1),
  ]);
  assert.equal(text, "Total current assets  |  7,453  |  7,659\nAccounts payable  |  1,804  |  1,612");
});

test("a units line and the year header keep their columns", () => {
  const text = itemsToText([it("(in millions, except share and per share amounts)", 33.8, 560, 210), it("2022", 483.0, 560, 18), it("2021", 569.4, 560, 18)]);
  assert.equal(text, "(in millions, except share and per share amounts)  |  2022  |  2021");
});

test("a lone $ joins the number after it; a lone % or ) joins the number before it", () => {
  const dollars = itemsToText([it("Cash and cash equivalents", 33.8, 300, 120), it("$", 470, 300, 4), it("1,671", 478, 300, 22), it("$", 556, 300, 4), it("2,148", 564, 300, 22)]);
  assert.equal(dollars, "Cash and cash equivalents  |  $1,671  |  $2,148");
  const negative = itemsToText([it("Treasury stock, at cost", 33.8, 200, 100), it("(", 480, 200, 3), it("20,532", 483, 200, 27), it(")", 510, 200, 3)]);
  assert.equal(negative, "Treasury stock, at cost  |  (20,532)");
  const percent = itemsToText([it("Operating margin", 33.8, 100, 80), it("11.4", 483, 100, 14), it("%", 497.2, 100, 5)]);
  assert.equal(percent, "Operating margin  |  11.4%");
});

test("real statement layout: the $ sits at the left of a column, the number is right-aligned, the next $ follows the previous number", () => {
  const text = itemsToText([
    it("Cash and cash equivalents", 33.8, 300, 120),
    it("$", 440, 300, 4),
    it("3,604", 495, 300, 22),
    it("$", 520, 300, 4),
    it("3,160", 580, 300, 22),
  ]);
  assert.equal(text, "Cash and cash equivalents  |  $3,604  |  $3,160"); // not "$  |  3,604 $  |  3,160"
  // a currency sign is only glued to something that looks like a number
  assert.equal(itemsToText([it("Total", 33.8, 100, 25), it("$", 400, 100, 4), it("n/a", 440, 100, 14)]), "Total  |  $  |  n/a");
});

test("a lone suffix or prefix far from any number is not glued to an unrelated cell", () => {
  const text = itemsToText([it("Note", 33.8, 100, 20), it(")", 300, 100, 3), it("7,453", 483, 100, 19)]);
  assert.equal(text, "Note  |  )  |  7,453");
  const trailing = itemsToText([it("Total", 33.8, 100, 25), it("$", 483, 100, 4)]);
  assert.equal(trailing, "Total  |  $");
});

test("a footnote mark after a number stays a separate token; a superscript above the baseline joins its row", () => {
  const glued = itemsToText([it("Net sales", 33.8, 400, 40), it("2,278", 500, 400, 19.1), it("(1)", 519.1, 402.8, 8, 5)]);
  assert.equal(glued, "Net sales  |  2,278 (1)"); // never "2,278(1)"
  const above = itemsToText([it("Operating profit", 33.8, 380, 70), it("(a)(b)", 110, 383.2, 20, 5), it("9,123", 483, 380, 19.1)]);
  assert.equal(above, "Operating profit (a)(b)  |  9,123"); // one row, not an orphan line of marks
});

test("rows further apart than the tolerance stay separate", () => {
  const text = itemsToText([it("Revenue", 33.8, 700), it("Cost of sales", 33.8, 689)]);
  assert.equal(text, "Revenue\nCost of sales");
});

test("the row tolerance scales with the font but is clamped (tiny print never merges adjacent rows)", () => {
  // 4 pt font: tolerance is half the font, 2 pt
  assert.equal(itemsToText([it("a", 10, 100, 3, 4), it("b", 20,98.5, 3, 4)]), "a b");
  assert.equal(itemsToText([it("a", 10, 100, 3, 4), it("b", 20,97.5, 3, 4)]), "a\nb");
  // 2 pt font: half would be 1, but the floor is 1.5
  assert.equal(itemsToText([it("a", 10, 100, 3, 2), it("b", 20,98.7, 3, 2)]), "a b");
  assert.equal(itemsToText([it("a", 10, 100, 3, 2), it("b", 20,98.3, 3, 2)]), "a\nb");
  // 20 pt font: half would be 10, but the ceiling is 4
  assert.equal(itemsToText([it("Title", 10, 100, 40, 20), it("sub", 60, 96.5, 20, 20)]), "Title sub");
  assert.equal(itemsToText([it("Title", 10, 100, 40, 20), it("sub", 60, 95.5, 20, 20)]), "Title\nsub");
});

test("blank, missing and non-finite items are dropped; an empty page gives an empty string", () => {
  assert.equal(itemsToText([]), "");
  assert.equal(itemsToText([it("   ", 10, 10), it("", 20, 10)]), "");
  assert.equal(itemsToText([it("ok", 10, 10), it("bad", NaN, 10), { str: undefined as never, x: 1, y: 1, width: 1, height: 1 }]), "ok");
});

test("words on one baseline with small gaps are joined with a space; touching pieces are joined without one", () => {
  assert.equal(itemsToText([it("Total", 10, 50, 22), it("current", 34, 50, 32), it("assets", 68, 50, 26)]), "Total current assets");
  assert.equal(itemsToText([it("19,", 10, 50, 13), it("815", 23, 50, 13)]), "19,815");
});
