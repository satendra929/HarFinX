// Figure provenance: where does each number in an answer come from? Pure, deterministic, no model, no I/O.
//   S = appears in text the model was shown from the source (read_file results)
//   U = appears in the user's own message
//   K = not a figure (year, enumerator, constant, label, file name, ...)
//   X = unverified: not from the source, the user, a calculation, or a known non-figure
//   C = the result of a calculate step (a quoted value must equal the full-precision result rounded to the
//       digits the answer shows, so "11.4%" and "11.35%" both trace to 0.113535...)
// "Verified" means "traceable", not "correct": the checker cannot tell whether the right row or period was chosen.

export interface NumToken {
  raw: string; // as written, e.g. "$1,233", "(473)", "3.06%"
  canon: string; // absolute value, no commas, no leading zeros, no trailing fraction zeros
  decimals: number; // digits written after the decimal point
  percent: boolean;
  money: boolean;
  scale?: string; // thousand | million | billion | trillion | bn | mm | k | m | b
  index: number; // position in the normalised text
  lineStart: boolean; // only markdown/list markers before it on its line
  followedByListMark: boolean; // "1." or "2)" style
}

export type Class = "S" | "U" | "C" | "K" | "X";
export interface Checked {
  token: NumToken;
  cls: Class;
  reason: string; // why: matched source/user raw text, or the K rule, or "unverified"
  context: string;
}

import { D, type Num } from "./calc/num.ts";

// ---- normalisation -------------------------------------------------------------------------------

const ZERO_WIDTH = /[​-‏⁠﻿­]/g;
// Real, capitalised month names only. A looser pattern (Mar[a-z]*) erased "margin 11.35%" and "decrease 5%".
const MONTHS = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
// Things that look like numbers but are labels. Replaced by a space before extraction.
const LABELS: RegExp[] = [
  /[\w./\\-]+\.(?:txt|csv|md|json|jsonl)\b/gi, // file names such as fb-00001.txt
  /\b(?:10-?[KQ]|8-?K|20-?F|S-1)\b/gi, // form names
  /\b(?:FY|CY|Q|H)\s?'?\d{1,4}\b/gi, // FY2021, Q1, H2
  /\b\d[QH]\b/gi, // 1Q, 2H
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?!\\d|%|[.,]\\d)(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, "g"), // December 31, 2018 (case-sensitive, day not a figure)
  /\b(?:rows?|lines?|pages?|notes?|steps?|chunks?|characters?|offsets?|sections?|exhibits?)\s+\d+(?:\s*[-–]\s*\d+)?(?!\s?%)/gi, // "row 12", "characters 0-1775"
];

/** Unicode and markup clean-up shared by source and answer text. */
export function normalise(text: string): string {
  let t = text.normalize("NFKC").replace(ZERO_WIDTH, "");
  t = t.replace(/−/g, "-").replace(/\\%/g, "%").replace(/\\[a-zA-Z]+/g, " "); // LaTeX: \frac \times \text ...
  for (const re of LABELS) t = t.replace(re, " ");
  return t;
}

// ---- extraction ----------------------------------------------------------------------------------

// ( ( )? currency? sign? digits(,ddd)* (.d+)? ( ) )? ( percent )? ( scale )?
const NUM = new RegExp(
  "(?<![\\p{L}\\p{N}_.,])" + // not inside a word or another number
    "(\\()?\\s?([$€£])?\\s?-?" +
    "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?" +
    "(\\))?" +
    "(\\s?(?:%|percent\\b))?" +
    "(?:\\s(thousand|million|billion|trillion)\\b|(bn|mm|[KMB])\\b)?",
  "giu",
);
const ORDINAL = /^(?:st|nd|rd|th)\b/i;
// Scale words are spelled many ways; compare canonical names.
const SCALES: Record<string, string> = { thousand: "thousand", k: "thousand", million: "million", mm: "million", m: "million", billion: "billion", bn: "billion", b: "billion", trillion: "trillion" };

export function canonical(intPart: string, frac = ""): string {
  const i = intPart.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/** All number tokens in already-normalised text. Ordinals ("3rd") are skipped. */
export function extractNumbers(normalised: string): NumToken[] {
  const out: NumToken[] = [];
  for (const m of normalised.matchAll(NUM)) {
    // A ")" with no "(" is not part of the number (e.g. the list marker in "2) text"): leave it in the text.
    const strayClose = Boolean(m[5]) && !m[1];
    const matched = strayClose ? m[0].slice(0, m[0].indexOf(")")) : m[0];
    const after = normalised.slice(m.index! + matched.length);
    const percent = !strayClose && Boolean(m[6]);
    const rawScale = strayClose ? undefined : (m[7] ?? m[8])?.toLowerCase();
    const scale = rawScale ? SCALES[rawScale] : undefined;
    const strayOpen = Boolean(m[1]) && !m[5];
    if (!percent && !scale && ORDINAL.test(after)) continue;
    const lineBegin = normalised.lastIndexOf("\n", m.index! - 1) + 1;
    const before = normalised.slice(lineBegin, m.index!);
    out.push({
      raw: strayOpen ? matched.trim().replace(/^\(\s?/, "") : matched.trim(),
      canon: canonical(m[3], m[4]),
      decimals: m[4]?.length ?? 0,
      percent,
      money: Boolean(m[2]),
      scale,
      index: m.index!,
      lineStart: /^[\s>*#_\-•]*$/.test(before),
      followedByListMark: /^[.)]\s/.test(after) && !m[4],
    });
  }
  return out;
}

// ---- non-figure rules (K) --------------------------------------------------------------------------

const BARE_CONSTANTS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "100", "360", "365", "1000"]);

