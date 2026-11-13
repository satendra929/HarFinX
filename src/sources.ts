// "Where do these numbers appear?": for the figures of an answer, the pages and rows of the files the model read that
// hold them, with the page's title, units, column header and period. Built by the harness from what the model was
// shown (the Ledger's row locations); the model is not involved. It is a number match only: it does not know whether
// the row, the period or the units are the right ones, and says so. Pure: no I/O.
import { extractNumbers, isNonFigure, normalise, type Ledger, type NumToken, type Rec } from "./provenance.ts";
import { nearestHeader, sectionTitle } from "./documents/pages.ts";
import { oneLine } from "./feedback.ts";

/** Shown above the entries, identically every time. */
export const DISCLAIMER = "Where these numbers appear in the pages read. Number match only (not row, period or units): confirm on the page.";

export interface SourceLimits {
  /** A figure on more pages than this is not listed (a capped list would look like the best matches). */
  pagesPerFigure: number;
  rowsPerPage: number;
  entries: number;
}
export const DEFAULT_SOURCE_LIMITS: SourceLimits = { pagesPerFigure: 3, rowsPerPage: 4, entries: 6 };

export interface SourceFigure {
  /** As the source prints it. */
  raw: string;
  /** Which of the row's numbers it is, as a count from 1 and the total ("1st of 2 numbers" is {at: 1, of: 2}): a fact about the row, not a column guess. */
  position?: { at: number; of: number };
  /** The figure is an input of a calculation the model ran, not a figure the answer states. */
  calcInput?: boolean;
}

export interface SourceRow {
  row: string;
  /** Every figure of the answer found on this row (a row holding two of them is one row, not two). */
  figures: SourceFigure[];
  /** The label of the line above, when the row has no label of its own. */
  labelAbove?: string;
  /** The row's own units line, when it differs from the entry's. */
  units?: string;
}

export interface SourceEntry {
  file: string;
  page?: number;
  printed?: string;
  title?: string;
  units?: string;
  columns?: string;
  period?: string;
  /** At least one of its figures was shown during the current question. */
  current: boolean;
  rows: SourceRow[];
  /** Rows beyond the row limit: counted, not listed. */
  moreRows?: number;
}

export interface SourcesResult {
  entries: SourceEntry[];
  /** Figures found on more pages than the limit: said, not listed. */
  many: { figure: string; pages: number }[];
  /** Entries cut by the limit. */
  moreEntries: number;
}

/** One file spelled two ways (./a/B.pdf, a\b.pdf) is one file. */
export function fileKey(file: string): string {
  return file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").toLowerCase();
}

/** The same row seen twice: equal, or one is a cut-off piece of the other (a text file read in overlapping chunks). Short fragments never count. */
function sameRow(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a)));
}

const ORD = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const hasLetters = (s: string) => /[A-Za-z]{2}/.test(s);

/** Where `raw` sits among the numbers of the row's cells after the label; undefined for rows that are not label | number | number. */
export function cellIndex(row: string, raw: string): { at: number; of: number } | undefined {
  const cells = row.split("|");
  if (cells.length < 3) return undefined;
  const numeric = cells.slice(1).filter((c) => extractNumbers(normalise(c)).length > 0);
  const at = numeric.findIndex((c) => extractNumbers(normalise(c)).some((t) => t.raw === raw));
  return at < 0 || numeric.length < 2 ? undefined : { at: at + 1, of: numeric.length };
}

/** "1st of 2 numbers"; for two figures of one row, "1st and 2nd of 2 numbers". */
export function describePositions(figures: readonly SourceFigure[]): string | undefined {
  const ps = figures.map((f) => f.position).filter((p): p is { at: number; of: number } => p !== undefined);
  if (ps.length === 0) return undefined;
  const total = ps[0].of;
  return ps.every((p) => p.of === total) ? `${ps.map((p) => ORD(p.at)).join(" and ")} of ${total} numbers` : ps.map((p) => `${ORD(p.at)} of ${p.of}`).join(", ");
}

