import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrinter } from "../src/printer.ts";

function make(pending: () => string = () => "") {
  const out: string[] = [];
  return { p: createPrinter({ write: (t) => void out.push(t) }, pending), text: () => out.join("") };
}

test("a line starts on a fresh line: an open line of text is closed first", () => {
  const { p, text } = make();
  p.text("Net sales were");
  p.line("tool call");
  p.line("another");
  assert.equal(text(), "Net sales were\ntool call\nanother\n");
});

test("a note has exactly one blank line above it, and none added when one is already there", () => {
  const { p, text } = make();
  p.text("answer\n");
  p.note("first note");
  p.note("second note");
  assert.equal(text(), "answer\n\nfirst note\n\nsecond note\n");
  const fresh = make();
  fresh.p.note("at the start"); // the start of the output counts as a blank line
  assert.equal(fresh.text(), "at the start\n");
  const open = make();
  open.p.text("cut off");
  open.p.note("note");
  assert.equal(open.text(), "cut off\n\nnote\n");
});

test("text that was held back is shown before a line or at the end, then the line is closed", () => {
  let held = "tail";
  const { p, text } = make(() => {
    const h = held;
    held = "";
    return h;
  });
  p.text("whole line\n");
  p.line("progress");
  assert.equal(text(), "whole line\ntail\nprogress\n");
  held = "last";
  p.end();
  p.end(); // nothing left: nothing printed
  assert.equal(text(), "whole line\ntail\nprogress\nlast\n");
});

test("begin(): a new question counts the caller's blank line, so a first note does not add a second", () => {
  const { p, text } = make();
  p.text("previous answer\n");
  p.begin();
  p.note("[stopped] reason");
  assert.equal(text(), "previous answer\n[stopped] reason\n");
});
