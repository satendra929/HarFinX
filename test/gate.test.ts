import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/provenance.ts";
import { gateText, redactUncited, repairMessage, splitSentences, untracedWarning } from "../src/gate.ts";

function page(l: Ledger, n: number, lines: string[]): void {
  l.addSource(`f.pdf p.${n}`, lines.join("\n"), { file: "f.pdf", page: n, pageLines: lines, lineOffset: 0 });
}
function ledger(): Ledger {
  const l = new Ledger();
  l.addUser("What were the net sales and the change in 2022?");
  page(l, 1, ["Income", "(in millions)", "Year ended December 31  |  2022  |  2021", "Net sales  |  32,765  |  31,009", "Net income  |  5,921  |  5,100"]);
  l.addCalc("g", "0.0566", "5.7%", true, { call: 1, expr: "(a - b) / b", inputs: [{ name: "a", literal: "32,765" }, { name: "b", literal: "31,009" }], literals: [], calls: [] });
  return l;
}

test("splitSentences: cuts after . ! ? and a space before a new sentence; not inside numbers or after vs. e.g. Inc.", () => {
  assert.deepEqual(splitSentences("It rose 5.7% in 2022. Net income was 5,921."), ["It rose 5.7% in 2022. ", "Net income was 5,921."]);
  assert.deepEqual(splitSentences("Cost rose ($31,089 million in 2022 vs. $29,855 million in 2021). Sales rose."), ["Cost rose ($31,089 million in 2022 vs. $29,855 million in 2021). ", "Sales rose."]);
  assert.deepEqual(splitSentences("Acme Inc. reported 5,921 e.g. for 2022. Done."), ["Acme Inc. reported 5,921 e.g. for 2022. ", "Done."]);
  assert.equal(splitSentences("a | b | 1.5 | 2.5").length, 1);
  assert.equal(splitSentences("").length, 0);
  assert.equal(splitSentences("one. two. three").join(""), "one. two. three"); // joining the pieces gives the line back
});

test("gateText: a quote, a calculation, a figure from the question and a year pass; a figure nobody printed fails; every number is looked at", () => {
  const l = ledger();
  assert.deepEqual(gateText("Net sales were $32,765 million in 2022, up 5.7%.", l, "What were the net sales and the change in 2022?"), []);
  const f = gateText("Net sales rose 5.6% to $99,999 million. Net income was 5,921.", l);
  assert.deepEqual(f.map((x) => x.raw), ["5.6%", "$99,999 million"]);
  assert.equal(f[0].sentence, "Net sales rose 5.6% to $99,999 million.");
  assert.equal(gateText("Growth was 65.3\\% last year.", l).length, 1); // a LaTeX percent is still looked at
});

test("repairMessage: names at most five figures with their sentence, never says the answer is wrong, and leaves out the page clause when pages cannot be opened", () => {
  const failing = Array.from({ length: 7 }, (_, i) => ({ raw: `${i + 20}.5%`, sentence: `Sentence number ${i}.`, reason: "x" }));
  const m = repairMessage(failing, true);
  assert.equal(m.split("\n").filter((x) => x.startsWith("- \"")).length, 5);
  assert.match(m, /- and 2 more/);
  assert.match(m, /Not shown to the user yet/);
  assert.match(m, /open that page/);
  assert.doesNotMatch(m, /wrong|incorrect|error/i);
  assert.doesNotMatch(repairMessage(failing, false), /open that page/);
  assert.match(repairMessage(failing, false), /call calculate/);
});

test("redactUncited: a sentence with an uncited figure goes, the rest stays; a table row or list item goes whole; counts and flags are right", () => {
  const l = ledger();
  const text = ["Net sales were $32,765 million. They rose 5.6% from 2021.", "- Net income was 5,921", "- Margin was 61.2%", "| Item | 2022 |", "| Net sales | 32,765 |", "| Guess | 70,001 |"].join("\n");
  const r = redactUncited(text, l);
  assert.equal(r.text, ["Net sales were $32,765 million.", "- Net income was 5,921", "| Item | 2022 |", "| Net sales | 32,765 |"].join("\n"));
  assert.equal(r.removed, 3);
  assert.equal(r.firstRemoved, false);
  assert.equal(r.withheld, false);
});

test("redactUncited: the first sentence going is reported; nothing left is withheld; a clean text is untouched; a heading with nothing under it goes", () => {
  const l = ledger();
  const a = redactUncited("Net sales rose 5.6%. Net income was 5,921.", l);
  assert.deepEqual([a.text, a.firstRemoved, a.removed], ["Net income was 5,921.", true, 1]);
  const b = redactUncited("Net sales were 99,999.", l);
  assert.deepEqual([b.text, b.withheld], ["", true]);
  assert.deepEqual(redactUncited("Net sales were 32,765 in 2022.", l), { text: "Net sales were 32,765 in 2022.", removed: 0, withheld: false, firstRemoved: false });
  const c = redactUncited("## Sales\nNet sales were 99,999.\n## Income\nNet income was 5,921.", l);
  assert.equal(c.text, "## Income\nNet income was 5,921.");
});

test("redactUncited: an unpaired bold or code mark left by a cut is dropped; a sentence after 'vs.' is not cut in two", () => {
  const l = ledger();
  const r = redactUncited("**Net sales were 5.6% up. Net income was** 5,921.", l);
  assert.doesNotMatch(r.text, /\*\*/);
  const v = redactUncited("Cost rose $31,089 million vs. $29,855 million in 2021 and net sales were 32,765.", l);
  assert.equal(v.removed, 1); // one sentence (the whole line), not a stray piece with half the numbers
});

test("untracedWarning: the line of FIGURE_FALLBACK=warn names the figures once each", () => {
  const w = untracedWarning([{ raw: "5.6%", sentence: "a", reason: "x" }, { raw: "5.6%", sentence: "b", reason: "x" }, { raw: "$9", sentence: "c", reason: "x" }]);
  assert.match(w, /^\[check\] 2 figures not traced to your file, your question or the calculator: 5\.6%, \$9\. Verify them against the source\.$/);
});
