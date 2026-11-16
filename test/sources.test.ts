import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
import { readPageTool } from "../src/tools/readPage.ts";
import { readFileTool } from "../src/tools/readFile.ts";
import { Ledger, checkText, extractNumbers, normalise, type NumToken } from "../src/provenance.ts";
import { DISCLAIMER, DEFAULT_SOURCE_LIMITS, buildSources, cellIndex, describePositions, fileKey, formatSources, indexOfFigure, placesOf, sourcesForAudit, type SourceLimits } from "../src/sources.ts";
import { RefNumbers } from "../src/refs.ts";
import { nearestHeader, pageLines, sectionTitle, splitPage } from "../src/documents/pages.ts";

let base: string;
let ws: Workspace;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-src-")));
  const dir = path.join(base, "ws");
  fs.mkdirSync(path.join(dir, "filings"), { recursive: true });
  fs.mkdirSync(path.join(base, "project"));
  for (const f of ["filings/a.pdf", "filings/b.pdf"]) fs.writeFileSync(path.join(dir, f), "fake-" + f);
  ws = openWorkspace(dir, path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

const toks = (s: string): NumToken[] => extractNumbers(normalise(s));
/** Reads page `page` (and optional part) of a fake document through the real read_page tool, feeding the ledger exactly as the CLI does. */
async function read(ledger: Ledger, pages: string[], page: number, file = "filings/a.pdf", part?: number): Promise<void> {
  const tool = readPageTool(createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages })), (label, t, meta) => ledger.addSource(label, t, meta));
  await tool.execute("id", { path: file, page, ...(part ? { part } : {}) } as never, undefined as never);
}
/** buildSources as the engine uses it: every place of the answer's figures numbered in order, as the marks would (a large number room so the list limit is the one tested). */
function build(figures: NumToken[], inputs: NumToken[], ledger: Ledger, limits: SourceLimits = DEFAULT_SOURCE_LIMITS) {
  const refs = new RefNumbers(1000);
  for (const t of figures) placesOf(t, ledger)?.keys.forEach((k) => refs.numberOf(k));
  return buildSources(figures, inputs, ledger, refs.order, limits);
}
const cellPosition = (row: string, raw: string) => {
  const at = cellIndex(row, raw);
  return at ? describePositions([{ raw, position: at }]) : undefined;
};
const answerTokens = (answer: string, ledger: Ledger) => checkText(answer, ledger).map((c) => c.token);

const BS = ["Consolidated Balance Sheets", "(in millions)", "As of January 28, 2023  |  Jan 28, 2023  |  Jan 29, 2022", "Merchandise inventories  |  5,818  |  5,923", "Total current assets  |  19,815  |  17,504"].join("\n");

test("end to end: a figure read from a page is sourced with file, page, title, units, period, columns, row and position", async () => {
  const l = new Ledger();
  l.addUser("What are inventories?");
  await read(l, [BS], 1);
  const r = build(answerTokens("Inventories were $5,818 million.", l), [], l);
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.file, "filings/a.pdf");
  assert.equal(e.page, 1);
  assert.equal(e.title, "Consolidated Balance Sheets"); // the units and period lines are shown on their own, not in the title
  assert.equal(e.units, "(in millions)");
  assert.equal(e.period, "As of January 28, 2023  |  Jan 28, 2023  |  Jan 29, 2022");
  assert.equal(e.columns, "As of January 28, 2023  |  Jan 28, 2023  |  Jan 29, 2022"); // two date cells make it the column heading (shown verbatim, never matched to a column)
  assert.deepEqual(e.rows.map((x) => [x.row, x.figures.map((f) => f.raw), describePositions(x.figures)]), [["Merchandise inventories  |  5,818  |  5,923", ["5,818"], "1st of 2 cells"]]);
});

test("formatSources: a short heading line, the page line, then units and column headings with the figure marked under its column", async () => {
  const l = new Ledger();
  l.addUser("q");
  await read(l, [["Consolidated Balance Sheets", "(in millions)", "|  2023  |  2022", "Merchandise inventories  |  5,818  |  5,923"].join("\n")], 1);
  const lines = formatSources(build(answerTokens("Inventories: 5,818.", l), [], l));
  assert.deepEqual(lines, [
    DISCLAIMER,
    "  [S1]  filings/a.pdf  p.1  Consolidated Balance Sheets",
    "    (in millions)              2023    2022",
    "    Merchandise inventories  [5,818]  5,923",
  ]);
});

