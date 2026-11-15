import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
import { passage, pageLines, PASSAGE_CHARS } from "../src/documents/pages.ts";
import { readPageTool } from "../src/tools/readPage.ts";
import { searchTool } from "../src/tools/search.ts";
import { PageVisits } from "../src/documents/visits.ts";
import { Ledger, checkText, extractNumbers, normalise } from "../src/provenance.ts";

let base: string;
let ws: Workspace;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-passage-")));
  fs.mkdirSync(path.join(base, "ws", "filings"), { recursive: true });
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(base, "ws", "filings", "a.pdf"), "fake");
  ws = openWorkspace(path.join(base, "ws"), path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

type R = { content: { text: string }[]; details: any };
const run = (tool: { execute: Function }, params: object) => tool.execute("id", params as never, undefined as never) as Promise<R>;
const store = (pages: string[]) => createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages }));
const prose = (n: number, hit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => hit[i] ?? `Filler sentence number ${i} about nothing in particular and its ordinary wording.`);
const F = "filings/a.pdf";

test("passage: one hit gives the hit line with three lines of context each side", () => {
  const lines = prose(30, { 10: "Net sales increased 20% in 2019 due to volume" });
  const p = passage(lines, "net sales increased");
  assert.deepEqual(p, { windows: [[7, 13]], more: false });
});

test("passage: far hits make two windows, near hits merge, five hits show three windows and say more", () => {
  const far = passage(prose(60, { 5: "alpha beta here", 40: "alpha beta there" }), "alpha beta");
  assert.deepEqual(far?.windows, [[2, 8], [37, 43]]);
  const near = passage(prose(60, { 20: "alpha beta one", 24: "alpha beta two" }), "alpha beta");
  assert.deepEqual(near?.windows, [[17, 27]]);
  const five = passage(prose(200, { 5: "alpha beta", 40: "alpha beta", 80: "alpha beta", 120: "alpha beta", 160: "alpha beta" }), "alpha beta");
  assert.equal(five?.windows.length, 3);
  assert.equal(five?.more, true);
});

test("passage: stems match, and fewer than half of the terms is no match", () => {
  assert.ok(passage(prose(10, { 4: "Commitments and contingencies" }), "contingency"));
  assert.equal(passage(prose(10, { 4: "Total revenue" }), "total current liabilities"), undefined); // 1 of 3
  assert.ok(passage(prose(10, { 4: "Total current assets" }), "total current liabilities")); // 2 of 3
  assert.equal(passage(prose(10), "the of and"), undefined); // only stop words
});

test("passage: the hit line is always whole and first, even when it alone passes the cap; a page of long lines stays near the cap", () => {
  const long = "alpha ".repeat(400); // 2,400 characters
  const p = passage([long], "alpha");
  assert.deepEqual(p, { windows: [[0, 0]], more: false });
  const lines = Array.from({ length: 30 }, (_, i) => (i === 15 ? "target " + "x".repeat(190) : "y".repeat(200)));
  const w = passage(lines, "target")!.windows;
  const size = w.reduce((n, [a, b]) => n + lines.slice(a, b + 1).join("\n").length, 0);
  assert.ok(size <= PASSAGE_CHARS + 20, String(size));
  assert.ok(w[0][0] <= 15 && w[0][1] >= 15);
});

test("read_page find: head, repeated heading lines, the hit and its context, a foot that says part of the page is shown", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => `Item ${i}  |  ${1000 + i}  |  ${2000 + i}`);
  rows[30] = "Total current liabilities  |  13,997  |  12,001";
  const page = ["Consolidated Balance Sheets", "(in millions)", "Year ended December 31  |  2022  |  2021", ...rows].join("\n");
  const shown: [string, string, number][] = [];
  const tool = readPageTool(store([page]), (l, t, m) => shown.push([l, t, m.lineOffset ?? -1]));
  const r = await run(tool, { path: F, page: 1, find: "total current liabilities" });
  const t = r.content[0].text;
  assert.match(t, /^\[page 1 of 1 in filings\/a\.pdf: lines around "total current liabilities"\]\n\[repeated from above on the page\]\n\(in millions\)\nYear ended December 31  \|  2022  \|  2021\nItem 27/);
  assert.match(t, /Total current liabilities  \|  13,997  \|  12,001\n/);
  assert.match(t, /\[page 1: part of the page is shown; call read_page without find for the whole page\]$/);
  assert.equal(r.details.matched, true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0][2], 3 + 30 - 3); // the window's first line index
  assert.ok(!shown[0][1].includes("(in millions)")); // repeated heading lines are not fed
  assert.ok(t.length < 1800);
});

test("read_page find: only shown rows reach the ledger, with their true line", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => `Row ${i}  |  ${5000 + i}`);
  rows[30] = "Net sales  |  32,765";
  rows[50] = "Other income  |  41,234";
  const ledger = new Ledger();
  const tool = readPageTool(store([rows.join("\n")]), (l, t, m) => ledger.addSource(l, t, m));
  await run(tool, { path: F, page: 1, find: "net sales" });
  assert.equal(checkText("Net sales were 32,765.", ledger)[0].cls, "S");
  assert.equal(checkText("Other income was 41,234.", ledger)[0].cls, "X");
  const [rec] = ledger.findAll(extractNumbers(normalise("32,765"))[0]);
  assert.equal(rec.where?.lineNo, 30);
  assert.equal(rec.where?.row, "Net sales  |  32,765");
});

