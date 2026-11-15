import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
import { lineItemTool, pickColumns } from "../src/tools/lineItem.ts";
import { shownOf } from "../src/shown.ts";
import { PageVisits } from "../src/documents/visits.ts";
import * as D from "./fixtures/docKinds.ts";

let base: string;
let ws: Workspace;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-li-")));
  fs.mkdirSync(path.join(base, "ws"));
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(base, "ws", "a.pdf"), "fake");
  ws = openWorkspace(path.join(base, "ws"), path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

type R = { content: { text: string }[]; details: any; structuredContent?: unknown };
const tool = (pages: string[], visits?: PageVisits) => lineItemTool(createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages })), visits);
const run = (t: { execute: Function }, params: object) => t.execute("id", params as never, undefined as never) as Promise<R>;

test("get_line_item: a line of a 10-K is found as printed, with its units, columns and the one column asked for", async () => {
  const r = await run(tool(D.REAL_10K), { path: "a.pdf", concept: "total_assets", period: "2022" });
  const t = r.content[0].text;
  assert.match(t, /^\[get_line_item total_assets in a\.pdf: found\]/);
  assert.match(t, /Balance sheet, page \d+, \(in millions\)/);
  assert.match(t, /Columns: December 31 2022 \| December 31 2021/);
  assert.match(t, /Row as printed: Total assets  \|  5,600  \|  5,330/);
  assert.match(t, /Column asked for: December 31 2022 -> 5,600/);
  assert.match(t, /\[checks: balance sheet: total assets equal total liabilities and equity in 2 columns/);
  assert.equal(r.details.status, "found");
});

test("get_line_item: the row goes to the host as shown text with its page lines, so the ledger can trace it", async () => {
  const r = await run(tool(D.REAL_10K), { path: "a.pdf", concept: "total_assets", period: "2022" });
  const shown = shownOf({ structuredContent: r.structuredContent });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].text, "Total assets  |  5,600  |  5,330");
  const meta = shown[0].meta as unknown as { pageLines: string[]; lineOffset: number; page: number };
  assert.equal(meta.pageLines[meta.lineOffset], shown[0].text);
  assert.equal(meta.page, r.details.page);
});

test("get_line_item: no period shows every printed column and says so; a year the statement does not print is not_found with the columns it does print", async () => {
  const all = await run(tool(D.REAL_10K), { path: "a.pdf", concept: "net_income" });
  assert.match(all.content[0].text, /no period given: every printed column is shown/);
  assert.doesNotMatch(all.content[0].text, /Column asked for/);
  const none = await run(tool(D.REAL_10K), { path: "a.pdf", concept: "total_assets", period: "2019" });
  assert.match(none.content[0].text, /not_found/);
  assert.match(none.content[0].text, /prints no column for 2019; its columns are: December 31 2022 \| December 31 2021/);
  assert.match(none.content[0].text, /use search and read_page/);
});

test("get_line_item: a concept the statements do not print is not_found, never computed", async () => {
  const noGross = D.REAL_10K.map((p) => p.replace("Gross profit  |  3,600  |  3,300", "Other  |  1  |  1"));
  const r = await run(tool(noGross), { path: "a.pdf", concept: "gross_profit", period: "2022" });
  assert.match(r.content[0].text, /not_found/);
  assert.match(r.content[0].text, /no row on the income statement is labelled like gross profit/);
});

test("get_line_item: two rows that both fit are ambiguous and both are shown (and fed to the ledger)", async () => {
  const pages = D.REAL_10K.map((p) => p.replace("Net sales  |  9,000  |  8,400", "Net sales  |  8,800  |  8,200\nTotal revenues  |  9,000  |  8,400"));
  const r = await run(tool(pages), { path: "a.pdf", concept: "revenue", period: "2022" });
  assert.match(r.content[0].text, /^\[get_line_item revenue in a\.pdf: ambiguous\]/);
  assert.match(r.content[0].text, /Net sales  \|  8,800/);
  assert.match(r.content[0].text, /Total revenues  \|  9,000/);
  assert.equal(shownOf({ structuredContent: r.structuredContent }).length, 2);
});