/** Returns a reason if the token is not a figure at all, else undefined. Order matters: see classify(). */
function nonFigureReason(t: NumToken): string | undefined {
  const bare = t.decimals === 0 && !t.percent && !t.money && !t.scale;
  if (bare && t.lineStart && t.followedByListMark && Number(t.canon) <= 30) return "list number";
  return undefined;
}
function yearOrConstantReason(t: NumToken): string | undefined {
  const bare = t.decimals === 0 && !t.percent && !t.money && !t.scale;
  if (!bare) return undefined; // "10%", "10.0", "$5" are figures, never constants
  if (/^(19|20)\d\d$/.test(t.canon) && !t.raw.includes(",")) return "year";
  if (BARE_CONSTANTS.has(t.canon)) return "constant";
  return undefined;
}

// ---- ledger --------------------------------------------------------------------------------------

interface Rec {
  raw: string;
  decimals: number;
  percent: boolean;
  scale?: string;
  origin: "S" | "U";
  label: string;
}

interface CalcRec {
  name: string;
  full: Num;
  shown: string;
  pct: boolean;
}

export class Ledger {
  private byCanon = new Map<string, Rec[]>();
  private calcs: CalcRec[] = [];

  private add(origin: "S" | "U", label: string, text: string): void {
    for (const t of extractNumbers(normalise(text))) {
      const list = this.byCanon.get(t.canon) ?? [];
      if (list.some((r) => r.raw === t.raw && r.label === label && r.origin === origin)) continue; // chunks overlap at their edges
      list.push({ raw: t.raw, decimals: t.decimals, percent: t.percent, scale: t.scale, origin, label });
      this.byCanon.set(t.canon, list);
    }
  }
  /** Text from the source that the model was actually shown (footers excluded by the caller). */
  addSource(label: string, text: string): void {
    this.add("S", label, text);
  }
  addUser(text: string): void {
    this.add("U", "user message", text);
  }
  /** A calculate step result: `full` is the unrounded value, `shown` what the tool told the model to quote. */
  addCalc(name: string, full: string, shown: string, pct: boolean): void {
    this.calcs.push({ name, full: new D(full), shown, pct });
  }
  reset(): void {
    this.byCanon.clear();
    this.calcs = [];
  }
  get size(): number {
    return this.byCanon.size + this.calcs.length;
  }

  /** A token matches a calculation when it equals the full-precision result rounded (half away from zero) to the token's own decimals; a percent token also matches the value times 100. */
  findCalc(t: NumToken): CalcRec | undefined {
    if (t.canon.length > 40) return undefined;
    const tv = new D(t.canon);
    return this.calcs.find((r) => {
      const forms = t.percent ? [r.full.times(100), r.full] : r.pct ? [r.full, r.full.times(100)] : [r.full];
      return forms.some((f) => tv.eq(f.abs().toDecimalPlaces(t.decimals, D.ROUND_HALF_UP)));
    });
  }

  /**
   * A token matches a source/user number when the value is equal (sign ignored) and:
   *  - it does not claim more decimals than the source has ("15.0" never matches a plain "15"),
   *  - a percent figure matches only a percent or decimal source number (never a plain integer),
   *  - a scale word only conflicts with a DIFFERENT scale word on the source number: "$7,453 million" is the
   *    source's "7,453" plus a unit label (statements state their scale in a header), but "$5.5 million" does
   *    not match a source "$5.5 billion".
   */
  find(t: NumToken): Rec | undefined {
    return (this.byCanon.get(t.canon) ?? []).find(
      (r) => t.decimals <= r.decimals && (!t.percent || r.percent || r.decimals > 0) && (!t.scale || !r.scale || t.scale === r.scale),
    );
  }
}

// ---- classification ------------------------------------------------------------------------------

export function classify(t: NumToken, ledger: Ledger): { cls: Class; reason: string } {
  const nf = nonFigureReason(t);
  if (nf) return { cls: "K", reason: nf };
  const rec = ledger.find(t);
  if (rec) return { cls: rec.origin, reason: `matches "${rec.raw}" in ${rec.label}` };
  const calc = ledger.findCalc(t);
  if (calc) return { cls: "C", reason: `calculate step "${calc.name}" (shown "${calc.shown}")` };
  const yc = yearOrConstantReason(t);
  if (yc) return { cls: "K", reason: yc };
  return { cls: "X", reason: "unverified: not in the source, the question, or a known non-figure" };
}

/** Checks every number in a piece of answer text. */
export function checkText(text: string, ledger: Ledger): Checked[] {
  const norm = normalise(text);
  return extractNumbers(norm).map((token) => {
    const { cls, reason } = classify(token, ledger);
    const context = norm.slice(Math.max(0, token.index - 30), token.index + token.raw.length + 20).replace(/\s+/g, " ").trim();
    return { token, cls, reason, context };
  });
}

export const unverified = (checked: Checked[]): Checked[] => checked.filter((c) => c.cls === "X");
