import { test } from "node:test";
import assert from "node:assert/strict";
import { answerShape } from "../src/shape.ts";

test("answerShape: a one-line answer", () => {
  assert.deepEqual(answerShape("Net sales were $32,765 million."), { words: 5, lines: 1, bullets: 0, headings: 0, tableRows: 0, boldSpans: 0, firstSentenceWords: 5 });
});

test("answerShape: counts words, non-empty lines, list items, headings, table lines and bold spans", () => {
  const text = ["Adobe's margin fell.", "", "### Calculation", "| Year | Margin |", "| --- | --- |", "| 2022 | **34.6%** |", "* **2021:** 36.8%", "- 2022: 34.6%", "1. done", "Plain **one** and **two**."].join("\n");
  const s = answerShape(text);
  assert.equal(s.lines, 9); // the empty line is not counted
  assert.equal(s.headings, 1);
  assert.equal(s.tableRows, 3);
  assert.equal(s.bullets, 3);
  assert.equal(s.boldSpans, 4);
  assert.equal(s.firstSentenceWords, 3); // "Adobe's margin fell."
});

test("answerShape: a decimal point does not end the first sentence; a long first sentence is counted whole; empty text is zeros", () => {
  assert.equal(answerShape("Revenue grew 7.2 percent to $5.8 billion in 2022, driven by volume. Costs rose.").firstSentenceWords, 12);
  assert.equal(answerShape("Based on the filing, the answer is 5.\nMore.").firstSentenceWords, 8);
  assert.deepEqual(answerShape(""), { words: 0, lines: 0, bullets: 0, headings: 0, tableRows: 0, boldSpans: 0, firstSentenceWords: 0 });
});