test("two figures of the answer on one row are one row with both marked; the period is shown once, the headings stay aligned", async () => {
  const l = new Ledger();
  l.addUser("q");
  await read(l, [BS], 1);
  const r = build(answerTokens("Inventories were $5,818 million, against $5,923 million before.", l), [], l);
  assert.equal(r.entries[0].rows.length, 1);
  const lines = formatSources(r);
  assert.deepEqual(lines.slice(2), [
    "    (in millions)  ·  As of January 28, 2023",
    "                              Jan 28, 2023   Jan 29, 2022",
    "    Merchandise inventories         [5,818]        [5,923]",
  ]);
  assert.equal(describePositions([{ raw: "a", position: { at: 1, of: 3 } }, { raw: "b", position: { at: 3, of: 3 } }]), "1st and 3rd of 3 cells");
  assert.equal(describePositions([{ raw: "a", position: { at: 1, of: 2 } }, { raw: "b", position: { at: 2, of: 3 } }]), "1st of 2, 2nd of 3");
  assert.equal(describePositions([{ raw: "a" }]), undefined);
});

test("units come from the nearest lines ABOVE the row, so two tables on one page are not mixed", async () => {
  const page = ["Segment results", "(in millions)", "|  2023  |  2022", "Revenue  |  9,111  |  8,000", "", "Other data", "(in thousands)", "|  2023  |  2022", "Units sold  |  7,777  |  6,000"].join("\n");
  const l = new Ledger();
  l.addUser("q");
  await read(l, [page], 1);
  const r = build(answerTokens("Revenue 9,111 and units 7,777.", l), [], l);
  const e = r.entries[0];
  assert.equal(e.units, "(in millions)"); // the entry takes the first row's units
  assert.equal(e.rows.find((x) => x.figures[0].raw === "9,111")!.units, undefined);
  assert.equal(e.rows.find((x) => x.figures[0].raw === "7,777")!.units, "(in thousands)"); // a row from another table says so
  assert.ok(formatSources(r).some((x) => x.includes("[7,777]") && x.includes("(in thousands)")));
});

test("a later part of a long page still gets its units and columns from the full page", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `Line item number ${i}  |  ${10_000 + i}  |  ${20_000 + i}`);
  const page = ["Consolidated Statements of Operations", "(in millions, except per share data)", "|  2022  |  2021", ...rows].join("\n");
  const parts = splitPage(page);
  assert.ok(parts.length >= 2);
  const l = new Ledger();
  l.addUser("q");
  await read(l, [page], 1, "filings/a.pdf", 2);
  const target = parts[1].split("\n")[3]; // some row inside part 2
  const raw = target.split("|")[1].trim();
  const r = build(answerTokens(`It was ${raw}.`, l), [], l);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].units, "(in millions, except per share data)");
  assert.equal(r.entries[0].columns, "|  2022  |  2021");
  assert.equal(r.entries[0].rows[0].row, target.trim());
});

test("part 2 and later: the hook is told where the part sits in the page, and a table that starts inside the page gets its OWN units", async () => {
  const first = Array.from({ length: 200 }, (_, i) => `Early item ${i}  |  ${10_000 + i}  |  ${20_000 + i}`);
  const second = Array.from({ length: 200 }, (_, i) => `Late item ${i}  |  ${40_000 + i}  |  ${50_000 + i}`);
  const page = ["Statements", "(in millions)", "|  2022  |  2021", ...first, "Supplemental data", "(in thousands)", "|  2022  |  2021", ...second].join("\n");
  const parts = splitPage(page);
  assert.ok(parts.length >= 3);
  const at = parts.findIndex((p) => p.includes("Late item 150  |"));
  assert.ok(at >= 1);

  const metas: { lineOffset?: number; pageLines?: readonly string[] }[] = [];
  const tool = readPageTool(createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages: [page] })), (_l, _t, meta) => metas.push(meta));
  await tool.execute("id", { path: "filings/a.pdf", page: 1, part: at + 1 } as never, undefined as never);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].pageLines![metas[0].lineOffset!], parts[at].split("\n")[0]); // the part's first line, at the offset the hook was given
  assert.equal(metas[0].lineOffset, parts.slice(0, at).reduce((n, p) => n + p.split("\n").length, 0));

  const l = new Ledger();
  l.addUser("q");
  await read(l, [page], 1, "filings/a.pdf", at + 1);
  const r = build(answerTokens("It was 40,150.", l), [], l);
  assert.equal(r.entries[0].units, "(in thousands)"); // the nearest units line above the row, not the page's first one
  assert.equal(r.entries[0].rows[0].row, "Late item 150  |  40150  |  50150");
});

