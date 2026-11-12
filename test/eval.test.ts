import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CONTEXT_FLAG_TOKENS,
  DATASET_SHA256,
  buildPrompt,
  evidenceFileText,
  evidencePath,
  hashFiles,
  normaliseEvidence,
  parseAuditLog,
  parseDataset,
  renderResult,
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
