import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, checkText, extractNumbers, maskLabels, normalise, unverified } from "../src/provenance.ts";
import { RefNumbers, markLine } from "../src/refs.ts";

const tokens = (s: string) => extractNumbers(normalise(s)).map((t) => t.raw);

// Names and codes that contain digits are not figures: nothing is left to check.
const LABELS_GONE = [
  "COVID-19 reduced demand",
  "Covid-19 reduced demand",
  "Rule 10b-5 applies",
  "Rule 10b5-1 plan",
  "Form 12b-25 notice",
  "Series A-1 preferred",
  "a 30-day period",
  "a 12-month term and 90-day notice",
  "the 52-week high",
  "7-Eleven stores",
  "a 3-for-1 split",
  "a 1-for-10 reverse split",
  "ASC 606 and ASU 2016-13",
  "Topic 842-10-25",
  "IFRS 16 leases",
  "Rule 144A offering",
  "Item 1A risk factors",
  "Schedule 13D",
  "FY2022-23 growth",
  "FY2022-2023 growth",
  "Q3-2022 results",
  "COVID‑19 and 3‑for‑1", // typographic (non-breaking) hyphens
];
for (const s of LABELS_GONE) test(`label, not a figure: ${s}`, () => assert.deepEqual(tokens(s), []));

// Anything with a unit marker, decimals, a comma, a scale word or digits on both sides of a hyphen stays a figure.
const FIGURES_KEPT: [string, string[]][] = [
  ["a $500-million deal", ["$500"]],
  ["a 500-million buyback", ["500"]],
  ["5-million shares", ["5"]],
  ["a 5-percent rise", ["5"]],
  ["a 25-basis-point cut", ["25"]],
  ["a 15-percentage-point gain", ["15"]],
  ["$5-6 million", ["$5", "6 million"]],
  ["growth of 5-10%", ["5", "10%"]],
  ["4.5%-plus", ["4.5%"]],
  ["net -19 loss", ["-19"]],
  ["2022-2023", ["2022", "2023"]],
  ["1,200-person staff", ["1,200"]],
  ["a 2.5-year term", ["2.5"]],
  ["COVID-19.5 oddity", ["19.5"]],
  ["EPS 2-3", ["2", "3"]],
  ["5M-6M", ["5M", "6M"]],
  ["10bn-12", ["10bn", "12"]],
  ["Rule 4.5 billion", ["4.5 billion"]],
  ["Item 7.5% of sales", ["7.5%"]],
  ["Rule 5-6%", ["5", "6%"]],
  ["Rule of 40", ["40"]],
  ["Note 7.5% of revenue", ["7.5%"]],
  ["Line 3.4 million", ["3.4 million"]],
  ["10-year yield 4.2%", ["4.2%"]],
  ["FY2022-23% odd", ["-23%"]],
];
for (const [s, want] of FIGURES_KEPT) test(`figure kept: ${s}`, () => assert.deepEqual(tokens(s), want));

test("blanking keeps the length of the text, so marks land on the right figure", () => {
  for (const s of [...LABELS_GONE, ...FIGURES_KEPT.map(([x]) => x), "Item\n300 revenue"]) assert.equal(maskLabels(s).length, s.length, s);
});

test("a number after a citation word on the next line is not a label", () => {
  assert.deepEqual(tokens("Item\n300"), ["300"]);
});

test("an answer with names and codes and one traced figure has nothing untraced", () => {
  const l = new Ledger();
  l.addUser("What did the filing say about revenue?");
  l.addSource("a.txt", "Revenue was $5,000 million.");
  const answer = "Revenue was $5,000 million, despite COVID-19, under Rule 10b-5 and ASC 606, in a 30-day window.";
  assert.deepEqual(unverified(checkText(answer, l)), []);
  assert.equal(unverified(checkText(answer + " Costs were $9,999 million.", l)).length, 1); // a real figure still is checked
});

test("a reference mark follows the figure, not the label beside it", () => {
  const l = new Ledger();
  l.addSource("a.pdf p.1", "Revenue  |  $5,000", { file: "a.pdf", page: 1, pageLines: ["Revenue  |  $5,000"], lineOffset: 0, printed: "1" });
  const out = markLine("COVID-19 hit; revenue was $5,000 [Rule 10b-5]", l, new RefNumbers(), (m) => `<${m}>`);
  assert.equal(out, "COVID-19 hit; revenue was $5,000<[S1]> [Rule 10b-5]");
});