test("a row with a label and one number gets no position; a row whose cells only mention years is not a column heading", () => {
  assert.equal(cellPosition("Revenue | 100 | see note", "100"), undefined);
  assert.equal(cellPosition("Revenue | 100", "100"), undefined);
  assert.equal(nearestHeader(["Revenue grew in 2022 | and again in 2023", "x | 1 | 2"], 1).columns, undefined);
  assert.equal(nearestHeader(["Note 2022 | Note 2023", "x | 1 | 2"], 1).columns, undefined);
  assert.equal(nearestHeader(["|  2022  |  2021", "x | 1 | 2"], 1).columns, "|  2022  |  2021"); // a real heading still counts
});

test("a figure the user also typed still gets its source (the user's text is recorded first and would otherwise hide the page)", async () => {
  const l = new Ledger();
  l.addUser("Is 5,818 right for inventories?");
  await read(l, [BS], 1);
  assert.equal(l.find(toks("5,818")[0])?.origin, "U");
  const r = build(answerTokens("Yes, 5,818.", l), [], l);
  assert.equal(r.entries[0].rows[0].figures[0].raw, "5,818");
});

test("calculator inputs are sourced and marked; a figure that is both stated and an input is not marked", async () => {
  const l = new Ledger();
  l.addUser("q");
  await read(l, [BS], 1);
  const r = build(answerTokens("Ratio: 19,815 / 5,818 gives 3.4 (3.41).", l), [...toks("5,818"), ...toks("19,815")], l);
  const rows = r.entries[0].rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.figures.every((f) => !f.calcInput))); // both are also stated in the answer
  const r2 = build(answerTokens("The ratio is 3.4.", l), [...toks("5,818")], l);
  assert.equal(r2.entries[0].rows[0].figures[0].calcInput, true);
  assert.ok(formatSources(r2).some((x) => x.includes("[5,818]") && x.includes("used in a calculation")));
});

test("years, list numbers, constants, unmatched figures and figures only the user wrote get no entry", async () => {
  const l = new Ledger();
  l.addUser("Compare 7,777 with the page.");
  await read(l, [BS + "\nFiscal 2023 results"], 1);
  const r = build(answerTokens("In 2023 the figure was 5,818 or 99,999 (7,777), 100%.", l), [], l);
  assert.deepEqual(r.entries.flatMap((e) => e.rows.flatMap((x) => x.figures.map((f) => f.raw))), ["5,818"]);
});

test("a figure on more than 3 pages is said, not listed", async () => {
  const l = new Ledger();
  l.addUser("q");
  for (let p = 1; p <= 5; p++) await read(l, Array.from({ length: 5 }, (_, i) => `Heading ${i}\nTotal | 4,242 | 1`), p);
  const r = build(answerTokens("It was 4,242.", l), [], l);
  assert.equal(r.entries.length, 0);
  assert.deepEqual(r.many, [{ figure: "4,242", pages: 5 }]);
  const lines = formatSources(r);
  assert.deepEqual(lines, [DISCLAIMER, "  4,242 appears on 5 pages; not listed"]);
});

test("the same figure on two rows of one page lists both rows, up to the row limit", async () => {
  const page = ["Heading", "Total revenue  |  5,000  |  1,001", "Total assets  |  5,000  |  1,002", "Total debt  |  5,000  |  1,003", "Total equity  |  5,000  |  1,004", "Total other  |  5,000  |  1,005"].join("\n");
  const l = new Ledger();
  l.addUser("q");
  await read(l, [page], 1);
  const r = build(answerTokens("5,000", l), [], l);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].rows.length, DEFAULT_SOURCE_LIMITS.rowsPerPage);
  assert.deepEqual(r.entries[0].rows.slice(0, 2).map((x) => x.row.split("|")[0].trim()), ["Total revenue", "Total assets"]);
});

