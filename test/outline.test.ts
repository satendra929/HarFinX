import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutline, findSection, formatOutline, outlineOf, sectionAt, OUTLINE_CHARS } from "../src/documents/outline.ts";

const prose = (n = 12) => Array.from({ length: n }, (_, i) => `Ordinary sentence number ${i} about the business and its results.`);
const table = (title: string, rows = 10) => [title, "(in millions)", "Year ended December 31  |  2022  |  2021", ...Array.from({ length: rows }, (_, i) => `Line ${i}  |  ${1000 + i}  |  ${2000 + i}`)].join("\n");
const page = (...lines: string[]) => [...lines, ...prose()].join("\n");
const fill = (n: number) => Array.from({ length: n }, () => prose().join("\n"));

/** A 10-K shaped filing: contents page, Items on stated pages, statements and Notes after Item 8. */
function tenK(): string[] {
  const pages = fill(40);
  const at = (p: number, text: string) => (pages[p - 1] = text);
  at(2, ["TABLE OF CONTENTS", "Item 1. Business  |  3", "Item 1A. Risk Factors  |  6", "Item 2. Properties  |  15", "Item 3. Legal Proceedings  |  16", "Item 7. Management's Discussion  |  19", "Item 8. Financial Statements  |  30", "Item 9. Changes in Accountants  |  38"].join("\n"));
  at(3, page("PART I", "Item 1. Business"));
  at(6, page("Item 1A. Risk Factors"));
  at(15, page("Item 2. Properties"));
  at(16, ["Item 3. Legal Proceedings", "None."].join("\n"));
  at(17, page("PART II", "Item 7. Management's Discussion and Analysis of Financial Condition"));
  at(30, page("Item 8. Financial Statements and Supplementary Data"));
  at(31, table("CONSOLIDATED STATEMENTS OF OPERATIONS"));
  at(32, table("CONSOLIDATED BALANCE SHEETS"));
  at(33, table("CONSOLIDATED STATEMENTS OF CASH FLOWS"));
  at(34, table("CONSOLIDATED STATEMENTS OF STOCKHOLDERS' EQUITY"));
  at(35, page("NOTE 1", "Summary of Significant Accounting Policies"));
  at(36, page("NOTE 2 - Revenue"));
  at(37, page("NOTE 3 - Debt"));
  at(38, page("Item 9. Changes in and Disagreements with Accountants"));
  return pages;
}
const ids = (o: ReturnType<typeof buildOutline>) => o.entries.map((e) => `${e.id}@${e.from}${e.to && e.to > e.from ? "-" + e.to : ""}`);

test("a 10-K shape: every entry on its page, ranges, the contents page excluded", () => {
  const o = buildOutline(tenK());
  assert.deepEqual(o.contentsPages, [2]);
  assert.deepEqual(ids(o), ["Item 1@3-5", "Item 1A@6-14", "Item 2@15", "Item 3@16", "Item 7@17-29", "Item 8@30-37", "Item 9@38-40",
    "Income statement@31", "Balance sheet@32", "Cash flow statement@33", "Equity statement@34", "Note 1@35", "Note 2@36", "Note 3@37"]);
  assert.equal(o.entries.find((e) => e.id === "Item 3")?.brief, true); // two lines under the heading and then the next heading
  assert.equal(o.entries.find((e) => e.id === "Item 7")?.brief, false);
  assert.equal(o.entries.find((e) => e.id === "Item 7")?.title, "Management's Discussion and Analysis of Financial Condition");
});

test("a contents page without page numbers is excluded by density; a running header repeating Item 8 gives one entry", () => {
  const pages = tenK();
  pages[1] = ["Item 1. Business", "Item 1A. Risk Factors", "Item 2. Properties", "Item 3. Legal Proceedings", "Item 7. MD&A", "Item 8. Financial Statements", "Item 9. Changes", "Item 15. Exhibits"].join("\n");
  for (let p = 30; p <= 37; p++) pages[p - 1] = "Item 8\n" + pages[p - 1];
  const o = buildOutline(pages);
  assert.deepEqual(o.contentsPages, [2]);
  assert.equal(o.entries.filter((e) => e.id === "Item 8").length, 1);
  assert.equal(o.entries.find((e) => e.id === "Item 8")?.from, 30);
});

test("a cross-reference at a line start, and a forward reference between two real Items, do not become Items", () => {
  const pages = tenK();
  pages[9] = page("as described in", "Item 7. Management's Discussion would be misread");
  pages[10] = page("Item 7 of this report discusses the matter."); // lower-case continuation
  pages[11] = page("Item 8. Financial Statements, see below"); // a forward reference with a real title is still only a candidate; the chain keeps the real run
  const o = buildOutline(pages);
  assert.deepEqual(ids(o).filter((s) => s.startsWith("Item")), ["Item 1@3-5", "Item 1A@6-14", "Item 2@15", "Item 3@16", "Item 7@17-29", "Item 8@30-37", "Item 9@38-40"]);
});

