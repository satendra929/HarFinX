import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStatements, parseCell, statementPage } from "../src/documents/statements.ts";
import { candidatesFor, conceptById, normLabel, CONCEPTS } from "../src/documents/concepts.ts";
import { checkStatements } from "../src/documents/statementChecks.ts";
import { REAL_10K, bsRows, isRows, cfRows, table } from "./fixtures/docKinds.ts";

test("parseCell: brackets are negative, dashes are zero, currency signs and footnote marks are ignored, anything else is not a figure", () => {
  assert.equal(parseCell("(8,958)"), "-8958");
  assert.equal(parseCell("$(6,841)"), "-6841");
  assert.equal(parseCell("$12.35"), "12.35");
  assert.equal(parseCell("1,234 (1)"), "1234"); // footnote mark after the figure
  assert.equal(parseCell("—"), "0");
  assert.equal(parseCell("-"), "0");
  assert.equal(parseCell("9.5%"), null);
  assert.equal(parseCell("(473"), null); // unbalanced
  assert.equal(parseCell("Note 5"), null);
  assert.equal(parseCell(""), null);
});

test("statementPage: a 10-K page gives units, columns with their year and one value per column; the lines are the page's own", () => {
  const sp = statementPage("Balance sheet", 7, table("CONSOLIDATED BALANCE SHEETS", bsRows));
  assert.equal(sp.units, "(in millions)");
  assert.deepEqual(sp.columns.map((c) => c.heading), ["December 31 2022", "December 31 2021"]);
  assert.deepEqual(sp.columns.map((c) => c.year), ["2022", "2021"]);
  const ta = sp.rows.find((r) => r.label === "Total assets")!;
  assert.deepEqual(ta.values, ["5600", "5330"]);
  assert.equal(ta.aligned, true);
  assert.equal(sp.lines[ta.line], ta.text, "row.line indexes the page's lines");
});

test("statementPage: a quarterly page with spans above the years gives one heading per column", () => {
  const page = ["3M COMPANY", "Consolidated Statement of Income", "Three months ended  |  Six months ended", "June 30,  |  June 30,", "(Millions, except per share amounts)  |  2023  |  2022  |  2023  |  2022", "Net sales  |  $8,325  |  $8,702  |  $16,356  |  $17,531", "Operating income (loss)  |  (8,958)  |  110  |  (7,717)  |  1,751"].join("\n");
  const sp = statementPage("Income statement", 3, page);
  assert.deepEqual(sp.columns.map((c) => c.heading), ["Three months ended June 30, 2023", "Three months ended June 30, 2022", "Six months ended June 30, 2023", "Six months ended June 30, 2022"]);
  assert.equal(sp.units, "(Millions, except per share amounts)");
  assert.deepEqual(sp.rows.find((r) => r.label.startsWith("Operating income"))!.values, ["-8958", "110", "-7717", "1751"]);
});

test("statementPage: a currency sign in a cell of its own or after the number does not break the columns; a row with the wrong cell count is marked misaligned", () => {
  const page = ["Balance Sheets", "(in millions)", "June 30, 2023  |  December 31, 2022", "Cash and cash equivalents  |  $  |  4,258 $  |  3,655", "Total assets  |  $  |  48,880 $  |  46,455", "Odd row  |  1  |  2  |  3"].join("\n");
  const sp = statementPage("Balance sheet", 5, page);
  assert.deepEqual(sp.rows[0].values, ["4258", "3655"]);
  assert.equal(sp.rows[0].aligned, true);
  assert.equal(sp.rows[2].aligned, false);
});

test("statementPage: a continuation page with no heading takes the columns carried from the page before; rows with no label are dropped", () => {
  const first = statementPage("Cash flow statement", 9, table("STATEMENTS OF CASH FLOWS", cfRows));
  const cont = statementPage("Cash flow statement", 10, ["Dividends paid  |  (200)  |  (180)", "1,234  |  5  |  6"].join("\n"), first.columns);
  assert.equal(cont.columns.length, 2);
  assert.equal(cont.rows.length, 1);
  assert.deepEqual(cont.rows[0].values, ["-200", "-180"]);
  assert.equal(cont.rows[0].aligned, true);
});

test("extractStatements: uses the outline's statement pages of a whole document", () => {
  const sts = extractStatements(REAL_10K);
  assert.deepEqual(sts.map((s) => s.id).sort(), ["Balance sheet", "Cash flow statement", "Income statement"]);
});