test("indexOfFigure: a figure inside a longer number is not that figure", () => {
  assert.equal(indexOfFigure("Revenue | 1,250 | 250", "250"), "Revenue | 1,250 | 250".lastIndexOf("250")); // the second one
  assert.equal(indexOfFigure("Cash 12,500 then 2,500 later", "2,500"), "Cash 12,500 then 2,500 later".lastIndexOf("2,500"));
  assert.equal(indexOfFigure("Cash 12,500", "2,500"), -1);
  assert.equal(indexOfFigure("share 0.250 and 250", "250"), "share 0.250 and 250".lastIndexOf("250"));
  assert.equal(indexOfFigure("It was 5,818.", "5,818"), 7); // a full stop at the end of a sentence is not a decimal point
  assert.equal(indexOfFigure("It was 5,818.5 net", "5,818"), -1);
  assert.equal(indexOfFigure("Total (473) | 120", "(473)"), 6);
  assert.equal(indexOfFigure("Loss -473 | 120", "-473"), 5);
  assert.equal(indexOfFigure("Rate 3.06% up", "3.06%"), 5);
  assert.equal(indexOfFigure("a +b", "+"), 2); // regex characters in a figure are plain text
  assert.equal(indexOfFigure("X5818 and 5818", "5818"), 10); // not inside a code or a word (the tokenizer's rule too)
});

test("a figure that also appears inside a longer number is marked where it really is, and a Unicode minus in the row still meets the figure", () => {
  const l = new Ledger();
  l.addUser("q");
  const rows = ["Heading", "Revenue | 1,250 | 250", "Net loss | −473 | 120.5"];
  l.addSource("f p.1", rows.join("\n"), { file: "f.pdf", page: 1, pageLines: rows, lineOffset: 0 });
  const lines = formatSources(build([...toks("250"), ...toks("-473")], [], l));
  assert.deepEqual(lines.slice(2), ["    Revenue    1,250    [250]   2nd of 2 cells", "    Net loss   [-473]  120.5   1st of 2 cells"]); // each figure marked in its own cell, the unmarked cells lined up under them
});

const THREE_M = ["Disaggregated revenue information", "Year ended December 31", "(Millions)  |  2022  |  2021  |  2020", "Other Consumer  |  —  |  (1,011)  |  1", "Total Company  |  $ 34,229  |  $ 35,355  |  $ 32,184", "Worldwide  |  $ 34,229  |  $ 35,355  |  $ 32,184"];
function threeM(answer: string, opts?: Parameters<typeof formatSources>[1], limits = DEFAULT_SOURCE_LIMITS): string[] {
  const l = new Ledger();
  l.addUser("q");
  l.addSource("f p.60", THREE_M.join("\n"), { file: "3M.pdf", page: 60, printed: "60", pageLines: THREE_M, lineOffset: 0 });
  return formatSources(build(answerTokens(answer, l), [], l, limits), opts);
}

test("a units line that is also the column heading line is shown once as units, and the period once; the printed page shows only when it differs", () => {
  const lines = threeM("Net sales were $34,229 million.");
  assert.deepEqual(lines, [
    DISCLAIMER,
    "  [S1]  3M.pdf  p.60  Disaggregated revenue information",
    "    (Millions)  ·  Year ended December 31",
    "                                    2022       2021       2020",
    "    Total Company = Worldwide  [$ 34,229]  $ 35,355   $ 32,184",
  ]);
});

test("a dash cell is a cell: the column of a figure next to it is right, and the headings still line up", () => {
  const lines = threeM("Other Consumer was (1,011).");
  assert.equal(lines.at(-1), "    Other Consumer      —  [(1,011)]     1");
  assert.equal(cellPosition("Other | — | (1,011) | 1", "(1,011)"), "2nd of 3 cells");
  assert.equal(cellPosition("Other | – | 5 | 1", "1"), "3rd of 3 cells");
});

test("rows with the same figures under different labels become one row; different figures stay apart", () => {
  const lines = threeM("Sales $34,229, and 1 for other, (1,011).", undefined, { ...DEFAULT_SOURCE_LIMITS, rowsPerPage: 10 }); // merging rows does not depend on the row limit
  assert.equal(lines.filter((x) => x.includes("Total Company")).length, 1);
  assert.ok(lines.some((x) => x.includes("Total Company = Worldwide")));
  assert.ok(lines.some((x) => x.startsWith("    Other Consumer")));
});

test("the page reference can be a terminal link; a link with control characters is dropped; nothing else changes", () => {
  const plain = threeM("Net sales were $34,229 million.");
  const withLink = threeM("Net sales were $34,229 million.", { link: (f, p) => `file:///x/${f}#page=${p}` });
  assert.equal(withLink[1], "  [S1]  3M.pdf  \u001b]8;;file:///x/3M.pdf#page=60\u001b\\p.60\u001b]8;;\u001b\\  Disaggregated revenue information");
  assert.deepEqual(withLink.filter((_, i) => i !== 1), plain.filter((_, i) => i !== 1));
  assert.deepEqual(threeM("Net sales were $34,229 million.", { link: () => "file:///x\u001b[2J" }), plain);
  assert.deepEqual(threeM("Net sales were $34,229 million.", { link: () => undefined }), plain);
});

