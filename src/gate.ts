// The figure gate: before an answer is shown, every figure in it must be cited (a quote from a page the model read, a
// calculation by the calculator from such numbers, or a figure from the question). A figure that is none of these makes
// the answer fail the gate: the model gets one fixed message naming the figures (repairMessage) and, if it still fails,
// the sentences with those figures are left out (redactUncited). Pure: no I/O.
import { extractNumbers, normalise, type Ledger, type NumToken } from "./provenance.ts";
import { citeFigure } from "./cite.ts";
import { oneLine } from "./feedback.ts";

export interface Failing {
  raw: string;
  /** The sentence the figure is in, shortened. */
  sentence: string;
  reason: string;
}

export const LEFT_OUT_LINE = "Left out: a sentence with a figure that could not be traced to a page or the calculator.";
export const WITHHELD_LINE = "The answer was withheld: its figures could not be traced to a page or the calculator.";

// A full stop after one of these does not end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:vs|e\.g|i\.e|approx|inc|co|corp|ltd|no|nos|u\.s|st|etc|fig|mr|mrs|ms|dr)\.$/i;
// A sentence ends at . ! or ? (and closing quotes or brackets) followed by space and the start of another sentence.
const BOUNDARY = /[.!?]["'”)\]*_`]*\s+(?=[A-Z0-9"“'(\[$*_`#|-])/g;

/** A line cut into sentences; the pieces keep their trailing space, so joining them gives the line back. */
export function splitSentences(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of line.matchAll(BOUNDARY)) {
    const end = m.index! + m[0].length;
    const piece = line.slice(from, m.index! + 1);
    if (ABBREVIATION.test(piece.trimEnd())) continue;
    out.push(line.slice(from, end));
    from = end;
  }
  out.push(line.slice(from));
  return out.filter((p) => p !== "");
}

const tokensOf = (sentence: string): NumToken[] => extractNumbers(normalise(sentence));

/** The uncited figures of one sentence. */
function uncitedIn(sentence: string, ledger: Ledger, question: string | undefined): { token: NumToken; reason: string }[] {
  const out: { token: NumToken; reason: string }[] = [];
  for (const t of tokensOf(sentence)) {
    const c = citeFigure(t, ledger, { sentence, question });
    if (c.kind === "uncited") out.push({ token: t, reason: c.reason });
  }
  return out;
}

/** Every figure of the text that cannot be cited, each with its sentence. Every number is looked at: nothing is skipped because a mark could not be placed. */
export function gateText(text: string, ledger: Ledger, question?: string): Failing[] {
  const failing: Failing[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const s of splitSentences(line)) {
      for (const u of uncitedIn(s, ledger, question)) {
        const key = `${u.token.raw}\u0000${s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        failing.push({ raw: u.token.raw, sentence: oneLine(s.trim(), 80), reason: u.reason });
      }
    }
  }
  return failing;
}

const MAX_NAMED = 5;

/** The fixed message that asks the model to answer again. It names the figures and never says the answer is wrong. */
export function repairMessage(failing: readonly Failing[], canOpenPages: boolean): string {
  const unique: Failing[] = [];
  for (const f of failing) if (!unique.some((u) => u.raw === f.raw && u.sentence === f.sentence)) unique.push(f);
  const named = unique.slice(0, MAX_NAMED);
  const lines = ["Not shown to the user yet: these figures are not copied from a page you opened and were not computed by the calculate tool, so they cannot be shown:"];
  for (const f of named) lines.push(`- "${oneLine(f.raw, 30)}" in: "${f.sentence}"`);
  if (unique.length > named.length) lines.push(`- and ${unique.length - named.length} more`);
  lines.push(
    "For each: if you worked it out, call calculate with the printed numbers as inputs and quote its shown value; " +
      (canOpenPages ? "if it is printed on a page you have not read, open that page; " : "") +
      "otherwise leave it out and say what is missing. Then write the whole answer again.",
  );
  return lines.join("\n");
}

export interface Redaction {
  text: string;
  /** Sentences (or table rows and list items) left out. */
  removed: number;
  /** Nothing was left. */
  withheld: boolean;
  /** The first sentence of the answer was left out: the fixed line goes above what is left. */
  firstRemoved: boolean;
}

const isBlock = (line: string): boolean => /^\s*(?:\||[-*+]\s|\d+[.)]\s)/.test(line); // a table row or a list item goes whole

/** The text without the sentences that hold an uncited figure. Tables rows and list items go whole; a heading left with nothing under it goes too. */
export function redactUncited(text: string, ledger: Ledger, question?: string): Redaction {
  const out: string[] = [];
  let removed = 0;
  let firstRemoved = false;
  let firstSeen = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const first = !firstSeen;
    firstSeen = true;
    const pieces = isBlock(line) ? [line] : splitSentences(line);
    const bad = pieces.map((p) => uncitedIn(p, ledger, question).length > 0);
    if (!bad.some(Boolean)) {
      out.push(line);
      continue;
    }
    removed += bad.filter(Boolean).length;
    if (first && bad[0]) firstRemoved = true;
    const kept = pieces.filter((_, i) => !bad[i]).join("").trimEnd();
    if (kept.trim()) out.push(tidy(kept));
  }
  // a heading with nothing under it, then blank runs
  const cleaned: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (/^#{1,6}\s/.test(out[i])) {
      const next = out.slice(i + 1).find((l) => l.trim());
      if (next === undefined || /^#{1,6}\s/.test(next)) continue;
    }
    if (!out[i].trim() && (cleaned.length === 0 || !cleaned[cleaned.length - 1].trim())) continue;
    cleaned.push(out[i]);
  }
  const result = cleaned.join("\n").trim();
  return { text: result, removed, withheld: removed > 0 && result === "", firstRemoved };
}

/** A line cut at a sentence can leave one half of a bold or code mark: drop an unpaired one. */
function tidy(line: string): string {
  let l = line;
  if (((l.match(/\*\*/g) ?? []).length) % 2 === 1) l = l.replace(/\*\*/g, "");
  if (((l.match(/`/g) ?? []).length) % 2 === 1) l = l.replace(/`/g, "");
  return l;
}

/** The warning line of `FIGURE_FALLBACK=warn`: the answer is shown and its uncited figures are listed. */
export function untracedWarning(failing: readonly Failing[]): string {
  const raws = [...new Set(failing.map((f) => f.raw))];
  const listed = raws.slice(0, MAX_NAMED);
  const more = raws.length - listed.length;
  const n = raws.length;
  return `[check] ${n} figure${n === 1 ? "" : "s"} not traced to your file, your question or the calculator: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Verify ${n === 1 ? "it" : "them"} against the source.`;
}
