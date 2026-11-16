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

/** The line to show the user: a warning when a figure is unverified, otherwise nothing. */
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
  return undefined; // everything traced: nothing to say (the numbers are in the audit log); a clean line under every answer was noise
}
