import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, headingLines, pageTitle, tokenize } from "../src/documents/search.ts";

test("tokenize: lower case, stop words out, numbers kept with or without commas, words stemmed", () => {
  assert.deepEqual(tokenize("Total current Liabilities of the company: 19,815 and 13997.5"), ["total", "current", "liabil", "company", "19815", "13997.5"]);
  assert.deepEqual(tokenize("assets ASSET business's"), ["asset", "asset", "business"]);
  assert.deepEqual(tokenize("gross, margins; loss"), ["gross", "margin", "loss"]); // "ss" endings are kept
  assert.deepEqual(tokenize("the of and"), []);
  assert.deepEqual(tokenize(""), []);
});

test("headingLines and pageTitle skip navigation, numbers-only and long lines, and keep only the label cell", () => {
  const page = "Table of Contents\n68\nLockheed Martin Corporation\nConsolidated Balance Sheets  |  2021\n(in millions)\nCash  |  3,604";
  assert.deepEqual(headingLines(page), ["Lockheed Martin Corporation", "Consolidated Balance Sheets", "(in millions)"]);
  assert.equal(pageTitle(page), "Lockheed Martin Corporation / Consolidated Balance Sheets / (in millions)");
  assert.equal(pageTitle("12\n\n"), "");
  assert.ok(pageTitle("x".repeat(50) + " word\n" + "Second heading words\nThird heading words here").length <= 90);
});

// A small filing: a prose page that mentions the balance sheet a lot, the balance sheet itself, an income statement.
const pages = [
  "Management discussion\nOur consolidated balance sheets show strength. The consolidated balance sheets and consolidated balance sheets notes discuss liquidity.",
  "ACME Corp\nConsolidated Balance Sheets\n(in millions)  |  2022  |  2021\nTotal current assets  |  19,815  |  19,378\nTotal current liabilities  |  13,997  |  13,933",
  "ACME Corp\nConsolidated Statements of Operations\nNet revenue  |  23,601  |  16,434\nGross margin  |  3,502  |  3,017",
  "Risk factors\nOur liabilities could rise. Current conditions are uncertain. Assets may be impaired.",
];
const index = buildIndex(pages);

test("row labels find the statement page first", () => {
  const hits = index.search("total current assets total current liabilities");
  assert.equal(hits[0].page, 2);
  assert.equal(hits[0].snippet, "Total current assets  |  19,815  |  19,378");
  assert.equal(hits[0].title, "ACME Corp / Consolidated Balance Sheets / (in millions)");
});

test("a statement name finds the statement over prose that repeats the name (heading words count extra)", () => {
  assert.equal(index.search("consolidated balance sheets")[0].page, 2);
  assert.equal(index.search("statements of operations")[0].page, 3);
});

test("words side by side beat the same words scattered", () => {
  // same words, same length; only the order differs
  const pair = buildIndex(["liabilities rose sharply during current year overall", "current liabilities rose sharply during year overall"]);
  assert.deepEqual(pair.search("current liabilities").map((h) => h.page), [2, 1]);
  assert.ok(index.search("current liabilities").some((h) => h.page === 4)); // scattered words still count
});

test("numbers are searchable, commas or not", () => {
  assert.equal(index.search("19,815")[0].page, 2);
  assert.equal(index.search("23601")[0].page, 3);
});

test("no match, an empty or stop-word-only query give no hits; k limits the list; pages count from 1", () => {
  assert.deepEqual(index.search("zebra"), []);
  assert.deepEqual(index.search(""), []);
  assert.deepEqual(index.search("the of and"), []);
  assert.equal(index.search("current", 2).length, 2);
  assert.equal(index.search("current", 0).length, 0);
  assert.ok(index.search("current").every((h) => h.page >= 1 && h.page <= pages.length));
  assert.equal(index.pages, 4);
});

test("ties are broken by page order, so results are deterministic", () => {
  const same = buildIndex(["Revenue grew", "Revenue grew", "Revenue grew"]);
  assert.deepEqual(same.search("revenue").map((h) => h.page), [1, 2, 3]);
});

test("a long matching line is cut to a short snippet", () => {
  const long = buildIndex(["Heading\n" + "revenue ".repeat(100)]);
  assert.ok(long.search("revenue")[0].snippet.length <= 200);
});

test("an empty document indexes and searches without error", () => {
  assert.deepEqual(buildIndex([]).search("anything"), []);
  assert.deepEqual(buildIndex(["", ""]).search("anything"), []);
});

import { stem } from "../src/documents/search.ts";

test("stem: related word forms meet", () => {
  const families = [
    ["cyclical", "cyclicality"],
    ["operate", "operating", "operation", "operations"],
    ["liability", "liabilities"],
    ["report", "reported", "reporting", "reports"],
    ["increase", "increased", "increasing", "increases"],
    ["business", "businesses"],
    ["revenue", "revenues"],
    ["asset", "assets"],
    ["significant", "significantly"],
    ["liquid", "liquidity"],
    ["tax", "taxes"],
    ["class", "classes"],
    ["match", "matches"],
    ["address", "addresses"],
  ];
  for (const family of families) assert.equal(new Set(family.map(stem)).size, 1, `${family.join(", ")} -> ${family.map(stem).join(", ")}`);
});

test("stem: unrelated words stay apart, and short words and numbers are not touched", () => {
  const apart = ["revenue", "margin", "asset", "liability", "income", "expense", "loss", "profit", "cash", "debt", "tax", "equity", "segment", "customer", "legal", "risk"];
  assert.equal(new Set(apart.map(stem)).size, apart.length);
  for (const short of ["tax", "gas", "bus", "is", "us", "ed", "ing"]) assert.equal(stem(short), short);
  assert.deepEqual(tokenize("2022 19,815 10-K"), ["2022", "19815", "10", "k"]);
});

test("tokenize: abbreviations with & stay whole, as typed and as printed; question and instruction words are dropped", () => {
  assert.deepEqual(tokenize("SG&A and R&D, PP&E"), ["sga", "rd", "ppe"]);
  assert.deepEqual(tokenize("SG & A"), ["sg"]); // spaced out: not an abbreviation (A is a stop word)
  assert.deepEqual(tokenize("What does the company state? Please explain, using the filing."), ["company", "filing"]);
});

test("search finds a page by a related word form", () => {
  const idx = buildIndex(["Industry cyclicality may affect demand for our aircraft", "Revenue by segment"]);
  assert.equal(idx.search("is the business cyclical")[0].page, 1);
  assert.equal(buildIndex(["Selling, general and administrative expenses (SG&A) rose", "Other"]).search("SG&A")[0].page, 1);
});
