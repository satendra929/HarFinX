import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CONTEXT_FLAG_TOKENS,
  contextFlagTokens,
  DATASET_SHA256,
  buildPrompt,
  evidenceFileText,
  evidencePath,
  goldPages,
  hashFiles,
  normaliseEvidence,
  numericMatch,
  parseAuditLog,
  parseDataset,
  renderResult,
  replayProvenance,
  selectByDocs,
  selectPilot,
  sha256Hex,
  shortId,
  type FbRecord,
} from "../eval/lib.ts";

const rec = (id: string, type: string, evidenceChars: number, evidenceCount = 1): FbRecord => ({
  financebench_id: `financebench_id_${id}`,
  company: "Acme",
  doc_name: "ACME_2020_10K",
  question_type: type,
  question_reasoning: null,
  question: `Question ${id}?`,
  answer: `Gold ${id}`,
  evidence: Array.from({ length: evidenceCount }, () => ({ evidence_text: "x".repeat(evidenceChars), doc_name: "ACME_2020_10K", evidence_page_num: 1 })),
});

test("selectPilot: first N per type by id, only single short evidence", () => {
  const rows = [
    rec("09", "a", 100), rec("03", "a", 100), rec("05", "a", 100), rec("01", "a", 100, 2), rec("02", "a", 3000),
    rec("07", "b", 100), rec("04", "b", 100),
  ];
  const out = selectPilot(rows, { a: 2, b: 5 }, 2500).map((r) => shortId(r.financebench_id));
  assert.deepEqual(out, ["03", "05", "04", "07"]); // 01 has two evidence items, 02 is too long, 09 is third in a
});

test("normaliseEvidence drops blank lines and trailing spaces only", () => {
  const raw = "Revenue \r\n \r\n\r\n$\r\n4,200 \n\n\tindented\n";
  assert.equal(normaliseEvidence(raw), "Revenue\n$\n4,200\n\tindented");
  assert.equal(normaliseEvidence("â€“ kept as is"), "â€“ kept as is"); // no re-encoding
});

test("evidence file: source line, normalised text, UTF-8 without BOM", () => {
  const r = rec("01", "a", 0);
  r.evidence[0].evidence_text = "A\n\n\nB \n";
  const t = evidenceFileText(r);
  assert.equal(t, "Source document: ACME_2020_10K\n\nA\nB\n");
  assert.notEqual(t.charCodeAt(0), 0xfeff);
});

test("prompt names the workspace-relative evidence file and carries the question verbatim", () => {
  const r = rec("03029", "a", 10);
  r.question = "  What is X?\nAnswer in USD millions.  ";
  assert.equal(evidencePath(r.financebench_id), "eval/fb-03029.txt");
  assert.equal(buildPrompt(r), "Using the file eval/fb-03029.txt, answer: What is X?\nAnswer in USD millions.");
  assert.throws(() => shortId("../etc"), /unexpected id/);
});

test("hashFiles is order-independent and content-sensitive", () => {
  const a = hashFiles([["a.ts", "1"], ["b.ts", "2"]]);
  assert.equal(a, hashFiles([["b.ts", "2"], ["a.ts", "1"]]));
  assert.notEqual(a, hashFiles([["a.ts", "1"], ["b.ts", "3"]]));
  assert.notEqual(a, hashFiles([["a.ts", "1"], ["c.ts", "2"]]));
});

// ---- audit log parsing ----
const L = (type: string, ts: string, data: object = {}) => JSON.stringify({ v: 1, seq: 1, ts, session: "s", type, ...data });
const usage = (input: number, cacheRead: number, output: number) => ({ input, cacheRead, cacheWrite: 0, output });
const assistant = (content: object[], stopReason: string, u: object) => L("message", "2026-01-01T00:00:05.000Z", { message: { role: "assistant", content, stopReason, usage: u } });

