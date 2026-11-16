// Figure provenance: where does each number in an answer come from? Pure, deterministic, no model, no I/O.
//   S = appears in text the model was shown from the source (read_file and read_page results)
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
// What is a figure? One order, applied to the source text and to the answer alike, so both sides always agree:
//   1. LABELS (below) are blanked first: names and codes that contain digits (file names, forms, pages, dates and fiscal
//      periods, "Note 7", "ASC 606", and a whole number joined to a word by a hyphen: COVID-19, 30-day, Rule 10b-5).
//   2. Every number left is extracted (extractNumbers); then a list number, a bare year or a usual constant is not a figure (K).
//   3. Anything else is a figure and is traced to the file, the question or the calculator.
// A whole number joined to a word by a hyphen is a label only when it has no unit marker: a currency sign, %, decimals,
// a thousands comma, a scale word, or digits on both sides of the hyphen ("$500-million", "5-10%", "2.5-year",
// "1,200-person", "$5-6 million", "2022-2023") keep it a figure. Left on purpose, as written, not guessed: a bare whole
// number after a hyphen or a citation word is a label even if meant as an amount ("Revenue-5", "Item 500"); "2016-13" alone is
// a range; "3M" is checked but not marked (looksLikeName, sources.ts).
const LB = String.raw`(?<![\p{L}\p{N}_.,$€£-])`; // not inside a word or number, not after a currency sign or a hyphen
const END = String.raw`(?![\p{L}\p{N}]|[.,]\d|%)`; // not followed by more digits, a decimal, a thousands comma or a percent
const HY = String.raw`[-‐‑]`; // hyphen, and the typographic hyphens NFKC leaves alone
const SCALEW = String.raw`(?!(?:thousand|million|billion|trillion|bn|mm|k|m|b|percent|percentage|basis|bps?|pct)\b)`; // "500-million", "5-percent" and "25-basis-point" are amounts, "30-day" is not
// Things that look like numbers but are labels. Replaced by a space before extraction. Order matters: the code and
// number-hyphen-word rules run before letters-hyphen-number (or "3-for-1" leaves a stray 3), and the citation words last (or "Rule 10b5-1" is cut in two).
const LABELS: RegExp[] = [
  /[\w./\\-]+\.(?:txt|csv|md|json|jsonl|pdf)\b/gi, // file names such as fb-00001.txt or filings/ACME_2023_10K.pdf
  /\b(?:10-?[KQ]|8-?K|20-?F|S-1)\b/gi, // form names
  /\bpages?\s+\d+\s+of\s+\d+\b/gi, // "page 68 of 136" (read_page headers); before the generic page pattern below
  /\bparts?\s+\d+(?:\s+of\s+\d+)?\b/gi, // "part 2 of 3"
  /\bpp?\.\s?\d+(?:\s*[-–]\s*\d+)?\b/gi, // "p.68", "pp. 66-68"
  /\b(?:FY|CY|Q|H)\s?'?\d{1,4}(?:-\d{2,4}(?![\d%]|[.,]\d)|\b)/gi, // FY2021, Q1, H2, FY2022-23, Q3-2022
  /\b\d[QH]\b/gi, // 1Q, 2H
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?!\\d|%|[.,]\\d)(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, "g"), // December 31, 2018 (case-sensitive, day not a figure)
  /\b(?:rows?|lines?|pages?|notes?|steps?|chunks?|characters?|offsets?|sections?|exhibits?)\s+\d+(?:\s*[-–]\s*\d+)?(?!\s?%|\.\d+\s?(?:%|(?:percent|thousand|million|billion|trillion|bn|mm)\b))/gi, // "row 12", "characters 0-1775" (not "Note 7.5% of revenue")
  new RegExp(LB + String.raw`(?!\d+(?:bn|mm|k|m)\d*-)\d+[a-z]{1,2}\d*${HY}\d+` + END, "gu"), // "10b-5", "10b5-1", "12b-25" (lowercase: "5M-6M" is a range)
  new RegExp(LB + String.raw`\d+${HY}` + SCALEW + String.raw`\p{L}+(?:${HY}\d+)?(?![\d%]|[.,]\d)`, "gu"), // "30-day", "7-Eleven", "3-for-1" ("500-million" stays)
  new RegExp(LB + String.raw`\p{L}+${HY}\d+` + END, "gu"), // "COVID-19", "A-1", "SFAS-142"
  /\b(?:ASC|ASU|SFAS|FAS|IFRS|IAS|Topics?|Rules?|Regulations?|Items?|Articles?|Schedules?)[ \t]+\d+(?:-\d+)*[A-Za-z]?(?![\d%]|[.,-]\d)/gi, // "ASC 606", "ASU 2016-13", "Item 1A" (whole numbers only: "Rule 4.5 billion" is an amount)
];