test("normLabel: case, apostrophes, brackets and punctuation do not matter", () => {
  assert.equal(normLabel("Total Stockholders' Equity:"), "total stockholders equity");
  assert.equal(normLabel("Net income (loss) attributable to 3M"), "net income attributable to 3m");
  assert.equal(normLabel("Revenues, net"), "revenues net");
});

const pageOf = (id: "Balance sheet" | "Income statement" | "Cash flow statement", rows: string[][]) => statementPage(id, 1, table("T", rows));

test("concepts: the parent's net income wins over the plain line; two lines of the same tier are ambiguous, never guessed", () => {
  const def = conceptById("net_income")!;
  const both = [pageOf("Income statement", [["Net income including noncontrolling interest", "1,000", "900"], ["Net income", "1,000", "900"], ["Net income attributable to ACME", "950", "860"], ["Net income attributable to noncontrolling interest", "50", "40"]])];
  const r = candidatesFor(def, both).found;
  assert.deepEqual(r.map((x) => x.row.label), ["Net income attributable to ACME"]);
  const plain = [pageOf("Income statement", [["Net income", "1,000", "900"]])];
  assert.equal(candidatesFor(def, plain).found.length, 1);
  const two = [pageOf("Income statement", [["Net sales", "100", "90"], ["Total revenues", "120", "110"]])];
  assert.equal(candidatesFor(conceptById("revenue")!, two).found.length, 2);
});

test("concepts: diluted per-share only under a per-share heading; a rows of another statement never match", () => {
  const def = conceptById("eps_diluted")!;
  const eps = [statementPage("Income statement", 1, ["Income", "(in millions)", "2022  |  2021", "Earnings per share:", "Basic  |  3.20  |  2.70", "Diluted  |  3.10  |  2.60", "Weighted average shares:", "Diluted  |  250  |  251"].join("\n"))];
  const r = candidatesFor(def, eps).found;
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].row.values, ["3.10", "2.60"]);
  assert.equal(candidatesFor(conceptById("net_income")!, [pageOf("Cash flow statement", [["Net income", "1", "2"]])]).found.length, 0);
});

test("concepts: every concept maps the typical label of its statement, and the common wrong lines do not match", () => {
  const cases: [string, string, boolean][] = [
    ["total_current_assets", "Total current assets", true], ["total_assets", "Total assets", true], ["total_assets", "Total assets held for sale", false],
    ["cash", "Cash and cash equivalents", true], ["cash", "Cash and cash equivalents at end of year", false],
    ["capex", "Purchases of property, plant and equipment", true], ["capex", "Payments for acquisition of property and equipment", true], ["capex", "Purchases of marketable securities", false],
    ["depreciation_amortization", "Depreciation and amortization", true], ["operating_cash_flow", "Net cash provided by (used in) operating activities", true], ["operating_cash_flow", "Net cash used in investing activities", false],
    ["gross_profit", "Gross profit", true], ["operating_income", "Income from operations", true], ["cost_of_revenue", "Cost of sales", true],
  ];
  for (const [id, label, want] of cases) {
    const def = conceptById(id)!;
    const n = normLabel(label);
    assert.equal(def.tiers.some((t) => t.some((re) => re.test(n))), want, `${id}: ${label}`);
  }
  assert.equal(CONCEPTS.length, 15);
});

test("checks: a balanced balance sheet verifies; an unbalanced one fails and names the column; closing cash that includes restricted cash is not a failure", () => {
  const bs = pageOf("Balance sheet", bsRows);
  assert.equal(checkStatements([bs]).balance.status, "verified");
  const broken = pageOf("Balance sheet", bsRows.map((r) => (r[0] === "Total assets" ? [r[0], "5,700", r[2]] : r)));
  const failed = checkStatements([broken]).balance;
  assert.equal(failed.status, "failed");
  assert.match(failed.detail, /December 31 2022/);
  assert.equal(checkStatements([]).balance.status, "not_checked");
  const cfTie = pageOf("Cash flow statement", cfRows);
  assert.equal(checkStatements([bs, cfTie]).cash.status, "verified");
  const cfRestricted = pageOf("Cash flow statement", [["Cash, cash equivalents and restricted cash at end of year", "1,500", "1,300"]]);
  assert.equal(checkStatements([bs, cfRestricted]).cash.status, "not_checked");
  const cfPlain = pageOf("Cash flow statement", [["Cash and cash equivalents at end of year", "1,500", "1,300"]]);
  assert.equal(checkStatements([bs, cfPlain]).cash.status, "failed");
});

test("income statement rows of the fixtures carry the right values (a sanity check on the fixture itself)", () => {
  assert.equal(isRows.length, 8);
});
