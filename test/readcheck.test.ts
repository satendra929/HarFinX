import { test } from "node:test";
import assert from "node:assert/strict";
import { PageVisits } from "../src/documents/visits.ts";
import { isShortAnswer, readMessage, searchMessage, SHORT_ANSWER_WORDS } from "../src/readcheck.ts";
import { answerShape } from "../src/shape.ts";
import { DEFAULT_READ_MIN_PAGES, parseReadMinPages } from "../src/config.ts";

test("thin: fewer looked-at pages than the minimum names the next listed pages in rank order", () => {
  const v = new PageVisits();
  v.listed("a.pdf", [27, 25, 33, 20, 30]);
  v.opened("a.pdf", 27);
  const t = v.thin(3)!;
  assert.equal(t.file, "a.pdf");
  assert.equal(t.looked, 1);
  assert.deepEqual(t.missing, [25, 33]);
});

test("thin: a passage and a part of a page each count once; enough pages means nothing to ask", () => {
  const v = new PageVisits();
  v.listed("a.pdf", [27, 25, 33, 20]);
  v.opened("a.pdf", 27);
  v.opened("a.pdf", 27); // the second part of the same page is not another page
  assert.equal(v.looked("a.pdf"), 1);
  v.opened("a.pdf", 25, "passage");
  v.opened("a.pdf", 99); // a page the search never listed still counts as a look
  assert.equal(v.looked("a.pdf"), 3);
  assert.equal(v.thin(3), undefined);
});

test("thin: nothing listed, minimum 0, or nothing left to name gives undefined", () => {
  const v = new PageVisits();
  assert.equal(v.thin(3), undefined);
  v.listed("a.pdf", [1, 2]);
  assert.equal(v.thin(0), undefined);
  v.opened("a.pdf", 1);
  v.opened("a.pdf", 2);
  assert.equal(v.thin(3), undefined); // the two listed pages are both read: nothing to name
});

test("thin: `max` caps how many pages are named; reset clears the question", () => {
  const v = new PageVisits();
  v.listed("a.pdf", [5, 6, 7, 8]);
  assert.deepEqual(v.thin(3, 1)!.missing, [5]);
  assert.deepEqual(v.thin(3)!.missing, [5, 6, 7]);
  v.reset();
  assert.equal(v.thin(3), undefined);
});

test("thin: with two files the one with the most listed pages is used, under the name the model wrote", () => {
  const v = new PageVisits();
  v.listed("Small.pdf", [1]);
  v.listed("Big.pdf", [4, 5, 6]);
  const t = v.thin(2)!;
  assert.equal(t.file, "Big.pdf");
  assert.deepEqual(t.missing, [4, 5]);
});

test("isShortAnswer: size and layout only; a short lookup is exempt, a list or a long answer is not", () => {
  assert.equal(isShortAnswer(answerShape("Net sales were $34,229 million[1] in 2022.")), true);
  assert.equal(isShortAnswer(answerShape("word ".repeat(SHORT_ANSWER_WORDS))), true);
  assert.equal(isShortAnswer(answerShape("word ".repeat(SHORT_ANSWER_WORDS + 1))), false);
  assert.equal(isShortAnswer(answerShape("Risks:\n* legal\n* supply")), false);
  assert.equal(isShortAnswer(answerShape("# Title\nShort.")), false);
});

test("readMessage: names the pages and the file, asks for the answer again, and asks for a short one", () => {
  const one = readMessage("a.pdf", 1, [25]);
  assert.match(one, /you looked at 1 page /);
  assert.match(one, /open page 25 of a\.pdf with read_page/);
  const two = readMessage("a.pdf", 2, [25, 33]);
  assert.match(two, /you looked at 2 pages /);
  assert.match(two, /open pages 25 and 33 of a\.pdf/);
  assert.match(readMessage("a.pdf", 0, [1, 2, 3]), /pages 1, 2 and 3 of a\.pdf/);
  assert.match(two, /write the whole answer again/);
  assert.match(two, /as short as the question needs/);
});

test("searchMessage: names the file, says no search was run, asks for the top pages and a short answer", () => {
  const m = searchMessage("a.pdf", 1, 3);
  assert.match(m, /you answered without searching a\.pdf/);
  assert.match(m, /you looked at 1 page /);
  assert.match(m, /call search on a\.pdf/);
  assert.match(m, /looked at 3 pages in all/);
  assert.match(m, /as short as the question needs/);
  assert.match(searchMessage("a.pdf", 0, 2), /you looked at 0 pages /);
});

test("searched: true once a search ran in the question, even one that listed nothing; reset clears it", () => {
  const v = new PageVisits();
  assert.equal(v.searched(), false);
  v.searchedBefore("a.pdf", "net sales");
  assert.equal(v.searched(), true);
  v.reset();
  assert.equal(v.searched(), false);
});

test("READ_MIN_PAGES: default 3, 0 turns it off, 5 is the most, anything else is refused", () => {
  assert.equal(parseReadMinPages(undefined), DEFAULT_READ_MIN_PAGES);
  assert.equal(parseReadMinPages(""), 3);
  assert.equal(parseReadMinPages("0"), 0);
  assert.equal(parseReadMinPages(" 5 "), 5);
  for (const bad of ["6", "-1", "two", "2.5"]) assert.throws(() => parseReadMinPages(bad), /READ_MIN_PAGES/);
});