test("a heading line without a label cell (2022 | 2021) lines up over the figures, and cells that are only a currency sign are not columns", () => {
  const rows = ["Balance sheet", "2022  |  2021", "Cash  |  $  |  4,835  |  $  |  2,535", "Short-term investments  |  1,020  |  1,073"];
  const l = new Ledger();
  l.addUser("q");
  l.addSource("f p.1", rows.join("\n"), { file: "a.pdf", page: 1, pageLines: rows, lineOffset: 0 });
  const lines = formatSources(build(answerTokens("4,835 and 1,020", l), [], l));
  assert.deepEqual(lines.slice(2), ["                              2022    2021", "    Cash                    [4,835]  2,535", "    Short-term investments  [1,020]  1,073"]);
});

test("rows with a different number of cells than the headings are shown unaligned, with their position, and the headings as text", () => {
  const rows = ["Statement", "|  2022  |  2021", "Revenue  |  5,818  |  5,923  |  1,111", "Other  |  5,818  |  2"];
  const l = new Ledger();
  l.addUser("q");
  l.addSource("f p.1", rows.join("\n"), { file: "a.pdf", page: 1, pageLines: rows, lineOffset: 0 });
  const lines = formatSources(build(answerTokens("5,818", l), [], l));
  assert.deepEqual(lines.slice(2), ["    columns: 2022   2021", "    Revenue  [5,818]  5,923   1,111   1st of 3 cells", "    Other  [5,818]  2   1st of 2 cells"]);
});

test("more rows than the limit on one page: the rest are counted, not silently dropped", async () => {
  const page = ["Heading", ...Array.from({ length: 7 }, (_, i) => `Item ${i}  |  5,000  |  ${i}`)].join("\n");
  const l = new Ledger();
  l.addUser("q");
  await read(l, [page], 1);
  const lines = formatSources(build(answerTokens("5,000", l), [], l));
  assert.equal(lines.filter((x) => x.includes("[5,000]")).length, DEFAULT_SOURCE_LIMITS.rowsPerPage);
  assert.ok(lines.includes(`    and ${7 - DEFAULT_SOURCE_LIMITS.rowsPerPage} more rows`));
});

test("a text file read in overlapping chunks, or twice, lists each row once (the whole line, not a cut-off piece)", () => {
  const l = new Ledger();
  l.addUser("q");
  l.addSource("n.txt", "intro\nRevenue was 11,503 in the year and costs were 9,876 overall", { file: "n.txt" });
  l.addSource("n.txt", "costs were 9,876 overall", { file: "n.txt" }); // the next chunk starts in the middle of that line
  l.addSource("n.txt", "Revenue was 11,503 in the year and costs were 9,876 overall", { file: "n.txt" }); // read again
  const r = build(answerTokens("Revenue 11,503 and costs 9,876.", l), [], l);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].rows.length, 1);
  assert.equal(r.entries[0].rows[0].row, "Revenue was 11,503 in the year and costs were 9,876 overall");
  assert.deepEqual(r.entries[0].rows[0].figures.map((f) => f.raw).sort(), ["11,503", "9,876"]);
});

test("a cut-off chunk first and the whole line later: the whole line replaces the piece", () => {
  const l = new Ledger();
  l.addUser("q");
  l.addSource("n.txt", "costs were 9,876 overall", { file: "n.txt" }); // a chunk that starts mid-line
  l.addSource("n.txt", "Revenue was 11,503 in the year and costs were 9,876 overall", { file: "n.txt" });
  const r = build(answerTokens("9,876", l), [], l);
  assert.equal(r.entries[0].rows.length, 1);
  assert.equal(r.entries[0].rows[0].row, "Revenue was 11,503 in the year and costs were 9,876 overall");
});

test("short fragments are never taken for the same row; longer overlapping ones are", () => {
  const long = new Ledger();
  long.addUser("q");
  long.addSource("n.txt", "Cash 5,000\nCash 5,000 and more cash", { file: "n.txt" });
  assert.equal(build(answerTokens("5,000", long), [], long).entries[0].rows.length, 1); // 10 characters, inside the longer line: same row
  const short = new Ledger();
  short.addUser("q");
  short.addSource("n.txt", "A 1,234\nXA 1,234 more", { file: "n.txt" }); // "A 1,234" is 7 characters and is inside the other line, but is too short to be taken for it
  assert.equal(build(answerTokens("1,234", short), [], short).entries[0].rows.length, 2);
});

