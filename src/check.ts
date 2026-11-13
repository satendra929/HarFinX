// Live figure check: after each answer, say which figures can be traced to the file the model read, the user's
// question or the calculator (src/provenance.ts), and which cannot. Warn-only: it never changes or blocks an answer.
// "Traced" means traceable, not correct. Pure functions here; the CLI prints and logs the result.
import { checkText, type Checked, type Class, type Ledger } from "./provenance.ts";

export interface CheckSummary {
  /** Numbers that are figures: S + U + C + X (years, list numbers and other non-figures are left out). */
  figures: number;
  counts: Record<Class, number>;
  /** Distinct unverified figures as written, with a snippet of the surrounding answer text. */
  unverified: { raw: string; context: string }[];
}

const MAX_LISTED = 5;

/** The visible answer of the current question: text blocks of every assistant message after the last user message. */
export function answerTextSince(messages: readonly unknown[]): string {
  const list = messages as { role?: string; content?: unknown }[];
  let lastUser = -1;
  list.forEach((m, i) => {
    if (m?.role === "user") lastUser = i;
  });
  return list
    .slice(lastUser + 1)
    .filter((m) => m?.role === "assistant" && Array.isArray(m.content))
    .flatMap((m) => m.content as { type?: string; text?: unknown }[])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export function summarizeCheck(checked: Checked[]): CheckSummary {
  const counts: Record<Class, number> = { S: 0, U: 0, C: 0, K: 0, X: 0 };
  const unverified = new Map<string, string>();
  for (const c of checked) {
    counts[c.cls]++;
    if (c.cls === "X" && !unverified.has(c.token.raw)) unverified.set(c.token.raw, c.context);
  }
  return {
    figures: counts.S + counts.U + counts.C + counts.X,
    counts,
    unverified: [...unverified].map(([raw, context]) => ({ raw, context })),
  };
}

// A claim that the calculator was used: "the calculate tool", "calculator tool", "my calculate call", "calculator output",
// "using/via/with (the) calculate", "called/ran calculate", a "Tool used: calculate" footer; names may be in backticks or
// bold. "calculated as (A - B) / B" (a definition), "a calculator" (generic) and "recalculate" are not claims.
const W = "[`*]*";
const CALC_CLAIM = new RegExp(
  `\\b(?:calculat(?:e|or|ion)${W}\\s+tool` +
    `|calculat(?:e|or)${W}\\s+(?:call|output)` +
    `|(?:using|used|with|via|by|through|from|called|ran|invoked|executed)\\s+(?:the\\s+)?${W}calculat(?:e|or)${W}(?![a-z])` +
    `|tools?(?:\\s+used)?:\\s*${W}calculate\\b)`,
  "i",
);
// Negations in the words just before a match ("I did not use the calculate tool", "Neither the calculate tool nor ...") ...
const NEGATION = /\b(?:not|never|no|neither|nor|without|didn'?t|did\s+not|don'?t|haven'?t|hasn'?t|hadn'?t|wasn'?t|weren'?t|isn'?t|won'?t|cannot|can'?t|unable)\b[^.\n]{0,40}$/i;
// ... and right after one ("The calculate tool was not used", "... was unavailable", "... wasn't called").
const NEGATED_AFTER = new RegExp(
  `^${W}(?:\\s+tool)?${W}\\s+(?:(?:was|were|is|are|has|have|had)\\s+(?:not|never|unavailable)|wasn'?t|weren'?t|isn'?t|hasn'?t|haven'?t|never|not\\s+(?:available|used|called|run|needed))`,
  "i",
);

/**
 * The phrase in which the answer claims to have used the calculate tool, or undefined. A negated mention ("I did not
 * use the calculate tool", "the calculate tool was not used") is not a claim. Text inside code fences is ignored.
 */
export function calculationClaim(answer: string): string | undefined {
  const text = answer.replace(/```[\s\S]*?```/g, " ");
  for (const m of text.matchAll(new RegExp(CALC_CLAIM.source, "gi"))) {
    const before = text.slice(Math.max(0, m.index! - 60), m.index!);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    if (NEGATION.test(before) || NEGATED_AFTER.test(after)) continue;
    return m[0].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/**
 * The line to show when the answer says it used the calculate tool but none ran in this question, else undefined.
 * Such an answer's derived figures were not computed by the harness: they come from the model's own arithmetic.
 */
export function calculationClaimLine(answer: string, calculationsRun: number): { text: string; phrase: string } | undefined {
  if (calculationsRun > 0) return undefined;
  const phrase = calculationClaim(answer);
  if (!phrase) return undefined;
  return {
    phrase,
    text: `[check] The answer says "${phrase}", but no calculation ran for this question: any figure it derived is the model's own arithmetic. Verify those figures, or ask again and require the calculate tool.`,
  };
}

/** Checks one answer's text against the ledger. */
export function checkAnswer(text: string, ledger: Ledger): CheckSummary {
  return summarizeCheck(checkText(text, ledger));
}

/** The line to show the user, or undefined when the answer has no figures. `warn` is true when something is unverified. */
export function checkLine(s: CheckSummary): { text: string; warn: boolean } | undefined {
  if (s.figures === 0) return undefined;
  if (s.unverified.length > 0) {
    const listed = s.unverified.slice(0, MAX_LISTED).map((u) => u.raw);
    const more = s.unverified.length - listed.length;
    const n = s.unverified.length;
    return {
      warn: true,
      text: `[check] ${n} figure${n === 1 ? "" : "s"} not traced to your file, your question or the calculator: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Verify ${n === 1 ? "it" : "them"} against the source.`,
    };
  }
  return {
    warn: false,
    text: `[check] ${s.figures} figure${s.figures === 1 ? "" : "s"} traced to your file, your question or the calculator (traceable, not necessarily correct)`,
  };
}
