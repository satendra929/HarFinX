// Pure helpers for the FinanceBench pilot ("evidence-provided mode"): dataset selection, evidence files,
// prompt, audit-log parsing, result files. No I/O here, so tests can import this without starting a run.
import { createHash } from "node:crypto";
import { Ledger, checkText, extractNumbers, normalise, type Checked, type Class } from "../src/provenance.ts";

// Upstream dataset, pinned. Public, non-commercial licence: it stays in git-ignored eval/data/.
export const DATASET_COMMIT = "cc39aeb4afdf33909ee1412188bf89035950c2eb";
export const DATASET_URL = `https://raw.githubusercontent.com/patronus-ai/financebench/${DATASET_COMMIT}/data/financebench_open_source.jsonl`;
export const DATASET_SHA256 = "a5a2aa673e573e55675fc3c0f9aa38c1cf59d2abc91edb077534f71f10a71877";

export interface FbEvidence {
  evidence_text: string;
  doc_name: string;
  evidence_page_num: number;
}
export interface FbRecord {
  financebench_id: string;
  company: string;
  doc_name: string;
  question_type: string;
  question_reasoning: string | null;
  question: string;
  answer: string;
  evidence: FbEvidence[];
}

/** Pilot selection: how many questions per type. */
export const PILOT_QUOTA: Record<string, number> = { "metrics-generated": 4, "domain-relevant": 3, "novel-generated": 3 };
/** Raw evidence size cap. Normalised evidence is shorter, so the claim "<= 2,500 chars" holds after normalisation too. */
export const MAX_RAW_EVIDENCE_CHARS = 2500;
/** Peak prompt + output above this is flagged as probable context loss (Ollama may truncate silently). This is the figure for an 8k window and the fallback for logs that do not record their window. */
export const CONTEXT_FLAG_TOKENS = 7500;
/** The flag threshold for a run: the same share of the window as 7500 is of 8192 (about 91.5%), so it follows the window the run used. */
export const contextFlagTokens = (window?: number): number => (window && window > 0 ? Math.floor(window * (CONTEXT_FLAG_TOKENS / 8192)) : CONTEXT_FLAG_TOKENS);

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Deterministic hash over named contents (names sorted), for hashing src/. */
export function hashFiles(entries: [name: string, content: string | Uint8Array][]): string {
  const lines = entries
    .map(([name, content]) => `${name}\0${sha256Hex(content)}`)
    .sort()
    .join("\n");
  return sha256Hex(lines);
}

export function parseDataset(text: string): FbRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FbRecord);
}

/** First N per type by id, among questions with exactly one short evidence passage. Fixed rule, no cherry-picking. */
export function selectPilot(rows: FbRecord[], quota = PILOT_QUOTA, maxChars = MAX_RAW_EVIDENCE_CHARS): FbRecord[] {
  const eligible = rows.filter((r) => r.evidence.length === 1 && r.evidence[0].evidence_text.length <= maxChars);
  const picked: FbRecord[] = [];
  for (const [type, n] of Object.entries(quota)) {
    picked.push(
      ...eligible
        .filter((r) => r.question_type === type)
        .sort((a, b) => a.financebench_id.localeCompare(b.financebench_id))
        .slice(0, n),
    );
  }
  return picked;
}

/** PDF extraction puts one cell per line with blank lines between. Drop blank lines and trailing spaces; nothing else changes. */
export function normaliseEvidence(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "")
    .join("\n");
}

/** Short id used in file names: financebench_id_03029 -> 03029. */
export function shortId(id: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(id)) throw new Error(`unexpected id: ${id}`);
  return id.replace(/^financebench_id_/, "");
}

/** Workspace-relative path of a question's evidence file. */
export const evidencePath = (id: string): string => `eval/fb-${shortId(id)}.txt`;

/** Evidence file content: one source line, then the normalised evidence. UTF-8, no BOM. */
export function evidenceFileText(rec: FbRecord): string {
  return `Source document: ${rec.evidence[0].doc_name}\n\n${normaliseEvidence(rec.evidence[0].evidence_text)}\n`;
}

// ---- modes: what the question is asked about ----------------------------------------------------
// evidence: a short evidence passage given as a text file (the original pilot).
// page:     the whole filing as a PDF, with the PDF page that holds the evidence named in the question.
// doc:      the whole filing as a PDF, nothing else named (the model has to find the page).
export type Mode = "evidence" | "page" | "doc";
export const MODES: Mode[] = ["evidence", "page", "doc"];