/** Kept for readers of one figure: the text for a single position. */
export function cellPosition(row: string, raw: string): string | undefined {
  const at = cellIndex(row, raw);
  return at ? describePositions([{ raw, position: at }]) : undefined;
}

function labelAboveOf(lines: readonly string[] | undefined, lineNo: number | undefined, row: string): string | undefined {
  const label = row.split("|")[0];
  if (hasLetters(label) || !lines || lineNo === undefined) return undefined;
  for (let i = lineNo - 1; i >= Math.max(0, lineNo - 3); i--) {
    const first = lines[i]?.split("|")[0]?.trim();
    if (first && hasLetters(first)) return first;
  }
  return undefined;
}

/**
 * The sources of the given figures. `figures` are the answer's numbers; `calcInputs` the printed numbers the model
 * gave the calculator during this question (shown the same way, marked as inputs). Years, list numbers and constants
 * are skipped. A figure with no recorded row (not read from a file page or text, or typed by the user only) has no entry.
 */
export function buildSources(figures: readonly NumToken[], calcInputs: readonly NumToken[], ledger: Ledger, limits: SourceLimits = DEFAULT_SOURCE_LIMITS): SourcesResult {
  const wanted = new Map<string, { token: NumToken; calcInput: boolean }>();
  for (const t of figures) if (!isNonFigure(t) && !wanted.has(t.raw)) wanted.set(t.raw, { token: t, calcInput: false });
  for (const t of calcInputs) if (!isNonFigure(t) && !wanted.has(t.raw)) wanted.set(t.raw, { token: t, calcInput: true });

  const entries = new Map<string, SourceEntry>();
  const many: SourcesResult["many"] = [];
  for (const { token, calcInput } of wanted.values()) {
    const recs = ledger.findAll(token).filter((r): r is Rec & { where: NonNullable<Rec["where"]> } => r.where !== undefined);
    if (recs.length === 0) continue;
    const places = new Set(recs.map((r) => `${fileKey(r.where.file)}#${r.where.page ?? ""}`));
    if (places.size > limits.pagesPerFigure) {
      many.push({ figure: recs[0].raw, pages: places.size });
      continue;
    }
    for (const r of recs) {
      const w = r.where;
      const key = `${fileKey(w.file)}#${w.page ?? ""}`;
      let entry = entries.get(key);
      const header = w.pageLines && w.lineNo !== undefined ? nearestHeader(w.pageLines, w.lineNo) : {};
      if (!entry) {
        entry = { file: w.file, page: w.page, printed: w.printed, title: w.pageLines ? sectionTitle(w.pageLines) : undefined, units: header.units, columns: header.columns, period: header.period, current: false, rows: [] };
        entries.set(key, entry);
      }
      if (w.q === ledger.question) entry.current = true;
      // The figure is shown as the source prints it (r.raw), not as the answer wrote it ("$5,818 million").
      const figure: SourceFigure = { raw: r.raw, position: cellIndex(w.row, r.raw), calcInput: calcInput || undefined };
      const same = entry.rows.find((x) => sameRow(x.row, w.row));
      if (same) {
        if (w.row.length > same.row.length) same.row = w.row; // a text file read in overlapping chunks first gives a cut-off line: keep the whole one
        if (!same.figures.some((f) => f.raw === r.raw)) same.figures.push(figure);
        continue;
      }
      entry.rows.push({
        row: w.row,
        figures: [figure],
        labelAbove: labelAboveOf(w.pageLines, w.lineNo, w.row),
        units: header.units !== undefined && header.units !== entry.units ? header.units : undefined,
      });
    }
  }
  const ordered = [...entries.values()].map((e) => ({ ...e, moreRows: Math.max(0, e.rows.length - limits.rowsPerPage), rows: e.rows.slice(0, limits.rowsPerPage) }));
  ordered.sort((a, b) => Number(b.current) - Number(a.current)); // current question first; sort is stable, so the order read is kept inside each group
  return { entries: ordered.slice(0, limits.entries), many, moreEntries: Math.max(0, ordered.length - limits.entries) };
}

