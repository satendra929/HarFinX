// Pure helpers for the FinanceBench pilot ("evidence-provided mode"): dataset selection, evidence files,
// prompt, audit-log parsing, result files. No I/O here, so tests can import this without starting a run.
import { createHash } from "node:crypto";
import { Ledger, checkText, type Checked, type Class } from "../src/provenance.ts";

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
/** Peak prompt + output above this is flagged as probable context loss (8k window, Ollama may truncate silently). */
export const CONTEXT_FLAG_TOKENS = 7500;

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

export const PROMPT_TEMPLATE = "Using the file {path}, answer: {question}";
export function buildPrompt(rec: FbRecord): string {
  return PROMPT_TEMPLATE.replace("{path}", evidencePath(rec.financebench_id)).replace("{question}", rec.question.trim());
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
  contextFlag: boolean;
}

export function parseAuditLog(text: string): AuditSummary {
  const s: AuditSummary = {
    outcome: "timeout",
    answer: "",
    hasAnswer: false,
    toolCalls: [],
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
    } else if (r.type === "run_start") {
      runStart = Date.parse(r.ts);
    } else if (r.type === "tool_start") {
      s.toolCalls.push({ tool: r.tool, args: r.args });
      if (r.tool === "calculate") s.calcCalls++;
    } else if (r.type === "tool_end") {
      if (r.tool === "calculate" && r.isError) s.calcErrors++;
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
    } else if (r.type === "run_end") {
      s.outcome = r.outcome;
      if (r.error) s.error = r.error;
      if (runStart !== undefined) s.durationMs = Date.parse(r.ts) - runStart;
    }
  }
  s.hasAnswer = s.answer.trim() !== "";
  if (!s.hasAnswer && lastMsg?.stopReason === "stop" && !(lastMsg.content ?? []).some((c: any) => c.type === "text" && c.text.trim())) {
    const th = (lastMsg.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("").trim();
    if (th) s.thinkingOnlyAnswer = th;
  }
  s.contextFlag = s.promptPlusOutputPeak > CONTEXT_FLAG_TOKENS;
  return s;
}

// ---- figure provenance replay ------------------------------------------------------------------

const FOOTER = /^\[(?:characters|end of file|offset)[^\]]*\]\s*$/gm;
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
  for (const r of records) {
    if (r.type === "run_start") ledger.addUser(r.text);
    else if (r.type === "tool_start") argsById.set(r.toolCallId, r.args);
    else if (r.type === "message" && r.message.role === "toolResult") {
      const m = r.message;
      if (m.toolName === "read_file") {
        const a = argsById.get(m.toolCallId) ?? {};
        chunks.push({ path: a.path ?? "?", offset: a.offset ?? 0, text: textOf(m.content).replace(FOOTER, "") });
      } else if (m.toolName === "calculate") {
        for (const st of m.details?.steps ?? []) ledger.addCalc(st.name, st.value, st.shown, st.pct);
      }
    } else if (r.type === "message" && r.message.role === "assistant") {
      answers.push(textOf(r.message.content));
      lastAssistant = r.message;
    }
  }
  // A final reply that exists only in the thinking channel is still something the model asserted: check it too.
  if (lastAssistant && lastAssistant.stopReason === "stop" && textOf(lastAssistant.content).trim() === "") {
    answers.push((lastAssistant.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join(""));
  }
  // Consecutive chunks of one file are stitched in offset order so a number split by a chunk edge is still found.
  for (const p of new Set(chunks.map((c) => c.path))) {
    ledger.addSource(p, chunks.filter((c) => c.path === p).sort((a, b) => a.offset - b.offset).map((c) => c.text).join(""));
  }
  const checked = answers.flatMap((a) => checkText(a, ledger));
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
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderResult({ rec, runId, summary: s, provenance: p, auditRelPath, note }: ResultInput): string {
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
    ["context_flag", s?.contextFlag ? "YES (peak prompt + output > 7500)" : "no"],
    ["audit_log", auditRelPath ?? "none"],
  ];
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
