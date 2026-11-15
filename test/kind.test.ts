import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDocument, supportsStatements } from "../src/documents/kind.ts";
import * as D from "./fixtures/docKinds.ts";

test("kind: a 10-K, a 10-Q and an 8-K are named from their cover, with high confidence, and every signal is listed", () => {
  for (const [pages, form] of [[D.REAL_10K, "10-K"], [D.REAL_10Q, "10-Q"], [D.REAL_8K, "8-K"]] as const) {
    const k = classifyDocument(pages);
    assert.equal(k.form, form);
    assert.equal(k.confidence, "high", `${form}: ${k.signals.join("; ")}`);
    assert.ok(k.signals.length >= 4);
  }
  assert.equal(supportsStatements(classifyDocument(D.REAL_10K)), true);
  assert.equal(supportsStatements(classifyDocument(D.REAL_10Q)), true);
  assert.equal(supportsStatements(classifyDocument(D.REAL_8K)), false, "an 8-K cover is not an annual or quarterly report");
});

test("kind: a 10-K wrapped in a glossy annual report is found by its cover on a later page", () => {
  const k = classifyDocument(D.WRAPPED_10K);
  assert.equal(k.form, "10-K", k.signals.join("; "));
  assert.equal(k.confidence, "high");
});

test("kind: an earnings release is called an earnings release, never a report the statement tools may serve", () => {
  const k = classifyDocument(D.EARNINGS_RELEASE);
  assert.equal(k.form, "earnings", k.signals.join("; "));
  assert.equal(k.confidence, "medium");
  assert.equal(supportsStatements(k), false);
});

test("kind: documents that talk like a filing but are not one stay unknown", () => {
  for (const [name, pages] of Object.entries({ proxy: D.PROXY_STATEMENT, prospectus: D.PROSPECTUS, deck: D.INVESTOR_DECK, analyst: D.ANALYST_NOTE, annualOnly: D.ANNUAL_REPORT_ONLY })) {
    const k = classifyDocument(pages);
    assert.equal(k.form, "unknown", `${name}: ${k.signals.join("; ")}`);
    assert.equal(supportsStatements(k), false, name);
  }
});

test("kind: a cover that names two different forms is not used", () => {
  const k = classifyDocument(D.CONFLICTING_COVER);
  assert.equal(k.form, "unknown");
  assert.ok(k.signals.some((s) => /different forms/.test(s)));
});

test("kind: no pages, or pages with nothing in them, is unknown and never throws", () => {
  assert.equal(classifyDocument([]).form, "unknown");
  assert.equal(classifyDocument(["", "", ""]).form, "unknown");
});