const ROW_CHARS = 100;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where `raw` occurs in `text` as a whole number: not inside another one ("250" in "1,250" or "2,500" does not count). -1 if there is none. */
export function indexOfFigure(text: string, raw: string): number {
  return new RegExp(`(?<![\\d,.])${escapeRegExp(raw)}(?!\\d|[.,]\\d)`).exec(text)?.index ?? -1;
}

/** The row with each figure marked `[like this]` (the first occurrence of each), cut around the first mark so it is always visible. */
function markRow(row: string, figures: readonly string[]): string {
  // the same character clean-up the figure checker applies, so a Unicode minus in the row still meets the figure's "-"
  const clean = oneLine(row, 10_000).normalize("NFKC").replace(/−/g, "-");
  const found: { at: number; raw: string }[] = [];
  const missing: string[] = [];
  for (const raw of figures) {
    const at = indexOfFigure(clean, raw);
    // two figures that are the same text on one row (or overlap) are marked once
    if (at < 0 || found.some((f) => at < f.at + f.raw.length && f.at < at + raw.length)) {
      if (at < 0) missing.push(raw);
      continue;
    }
    found.push({ at, raw });
  }
  found.sort((a, b) => a.at - b.at);
  let marked = "";
  let pos = 0;
  for (const f of found) {
    marked += clean.slice(pos, f.at) + `[${f.raw}]`;
    pos = f.at + f.raw.length;
  }
  marked += clean.slice(pos);
  const from = found.length ? Math.max(0, found[0].at - Math.floor(ROW_CHARS / 2)) : 0;
  const cut = oneLine((from > 0 ? "…" : "") + marked.slice(from), ROW_CHARS);
  return cut + missing.map((m) => `   [${oneLine(m, 30)}]`).join("");
}

/** The lines to show (plain text; the CLI makes them dim). Empty when there is nothing to show. */
export function formatSources(r: SourcesResult): string[] {
  if (r.entries.length === 0 && r.many.length === 0) return [];
  const out = [DISCLAIMER];
  for (const e of r.entries) {
    const head = [oneLine(e.file, 60), e.page !== undefined ? `p.${e.page}${e.printed ? ` [printed ${oneLine(e.printed, 8)}]` : ""}` : "", e.title ? oneLine(e.title, 70) : "", e.units ? oneLine(e.units, 40) : "", e.period ? oneLine(e.period, 40) : ""].filter(Boolean);
    out.push("  " + head.join("  "));
    e.rows.forEach((x, i) => {
      const parts = [(x.labelAbove ? `(? ${oneLine(x.labelAbove, 30)})  ` : "") + markRow(x.row, x.figures.map((f) => f.raw))];
      const position = describePositions(x.figures);
      if (position) parts.push(position);
      if (x.units) parts.push(oneLine(x.units, 40));
      if (x.figures.every((f) => f.calcInput)) parts.push("used in a calculation");
      if (i === 0 && e.columns) parts.push(`columns: ${oneLine(e.columns, 60)}`);
      out.push("    " + parts.join("     "));
    });
    if (e.moreRows) out.push(`    and ${e.moreRows} more row${e.moreRows === 1 ? "" : "s"}`);
  }
  for (const m of r.many) out.push(`  ${oneLine(m.figure, 30)} appears on ${m.pages} pages; not listed`);
  if (r.moreEntries > 0) out.push(`  and ${r.moreEntries} more page${r.moreEntries === 1 ? "" : "s"}`);
  return out;
}

/** A compact record of what was shown, for the audit log. */
export function sourcesForAudit(r: SourcesResult): { file: string; page?: number; printed?: string; rows: string[] }[] {
  return r.entries.map((e) => ({ file: e.file, page: e.page, printed: e.printed, rows: e.rows.map((x) => oneLine(x.row, 120)) }));
}
