import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
import { searchTool } from "../src/tools/search.ts";
import { humanSize, listFilesTool } from "../src/tools/listFiles.ts";
import { makePdf } from "./fixtures/makePdf.ts";

let base: string;
let ws: Workspace;
let empty: Workspace;

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-tools-")));
  const dir = path.join(base, "ws");
  fs.mkdirSync(path.join(dir, "filings"), { recursive: true });
  fs.mkdirSync(path.join(base, "empty"));
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(dir, "filings", "ACME_2022_10K.pdf"), "fake");
  fs.writeFileSync(path.join(dir, "notes.txt"), "plain");
  fs.writeFileSync(
    path.join(dir, "real.pdf"),
    makePdf([
      [{ x: 50, y: 700, text: "Risk factors and prose about liabilities" }],
      [{ x: 50, y: 700, text: "Consolidated Balance Sheets" }, { x: 50, y: 680, text: "Total current liabilities" }, { x: 400, y: 680, text: "5,175" }],
    ]),
  );
  ws = openWorkspace(dir, path.join(base, "project"), []);
  empty = openWorkspace(path.join(base, "empty"), path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

type R = { content: { text: string }[]; details: any };
const run = (tool: { execute: Function }, params: object) => tool.execute("id", params as never, undefined as never) as Promise<R>;
const PAGES = [
  "Management discussion\nThe consolidated balance sheets are discussed in many places; consolidated balance sheets again.",
  "ACME Corp\nConsolidated Balance Sheets\nTotal current assets  |  19,815\nTotal current liabilities  |  13,997",
  "ACME Corp\nConsolidated Statements of Operations\nNet revenue  |  23,601",
];
let parses = 0;
const fakeStore = () => createDocStore(ws, async (): Promise<ParsedPdf> => (parses++, { pages: PAGES }));

test("search: pages ranked, each with page number, title and the best line; a pointer to read_page", async () => {
  const r = await run(searchTool(fakeStore()), { path: "filings/ACME_2022_10K.pdf", query: "total current liabilities" });
  const t = r.content[0].text;
  assert.match(t, /^\[search "total current liabilities" in filings\/ACME_2022_10K\.pdf \(3 pages\)\]\npage 2: ACME Corp \/ Consolidated Balance Sheets \/ Total current assets\n  Total current liabilities  \|  13,997\n/);
  assert.match(t, /\[read a page with read_page\(path, page\)\]$/);
  assert.equal(r.details.pages[0], 2);
  assert.ok(t.length < 2000);
});

test("search: the index is built once per document, however many searches", async () => {
  parses = 0;
  const tool = searchTool(fakeStore());
  for (const q of ["revenue", "balance sheets", "current"]) await run(tool, { path: "filings/ACME_2022_10K.pdf", query: q });
  assert.equal(parses, 1);
});

test("search: no match says so and suggests what to try; bad input is refused with a usable message", async () => {
  const tool = searchTool(fakeStore());
  const none = await run(tool, { path: "filings/ACME_2022_10K.pdf", query: "zebra" });
  assert.match(none.content[0].text, /No page matches\. Try other words, such as a row label or a statement name\./);
  await assert.rejects(run(tool, { path: "notes.txt", query: "x" }), /search works on PDF files/);
  await assert.rejects(run(tool, { path: "filings/ACME_2022_10K.pdf", query: "   " }), /give a few words/);
  await assert.rejects(run(tool, { path: "filings/ACME_2022_10K.pdf" }), /give a few words/);
  await assert.rejects(run(tool, { path: "../outside.pdf", query: "x" }), /not found or not allowed/);
});

test("search: a very long query is cut, and whitespace is tidied in the echo", async () => {
  const r = await run(searchTool(fakeStore()), { path: "filings/ACME_2022_10K.pdf", query: "revenue\n\n  " + "x".repeat(500) });
  const echo = r.content[0].text.split("\n")[0];
  assert.ok(echo.length < 300);
  assert.doesNotMatch(echo, /\n/);
});

test("search: end to end on a real PDF through the worker", async () => {
  const r = await run(searchTool(createDocStore(ws)), { path: "real.pdf", query: "total current liabilities" });
  assert.match(r.content[0].text, /^\[search .* \(2 pages\)\]\npage 2: Consolidated Balance Sheets/);
});

test("list_files: paths and readable sizes, sorted; an empty workspace says so", async () => {
  const r = await run(listFilesTool(ws), {});
  assert.match(r.content[0].text, /^\[3 files in the workspace\]\nfilings\/ACME_2022_10K\.pdf  \(4 B\)\nnotes\.txt  \(5 B\)\nreal\.pdf  \(\d+ (B|KB)\)$/);
  assert.equal((await run(listFilesTool(empty), {})).content[0].text, "[the workspace folder has no files]");
});

test("humanSize", () => {
  assert.equal(humanSize(5), "5 B");
  assert.equal(humanSize(2048), "2 KB");
  assert.equal(humanSize(5 * 1024 * 1024 + 100), "5.0 MB");
});

test("search: instruction sentences and date markers in the query do not pull in decoy pages (the tool cleans the query)", async () => {
  const pages = [
    "Notes on presentation\nRevenue as a percentage, in USD millions, rounded to two decimals; USD millions again; percentage of revenue, USD millions.",
    "ACME Corp\nConsolidated Balance Sheets\nTotal current liabilities  |  13,997  |  13,933",
    "Other\nUnrelated text about properties",
  ];
  const tool = searchTool(createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages })));
  const asked = "What were total current liabilities in FY2022? Answer in USD millions, rounded to two decimals as a percentage of revenue.";
  const r = await run(tool, { path: "filings/ACME_2022_10K.pdf", query: asked });
  assert.equal(r.details.pages[0], 2);
  assert.ok(r.content[0].text.startsWith(`[search "${asked}" in`)); // the echo keeps what the model asked
});