test("a failing feed never changes what a read tool returns", async () => {
  const boom = () => { throw new Error("feed failed"); };
  const pageTool = readPageTool(createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages: ["Heading\nTotal | 1,234 | 5"] })), boom);
  const r = (await pageTool.execute("id", { path: "filings/a.pdf", page: 1 } as never, undefined as never)) as { content: { text: string }[] };
  assert.match(r.content[0].text, /^\[page 1 of 1 in filings\/a\.pdf\]\nHeading\nTotal \| 1,234 \| 5\n\[end of page 1\]$/);

  fs.writeFileSync(path.join(ws.root, "feed.txt"), "Revenue 11,503\n");
  const fileTool = readFileTool(ws, boom);
  const f = (await fileTool.execute("id", { path: "feed.txt" } as never, undefined as never)) as { content: { text: string }[] };
  assert.match(f.content[0].text, /Revenue 11,503/);
});

test("entries beyond the limit are counted", async () => {
  const many = new Ledger();
  many.addUser("q");
  const pages = Array.from({ length: 9 }, (_, i) => `Heading ${i}\nItem ${i}  |  ${3000 + i}  |  1`);
  for (let p = 1; p <= 9; p++) await read(many, pages, p);
  const r2 = build(answerTokens(Array.from({ length: 9 }, (_, i) => String(3000 + i)).join(", "), many), [], many);
  assert.equal(r2.entries.length, DEFAULT_SOURCE_LIMITS.entries);
  assert.equal(r2.moreEntries, 9 - DEFAULT_SOURCE_LIMITS.entries);
  assert.equal(formatSources(r2).at(-1), `  and ${9 - DEFAULT_SOURCE_LIMITS.entries} more pages`);
});

test("one file spelled two ways is one entry", async () => {
  const l = new Ledger();
  l.addUser("q");
  await read(l, [BS], 1, "filings/a.pdf");
  await read(l, [BS], 1, "./filings/a.pdf");
  await read(l, [BS], 1, "filings\\a.pdf");
  assert.equal(fileKey("./Filings\\A.pdf"), "filings/a.pdf");
  const r = build(answerTokens("5,818", l), [], l);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].rows.length, 1);
  assert.equal(r.entries[0].file, "filings/a.pdf"); // shown as first spelled
});

test("a row with no label of its own shows the label of the line above, marked uncertain", async () => {
  const page = ["Statement", "Net revenue", "  |  8,765  |  7,654"].join("\n");
  const l = new Ledger();
  l.addUser("q");
  await read(l, [page], 1);
  const r = build(answerTokens("8,765", l), [], l);
  assert.equal(r.entries[0].rows[0].labelAbove, "Net revenue");
  assert.ok(formatSources(r).some((x) => x.includes("(? Net revenue)") && x.includes("[8,765]")));
});

test("text files: sourced by file and row, no page", () => {
  const l = new Ledger();
  l.addUser("q");
  l.addSource("notes.txt", "Net sales 11,503 11,303\nOperating income 1,306", { file: "notes.txt" });
  const r = build(answerTokens("Operating income was 1,306.", l), [], l);
  assert.equal(r.entries[0].page, undefined);
  const lines = formatSources(r);
  assert.equal(lines[1], "  [S1]  notes.txt");
  assert.equal(lines[2], "    Operating income [1,306]");
});

test("records without a recorded row (eval replay style) give no entries and no errors", () => {
  const l = new Ledger();
  l.addSource("income.txt", "Net sales 11,503");
  const r = build(answerTokens("Net sales 11,503", l), [], l);
  assert.deepEqual(r, { entries: [], many: [], moreEntries: 0 });
  assert.deepEqual(formatSources(r), []);
});

test("cellPosition: the figure's place among the row's numbers is a fact; other rows say nothing", () => {
  assert.equal(cellPosition("Revenue | 5,818 | 5,923", "5,818"), "1st of 2 cells");
  assert.equal(cellPosition("Revenue | 5,818 | 5,923", "5,923"), "2nd of 2 cells");
  assert.equal(cellPosition("Revenue | 1 | 2 | 3 | 4,444", "4,444"), "4th of 4 cells");
  assert.equal(cellPosition("Revenue | 11 | 12 | 13", "12"), "2nd of 3 cells");
  assert.equal(cellPosition("Revenue | 5,818", "5,818"), undefined); // one number: nothing to place
  assert.equal(cellPosition("Revenue was 5,818 in 2023", "5,818"), undefined); // prose
  assert.equal(cellPosition("Revenue | 5,818 | 5,923", "9,999"), undefined);
  assert.equal(cellPosition("Revenue | $ 5,818 | (203)", "(203)"), "2nd of 2 cells");
});

