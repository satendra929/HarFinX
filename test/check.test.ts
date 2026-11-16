import { test } from "node:test";
import assert from "node:assert/strict";
import { answerTextSince, checkLine, summarizeCheck } from "../src/check.ts";
import { checkText, Ledger } from "../src/provenance.ts";

const checkAnswer = (text: string, l: Ledger) => summarizeCheck(checkText(text, l));
const asst = (...blocks: { type: string; text?: string; thinking?: string }[]) => ({ role: "assistant", content: blocks });
const text = (t: string) => ({ type: "text", text: t });
const think = (t: string) => ({ type: "thinking", thinking: t });

const ledger = () => {
  const l = new Ledger();
  l.addSource("income.txt", "Net sales 11,503 11,303 Operating income 1,306 509");
  l.addUser("What is the operating margin for FY2019?");
  l.addCalc("margin19", "0.113535599409", "11.4%", true);
  return l;
};

test("answerTextSince: only visible text of the current question; not thinking, tool calls, tool results or earlier questions", () => {
  const messages = [
    { role: "user", content: "q1" },
    asst(text("earlier answer 999")),
    { role: "user", content: [{ type: "text", text: "q2" }] },
    asst(think("secret 123"), { type: "toolCall" } as never),
    { role: "toolResult", content: [{ type: "text", text: "file 456" }] },
    asst(text("Net sales were 11,503."), think("more 789")),
    asst(text("Margin 11.4%.")),
  ];
  assert.equal(answerTextSince(messages), "Net sales were 11,503.\nMargin 11.4%.");
  assert.equal(answerTextSince([]), "");
  assert.equal(answerTextSince([{ role: "user", content: "q" }, { role: "assistant" }, null as never]), ""); // odd shapes are tolerated
});

test("summarizeCheck counts classes, leaves non-figures out of 'figures', and lists each unverified figure once", () => {
  const s = checkAnswer("Net sales 11,503 and margin 11.4% in 2019; but 13.6% and again 13.6%, plus 8.3%.", ledger());
  assert.equal(s.counts.S, 1);
  assert.equal(s.counts.C, 1);
  assert.deepEqual(s.unverified.map((u) => u.raw), ["13.6%", "8.3%"]);
  assert.equal(s.counts.X, 3); // 13.6% twice
  assert.equal(s.figures, s.counts.S + s.counts.U + s.counts.C + s.counts.X);
  assert.equal(s.counts.K, 1); // the year 2019 is a non-figure: not counted in "figures"
  assert.match(s.unverified[0].context, /13\.6%/);
});

test("checkLine: a warning lists the unverified figures; a clean answer, or no figures, gets no line", () => {
  const warn = checkLine(checkAnswer("Margin 11.4% and 13.6%.", ledger()))!;
  assert.equal(warn.warn, true);
  assert.equal(warn.text, "[check] 1 figure not traced to your file, your question or the calculator: 13.6%. Verify it against the source.");

  // everything traced: no line (the counts stay in the audit log)
  assert.equal(checkLine(checkAnswer("Net sales were 11,503 and the margin 11.4%.", ledger())), undefined);
  assert.equal(checkLine(checkAnswer("Net sales were 11,503.", ledger())), undefined);

  assert.equal(checkLine(checkAnswer("No numbers here, and only the year FY2021.", ledger())), undefined);
  assert.equal(checkLine(summarizeCheck([])), undefined);
});

test("checkLine: more than five unverified figures are cut off with a count; plural wording", () => {
  const s = checkAnswer("Odd values: 101.1, 202.2, 303.3, 404.4, 505.5, 606.6, 707.7.", new Ledger());
  const line = checkLine(s)!;
  assert.equal(s.unverified.length, 7);
  assert.match(line.text, /^\[check\] 7 figures not traced .*: 101\.1, 202\.2, 303\.3, 404\.4, 505\.5 and 2 more\. Verify them against the source\.$/);
});

test("the live check agrees with the checker the offline report uses", () => {
  const l = ledger();
  const answer = "Net sales 11,503, operating income 1,306, margin 11.4%, invented 7,777.";
  const live = checkAnswer(answer, l);
  const offline = checkText(answer, l);
  assert.equal(live.counts.X, offline.filter((c) => c.cls === "X").length);
  assert.deepEqual(live.unverified.map((u) => u.raw), ["7,777"]);
});