const goodLog = [
  L("session_start", "2026-01-01T00:00:00.000Z", { provider: "ollama", model: "qwen3:14b" }),
  L("run_start", "2026-01-01T00:00:01.000Z", { text: "q" }),
  assistant([{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "read_file" }], "toolUse", usage(36, 308, 1955)),
  L("tool_start", "2026-01-01T00:00:06.000Z", { tool: "read_file", args: { path: "eval/fb-1.txt" } }),
  L("guard", "2026-01-01T00:00:06.000Z", { kind: "call" }),
  L("message", "2026-01-01T00:00:07.000Z", { message: { role: "toolResult", content: [{ type: "text", text: "data" }] } }),
  assistant([{ type: "thinking", thinking: "SECRET THOUGHT" }, { type: "text", text: "Net income " }, { type: "text", text: "is 5." }], "stop", usage(2747, 4437, 233)),
  L("run_end", "2026-01-01T00:00:11.500Z", { outcome: "ok" }),
].join("\n");

test("parseAuditLog: answer, tokens, tools, duration, outcome", () => {
  const s = parseAuditLog(goodLog);
  assert.equal(s.model, "qwen3:14b");
  assert.equal(s.outcome, "ok");
  assert.equal(s.answer, "Net income is 5."); // text blocks joined, thinking excluded
  assert.ok(!s.answer.includes("SECRET"));
  assert.equal(s.hasAnswer, true);
  assert.equal(s.modelCalls, 2);
  assert.deepEqual(s.toolCalls.map((t) => t.tool), ["read_file"]);
  assert.equal(s.promptTokensPeak, 2747 + 4437); // input + cacheRead
  assert.equal(s.promptTokensSum, 36 + 308 + 2747 + 4437);
  assert.equal(s.outputTokensSum, 1955 + 233);
  assert.equal(s.promptPlusOutputPeak, 2747 + 4437 + 233); // 7417: just under the flag
  assert.equal(s.contextFlag, false);
  assert.equal(s.durationMs, 10500);
  assert.equal(s.lastStopReason, "stop");
});

test("parseAuditLog: a run with no run_end is a timeout; a partial last line is ignored", () => {
  const cut = goodLog.split("\n").slice(0, 4).join("\n") + '\n{"v":1,"seq":5,"ty';
  const s = parseAuditLog(cut);
  assert.equal(s.outcome, "timeout");
  assert.equal(s.durationMs, undefined);
  assert.equal(s.hasAnswer, false);
});

test("parseAuditLog: no stop message means no answer (e.g. guard tripped on a tool call)", () => {
  const log = [
    L("run_start", "2026-01-01T00:00:01.000Z"),
    assistant([{ type: "text", text: "let me look" }, { type: "toolCall", name: "read_file" }], "toolUse", usage(10, 0, 5)),
    L("run_end", "2026-01-01T00:00:02.000Z", { outcome: "guard_tripped" }),
  ].join("\n");
  const s = parseAuditLog(log);
  assert.equal(s.answer, "");
  assert.equal(s.hasAnswer, false);
  assert.equal(s.outcome, "guard_tripped");
});

test("parseAuditLog: flags probable context loss from the numbers", () => {
  const log = [L("run_start", "2026-01-01T00:00:01.000Z"), assistant([{ type: "text", text: "x" }], "stop", usage(100, CONTEXT_FLAG_TOKENS, 10)), L("run_end", "2026-01-01T00:00:02.000Z", { outcome: "ok" })].join("\n");
  assert.equal(parseAuditLog(log).contextFlag, true);
});

test("parseAuditLog: the context flag follows the window recorded in session_start (16k run: 8k-sized peak is fine, 15k is not)", () => {
  const body = (peak: number) => [L("session_start", "2026-01-01T00:00:00.000Z", { contextWindow: 16384 }), L("run_start", "2026-01-01T00:00:01.000Z"), assistant([{ type: "text", text: "x" }], "stop", usage(100, peak, 10)), L("run_end", "2026-01-01T00:00:02.000Z", { outcome: "ok" })].join("\n");
  const ok = parseAuditLog(body(CONTEXT_FLAG_TOKENS));
  assert.equal(ok.contextWindow, 16384);
  assert.equal(ok.contextFlag, false);
  assert.equal(parseAuditLog(body(15_000)).contextFlag, true);
  assert.equal(contextFlagTokens(16384), 15000); // 91.5% of the window
  assert.equal(contextFlagTokens(undefined), CONTEXT_FLAG_TOKENS); // logs without a recorded window keep the old figure
  assert.equal(contextFlagTokens(8192), CONTEXT_FLAG_TOKENS);
});

