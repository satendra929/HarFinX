import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
import { isUnlabeledRow, markUnlabeled, NO_LABEL_MARK } from "../src/documents/pages.ts";
import { readPageTool } from "../src/tools/readPage.ts";
import { Ledger, checkText, extractNumbers, normalise } from "../src/provenance.ts";

let base: string;
let ws: Workspace;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-aids-")));
  fs.mkdirSync(path.join(base, "ws"), { recursive: true });
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(base, "ws", "a.pdf"), "fake");
  ws = openWorkspace(path.join(base, "ws"), path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

type R = { content: { text: string }[]; details: any };
const run = (tool: { execute: Function }, params: object) => tool.execute("id", params as never, undefined as never) as Promise<R>;
const store = (pages: string[]) => createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages }));

test("isUnlabeledRow: figures only, the first cell a figure; labeled rows, headings, year rows and prose are not", () => {
  assert.equal(isUnlabeledRow("3,502  |  3,017  |  (5,685)"), true);
  assert.equal(isUnlabeledRow("$1,671  |  $2,148"), true);
  assert.equal(isUnlabeledRow("12.5%  |  —  |  4.0%"), true);
  assert.equal(isUnlabeledRow("Gross margin  |  3,502  |  3,017"), false);
  assert.equal(isUnlabeledRow("2022  |  2021"), false);
  assert.equal(isUnlabeledRow("2022  |  5,000  |  4,000"), false); // led by a year
  assert.equal(isUnlabeledRow("(473)  |  note text"), false);
  assert.equal(isUnlabeledRow("3,502"), false); // no cells
  assert.equal(isUnlabeledRow("Revenue 3,502"), false);
});

test("markUnlabeled: the mark holds no digit, the line count is unchanged, labeled rows are untouched", () => {
  const lines = ["Revenue  |  10  |  9", "3,502  |  3,017", "Total  |  1  |  2"];
  const out = markUnlabeled(lines);
  assert.equal(out.length, 3);
  assert.equal(out[0], lines[0]);
  assert.equal(out[1], "3,502  |  3,017" + NO_LABEL_MARK);
  assert.ok(!/\d/.test(NO_LABEL_MARK));
});

test("read_page: an unlabeled row is marked for the model but the ledger text and row stay unmarked", async () => {
  const filler = Array.from({ length: 12 }, (_, i) => `Filler row ${i}  |  ${100 + i}  |  ${200 + i}`);
  const page = ["Statements", "Year ended  |  2022  |  2021", "Revenue  |  10,000  |  9,000", ...filler, "3,502  |  3,017", "Costs  |  (5,000)  |  (4,000)"].join("\n");
  const ledger = new Ledger();
  const fed: string[] = [];
  const tool = readPageTool(store([page]), (l, t, m) => { fed.push(t); ledger.addSource(l, t, m); });
  const r = await run(tool, { path: "a.pdf", page: 1 });
  assert.match(r.content[0].text, /3,502  \|  3,017  \[no label in the file\]\n/);
  assert.ok(!fed.join("").includes("no label"));
  const [rec] = ledger.findAll(extractNumbers(normalise("3,502"))[0]);
  assert.equal(rec.where?.row, "3,502  |  3,017");
  assert.equal(checkText("It was 3,502.", ledger)[0].cls, "S");
  const f = await run(tool, { path: "a.pdf", page: 1, find: "revenue" });
  assert.doesNotMatch(f.content[0].text, /no label/); // the row is outside the window
  const g = await run(tool, { path: "a.pdf", page: 1, find: "costs" });
  assert.match(g.content[0].text, /\[no label in the file\]/); // within three lines of the hit
});