test("formatSources: unsafe characters in file names and rows are removed; long rows are cut around the figure; a missing figure is appended", () => {
  const l = new Ledger();
  l.addUser("q");
  const longRow = "A very long label " + "x".repeat(150) + "  |  4,321  |  1,111";
  l.addSource("a\u001b[2Jb‮.pdf p.1", "Statement\n" + longRow, { file: "a\u001b[2Jb‮.pdf", page: 1, pageLines: ["Statement", longRow], lineOffset: 1 });
  const lines = formatSources(build(answerTokens("4,321", l), [], l));
  assert.ok(lines.every((x) => !/[\u001b‮\n]/.test(x)));
  const row = lines.find((x) => x.includes("4,321"))!;
  assert.ok(row.includes("[4,321]"));
  assert.ok(row.length < 170);
  assert.ok(row.includes("…"));
});

test("sourcesForAudit: file, page, printed and the rows shown", async () => {
  const l = new Ledger();
  l.addUser("q");
  await read(l, [BS], 1);
  const a = sourcesForAudit(build(answerTokens("5,818", l), [], l));
  assert.deepEqual(a, [{ ref: 1, file: "filings/a.pdf", page: 1, printed: undefined, rows: ["Merchandise inventories | 5,818 | 5,923"] }]);
});

// ---- the page helpers ------------------------------------------------------------------------------------------------

test("nearestHeader: the closest units, year-column and period lines above the row; none are invented", () => {
  const lines = ["Heading", "(in thousands)", "|  2020  |  2019", "x | 1 | 2", "(in millions)", "Three months ended March 31, 2023", "|  2023  |  2022", "Revenue | 5 | 6"];
  assert.deepEqual(nearestHeader(lines, 7), { units: "(in millions)", columns: "|  2023  |  2022", period: "Three months ended March 31, 2023" });
  assert.deepEqual(nearestHeader(lines, 3), { units: "(in thousands)", columns: "|  2020  |  2019" });
  assert.deepEqual(nearestHeader(["Revenue | 5 | 6"], 0), {});
  assert.deepEqual(nearestHeader([], 5), {});
});

test("nearestHeader: column headings may be dates or fiscal years, not only bare years", () => {
  assert.equal(nearestHeader(["|  Jan 28, 2023  |  Jan 29, 2022", "Revenue | 5 | 6"], 1).columns, "|  Jan 28, 2023  |  Jan 29, 2022");
  assert.equal(nearestHeader(["|  January 28, 2023  |  January 29, 2022", "Revenue | 5 | 6"], 1).columns, "|  January 28, 2023  |  January 29, 2022");
  assert.equal(nearestHeader(["|  Fiscal 2023  |  Fiscal 2022", "Revenue | 5 | 6"], 1).columns, "|  Fiscal 2023  |  Fiscal 2022");
  assert.equal(nearestHeader(["|  FY2023  |  FY2022", "Revenue | 5 | 6"], 1).columns, "|  FY2023  |  FY2022");
  assert.equal(nearestHeader(["Revenue grew in 2023 and 2022 | a | b", "x | 1 | 2"], 1).columns, undefined); // prose with years is not a heading
  assert.equal(nearestHeader(["|  2023  |  note", "x | 1 | 2"], 1).columns, undefined); // needs two heading cells
});

