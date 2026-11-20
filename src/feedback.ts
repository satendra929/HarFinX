// What the terminal shows about the agent's work: one dim line per tool call that names its target, and the helper that
// makes any model-controlled text safe to print. Pure functions; the CLI does the printing.
// Colour convention: yellow is reserved for the harness acting (limits, blocks, warnings); routine progress is dim.

// Controls (C0, DEL, C1, including newline and tab), format characters (bidi marks, zero-width characters, soft hyphen,
// BOM), line and paragraph separators, and lone surrogates. With the `u` flag a paired surrogate is one code point and is kept.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/**
 * Text from the model or from file names, made safe for one terminal line: unsafe characters become spaces, runs of
 * whitespace collapse, and the result is cut (by code point) with an ellipsis. Never returns a newline.
 */
export function oneLine(value: unknown, max = 80): string {
  const s = (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)).replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  const cps = [...s];
  return cps.length > max ? cps.slice(0, Math.max(0, max - 1)).join("") + "…" : s;
}

/** Share of the per-question call limit from which the count is worth showing. */
export const COUNTER_FROM = 0.75;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The expression text of a calculate call: every step's expr, or the single expr; empty when it has none (a help request). */
function calcExprs(a: Record<string, unknown>): string {
  const steps = Array.isArray(a.steps) ? a.steps : [];
  const fromSteps = steps.map((s) => (typeof asRecord(s).expr === "string" ? (asRecord(s).expr as string) : "")).filter(Boolean);
  if (fromSteps.length) return fromSteps.join("; ");
  return typeof a.expr === "string" ? a.expr : "";
}

/**
 * One dim line for a tool call that is starting: what it does and to what (`→ read page 68 of filings/X.pdf`).
 * `n` is this call's number in the question and `max` the limit; the count is shown only near the limit, never past it.
 */
export function toolLine(name: string, args: unknown, n: number, max: number): string {
  const a = asRecord(args);
  const file = typeof a.path === "string" ? oneLine(a.path, 60) : undefined;
  let what: string;
  switch (name) {
    case "read_page":
      what = `read page ${oneLine(a.page, 8)}${a.part !== undefined && a.part !== 1 ? ` (part ${oneLine(a.part, 4)})` : ""} of ${file ?? "?"}${typeof a.find === "string" && a.find.trim() ? ` (around "${oneLine(a.find, 40)}")` : ""}`;
      break;
    case "search":
      what = `search "${oneLine(a.query, 50)}"${file ? ` in ${file}` : ""}${typeof a.section === "string" && a.section.trim() ? ` (section ${oneLine(a.section, 30)})` : ""}`;
      break;
    case "outline":
      what = `outline of ${file ?? "?"}`;
      break;
    case "list_files":
      what = "list files";
      break;
    case "read_file":
      what = `read ${file ?? "?"}${a.offset !== undefined && a.offset !== 0 ? ` from character ${oneLine(a.offset, 10)}` : ""}`;
      break;
    case "read_skill":
      what = `read skill ${oneLine(a.name, 64)}`;
      break;
    case "calculate": {
      const e = oneLine(calcExprs(a), 70);
      what = e ? `calculate  ${e}` : "calculate";
      break;
    }
    default: {
      const first = Object.values(a).find((v) => typeof v === "string");
      what = `${oneLine(name, 30)}${typeof first === "string" ? "  " + oneLine(first, 50) : ""}`;
    }
  }
  const show = max > 0 && n <= max && n >= Math.ceil(COUNTER_FROM * max);
  return `→ ${what}${show ? `   (call ${n} of ${max})` : ""}`;
}

// ---- what to tell the user when a question ends badly ---------------------------------------------------------------
// Each message says what happened and what to do next. None of them names a file, a filing or a model.

/** The question used more tool calls than the limit allows. */
export function callLimitMessage(reason: string): string {
  return `Stopped: ${oneLine(reason, 120)}. The question needed more steps than the limit allows. Ask a narrower question (name the file, the statement and the year), or split it into two.`;
}

/** The model looped (the same call over and over, or reasoning without end) and was stopped. */
export function loopMessage(reason: string): string {
  return `The model got stuck in a loop and was stopped (${oneLine(reason, 120)}). Ask again, or rephrase the question; a narrower question usually helps.`;
}

/** After one retry the model still returned nothing: the advice depends on how much it had already tried. */
export function emptyAnswerHint(calls: number, max: number): string {
  return max > 0 && calls >= Math.ceil(COUNTER_FROM * max)
    ? `it used ${calls} of ${max} tool calls without reaching an answer; ask for one specific figure (name the file, the statement and the year)`
    : "ask again, or rephrase the question";
}

/** The question ran into the budget for file text (the guard blocked later reads), so the answer may be built on part of what it needed. */
export function budgetNote(reason: string): string {
  return `[limit] ${oneLine(reason, 120)}. The answer may be incomplete: ask about one statement or page at a time.`;
}

/** The dim line shown after a search finishes: the pages it returned, so a wrong pick is visible. Undefined when the result has no page list. */
/** The dim line under an outline call: how many sections were found. */
export function outlineResultLine(details: unknown): string | undefined {
  const d = asRecord(details);
  if (typeof d.found !== "boolean") return undefined;
  if (!d.found) return "  → no outline found";
  const part = (n: unknown, w: string) => (typeof n === "number" && n > 0 ? [`${n} ${w}${n === 1 ? "" : "s"}`] : []);
  return `  → ${[...part(d.items, "Item"), ...part(d.statements, "statement"), ...part(d.notes, "Note")].join(", ")}`;
}

export function searchResultLine(details: unknown): string | undefined {
  const pages = asRecord(details).pages;
  if (!Array.isArray(pages)) return undefined;
  const nums = pages.filter((p): p is number => Number.isInteger(p));
  const seen = new Set(Array.isArray(asRecord(details).opened) ? (asRecord(details).opened as unknown[]) : []);
  return nums.length ? `  → ${nums.map((p) => `p.${p}${seen.has(p) ? " (opened)" : ""}`).join(", ")}` : "  → no page matched";
}
