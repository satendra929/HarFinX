import { test } from "node:test";
import assert from "node:assert/strict";
import { printedCandidates, printedLabelOf, printedLabels } from "../src/documents/printed.ts";

/** A filing of `n` pages whose page i (file position) prints i - offset at its foot, for pages after the front matter. */
const filing = (n: number, offset: number, front = offset): string[] =>
  Array.from({ length: n }, (_, i) => {
    const pageNo = i + 1;
    const body = `Heading ${pageNo}\nSome text | 1 | 2\nMore text on the page`;
    return pageNo > front ? `${body}\n${pageNo - offset}` : body; // the cover and contents print no number
  });

test("printedCandidates: bare numbers or 'Page N' among the first and last lines; table rows and years-in-text are not", () => {
  assert.deepEqual(printedCandidates("Text\nTotal | 81\n54"), [54]);
  assert.deepEqual(printedCandidates("Page 12\nBody\nBody 2\nBody 3\nBody 4"), [12]);
  assert.deepEqual(printedCandidates("Body\n\n  54  \n"), [54]);
  assert.deepEqual(printedCandidates("a\nb\nc\nd\n5\ne\nf\ng"), []); // a number in the middle of the page is not a page number
  assert.deepEqual(printedCandidates("Total | 81"), []);
  assert.deepEqual(printedCandidates("Revenue grew 12%\nPage 12 of 140"), []);
  assert.deepEqual(printedCandidates("0\n00"), []);
  assert.deepEqual(printedCandidates("12345"), []); // five digits is not a page number
});

test("printedLabels: a steady offset gives each numbered page its printed number; the front matter gets none", () => {
  const labels = printedLabels(filing(40, 2));
  assert.equal(labels[0], undefined);
  assert.equal(labels[1], undefined);
  assert.equal(labels[2], "1"); // file page 3 prints 1
  assert.equal(labels[67 - 40 + 39], undefined); // out of range stays undefined
  assert.equal(labels[39], "38");
});

test("printedLabels: a footnote number alone on a line does not hide the real page number", () => {
  const pages = filing(30, 2);
  pages[19] = pages[19].replace(/\n(\d+)$/, "\n1\n$1"); // a footnote '1' above the real number (file page 20 prints 18)
  const labels = printedLabels(pages);
  assert.equal(labels[19], "18");
});

test("printedLabels: pages that restart the numbering (an appendix) get none while the main body keeps its labels", () => {
  const pages = filing(60, 2);
  for (let i = 45; i < 60; i++) pages[i] = pages[i].replace(/\n\d+$/, `\n${i - 44}`); // numbering restarts at 1
  const labels = printedLabels(pages);
  assert.equal(labels[10], "9");
  assert.equal(labels[44], "43");
  assert.equal(labels[50], undefined);
});

test("printedLabels: nothing when too few pages show a number, or when two numberings are about equally common", () => {
  assert.ok(printedLabels(filing(4, 1)).every((x) => x === undefined)); // fewer than 5 numbered pages
  const mixed = [...filing(12, 2), ...filing(12, 2).map((p, i) => p.replace(/\n\d+$/, `\n${i + 1 + 3}`))]; // second half shifted: two offsets, equally common
  assert.ok(printedLabels(mixed).every((x) => x === undefined));
  assert.ok(printedLabels([]).length === 0);
});

test("printedLabels: random numbers at page feet give no consensus, so no labels", () => {
  const pages = Array.from({ length: 30 }, (_, i) => `Heading\nbody\n${(i * 7) % 90 + 1}`);
  assert.ok(printedLabels(pages).every((x) => x === undefined));
});

test("printedLabels: a number printed at the head of the page counts too", () => {
  const pages = Array.from({ length: 20 }, (_, i) => `${i + 1 - 3 > 0 ? i + 1 - 3 : "Cover"}\nBody text\nMore text\nEven more`);
  const labels = printedLabels(pages);
  assert.equal(labels[9], "7");
});

test("printedLabelOf: by file page (from 1), computed once per document", () => {
  const pages = filing(30, 2);
  assert.equal(printedLabelOf(pages, 10), "8");
  assert.equal(printedLabelOf(pages, 1), undefined);
  assert.equal(printedLabelOf(pages, 31), undefined);
  assert.equal(printedLabelOf(pages, 0), undefined);
  assert.equal(printedLabelOf(filing(30, 5), 10), "5"); // another document: its own offset
});
