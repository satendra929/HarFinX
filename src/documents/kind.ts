// What kind of document is this? A scored, explainable check on the page texts of a parsed PDF: is it a US annual or
// quarterly report (10-K, 10-Q), a current report (8-K), an earnings release, or something else or unclear?
// The answer decides whether the standardized statement tools may be used; "unknown" only removes that path (search and
// page reading still work), so a wrong "unknown" costs speed, never an answer. Pure: no I/O. General rules about how
// these forms are printed (the cover block is prescribed by the form); nothing about any company, and the file name is
// never read.
import { outlineOf, type Outline } from "./outline.ts";

export type Form = "10-K" | "10-Q" | "8-K" | "earnings" | "unknown";
export type Confidence = "high" | "medium" | "unknown";

export interface DocKind {
  form: Form;
  confidence: Confidence;
  score: number;
  /** Every rule that fired, in plain words ("+3 cover names the SEC"), so a wrong call can be traced. */
  signals: string[];
}

/** Pages scanned for the cover and the signals: a glossy annual report can hold the 10-K after marketing pages. */
export const SCAN_PAGES = 15;
const COVER_PAGES = 3;

const FORM_LINE = /^\W*(?:FORM\s+)(10-K|10-Q|8-K)(?:\/A)?\W*(?:\(Mark One\))?\W*$/i;
const PURSUANT: [RegExp, Form][] = [
  [/ANNUAL REPORT PURSUANT TO SECTION 13 OR 15\(?d\)?/i, "10-K"],
  [/QUARTERLY REPORT PURSUANT TO SECTION 13 OR 15\(?d\)?/i, "10-Q"],
  [/(?:^|\W)CURRENT REPORT(?:\W|$).*PURSUANT TO SECTION 13 OR 15\(?d\)?|^\W*CURRENT REPORT\W*$/i, "8-K"],
];
const NEGATIVE = /(?:SCHEDULE\s+14A|PROXY STATEMENT|PROSPECTUS|REGISTRATION STATEMENT|OFFERING MEMORANDUM|INFORMATION STATEMENT)/i;
const RESULTS_HEADLINE = /\b(?:announces?|reports?|reported|posts?)\b.{0,80}\b(?:results|earnings|quarter|fiscal|year)\b/i;

const RELEASE_MARK = /^\W*(?:FOR\s+IMMEDIATE\s+RELEASE|PRESS\s+RELEASE)\W*$/i;
const words = (s: string) => (s.match(/[A-Za-z]{2,}/g) ?? []).length;

/** The cover form of a document: the form named on its own line, or the title phrase; undefined when none or when they disagree. */
function coverForm(cover: readonly string[], signals: string[]): Form | undefined {
  const named = new Set<Form>();
  const phrased = new Set<Form>();
  for (const raw of cover) {
    const line = raw.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim();
    if (!line || line.length > 160) continue;
    const m = FORM_LINE.exec(line);
    if (m) named.add(m[1].toUpperCase() as Form);
    for (const [re, f] of PURSUANT) if (re.test(line)) phrased.add(f);
  }
  const all = new Set<Form>([...named, ...phrased]);
  if (all.size === 1) {
    signals.push(`+3 cover names the form: ${[...all][0]}${named.size && phrased.size ? " (by form line and title phrase)" : named.size ? " (form line)" : " (title phrase)"}`);
    return [...all][0];
  }
  if (all.size > 1) signals.push(`0 cover names different forms (${[...all].join(", ")}): not used`);
  return undefined;
}