/** The same wording in every mode, only the thing named differs. */
export const PROMPT_TEMPLATE = "Using the file {path}, answer: {question}";
export const PROMPT_TEMPLATES: Record<Mode, string> = {
  evidence: PROMPT_TEMPLATE,
  page: "Using page {page} of the file {path}, answer: {question}",
  doc: PROMPT_TEMPLATE,
};

/** Where a filing sits inside an eval workspace. */
export const pdfPath = (rec: FbRecord): string => `filings/${rec.doc_name}.pdf`;
/** PDF pages that hold the gold evidence (the dataset counts from 0; the tool counts from 1). */
export const goldPages = (rec: FbRecord): number[] => rec.evidence.map((e) => e.evidence_page_num + 1);

export function buildPrompt(rec: FbRecord, mode: Mode = "evidence"): string {
  const template = PROMPT_TEMPLATES[mode];
  const target = mode === "evidence" ? evidencePath(rec.financebench_id) : pdfPath(rec);
  return template.replace("{path}", target).replace("{page}", String(goldPages(rec)[0])).replace("{question}", rec.question.trim());
}

/** Upstream location of a filing, at the pinned dataset commit. */
export const pdfUrl = (docName: string): string => `https://raw.githubusercontent.com/patronus-ai/financebench/${DATASET_COMMIT}/pdfs/${docName}.pdf`;

/** The first filings set: five filings that together hold about two dozen single-passage questions. */
export const FILINGS5 = ["AMD_2022_10K", "AMERICANEXPRESS_2022_10K", "BOEING_2022_10K", "Pfizer_2023Q2_10Q", "LOCKHEEDMARTIN_2021_10K"];

/** Every question with a single evidence passage, by id (115 of the 150 in the open sample). */
export function selectSingleEvidence(rows: FbRecord[]): FbRecord[] {
  return rows.filter((r) => r.evidence.length === 1).sort((a, b) => a.financebench_id.localeCompare(b.financebench_id));
}

/** Every single-evidence question on the given filings, by id. */
export function selectByDocs(rows: FbRecord[], docs: string[]): FbRecord[] {
  return rows.filter((r) => r.evidence.length === 1 && docs.includes(r.doc_name)).sort((a, b) => a.financebench_id.localeCompare(b.financebench_id));
}

// ---- a generic, provisional check of an answer against the gold answer ---------------------------

export interface NumericMatch {
  total: number; // figures in the gold answer
  found: number; // of those, figures the answer states (equal when rounded to the gold's decimals, or within 0.5%)
}

const isYear = (t: { canon: string; decimals: number; percent: boolean; money: boolean }) => t.decimals === 0 && !t.percent && !t.money && /^(?:19|20)\d\d$/.test(t.canon);

/**
 * How many of the gold answer's figures appear in the answer. Undefined when the gold holds no figure (a text answer).
 * Years are skipped. A match is a numeric match, not a text match: "5,466.312" matches a gold "5466.00" within 0.5%.
 * This does not check units or meaning: it is a provisional signal, not a grade.
 */
export function numericMatch(gold: string, answer: string): NumericMatch | undefined {
  const g = extractNumbers(normalise(gold)).filter((t) => !isYear(t));
  if (g.length === 0) return undefined;
  const a = extractNumbers(normalise(answer)).map((t) => Number(t.canon));
  let found = 0;
  for (const t of g) {
    const v = Number(t.canon);
    const tol = Math.max(Math.abs(v) * 0.005, 0.5 * 10 ** -t.decimals);
    if (a.some((x) => Math.abs(x - v) <= tol)) found++;
  }
  return { total: g.length, found };
}

// ---- audit log parsing -------------------------------------------------------------------------

