import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedHeader, PART_CHARS, splitPage } from "../src/documents/pages.ts";

test("a short page is one part, unchanged; an empty page has no parts", () => {
  assert.deepEqual(splitPage("a\nb\nc"), ["a\nb\nc"]);
  assert.deepEqual(splitPage(""), []);
  assert.deepEqual(splitPage("  \n \n"), []);
});

test("long pages are split only between lines, each part within the limit, nothing lost or reordered", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `Row ${i}  |  ${1000 + i}  |  ${2000 + i}`);
  const parts = splitPage(lines.join("\n"), 500);
  assert.ok(parts.length > 3);
  for (const p of parts) assert.ok(p.length <= 500, `part of ${p.length} characters`);
  assert.deepEqual(parts.join("\n").split("\n"), lines); // whole lines, same order
  for (const p of parts) for (const l of p.split("\n")) assert.match(l, /^Row \d+  \|  \d+  \|  \d+$/); // no row cut in two
});

test("a single line longer than the limit is cut at spaces rather than blowing the limit", () => {
  const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const parts = splitPage(long, 400);
  for (const p of parts) assert.ok(p.length <= 400);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long);
  assert.deepEqual(splitPage("x".repeat(1000), 400).map((p) => p.length), [400, 400, 200]); // no spaces: hard cut
});

test("the default part size leaves room under the 5,000-character result cap for a header and footer", () => {
  assert.ok(PART_CHARS + 600 < 5000);
});

test("carriedHeader finds the units line and the column-year line, in page order, each once", () => {
  const page = [
    "Table of Contents",
    "Consolidated Balance Sheets",
    "(in millions, except share and per share amounts)  |  2022  |  2021",
    "Cash and cash equivalents  |  $1,671  |  $2,148",
  ];
  assert.deepEqual(carriedHeader(page), ["(in millions, except share and per share amounts)  |  2022  |  2021"]); // one line holds both
  assert.deepEqual(carriedHeader(["Lockheed", "(in millions, except par value)", "December 31,", "2021  |  2020", "Assets"]), ["(in millions, except par value)", "2021  |  2020"]);
  assert.deepEqual(carriedHeader(["x", "(MILLIONS, EXCEPT PER SHARE DATA)  |  2023  |  2022  |  2023  |  2022"]), ["(MILLIONS, EXCEPT PER SHARE DATA)  |  2023  |  2022  |  2023  |  2022"]);
  assert.deepEqual(carriedHeader(["December 31 (Millions, except share data)  |  2022  |  2021"]), ["December 31 (Millions, except share data)  |  2022  |  2021"]);
  assert.deepEqual(carriedHeader(["(Dollars in millions, except per share data)", "Years ended December 31,  |  2022  |  2021  |  2020"]), ["(Dollars in millions, except per share data)", "Years ended December 31,  |  2022  |  2021  |  2020"]);
});

test("carriedHeader: one year cell is not a header; no units and no years gives nothing", () => {
  assert.deepEqual(carriedHeader(["Revenue  |  2022  |  5,000", "Cost of sales  |  3,000"]), []);
  assert.deepEqual(carriedHeader(["Just prose about the year 2022 and 2021."]), []);
  assert.deepEqual(carriedHeader([]), []);
});

test("carriedHeader: a boundary line such as 'Years ended December 31, | 2022 | 2021 | 2020' counts as the year line", () => {
  const found = carriedHeader(["(Dollars in millions, except per share data)", "Years ended December 31,  |  2022  |  2021  |  2020"]);
  assert.equal(found.length, 2);
  assert.match(found[1], /2022\s+\|\s+2021\s+\|\s+2020/);
});