test("renderResult: fields, gold, blank human grade, repo-relative paths only", () => {
  const md = renderResult({ rec: rec("01", "a", 5), runId: "run-x", summary: parseAuditLog(goodLog), auditRelPath: "eval/runs/run-x/audit/01/session-1.jsonl" });
  assert.match(md, /^outcome: ok$/m);
  assert.match(md, /^tool_calls: 1 \(read_file\)$/m);
  assert.match(md, /^prompt_tokens_peak: 7184$/m);
  assert.match(md, /## Gold answer\n\nGold 01\n/);
  assert.match(md, /## Model answer\n\nNet income is 5\.\n/);
  assert.match(md, /^human_score:$/m);
  assert.doesNotMatch(md, /[A-Za-z]:\\/); // no absolute Windows paths

  const none = renderResult({ rec: rec("02", "a", 5), runId: "run-x", summary: undefined, auditRelPath: undefined, note: "no audit log produced" });
  assert.match(none, /^outcome: no_audit_log$/m);
  assert.match(none, /\(no answer\)/);
});

// Checks the real pilot selection. Skipped when the (git-ignored, non-commercial) dataset is not present.
const DATA = path.join(import.meta.dirname, "..", "eval", "data", "financebench_open_source.jsonl");
test("the real pilot selection has 10 questions", { skip: !fs.existsSync(DATA) }, () => {
  const raw = fs.readFileSync(DATA);
  assert.equal(sha256Hex(raw), DATASET_SHA256);
  assert.equal(selectPilot(parseDataset(raw.toString("utf8"))).length, 10);
});

// ---- filings modes: prompts, selection, page reads, numeric match ----

test("modes: the evidence prompt is unchanged; page and doc prompts name the filing (and the page) with the same wording", () => {
  const r = rec("01", "a", 5); // evidence_page_num 1 in the dataset means PDF page 2
  assert.deepEqual(goldPages(r), [2]);
  assert.equal(buildPrompt(r), "Using the file eval/fb-01.txt, answer: Question 01?");
  assert.equal(buildPrompt(r, "evidence"), buildPrompt(r));
  assert.equal(buildPrompt(r, "page"), "Using page 2 of the file filings/ACME_2020_10K.pdf, answer: Question 01?");
  assert.equal(buildPrompt(r, "doc"), "Using the file filings/ACME_2020_10K.pdf, answer: Question 01?");
});

test("selectByDocs: single-evidence questions on the named filings only, by id, whatever the evidence length", () => {
  const other = { ...rec("04", "a", 10), doc_name: "OTHER_2021_10K" };
  const rows = [rec("09", "a", 100), rec("03", "b", 5000), rec("05", "a", 10, 2), other, rec("01", "c", 10)];
  assert.deepEqual(selectByDocs(rows, ["ACME_2020_10K"]).map((r) => shortId(r.financebench_id)), ["01", "03", "09"]);
  assert.deepEqual(selectByDocs(rows, []).length, 0);
});

test("numericMatch: gold figures found in the answer by value; years skipped; text gold has no match to make", () => {
  assert.deepEqual(numericMatch("$5466.00", "Total current liabilities were 5,466.312 million USD."), { total: 1, found: 1 }); // within 0.5%
  assert.deepEqual(numericMatch("10.3%", "The 3-year average margin is 0.1%."), { total: 1, found: 0 });
  assert.deepEqual(numericMatch("10.3%", "The average is 10.3%."), { total: 1, found: 1 });
  assert.deepEqual(numericMatch("FY2022 working capital was $2,278 million and 5.0%", "Working capital is $2,278 million."), { total: 2, found: 1 }); // the year is skipped
  assert.deepEqual(numericMatch("1.6", "about 1.64"), { total: 1, found: 1 }); // rounds to the gold's decimals
  assert.deepEqual(numericMatch("1.6", "about 1.7"), { total: 1, found: 0 });
  assert.equal(numericMatch("Yes, it is positive.", "yes"), undefined);
  assert.equal(numericMatch("In 2022 only", "x 2022"), undefined); // only a year
});

const pageLog = (pageText: string, answer: string, readIsError = false) =>
  [
    L("session_start", "2026-01-01T00:00:00.000Z", { provider: "ollama", model: "gemma4:12b" }),
    L("run_start", "2026-01-01T00:00:01.000Z", { text: "Using page 68 of the file filings/ACME.pdf, answer: What is working capital?" }),
    L("tool_start", "2026-01-01T00:00:02.000Z", { toolCallId: "c1", tool: "read_page", args: { path: "filings/ACME.pdf", page: 68 } }),
    L("tool_end", "2026-01-01T00:00:03.000Z", { toolCallId: "c1", tool: "read_page", isError: readIsError }),
    L("message", "2026-01-01T00:00:03.000Z", { message: { role: "toolResult", toolCallId: "c1", toolName: "read_page", content: [{ type: "text", text: pageText }] } }),
    L("tool_start", "2026-01-01T00:00:04.000Z", { toolCallId: "c2", tool: "read_page", args: { path: "filings/ACME.pdf", page: 69, part: 2 } }),
    L("tool_end", "2026-01-01T00:00:05.000Z", { toolCallId: "c2", tool: "read_page", isError: true }), // a failed read does not count
    assistant([{ type: "text", text: answer }], "stop", usage(100, 0, 20)),
    L("run_end", "2026-01-01T00:00:06.000Z", { outcome: "ok" }),
  ].join("\n");
const PAGE = "[page 68 of 136 in filings/ACME.pdf]\nTotal current assets  |  19,815  |  19,378\nTotal current liabilities  |  13,997  |  13,933\n[end of page 68]";

test("parseAuditLog: successful read_page calls are listed with their page and part; failed ones are not", () => {
  assert.deepEqual(parseAuditLog(pageLog(PAGE, "x")).pagesRead, [{ path: "filings/ACME.pdf", page: 68, part: 1 }]);
  assert.deepEqual(parseAuditLog(pageLog(PAGE, "x", true)).pagesRead, []);
});

test("replayProvenance: page text feeds the ledger (headers and footers excluded); 'page 68 of 136' is a label, not a figure", () => {
  const ok = replayProvenance(pageLog(PAGE, "Per page 68 of 136, current assets were 19,815 and current liabilities 13,997; the margin is 7,777."));
  assert.deepEqual(ok.checked.map((c) => `${c.token.raw}=${c.cls}`), ["19,815=S", "13,997=S", "7,777=X"]);
  assert.equal(ok.counts.X, 1);
  // the header's "136" must not have become a source number that lets an invented 136 pass
  assert.deepEqual(replayProvenance(pageLog(PAGE, "Current assets were 136.")).unverified.map((c) => c.token.raw), ["136"]);
});

test("renderResult in page mode: the mode, the gold page, the pages read, whether the gold page was read, the numeric match", () => {
  const r = rec("01", "a", 5);
  r.answer = "19,815";
  r.evidence[0].evidence_page_num = 67; // PDF page 68
  const s = parseAuditLog(pageLog(PAGE, "Total current assets were 19,815."));
  const md = renderResult({ rec: r, runId: "run-x", summary: s, auditRelPath: "eval/runs/run-x/a.jsonl", mode: "page" });
  assert.match(md, /^mode: page$/m);
  assert.match(md, /^gold_page: 68$/m);
  assert.match(md, /^pages_read: 68$/m);
  assert.match(md, /^gold_page_read: yes$/m);
  assert.match(md, /^gold_numbers_found: 1 of 1/m);
  r.evidence[0].evidence_page_num = 10;
  const miss = renderResult({ rec: r, runId: "run-x", summary: s, auditRelPath: undefined, mode: "doc" });
  assert.match(miss, /^gold_page: 11$/m);
  assert.match(miss, /^gold_page_read: no$/m);
  const evidence = renderResult({ rec: r, runId: "run-x", summary: s, auditRelPath: undefined }); // evidence mode adds no page lines
  assert.doesNotMatch(evidence, /gold_page|pages_read|^mode:/m);
});

// ---- retrieval check helpers ----
import { labelQuery, recallAt, type Probe } from "../eval/retrieval.ts";

test("labelQuery: the printed row labels, before each line's first number, without repeats; capped in words", () => {
  const evidence = "Total current assets  |  19,815  |  19,378\nGoodwill  |  $10,813\n(in millions)\nTotal current assets  |  1\nNet sales (a)  |  5";
  assert.equal(labelQuery(evidence), "Total current assets Goodwill Net sales");
  assert.equal(labelQuery("one two three four five six seven eight nine ten eleven twelve 1", 5), "one two three four five");
  assert.equal(labelQuery("1,234\n(5)\n$7"), "");
});

test("recallAt counts the questions whose gold page ranks within the first k", () => {
  const p = (raw: number): Probe => ({ id: "x", doc: "d", ranks: { raw, clean: raw, label: raw } });
  const probes = [p(1), p(3), p(5), p(6), p(Infinity)];
  assert.deepEqual([1, 3, 5, 10].map((k) => recallAt(probes, "raw", k)), [1, 2, 3, 4]);
});

test("doc mode: searches (query and listed pages) are parsed, and the retrieval diagnosis tells read / listed-not-read / never listed", () => {
  const log = (listed: number[], readPage: number | undefined) =>
    [
      L("session_start", "2026-01-01T00:00:00.000Z", { provider: "ollama", model: "gemma4:12b" }),
      L("run_start", "2026-01-01T00:00:01.000Z", { text: "Using the file filings/ACME.pdf, answer: q" }),
      L("tool_start", "2026-01-01T00:00:02.000Z", { toolCallId: "s1", tool: "search", args: { path: "filings/ACME.pdf", query: "total current assets" } }),
      L("tool_end", "2026-01-01T00:00:02.100Z", { toolCallId: "s1", tool: "search", isError: false }),
      L("message", "2026-01-01T00:00:02.200Z", { message: { role: "toolResult", toolCallId: "s1", toolName: "search", content: [{ type: "text", text: "x" }], details: { pages: listed } } }),
      ...(readPage ? [L("tool_start", "2026-01-01T00:00:03.000Z", { toolCallId: "r1", tool: "read_page", args: { path: "filings/ACME.pdf", page: readPage } }), L("tool_end", "2026-01-01T00:00:03.100Z", { toolCallId: "r1", tool: "read_page", isError: false })] : []),
      assistant([{ type: "text", text: "answer" }], "stop", usage(10, 0, 5)),
      L("run_end", "2026-01-01T00:00:06.000Z", { outcome: "ok" }),
    ].join("\n");
  const r = rec("01", "a", 5);
  r.evidence[0].evidence_page_num = 67; // gold PDF page 68
  const s = parseAuditLog(log([12, 68, 5], 68));
  assert.deepEqual(s.searches, [{ query: "total current assets", pages: [12, 68, 5] }]);
  const md = (listed: number[], read: number | undefined) => renderResult({ rec: r, runId: "x", summary: parseAuditLog(log(listed, read)), auditRelPath: undefined, mode: "doc" });
  assert.match(md([12, 68], 68), /^retrieval: gold page read$/m);
  assert.match(md([12, 68], 12), /^retrieval: gold page listed by search, not read$/m);
  assert.match(md([12, 30], 12), /^retrieval: gold page never listed/m);
  assert.match(md([12, 68], 68), /^search_queries: "total current assets"$/m);
  assert.match(md([12, 68], 68), /^gold_page_in_search: yes$/m);
  const noSearch = renderResult({ rec: r, runId: "x", summary: parseAuditLog([L("run_start", "2026-01-01T00:00:01.000Z"), assistant([{ type: "text", text: "a" }], "stop", usage(1, 0, 1)), L("run_end", "2026-01-01T00:00:02.000Z", { outcome: "ok" })].join("\n")), auditRelPath: undefined, mode: "doc" });
  assert.match(noSearch, /^retrieval: no search made$/m);
});