export interface AuditSummary {
  provider?: string;
  model?: string;
  outcome: string; // run_end.outcome, or "timeout" when the run never ended (child killed)
  error?: string;
  answer: string;
  hasAnswer: boolean;
  /** The final reply when it exists only in the thinking channel (no text block): the user would see nothing. */
  thinkingOnlyAnswer?: string;
  lastStopReason?: string;
  toolCalls: { tool: string; args: unknown }[];
  /** Successful read_page calls (the model was shown that part of that page), in order. */
  pagesRead: { path: string; page: number; part: number }[];
  /** Every search call: what the model asked, and the pages the tool listed (empty when it found nothing or failed). */
  searches: { query: string; pages: number[] }[];
  guardKinds: string[];
  calcCalls: number;
  calcErrors: number;
  calcWarnings: number; // WARNING lines in calculate results (inputs not found in the source or question)
  modelCalls: number;
  promptTokensPeak: number; // input + cacheRead + cacheWrite of the largest single call
  promptPlusOutputPeak: number;
  promptTokensSum: number; // summed over calls: the cached prefix is re-counted on every call
  outputTokensSum: number; // includes thinking tokens
  durationMs?: number; // run_start -> run_end
  contextWindow?: number; // from session_start; absent in logs written before it was recorded
  contextFlag: boolean;
}

export function parseAuditLog(text: string): AuditSummary {
  const s: AuditSummary = {
    outcome: "timeout",
    answer: "",
    hasAnswer: false,
    toolCalls: [],
    pagesRead: [],
    searches: [],
    guardKinds: [],
    calcCalls: 0,
    calcErrors: 0,
    calcWarnings: 0,
    modelCalls: 0,
    promptTokensPeak: 0,
    promptPlusOutputPeak: 0,
    promptTokensSum: 0,
    outputTokensSum: 0,
    contextFlag: false,
  };
  let runStart: number | undefined;
  let lastMsg: any;
  let shownAnswer: string | undefined; // the text the user was shown as the answer (after the figure gate), when the log records it
  const pageCalls = new Map<string, { path: string; page: number; part: number }>();
  const searchQueries = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a killed child can leave a partial last line
    }
    if (r.type === "session_start") {
      s.provider = r.provider;
      s.model = r.model;
      if (Number.isInteger(r.contextWindow) && r.contextWindow > 0) s.contextWindow = r.contextWindow;
    } else if (r.type === "run_start") {
      runStart = Date.parse(r.ts);
    } else if (r.type === "tool_start") {
      s.toolCalls.push({ tool: r.tool, args: r.args });
      if (r.tool === "calculate") s.calcCalls++;
      if (r.tool === "search" && typeof r.args?.query === "string") searchQueries.set(r.toolCallId, r.args.query);
      if (r.tool === "read_page" && typeof r.args?.path === "string" && Number.isInteger(r.args?.page)) {
        pageCalls.set(r.toolCallId, { path: r.args.path, page: r.args.page, part: Number.isInteger(r.args.part) ? r.args.part : 1 });
      }
    } else if (r.type === "tool_end") {
      if (r.tool === "calculate" && r.isError) s.calcErrors++;
      const call = pageCalls.get(r.toolCallId);
      if (call && !r.isError) s.pagesRead.push(call); // only reads that returned page text
    } else if (r.type === "message" && r.message?.role === "toolResult" && r.message.toolName === "search") {
      const pages = Array.isArray(r.message.details?.pages) ? r.message.details.pages.filter((p: unknown) => Number.isInteger(p)) : [];
      s.searches.push({ query: searchQueries.get(r.message.toolCallId) ?? String(r.message.details?.query ?? ""), pages });
    } else if (r.type === "message" && r.message?.role === "toolResult" && r.message.toolName === "calculate") {
      s.calcWarnings += ((r.message.content ?? []).map((c: any) => c.text ?? "").join("").match(/^WARNING:/gm) ?? []).length;
    } else if (r.type === "guard") {
      s.guardKinds.push(r.kind);
    } else if (r.type === "message" && r.message?.role === "assistant") {
      const m = r.message;
      s.modelCalls++;
      lastMsg = m;
      const u = m.usage ?? {};
      const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      const out = u.output ?? 0;
      s.promptTokensSum += prompt;
      s.outputTokensSum += out;
      s.promptTokensPeak = Math.max(s.promptTokensPeak, prompt);
      s.promptPlusOutputPeak = Math.max(s.promptPlusOutputPeak, prompt + out);
      s.lastStopReason = m.stopReason;
      if (m.stopReason === "stop") {
        s.answer = (m.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
      }
    } else if (r.type === "answer_shown" && typeof r.text === "string") {
      shownAnswer = r.text;
    } else if (r.type === "run_end") {
      s.outcome = r.outcome;
      if (r.error) s.error = r.error;
      if (runStart !== undefined) s.durationMs = Date.parse(r.ts) - runStart;
    }
  }
  if (shownAnswer !== undefined) s.answer = shownAnswer; // never the draft the gate rejected, nor text it left out
  s.hasAnswer = s.answer.trim() !== "";
  if (!s.hasAnswer && lastMsg?.stopReason === "stop" && !(lastMsg.content ?? []).some((c: any) => c.type === "text" && c.text.trim())) {
    const th = (lastMsg.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("").trim();
    if (th) s.thinkingOnlyAnswer = th;
  }
  s.contextFlag = s.promptPlusOutputPeak > contextFlagTokens(s.contextWindow);
  return s;
}