test("get_line_item: a quarterly report prints several columns for a year: the period decides, and without a decision it is ambiguous", async () => {
  const q = [...D.REAL_10Q];
  const i = q.findIndex((p) => /STATEMENTS OF INCOME/.test(p));
  q[i] = ["ACME Corp", "CONDENSED CONSOLIDATED STATEMENTS OF INCOME", "(Millions)", "Three months ended  |  Six months ended", "June 30,  |  June 30,", "(in millions)  |  2023  |  2022  |  2023  |  2022", ...D.isRows.map((r) => `${r[0]}  |  ${r[1]}  |  ${r[2]}  |  ${r[1]}0  |  ${r[2]}0`)].join("\n");
  const t = tool(q);
  const amb = await run(t, { path: "a.pdf", concept: "net_income", period: "2023" });
  assert.match(amb.content[0].text, /ambiguous/);
  assert.match(amb.content[0].text, /more than one column fits 2023/);
  const three = await run(t, { path: "a.pdf", concept: "net_income", period: "three months 2023" });
  assert.match(three.content[0].text, /Column asked for: Three months ended June 30, 2023 -> 780/);
  const six = await run(t, { path: "a.pdf", concept: "net_income", period: "six months 2023" });
  assert.match(six.content[0].text, /Column asked for: Six months ended June 30, 2023 -> 7,800|Column asked for: Six months ended June 30, 2023 -> 780/);
});

test("get_line_item: a file that is not a 10-K or 10-Q is not_found with what it looks like; an earnings release too", async () => {
  for (const [pages, want] of [[D.INVESTOR_DECK, "unknown"], [D.EARNINGS_RELEASE, "earnings"], [D.PROXY_STATEMENT, "unknown"]] as const) {
    const r = await run(tool([...pages]), { path: "a.pdf", concept: "total_assets" });
    assert.match(r.content[0].text, /not_found/);
    assert.match(r.content[0].text, /does not read as an annual or quarterly report/);
    assert.equal(r.details.kind, want);
  }
});

test("get_line_item: an unknown concept lists the known ones; a non-PDF path is refused", async () => {
  const r = await run(tool(D.REAL_10K), { path: "a.pdf", concept: "ebitda" });
  assert.match(r.content[0].text, /unknown concept; choose one of: revenue, cost_of_revenue/);
  await assert.rejects(run(tool(D.REAL_10K), { path: "notes.txt", concept: "revenue" }), /reads PDF files/);
});

test("get_line_item: statements that do not balance are served but marked unverified", async () => {
  const bad = D.REAL_10K.map((p) => p.replace("Total assets  |  5,600  |  5,330", "Total assets  |  5,900  |  5,330"));
  const r = await run(tool(bad), { path: "a.pdf", concept: "total_assets", period: "2022" });
  assert.match(r.content[0].text, /found, UNVERIFIED/);
  assert.match(r.content[0].text, /DOES NOT BALANCE/);
  assert.match(r.content[0].text, /confirm on the page/);
});

test("get_line_item: the page a line came from counts as looked at for the search marks", async () => {
  const visits = new PageVisits();
  const r = await run(tool(D.REAL_10K, visits), { path: "a.pdf", concept: "total_assets", period: "2022" });
  assert.equal(visits.state("a.pdf", r.details.page), "passage");
});

test("pickColumns: year, span words and the no-year cases", () => {
  const cols = [
    { index: 0, heading: "Three months ended June 30, 2023", year: "2023" },
    { index: 1, heading: "Three months ended June 30, 2022", year: "2022" },
    { index: 2, heading: "Six months ended June 30, 2023", year: "2023" },
  ];
  assert.equal(pickColumns(cols, "2023").picked.length, 2);
  assert.deepEqual(pickColumns(cols, "Q2 2023").picked.map((c) => c.index), [0]);
  assert.deepEqual(pickColumns(cols, "six months 2023").picked.map((c) => c.index), [2]);
  assert.equal(pickColumns(cols, "2019").picked.length, 0);
  assert.equal(pickColumns(cols, undefined).picked.length, 3);
  assert.match(pickColumns(cols, "last year").note ?? "", /no year/);
});