/** Unicode and markup clean-up shared by source and answer text. */
export function normalise(text: string): string {
  let t = text.normalize("NFKC").replace(ZERO_WIDTH, "");
  t = t.replace(/−/g, "-").replace(/\\%/g, "%").replace(/\\[a-zA-Z]+/g, " "); // LaTeX: \frac \times \text ...
  for (const re of LABELS) t = t.replace(re, " ");
  return t;
}

/**
 * `text` with the label text that normalise() blanks (file names, "p. 45", "Note 7", form names, dates) overwritten by
 * spaces of the same length, so a position found in it is a position in `text`. Used to place a mark in the raw answer:
 * normalise() itself shifts positions, so token indexes cannot be used there.
 */
export function maskLabels(text: string): string {
  let t = text;
  for (const re of LABELS) t = t.replace(re, (s) => " ".repeat(s.length));
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

/** Where in a source a figure was printed. Only records added with `SourceMeta` have one. */
export interface Where {
  file: string;
  page?: number;
  /** The original line the figure is on; a short snippet of the text around it when its line could not be found (`rowFound` false). */
  row: string;
  rowFound: boolean;
  /** Index of the row in `pageLines`, when the source is a page. */
  lineNo?: number;
  /** Every line of the page the row is on (shared by all records of the page). */
  pageLines?: readonly string[];
  /** Which question of the chat showed it (1 for the first). */
  q: number;
  /** The page number printed on the page, when it was detected. */
  printed?: string;
}

/** What the caller knows about the text it hands to `addSource`: enough to say where each figure was printed. */
export interface SourceMeta {
  file: string;
  page?: number;
  /** All lines of the whole page; `text` may be one part of it. */
  pageLines?: readonly string[];
  /** Index in `pageLines` of the first line of `text`. */
  lineOffset?: number;
  printed?: string;
}

export interface Rec {
  raw: string;
  decimals: number;
  percent: boolean;
  scale?: string;
  origin: "S" | "U";
  label: string;
  where?: Where;
}

/**
 * Whether a number written in an answer can be the source number `r` (the values are already equal: callers look the
 * source numbers up by canonical value):
 *  - it does not claim more decimals than the source has ("15.0" never matches a plain "15"),
 *  - a percent figure matches only a percent or decimal source number (never a plain integer),
 *  - a scale word only conflicts with a DIFFERENT scale word on the source number.
 */
export function tokenMatches(t: NumToken, r: Rec): boolean {
  return t.decimals <= r.decimals && (!t.percent || r.percent || r.decimals > 0) && (!t.scale || !r.scale || t.scale === r.scale);
}

/** True for numbers that are not figures at all: list numbers, bare years and the usual constants. */
export function isNonFigure(t: NumToken): boolean {
  return Boolean(nonFigureReason(t) || yearOrConstantReason(t));
}

/**
 * The original line each token is on (see Ledger.add). The text is normalised as a whole, which can remove a newline
 * (a label such as "December\n31" or "page\n12" is blanked), so a line number counted in the normalised text drifts.
 * Instead each ORIGINAL line is read on its own and the two token sequences, both in text order, are matched forward:
 * a token takes the next line token with the same text and value. A token with no such twin (a scale word on the next
 * line joined it) gets a snippet and does not move the position. Returns undefined if anything goes wrong: locating is
 * a nicety and must never stop a figure from being recorded.
 */
function locateRows(text: string, norm: string, tokens: NumToken[], meta: SourceMeta, q: number): Where[] | undefined {
  try {
    const orig = text.split("\n");
    const flat: { k: number; t: NumToken }[] = [];
    orig.forEach((line, k) => {
      for (const t of extractNumbers(normalise(line))) flat.push({ k, t });
    });
    let p = 0; // next unmatched entry of `flat`
    return tokens.map((t): Where => {
      let at = p;
      while (at < flat.length && !(flat[at].t.raw === t.raw && flat[at].t.canon === t.canon)) at++;
      const base = { file: meta.file, page: meta.page, q, printed: meta.printed };
      if (at >= flat.length) {
        const snippet = norm.slice(Math.max(0, t.index - 40), t.index + t.raw.length + 40).replace(/\s+/g, " ").trim();
        return { ...base, row: snippet, rowFound: false };
      }
      p = at + 1;
      const k = flat[at].k;
      return { ...base, row: orig[k].trim(), rowFound: true, lineNo: meta.pageLines ? (meta.lineOffset ?? 0) + k : undefined, pageLines: meta.pageLines };
    });
  } catch {
    return undefined;
  }
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
  private q = 0; // questions asked in this chat so far

  private add(origin: "S" | "U", label: string, text: string, meta?: SourceMeta): void {
    const norm = normalise(text);
    const tokens = extractNumbers(norm);
    const located = meta ? locateRows(text, norm, tokens, meta, this.q) : undefined;
    tokens.forEach((t, i) => {
      const where = located?.[i];
      const list = this.byCanon.get(t.canon) ?? [];
      // chunks overlap at their edges; two different rows with the same figure are kept apart by their row text
      if (list.some((r) => r.raw === t.raw && r.label === label && r.origin === origin && r.where?.row === where?.row)) return;
      list.push({ raw: t.raw, decimals: t.decimals, percent: t.percent, scale: t.scale, origin, label, where });
      this.byCanon.set(t.canon, list);
    });
  }
  /** Text from the source that the model was actually shown (footers excluded by the caller). With `meta`, each figure also remembers its row. */
  addSource(label: string, text: string, meta?: SourceMeta): void {
    this.add("S", label, text, meta);
  }
  /** The user's message at the start of a question; it also counts the question. */
  addUser(text: string): void {
    this.q++;
    this.add("U", "user message", text);
  }
  /** Which question of the chat is being answered (1 for the first). */
  get question(): number {
    return this.q;
  }
  /** A calculate step result: `full` is the unrounded value, `shown` what the tool told the model to quote. */
  addCalc(name: string, full: string, shown: string, pct: boolean): void {
    this.calcs.push({ name, full: new D(full), shown, pct });
  }
  reset(): void {
    this.byCanon.clear();
    this.calcs = [];
    this.q = 0;
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
   * A token matches a source/user number when the value is equal (sign ignored) and `tokenMatches` agrees: "$7,453
   * million" is the source's "7,453" plus a unit label (statements state their scale in a header), but "$5.5 million"
   * does not match a source "$5.5 billion".
   */
  find(t: NumToken): Rec | undefined {
    return (this.byCanon.get(t.canon) ?? []).find((r) => tokenMatches(t, r));
  }
  /** Every source or user number the token matches, in the order they were recorded (`find` returns the first of these). */
  findAll(t: NumToken): Rec[] {
    return (this.byCanon.get(t.canon) ?? []).filter((r) => tokenMatches(t, r));
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