// ---- figure provenance replay ------------------------------------------------------------------

// Lines the tools add around file text (chunk notes, page headers and footers): not part of the source.
const FOOTER = /^\[(?:characters|end of file|offset|page|part|repeated)[^\]]*\]\s*$/gm;
const textOf = (content: any[] | undefined): string => (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");

export interface ProvenanceSummary {
  checked: Checked[];
  counts: Record<Class, number>;
  unverified: Checked[];
}

/** Replays one session's audit log: ledger = file text shown + the user's text + calculate results; checks every assistant text block. */
export function replayProvenance(logText: string): ProvenanceSummary {
  const records = logText.split("\n").filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const argsById = new Map<string, any>();
  const chunks: { path: string; offset: number; text: string }[] = [];
  const answers: string[] = [];
  const ledger = new Ledger();
  let lastAssistant: any;
  let shown: string | undefined; // the text the user was shown as the answer, when the log records it
  for (const r of records) {
    if (r.type === "run_start") ledger.addUser(r.text);
    else if (r.type === "tool_start") argsById.set(r.toolCallId, r.args);
    else if (r.type === "message" && r.message.role === "toolResult") {
      const m = r.message;
      if (m.toolName === "read_file") {
        const a = argsById.get(m.toolCallId) ?? {};
        chunks.push({ path: a.path ?? "?", offset: a.offset ?? 0, text: textOf(m.content).replace(FOOTER, "") });
      } else if (m.toolName === "read_page") {
        // Each part holds whole rows, so parts are separate sources (no stitching across a chunk edge is needed).
        const a = argsById.get(m.toolCallId) ?? {};
        ledger.addSource(`${a.path ?? "?"} p.${a.page ?? "?"}`, textOf(m.content).replace(FOOTER, ""));
      } else if (m.toolName === "calculate") {
        for (const st of m.details?.steps ?? []) ledger.addCalc(st.name, st.value, st.shown, st.pct);
      }
    } else if (r.type === "message" && r.message.role === "assistant") {
      answers.push(textOf(r.message.content));
      lastAssistant = r.message;
    } else if (r.type === "answer_shown" && typeof r.text === "string") shown = r.text;
  }
  // A final reply that exists only in the thinking channel is still something the model asserted: check it too.
  if (lastAssistant && lastAssistant.stopReason === "stop" && textOf(lastAssistant.content).trim() === "") {
    answers.push((lastAssistant.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join(""));
  }
  // Consecutive chunks of one file are stitched in offset order so a number split by a chunk edge is still found.
  for (const p of new Set(chunks.map((c) => c.path))) {
    ledger.addSource(p, chunks.filter((c) => c.path === p).sort((a, b) => a.offset - b.offset).map((c) => c.text).join(""));
  }
  const checked = (shown !== undefined ? [shown] : answers).flatMap((a) => checkText(a, ledger)); // the answer the user was shown, when the log says which
  const counts: Record<Class, number> = { S: 0, U: 0, C: 0, K: 0, X: 0 };
  for (const c of checked) counts[c.cls]++;
  return { checked, counts, unverified: checked.filter((c) => c.cls === "X") };
}

// ---- result file -------------------------------------------------------------------------------

export interface ResultInput {
  rec: FbRecord;
  runId: string;
  summary: AuditSummary | undefined; // undefined: no audit log was produced
  provenance?: ProvenanceSummary;
  auditRelPath: string | undefined; // repo-relative, forward slashes
  note?: string;
  mode?: Mode; // default evidence
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderResult({ rec, runId, summary: s, provenance: p, auditRelPath, note, mode = "evidence" }: ResultInput): string {
  const tools = s ? [...new Set(s.toolCalls.map((t) => t.tool))].join(", ") || "none" : "n/a";
  const header: [string, string][] = [
    ["id", rec.financebench_id],
    ["company", rec.company],
    ["type", rec.question_type],
    ["run", runId],
    ["model", s?.model ?? "unknown"],
    ["outcome", s ? s.outcome : "no_audit_log"],
    ["answer_present", s ? String(s.hasAnswer) : "false"],
    ["answer_channel", s ? (s.hasAnswer ? "text" : s.thinkingOnlyAnswer ? "THINKING ONLY (nothing was shown to the user)" : "none") : "none"],
    ["last_stop_reason", s?.lastStopReason ?? "n/a"],
    ["duration_s", s?.durationMs !== undefined ? (s.durationMs / 1000).toFixed(1) : "n/a"],
    ["model_calls", String(s?.modelCalls ?? 0)],
    ["tool_calls", s ? `${s.toolCalls.length} (${tools})` : "0"],
    ["calculate", s ? `${s.calcCalls} call(s), ${s.calcErrors} error(s), ${s.calcWarnings} warning(s)` : "n/a"],
    ["figures", p ? `S ${p.counts.S}, U ${p.counts.U}, C ${p.counts.C}, K ${p.counts.K}, X ${p.counts.X}` : "n/a"],
    ["unverified_figures", p ? [...new Set(p.unverified.map((c) => c.token.raw))].slice(0, 10).join(", ") || "none" : "n/a"],
    ["guard_events", s ? s.guardKinds.filter((k) => k !== "call").join(", ") || "none" : "n/a"],
    ["prompt_tokens_peak", String(s?.promptTokensPeak ?? 0)],
    ["output_tokens_total", String(s?.outputTokensSum ?? 0)],
    ["context_flag", s?.contextFlag ? `YES (peak prompt + output > ${contextFlagTokens(s.contextWindow)})` : "no"],
  ];
  const gold = s?.hasAnswer ? numericMatch(rec.answer, s.answer) : undefined;
  header.push(["gold_numbers_found", s?.hasAnswer ? (gold ? `${gold.found} of ${gold.total} (provisional numeric match, not a grade)` : "n/a (gold has no figure)") : "n/a"]);
  if (mode !== "evidence") {
    const wanted = goldPages(rec);
    const read = [...new Set((s?.pagesRead ?? []).map((r) => r.page))].sort((a, b) => a - b);
    header.splice(3, 0, ["mode", mode]);
    const searches = s?.searches ?? [];
    const listed = searches.some((x) => wanted.some((g) => x.pages.includes(g)));
    const goldRead = wanted.some((g) => read.includes(g));
    header.push(["gold_page", wanted.join(", ")], ["pages_read", read.join(", ") || "none"], ["gold_page_read", s ? (goldRead ? "yes" : "no") : "n/a"]);
    if (mode === "doc") {
      header.push(
        ["searches", String(searches.length)],
        ["search_queries", searches.map((x) => `"${x.query.replace(/\s+/g, " ").slice(0, 120)}"`).join(" | ") || "none"],
        ["gold_page_in_search", s ? (listed ? "yes" : "no") : "n/a"],
        ["retrieval", s ? (goldRead ? "gold page read" : listed ? "gold page listed by search, not read" : searches.length ? "gold page never listed (another page may also be valid)" : "no search made") : "n/a"],
      );
    }
  }
  header.push(["audit_log", auditRelPath ?? "none"]);
  const lines = [`# ${rec.financebench_id} (${rec.company})`, "", ...header.map(([k, v]) => `${k}: ${v}`)];
  if (note) lines.push(`note: ${oneLine(note)}`);
  lines.push(
    "",
    "## Question",
    "",
    rec.question.trim(),
    "",
    "## Gold answer",
    "",
    rec.answer.trim(),
    "",
    "## Model answer",
    "",
    s?.hasAnswer ? s.answer.trim() : s?.thinkingOnlyAnswer ? `(No answer text was shown to the user. The reply was in the model's reasoning channel:)

${s.thinkingOnlyAnswer}` : "(no answer)",
    "",
    "## Human grade (fill in: correct | incorrect | refused | no_answer | ungradable)",
    "",
    "human_score:",
    "human_notes:",
    "",
  );
  return lines.join("\n");
}