export function classifyDocument(pages: readonly string[], outline: Outline = outlineOf(pages)): DocKind {
  const signals: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    score += n;
    signals.push(`${n > 0 ? "+" : ""}${n} ${why}`);
  };
  if (pages.length === 0) return { form: "unknown", confidence: "unknown", score: 0, signals: ["no pages"] };

  const head = pages.slice(0, SCAN_PAGES);
  // The cover is page 1 to 3; in a glossy annual report that wraps the filing it is a later page that names the form on
  // a line of its own and the Commission on the same page.
  const coverIdx = new Set(head.map((_, i) => i).filter((i) => i < COVER_PAGES));
  head.forEach((p, i) => {
    if (i >= COVER_PAGES && /SECURITIES\s+AND\s+EXCHANGE\s+COMMISSION/i.test(p) && p.split("\n").some((l) => FORM_LINE.test(l.replace(/\s*\|\s*/g, " ").trim()))) coverIdx.add(i);
  });
  const coverLines = [...coverIdx].sort((a, b) => a - b).flatMap((i) => head[i].split("\n"));
  const coverText = coverLines.join("\n");

  // The cover block (prescribed by the form)
  const form = coverForm(coverLines, signals);
  if (form) score += 3;
  if (/SECURITIES\s+AND\s+EXCHANGE\s+COMMISSION/i.test(coverText)) add(3, "cover names the Securities and Exchange Commission");
  if (/Commission\s+File\s+(?:Number|No\.?)/i.test(coverText) && /\b\d{3}-\d{4,6}\b/.test(coverText)) add(2, "cover has a commission file number");
  if (/exact\s+name\s+of\s+registrant/i.test(coverText)) add(2, "cover has the registrant line");
  if (/pursuant\s+to\s+section\s+13\s+or\s+15\(?d\)?/i.test(coverText)) add(2, "cover cites section 13 or 15(d)");
  if (/(?:large\s+accelerated\s+filer|smaller\s+reporting\s+company)/i.test(coverText)) add(1, "cover has the filer-status boxes");

  // The body: Items in order and the primary statements
  const itemIds = new Set(outline.entries.filter((e) => e.kind === "item").map((e) => e.id.replace(/^Part [IV]+ /i, "")));
  const stmts = new Set(outline.entries.filter((e) => e.kind === "statement").map((e) => e.id));
  const core = ["Balance sheet", "Income statement", "Cash flow statement"].filter((s) => stmts.has(s));
  if (itemIds.size >= 4) add(3, `${itemIds.size} Item headings in order`);
  if (core.length) add(core.length, `${core.length} primary statement${core.length === 1 ? "" : "s"} found (${core.join(", ")})`);

  // Documents that mention SEC language but are not the report
  if (coverLines.some((l) => l.length <= 120 && NEGATIVE.test(l))) add(-4, "cover block names a proxy statement, prospectus or registration statement");
  const median = [...head.map(words)].sort((a, b) => a - b)[Math.floor(head.length / 2)] ?? 0;
  if (head.length >= 6 && median < 40) add(-2, `pages are sparse (median ${median} words): slides or a brochure`);

  // An earnings release: no prescribed cover, a results headline at the top, and statement tables
  const top = pages.slice(0, 2).flatMap((p) => p.split("\n")).slice(0, 40);
  const headline = top.find((l) => l.length <= 200 && (RESULTS_HEADLINE.test(l) || RELEASE_MARK.test(l)));
  const tables = (pages.slice(0, SCAN_PAGES).join("\n").match(/\|/g) ?? []).length >= 40;

  let kind: Form = "unknown";
  let confidence: Confidence = "unknown";
  if (form && score >= 8) {
    kind = form;
    confidence = "high";
  } else if (form && score >= 4) {
    kind = form;
    confidence = "medium";
  } else if (!form && headline && tables && score >= 0) {
    kind = "earnings";
    confidence = "medium";
    signals.push("0 no prescribed cover, a results headline at the top and statement tables: an earnings release");
  } else if (!form && core.length >= 2 && itemIds.size >= 4) {
    // A report whose cover was not recognised (a glossy annual report that wraps the filing): the body says what it is.
    kind = "unknown";
    signals.push("0 report-like body without a recognised cover: form not named");
  }
  return { form: kind, confidence, score, signals };
}

/** The structured statement tools apply only to annual and quarterly reports that the detector is sure of. */
export const supportsStatements = (k: DocKind): boolean => (k.form === "10-K" || k.form === "10-Q") && k.confidence !== "unknown";
