import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import { PdfError, type ParsedPdf } from "../src/documents/pdf.ts";
import { readPageTool } from "../src/tools/readPage.ts";
import { readFileTool } from "../src/tools/readFile.ts";
import { makePdf } from "./fixtures/makePdf.ts";

let base: string;
let ws: Workspace;

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-page-")));
  const dir = path.join(base, "ws");
  fs.mkdirSync(path.join(dir, "filings"), { recursive: true });
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(dir, "filings", "a.pdf"), "fake-a");
  fs.writeFileSync(path.join(dir, "notes.txt"), "plain text");
  fs.writeFileSync(path.join(dir, "real.pdf"), makePdf([[{ x: 50, y: 700, text: "Total current assets" }, { x: 400, y: 700, text: "7,453" }, { x: 480, y: 700, text: "7,659" }], []]));
  ws = openWorkspace(dir, path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

const run = (tool: ReturnType<typeof readPageTool>, params: object) => tool.execute("id", params as never, undefined as never) as Promise<{ content: { text: string }[]; details: any }>;
const toolFor = (pages: string[], shown: [string, string][] = []) => readPageTool(createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages })), (l, t) => shown.push([l, t]));

const statement = (rows: number) => [
  "Consolidated Balance Sheets",
  "(in millions, except per share data)  |  2022  |  2021",
  ...Array.from({ length: rows }, (_, i) => `Line item number ${i}  |  ${10_000 + i}  |  ${20_000 + i}`),
].join("\n");

test("one short page: header, the text, an end marker; the ledger gets the page text only", async () => {
  const shown: [string, string][] = [];
  const r = await run(toolFor(["page one", "Total current assets  |  7,453  |  7,659"], shown), { path: "filings/a.pdf", page: 2 });
  assert.equal(r.content[0].text, "[page 2 of 2 in filings/a.pdf]\nTotal current assets  |  7,453  |  7,659\n[end of page 2]");
  assert.deepEqual(shown, [["filings/a.pdf p.2", "Total current assets  |  7,453  |  7,659"]]); // no header or footer text in the ledger
  assert.deepEqual(r.details, { path: "filings/a.pdf", page: 2, part: 1, parts: 1, pages: 2 });
});

test("a long page comes in parts that never cut a row; later parts repeat the units and year header", async () => {
  const shown: [string, string][] = [];
  const tool = toolFor([statement(300)], shown);
  const first = await run(tool, { path: "filings/a.pdf", page: 1 });
  assert.match(first.content[0].text, /\[page 1, part 1 of \d+; call read_page again with part=2 for the rest\]$/);
  assert.doesNotMatch(first.content[0].text, /repeated from the top/);
  const second = await run(tool, { path: "filings/a.pdf", page: 1, part: 2 });
  const t = second.content[0].text;
  assert.match(t, /^\[page 1 of 1 in filings\/a\.pdf\]\n\[repeated from the top of the page\]\n\(in millions, except per share data\)  \|  2022  \|  2021\nLine item number /);
  assert.match(t, /\[page 1, part 2 of \d+; call read_page again with part=3 for the rest\]$/);
  for (const [, body] of shown) for (const line of body.split("\n")) assert.match(line, /^(Consolidated Balance Sheets|\(in millions.*|Line item number \d+  \|  \d+  \|  \d+)$/); // whole rows only
  assert.ok(first.content[0].text.length < 5000 && t.length < 5000, "every result stays under the guard's per-result cap");
  // read on to the end: the parts together hold every row exactly once
  let last = t;
  for (let part = 3; /call read_page again/.test(last); part++) last = (await run(tool, { path: "filings/a.pdf", page: 1, part })).content[0].text;
  assert.match(last, /\[end of page 1, part \d+ of \d+\]$/);
  const rows = shown.flatMap(([, b]) => b.split("\n")).filter((l) => l.startsWith("Line item"));
  assert.equal(rows.length, 300);
  assert.equal(new Set(rows).size, 300);
});

test("the worst real page size (6,600 characters of rows) still gives results under 5,000 characters", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => `Operating item ${i} with a longer label for realism  |  ${i * 7},${100 + i}  |  ${i * 5},${200 + i}`);
  const tool = toolFor([`(in millions)  |  2022  |  2021\n${rows.join("\n")}`.slice(0, 6600)]);
  for (const part of [1, 2]) assert.ok((await run(tool, { path: "filings/a.pdf", page: 1, part })).content[0].text.length < 5000);
});

test("errors the model can act on: page out of range, bad numbers, no such part, a text file, an empty page", async () => {
  const tool = toolFor(["one", ""]);
  await assert.rejects(run(tool, { path: "filings/a.pdf", page: 3 }), /page 3 is not in this file: it has 2 pages/);
  await assert.rejects(run(tool, { path: "filings/a.pdf", page: 0 }), /whole number, 1 or more/);
  await assert.rejects(run(tool, { path: "filings/a.pdf", page: 1.5 }), /whole number/);
  await assert.rejects(run(tool, { path: "filings/a.pdf", page: 1, part: 2 }), /page 1 has 1 part; there is no part 2/);
  await assert.rejects(run(tool, { path: "notes.txt", page: 1 }), /read_page reads PDF files; use read_file/);
  await assert.rejects(run(tool, { path: undefined, page: 1 }), /read_page reads PDF files/);
  const empty = await run(tool, { path: "filings/a.pdf", page: 2 });
  assert.equal(empty.content[0].text, "[page 2 of 2 in filings/a.pdf]\n[this page has no text: it may be blank or an image]");
});

test("the workspace still decides which files exist: traversal, missing and outside paths are refused", async () => {
  const tool = toolFor(["x"]);
  for (const p of ["../x.pdf", "missing.pdf", "C:\\Windows\\x.pdf", "..\\ws\\filings\\a.pdf"]) await assert.rejects(run(tool, { path: p, page: 1 }), /not found or not allowed/);
});

test("a PDF problem reaches the model as the parser's friendly message", async () => {
  const tool = readPageTool(createDocStore(ws, async () => { throw new PdfError("no_text", "This PDF has no text layer (it looks scanned). Scanned PDFs are not supported yet."); }));
  await assert.rejects(run(tool, { path: "filings/a.pdf", page: 1 }), /no text layer.*scanned/i);
});

test("end to end with a real PDF through the worker: the page text and its row layout", async () => {
  const tool = readPageTool(createDocStore(ws));
  const r = await run(tool, { path: "real.pdf", page: 1 });
  assert.match(r.content[0].text, /^\[page 1 of 2 in real\.pdf\]\nTotal current assets\s+\|\s+7,453\s+\|\s+7,659\n\[end of page 1\]$/);
  const blank = await run(tool, { path: "real.pdf", page: 2 });
  assert.match(blank.content[0].text, /this page has no text/);
});

test("read_file points to read_page for a PDF, before any size or binary check", async () => {
  const tool = readFileTool(ws);
  await assert.rejects(tool.execute("id", { path: "real.pdf" } as never, undefined as never), /this is a PDF: use read_page/);
  await assert.rejects(tool.execute("id", { path: "UPPER.PDF" } as never, undefined as never), /this is a PDF: use read_page/);
  const ok = (await tool.execute("id", { path: "notes.txt" } as never, undefined as never)) as { content: { text: string }[] };
  assert.match(ok.content[0].text, /^plain text/);
});