test("a 10-Q shape: Part II Items carry their Part", () => {
  const pages = fill(30);
  pages[0] = page("PART I", "Item 1. Financial Statements");
  pages[8] = page("Item 2. Management's Discussion and Analysis");
  pages[14] = page("Item 3. Quantitative and Qualitative Disclosures");
  pages[16] = page("Item 4. Controls and Procedures");
  pages[18] = page("PART II", "Item 1. Legal Proceedings");
  pages[20] = page("Item 1A. Risk Factors");
  pages[22] = page("Item 2. Unregistered Sales");
  pages[26] = page("Item 6. Exhibits");
  const o = buildOutline(pages);
  assert.deepEqual(o.entries.map((e) => e.id), ["Item 1", "Item 2", "Item 3", "Item 4", "Part II Item 1", "Part II Item 1A", "Part II Item 2", "Part II Item 6"].map((s, i) => (i < 4 ? `Part I ${s}` : s)));
  assert.equal(findSection(o, "part ii item 1a")?.from, 21);
  assert.equal(findSection(o, "item 1")?.from, 1);
});

test("an 8-K with two Items shows none; three Items show", () => {
  const two = fill(5);
  two[0] = page("Item 2.02 Results of Operations");
  two[2] = page("Item 9.01 Financial Statements and Exhibits");
  assert.deepEqual(buildOutline(two).entries, []);
  const three = fill(6);
  three[0] = page("Item 7.01 Regulation FD Disclosure");
  three[2] = page("Item 8.01 Other Events");
  three[4] = page("Item 9.01 Financial Statements and Exhibits");
  assert.deepEqual(ids(buildOutline(three)), ["Item 7.01@1-2", "Item 8.01@3-4", "Item 9.01@5-6"]);
});

test("numbered notes after the statements; a numbered list before them is not a note series", () => {
  const pages = fill(20);
  pages[2] = page("1. I have reviewed this annual report", "2. Based on my knowledge, the report is accurate", "3. The financial statements fairly present");
  pages[5] = table("CONSOLIDATED STATEMENTS OF OPERATIONS");
  pages[6] = table("CONSOLIDATED BALANCE SHEETS");
  pages[7] = table("CONSOLIDATED STATEMENTS OF CASH FLOWS");
  pages[9] = page("1. Significant Accounting Policies");
  pages[11] = page("2. Revenue Recognition");
  pages[13] = page("3. Income Taxes");
  pages[15] = page("4. Segments");
  const o = buildOutline(pages);
  assert.deepEqual(o.entries.filter((e) => e.kind === "note").map((e) => `${e.id}@${e.from}`), ["Note 1@10", "Note 2@12", "Note 3@14", "Note 4@16"]);
});

test("a notes index page is excluded; a series that does not start at 1 is not shown", () => {
  const pages = fill(20);
  pages[1] = ["Note 1  Policies  |  8", "Note 2  Revenue  |  10", "Note 3  Taxes  |  12", "Note 4  Debt  |  14", "Note 5  Leases  |  16"].join("\n");
  pages[9] = page("Note 2 - Revenue");
  pages[11] = page("Note 3 - Taxes");
  pages[13] = page("Note 4 - Debt");
  const o = buildOutline(pages);
  assert.equal(o.entries.filter((e) => e.kind === "note").length, 0);
  assert.deepEqual(o.contentsPages, [2]);
});

test("statements: a supplemental page, a continued page and an index page are not statements; MD&A analysis before the real one is skipped", () => {
  const pages = fill(30);
  pages[9] = table("Supplemental Balance Sheet Information");
  pages[10] = table("Consolidated balance sheets analysis");
  pages[11] = [ "CONSOLIDATED BALANCE SHEETS", "CONSOLIDATED STATEMENTS OF CASH FLOWS", ...Array.from({ length: 10 }, (_, i) => `Statement  |  ${i}  |  ${i}`)].join("\n");
  pages[19] = table("CONSOLIDATED BALANCE SHEETS (continued)");
  pages[20] = table("CONSOLIDATED STATEMENTS OF OPERATIONS");
  pages[21] = table("CONSOLIDATED BALANCE SHEETS");
  pages[22] = table("CONSOLIDATED STATEMENTS OF CASH FLOWS");
  pages[24] = page("NOTE 1", "Summary");
  pages[25] = page("NOTE 2", "Revenue");
  pages[26] = page("NOTE 3", "Debt");
  const o = buildOutline(pages);
  assert.deepEqual(o.entries.filter((e) => e.kind === "statement").map((e) => `${e.id}@${e.from}`), ["Income statement@21", "Balance sheet@22", "Cash flow statement@23"]);
});

