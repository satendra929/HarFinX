import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
import { outlineTool } from "../src/tools/outline.ts";
import { searchTool } from "../src/tools/search.ts";
import { buildOutline } from "../src/documents/outline.ts";
import { outlineResultLine, toolLine } from "../src/feedback.ts";
import { checkText, Ledger } from "../src/provenance.ts";

let base: string;
let ws: Workspace;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-outline-")));
  fs.mkdirSync(path.join(base, "ws"), { recursive: true });
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(base, "ws", "f.pdf"), "fake");
  fs.writeFileSync(path.join(base, "ws", "n.txt"), "x");
  ws = openWorkspace(path.join(base, "ws"), path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

type R = { content: { text: string }[]; details: any };
const run = (tool: { execute: Function }, params: object) => tool.execute("id", params as never, undefined as never) as Promise<R>;
const prose = (n = 12) => Array.from({ length: n }, (_, i) => `Sentence ${i} about impairment charges and the business.`).join("\n");
// a fresh page array per test: the outline is remembered per array
const filing = (): string[] => {
  const p = Array.from({ length: 12 }, () => prose());
  p[0] = `Item 1. Business\n${prose()}`;
  p[3] = `Item 1A. Risk Factors\n${prose()}\nGoodwill impairment risk is described here`;
  p[6] = `Item 7. Management's Discussion\n${prose()}\nImpairment of goodwill was recorded`;
  p[9] = `Item 9. Controls\n${prose()}`;
  return p;
};
const store = (pages: string[]) => createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages }));

test("outline tool: the map as text, details for the audit log, only PDFs", async () => {
  const r = await run(outlineTool(store(filing())), { path: "f.pdf" });
  assert.match(r.content[0].text, /^\[outline of f\.pdf, pages 1-12; p\. is the page of the file\]\nItem 1 Business p\.1-3\nItem 1A Risk Factors p\.4-6\nItem 7 Management's Discussion p\.7-9\nItem 9 Controls p\.10-12\n/);
  assert.deepEqual(r.details, { path: "f.pdf", pages: 12, items: 4, statements: 0, notes: 0, contentsPages: [], found: true });
  await assert.rejects(run(outlineTool(store(filing())), { path: "n.txt" }), /outline works on PDF files/);
  const none = await run(outlineTool(store(Array.from({ length: 4 }, () => prose()))), { path: "f.pdf" });
  assert.match(none.content[0].text, /No outline found/);
  assert.equal(none.details.found, false);
});

test("outline tool: a builder that throws gives 'No outline found', not an error", async () => {
  const r = await run(outlineTool(store(filing()), () => { throw new Error("boom"); }), { path: "f.pdf" });
  assert.match(r.content[0].text, /No outline found/);
});

test("outline is not a source: its text holds no figure that traces, and a figure echoed from it is untraced", async () => {
  const r = await run(outlineTool(store(filing())), { path: "f.pdf" });
  assert.ok(r.content[0].text.length < 2300);
  assert.equal(checkText("Item 15 lists the exhibits.", new Ledger()).some((c) => c.cls === "X"), true); // pinned: today's behaviour for "Item 15"
});

test("search section: only pages inside the section are ranked; the head line names it; ids, titles and misses", async () => {
  const pages = filing();
  const tool = searchTool(store(pages));
  const all = await run(tool, { path: "f.pdf", query: "impairment" });
  assert.equal(all.content[0].text.split("\n")[0], '[search "impairment" in f.pdf (12 pages)]');
  const sec = await run(tool, { path: "f.pdf", query: "impairment", section: "Item 7" });
  assert.equal(sec.content[0].text.split("\n")[0], '[search "impairment" in f.pdf (12 pages), section Item 7 p.7-9]');
  assert.ok(sec.details.pages.every((p: number) => p >= 7 && p <= 9));
  assert.equal(sec.details.sectionFound, true);
  assert.deepEqual(sec.details.range, { from: 7, to: 9 });
  const byTitle = await run(tool, { path: "f.pdf", query: "impairment", section: "risk factors" });
  assert.match(byTitle.content[0].text, /section Item 1A p\.4-6\]/);
  const dot = await run(tool, { path: "f.pdf", query: "impairment", section: "item 7." });
  assert.match(dot.content[0].text, /section Item 7 p\.7-9\]/);
  const miss = await run(tool, { path: "f.pdf", query: "impairment", section: "MDA" });
  assert.equal(miss.content[0].text.split("\n")[0], '[search "impairment" in f.pdf (12 pages); section "MDA" not found, whole file searched]');
  assert.equal(miss.details.sectionFound, false);
  assert.equal(miss.details.pages.length, all.details.pages.length);
});

test("search without section never builds an outline and prints what it printed before; with one, the outline is built once", async () => {
  const pages = filing();
  let builds = 0;
  const counting = (p: readonly string[]) => (builds++, buildOutline(p));
  const tool = searchTool(store(pages), undefined, counting);
  await run(tool, { path: "f.pdf", query: "impairment" });
  await run(tool, { path: "f.pdf", query: "goodwill", section: "" });
  assert.equal(builds, 0);
  await run(tool, { path: "f.pdf", query: "impairment", section: "Item 7" });
  assert.equal(builds, 1);
});

test("feedback: the outline and section lines", () => {
  assert.equal(toolLine("outline", { path: "filings/a.pdf" }, 1, 8).includes("outline of filings/a.pdf"), true);
  assert.match(toolLine("search", { path: "a.pdf", query: "debt", section: "Item 7" }, 1, 8), /\(section Item 7\)/);
  assert.equal(outlineResultLine({ found: true, items: 21, statements: 4, notes: 11 }), "  → 21 Items, 4 statements, 11 Notes");
  assert.equal(outlineResultLine({ found: false }), "  → no outline found");
  assert.equal(outlineResultLine(undefined), undefined);
});