test("nearestHeader: a row of figures is never a heading, even when its label holds heading words or its values look like years", () => {
  assert.deepEqual(nearestHeader(["Net income for the year  |  1,234  |  1,100", "Revenue | 5 | 6"], 1), {}); // "for the year" is a row label here
  assert.deepEqual(nearestHeader(["Employees  |  2015  |  2018", "Revenue | 5 | 6"], 1), {}); // years as values, not column headings
  assert.deepEqual(nearestHeader(["Quarterly dividend  |  0.51  |  0.48", "Revenue | 5 | 6"], 1), {});
  assert.deepEqual(nearestHeader(["For the year, net income  |  1,234  |  1,100", "Revenue | 5 | 6"], 1), {}); // a label that starts like a period heading, with ordinary figures
  assert.deepEqual(nearestHeader(["Sales, in millions  |  1,234  |  1,100", "Revenue | 5 | 6"], 1), {}); // a label that holds a units phrase
  // and the real headings still count
  assert.equal(nearestHeader(["(in millions)  |  2022  |  2021", "x | 1 | 2"], 1).columns, "(in millions)  |  2022  |  2021");
  assert.equal(nearestHeader(["(in millions)  |  2022  |  2021", "x | 1 | 2"], 1).units, "(in millions)  |  2022  |  2021");
  assert.equal(nearestHeader(["Year ended December 31  |  2022  |  2021", "x | 1 | 2"], 1).columns, "Year ended December 31  |  2022  |  2021");
  assert.equal(nearestHeader(["Year ended December 31  |  2022  |  2021", "x | 1 | 2"], 1).period, "Year ended December 31  |  2022  |  2021");
  assert.equal(nearestHeader(["As of January 28, 2023  |  Jan 28, 2023  |  Jan 29, 2022", "x | 1 | 2"], 1).columns, "As of January 28, 2023  |  Jan 28, 2023  |  Jan 29, 2022");
  assert.equal(nearestHeader(["Fiscal year  |  FY2023  |  FY2022", "x | 1 | 2"], 1).columns, "Fiscal year  |  FY2023  |  FY2022");
});

test("nearestHeader: the period is a heading that STARTS with a period phrase, not a wrapped row label that mentions one", () => {
  const wrapped = ["Example Holdings, Inc.","CONSOLIDATED BALANCE SHEETS", "As of December 31,", "2022  |  2021", "(In millions, except par value)", "Current assets:", "Loans and interest receivable, net of allowances of $598 and $491 as of December 31, 2022 and 2021,", "respectively  |  7,431  |  4,846", "Total current assets  |  57,517  |  52,574"];
  assert.deepEqual(nearestHeader(wrapped, 8), { period: "As of December 31,", columns: "2022  |  2021", units: "(In millions, except par value)" });
  for (const p of ["As of January 28, 2023", "Year ended December 31", "For the year ended June 30, 2023", "Three Months Ended March 31, 2023", "Nine months ended September 30", "Fiscal year ended January 28, 2023", "At December 31, 2022", "52 weeks ended January 1"]) {
    assert.equal(nearestHeader([p, "Revenue | 5 | 6"], 1).period, p, p);
  }
  for (const notPeriod of ["Revenue grew as of the end of the year", "Interest paid for the quarter was low", "Balance at the period ended", "respectively, as of December 31, 2022 and 2021"]) {
    assert.equal(nearestHeader([notPeriod, "Revenue | 5 | 6"], 1).period, undefined, notPeriod);
  }
});

test("nearestHeader: a long prose sentence is not taken as the period line", () => {
  const prose = "The Company's fiscal year ended on December 31 and the results for the period are discussed in the following pages in detail, including the segments.";
  assert.deepEqual(nearestHeader([prose, "Revenue | 5 | 6"], 1), {});
});

test("sectionTitle: the last two headings above the first table row; for prose its first two headings; none invented", () => {
  assert.equal(sectionTitle(["Table of Contents", "AMAZON.COM, INC.", "CONSOLIDATED BALANCE SHEETS", "(in millions, except per share data)", "|  2019  |  2018", "Cash  |  1  |  2"]), "AMAZON.COM, INC. / CONSOLIDATED BALANCE SHEETS");
  assert.equal(sectionTitle(["Item 7. Management's Discussion", "Overview", "Net sales grew because demand rose for products and services in all segments."]), "Item 7. Management's Discussion / Overview");
  assert.equal(sectionTitle(["Company", "Statement A", "Statement B", "Statement C", "|  2020  |  2019", "x | 1 | 2"]), "Statement B / Statement C");
  assert.equal(sectionTitle(["(in millions)", "As of December 31, 2022", "|  2022  |  2021", "x | 1 | 2"]), undefined);
  assert.equal(sectionTitle([]), undefined);
  assert.equal(sectionTitle(["12", "| 1 | 2"]), undefined);
});

test("pageLines is the very list splitPage cuts into parts, so a part's lines sit at a known offset", () => {
  const text = Array.from({ length: 400 }, (_, i) => `Row ${i} | ${i} | ${i * 2}`).join("\n") + "\n" + "w ".repeat(3000);
  const all = pageLines(text);
  const parts = splitPage(text);
  assert.equal(parts.map((p) => p.split("\n").length).reduce((a, b) => a + b, 0), all.length);
  assert.equal(parts.join("\n"), all.join("\n"));
});