test("statements after the last Item: that Item's range stops before them", () => {
  const pages = fill(30);
  pages[0] = page("Item 1. Business");
  pages[5] = page("Item 7. Management's Discussion");
  pages[9] = page("Item 15. Exhibits");
  pages[19] = table("CONSOLIDATED STATEMENTS OF OPERATIONS");
  pages[20] = table("CONSOLIDATED BALANCE SHEETS");
  pages[21] = table("CONSOLIDATED STATEMENTS OF CASH FLOWS");
  pages[23] = page("NOTE 1", "Policies");
  pages[24] = page("NOTE 2", "Revenue");
  pages[25] = page("NOTE 3", "Debt");
  const o = buildOutline(pages);
  assert.equal(o.entries.find((e) => e.id === "Item 15")?.to, 19);
});

test("a title on the next line; a running 'Item 1' header above the real heading takes its title", () => {
  const pages = fill(10);
  pages[0] = page("Item 1", "Business");
  pages[1] = page("Item 1", "ITEM 1. BUSINESS");
  pages[3] = page("Item 2", "Properties");
  pages[5] = page("Item 3", "Legal Proceedings");
  const o = buildOutline(pages);
  assert.equal(o.entries[0].title, "Business");
  const alt = fill(10);
  alt[0] = page("Item 1", "ITEM 1. BUSINESS");
  alt[3] = page("Item 2 Properties");
  alt[5] = page("Item 3 Legal");
  assert.equal(buildOutline(alt).entries[0].title, "BUSINESS");
});

test("a repeated Item id with no Part heading between shows no Items", () => {
  const pages = fill(20);
  pages[0] = page("Item 1. Financial Statements");
  pages[4] = page("Item 2. Management's Discussion");
  pages[8] = page("Item 3. Market Risk");
  pages[12] = page("Item 1. Legal Proceedings");
  pages[16] = page("Item 1A. Risk Factors");
  assert.deepEqual(buildOutline(pages).entries.filter((e) => e.kind === "item"), []);
});

test("negative cases return an empty outline", () => {
  assert.deepEqual(buildOutline([]).entries, []);
  assert.deepEqual(buildOutline(fill(5)).entries, []);
  assert.deepEqual(buildOutline(["1\n2\n3", "4 5 6"]).entries, []);
  const two = fill(5);
  two[0] = page("Item 1. A");
  two[2] = page("Item 2. B");
  assert.deepEqual(buildOutline(two).entries, []);
  const many = [Array.from({ length: 2100 }, (_, i) => `Item ${(i % 20) + 1}. Title ${i}`).join("\n")];
  assert.deepEqual(buildOutline(many).entries, []);
});

test("formatOutline: head, one entry per line, titles cut, never over the cap, no outline text", () => {
  const o = buildOutline(tenK());
  const t = formatOutline(o, "f.pdf", 40);
  assert.match(t, /^\[outline of f\.pdf, pages 1-40; p\. is the page of the file\]\nItem 1 Business p\.3-5\n/);
  assert.match(t, /Item 3 Legal Proceedings p\.16 \(brief\)/);
  assert.ok(t.length <= OUTLINE_CHARS);
  const long = { entries: Array.from({ length: 40 }, (_, i) => ({ kind: "note" as const, id: `Note ${i + 1}`, title: "A very long note title that goes on and on", from: i + 1 })), contentsPages: [] };
  const lt = formatOutline(long, "f.pdf", 99);
  assert.equal(lt.split("\n").length, 42);
  assert.ok(lt.length <= OUTLINE_CHARS + 200);
  assert.match(formatOutline({ entries: [], contentsPages: [] }, "f.pdf", 9), /^\[outline of f\.pdf, pages 1-9\]\nNo outline found: .* Use search\.$/);
});

test("findSection: by id, by id with a dot, by unique title words; ambiguous or unknown is undefined; sectionAt", () => {
  const o = buildOutline(tenK());
  assert.equal(findSection(o, "Item 7")?.id, "Item 7");
  assert.equal(findSection(o, "item 7.")?.id, "Item 7");
  assert.equal(findSection(o, "1A")?.id, "Item 1A");
  assert.equal(findSection(o, "note 2")?.from, 36);
  assert.equal(findSection(o, "risk factors")?.id, "Item 1A");
  assert.equal(findSection(o, "financial")?.id, undefined); // several titles hold it
  assert.equal(findSection(o, "MDA"), undefined);
  assert.equal(findSection(o, ""), undefined);
  assert.equal(sectionAt(o, 20)?.id, "Item 7");
});

test("outlineOf builds once per page array", () => {
  const pages = tenK();
  assert.equal(outlineOf(pages), outlineOf(pages));
});