test("read_page find: no match is short, bracketed, feeds nothing and is not an open; part is ignored; stop words mean a whole page", async () => {
  const shown: string[] = [];
  const visits = new PageVisits();
  const tool = readPageTool(store(["Consolidated Balance Sheets\nTotal assets  |  5", "Other page"]), (l) => shown.push(l), visits);
  const none = await run(tool, { path: F, page: 1, find: "quick [ratio]" });
  assert.equal(none.content[0].text, '[page 1 of 2 in filings/a.pdf: no line has "quick ratio"; the page is titled: Consolidated Balance Sheets]\n[page 1: call read_page without find to read it, or search for other words]');
  assert.equal(none.details.matched, false);
  assert.deepEqual(shown, []);
  assert.equal(visits.state(F, 1), undefined);
  const withPart = await run(tool, { path: F, page: 1, part: 9, find: "total assets" });
  assert.equal(withPart.details.matched, true);
  const stop = await run(tool, { path: F, page: 2, find: "the of" });
  assert.match(stop.content[0].text, /^\[page 2 of 2 in filings\/a\.pdf\]\nOther page\n\[end of page 2\]$/);
});

test("read_page find: a page that is one huge line is shown whole once and does not crash", async () => {
  const r = await run(readPageTool(store(["alpha ".repeat(900)])), { path: F, page: 1, find: "alpha" });
  assert.equal(r.details.matched, true);
  assert.ok(r.content[0].text.length < 5000);
  assert.ok(pageLines("alpha ".repeat(900)).length >= 2);
});

test("read_page names pages a search listed and nobody opened; none once opened or without a search", async () => {
  const pages = Array.from({ length: 6 }, (_, i) => `Heading ${i}\nTotal widgets sold ${i}  |  ${i}00`);
  const visits = new PageVisits();
  const search = searchTool(store(pages), visits);
  const read = readPageTool(store(pages), undefined, visits);
  assert.doesNotMatch((await run(read, { path: F, page: 1 })).content[0].text, /listed by search/);
  visits.reset();
  const listed: number[] = (await run(search, { path: F, query: "total widgets sold" })).details.pages;
  const t = (await run(read, { path: F, page: listed[0] })).content[0].text;
  const m = /\[listed by search, not opened: ([^\]]*)\]/.exec(t);
  assert.ok(m);
  assert.ok(!m![1].includes(`p.${listed[0]}`) && m![1].includes(`p.${listed[1]}`));
  for (const p of listed.slice(1)) await run(read, { path: F, page: p });
  assert.doesNotMatch((await run(read, { path: F, page: listed[0] })).content[0].text, /listed by search/);
});

test("visits: opened after a whole page, a part and a passage; a passage never downgrades; a no-match is not an open; reset; one file in two spellings", () => {
  const v = new PageVisits();
  v.opened("filings/a.pdf", 3, "passage");
  assert.equal(v.state("./Filings\\A.pdf", 3), "passage");
  v.opened("filings/a.pdf", 3);
  v.opened("filings/a.pdf", 3, "passage");
  assert.equal(v.state("filings/a.pdf", 3), "opened");
  v.reset();
  assert.equal(v.state("filings/a.pdf", 3), undefined);
});

test("search marks opened and passage-read pages and lists earlier pages never opened (at most 5, not on a first search, reset per question)", async () => {
  const pages = Array.from({ length: 8 }, (_, i) => `Heading ${i}\nTotal widgets sold ${i}  |  ${i}00`);
  const visits = new PageVisits();
  const search = searchTool(store(pages), visits);
  const read = readPageTool(store(pages), undefined, visits);
  const first = await run(search, { path: F, query: "total widgets sold" });
  assert.doesNotMatch(first.content[0].text, /listed earlier/);
  const listed: number[] = first.details.pages;
  await run(read, { path: F, page: listed[0] });
  await run(read, { path: F, page: listed[1], find: "widgets" });
  const second = await run(search, { path: F, query: "heading widgets" });
  const t = second.content[0].text;
  assert.match(t, new RegExp(`page ${listed[0]} \\(opened\\)`));
  assert.match(t, new RegExp(`page ${listed[1]} \\(passage read\\)`));
  for (const m of t.matchAll(/\[listed earlier, not opened: ([^\]]*)\]/g)) {
    const ps = m[1].split(", ");
    assert.ok(ps.length <= 5);
    assert.ok(!ps.includes(`p.${listed[0]}`) && !ps.includes(`p.${listed[1]}`));
  }
  visits.reset();
  assert.doesNotMatch((await run(search, { path: F, query: "total widgets sold" })).content[0].text, /listed earlier|\(opened\)/);
});
