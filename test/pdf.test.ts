import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePdf, PdfError } from "../src/documents/pdf.ts";
import { makePdf } from "./fixtures/makePdf.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url);
const rejectsWith = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof PdfError, `expected a PdfError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (message) assert.match(e.message, message);
    return true;
  });
};

// A balance-sheet-like page: the label of the last row sits 0.64 pt below its values (the real split-row case).
const balanceSheet = makePdf([
  [
    { x: 50, y: 700, text: "(in millions)" },
    { x: 400, y: 700, text: "2022" },
    { x: 480, y: 700, text: "2021" },
    { x: 50, y: 680, text: "Total current assets" },
    { x: 400, y: 680, text: "7,453" },
    { x: 480, y: 680, text: "7,659" },
    { x: 50, y: 600, text: "Other accrued liabilities (Notes 10 and 13)" },
    { x: 400, y: 600.64, text: "3,147" },
    { x: 480, y: 600.64, text: "3,139" },
  ],
  [{ x: 50, y: 700, text: "Second page: Total current liabilities" }, { x: 400, y: 700, text: "5,175" }],
]);

test("parses a text PDF into one text per page, with table rows rebuilt", async () => {
  const { pages } = await parsePdf(balanceSheet);
  assert.equal(pages.length, 2);
  const lines = pages[0].split("\n");
  assert.deepEqual(lines[0].split(/\s*\|\s*/), ["(in millions)", "2022", "2021"]);
  assert.deepEqual(lines[1].split(/\s*\|\s*/), ["Total current assets", "7,453", "7,659"]);
  assert.deepEqual(lines[2].split(/\s*\|\s*/), ["Other accrued liabilities (Notes 10 and 13)", "3,147", "3,139"]); // label and values stayed together
  assert.match(pages[1], /Total current liabilities\s+\|\s+5,175/);
});

test("the caller's buffer is left usable (the worker gets a copy)", async () => {
  const bytes = new Uint8Array(balanceSheet);
  await parsePdf(bytes);
  assert.ok(bytes.length > 0 && bytes[0] === 0x25); // still "%PDF"
});

test("not a PDF, and a PDF cut short, give a friendly 'not readable' error without echoing file content", async () => {
  await rejectsWith(parsePdf(Buffer.from("this is just text, SECRET-MARKER")), "invalid", /not a readable PDF/);
  await assert.rejects(parsePdf(Buffer.from("this is just text, SECRET-MARKER")), (e: Error) => !e.message.includes("SECRET-MARKER"));
  await rejectsWith(parsePdf(balanceSheet.subarray(0, 120)), "invalid");
});

test("a PDF with no text on its pages is reported as scanned, not returned as empty pages", async () => {
  await rejectsWith(parsePdf(makePdf([[], [], []])), "no_text", /no text layer.*scanned/i);
});

test("limits: pages, characters per page, characters per document", async () => {
  await rejectsWith(parsePdf(balanceSheet, { maxPages: 1 }), "too_many_pages", /2 pages; the limit is 1/);
  const cut = await parsePdf(balanceSheet, { maxPageChars: 30 });
  assert.match(cut.pages[0], /\[page text cut at 30 characters\]$/);
  await rejectsWith(parsePdf(balanceSheet, { maxTotalChars: 50 }), "too_much_text");
});

test("a worker that never finishes is stopped at the time limit, and the session carries on", async () => {
  const started = Date.now();
  await rejectsWith(parsePdf(balanceSheet, { workerUrl: fixture("hangWorker"), timeoutMs: 400 }), "timeout", /took longer than/);
  assert.ok(Date.now() - started < 5000, "the hung worker must be terminated, not waited for");
  const again = await parsePdf(balanceSheet); // an ordinary parse still works afterwards
  assert.equal(again.pages.length, 2);
});

test("a worker that exhausts its memory limit fails that parse only", async () => {
  // With a 32 MB limit the worker dies at once; the short time limit means a limit that is not applied would show as
  // "timeout" instead of "memory".
  await rejectsWith(parsePdf(balanceSheet, { workerUrl: fixture("oomWorker"), memoryMb: 32, timeoutMs: 3000 }), "memory", /too much memory/);
});

test("a worker that answers nonsense or exits without a result is a clean failure", async () => {
  await rejectsWith(parsePdf(balanceSheet, { workerUrl: fixture("garbageWorker"), timeoutMs: 5000 }), "failed", /could not be read/);
  await rejectsWith(parsePdf(balanceSheet, { workerUrl: fixture("exitWorker"), timeoutMs: 5000 }), "failed");
});

test("an aborted signal stops the parse, before or during", async () => {
  const done = new AbortController();
  done.abort();
  await rejectsWith(parsePdf(balanceSheet, { signal: done.signal }), "aborted");
  const ac = new AbortController();
  const p = parsePdf(balanceSheet, { workerUrl: fixture("hangWorker"), timeoutMs: 20_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await rejectsWith(p, "aborted");
});
