import { test } from "node:test";
import assert from "node:assert/strict";
import { callKey } from "../src/callKey.ts";

const s = (query: string, extra: object = {}) => callKey("search", { path: "a.pdf", query, ...extra });

test("search: capitals and spacing do not make a new call", () => {
  assert.equal(s("total net sales 2022"), s("Total Net Sales 2022"));
  assert.equal(s("total net sales"), s("total   net  sales"));
});

test("search: word order and a repeated word do, because the tool ranks side-by-side words in the order typed", () => {
  assert.notEqual(s("net sales total"), s("total net sales"));
  assert.notEqual(s("net sales net sales"), s("net sales"));
  assert.notEqual(s("cash equivalents"), s("cash and cash equivalents")); // a refinement is a new search
});

test("search: another file, section or word is another call; a path spelled two ways is one file", () => {
  assert.notEqual(s("net sales"), callKey("search", { path: "b.pdf", query: "net sales" }));
  assert.notEqual(s("net sales"), s("net sales", { section: "Item 7" }));
  assert.equal(s("net sales", { section: "Item 7" }), s("net sales", { section: " item  7 " }));
  assert.notEqual(s("net sales"), s("net income"));
  assert.equal(s("net sales"), s("net sales 2022")); // the search tool drops a year before it searches, so these are one search
  assert.equal(callKey("search", { path: "./Filings\\A.pdf", query: "x1" }), callKey("search", { path: "filings/a.pdf", query: "x1" }));
});

test("read_page: the same file, page, part and find is one call; any difference is another", () => {
  const r = (a: object) => callKey("read_page", { path: "a.pdf", ...a });
  assert.equal(r({ page: 5 }), r({ page: 5, part: 1 }));
  assert.equal(r({ page: 5 }), r({ page: "5" }));
  assert.notEqual(r({ page: 5 }), r({ page: 6 }));
  assert.notEqual(r({ page: 5 }), r({ page: 5, part: 2 }));
  assert.notEqual(r({ page: 5 }), r({ page: 5, find: "net income" }));
  assert.equal(r({ page: 5, find: "Net income" }), r({ page: 5, find: "net  income" }));
  assert.notEqual(callKey("read_page", { path: "b.pdf", page: 5 }), r({ page: 5 }));
});

test("other tools: the same arguments are one call; calculate and odd arguments have no key", () => {
  assert.equal(callKey("outline", { path: "a.pdf" }), callKey("outline", { path: "A.pdf" }));
  assert.notEqual(callKey("outline", { path: "a.pdf" }), callKey("outline", { path: "b.pdf" }));
  assert.equal(callKey("list_files", {}), callKey("list_files", {}));
  assert.notEqual(callKey("outline", { path: "a.pdf" }), callKey("list_files", { path: "a.pdf" }));
  assert.equal(callKey("calculate", { inputs: { a: "1" }, expr: "a" }), undefined);
  assert.equal(callKey("search", undefined), undefined);
  assert.equal(callKey("search", "text"), undefined);
  assert.equal(callKey("search", [1]), undefined);
});
