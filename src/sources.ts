// "Where do these numbers appear?": for the figures of an answer, the pages and rows of the files the model read that
// hold them, with the page's title, units, column header and period. Built by the harness from what the model was
// shown (the Ledger's row locations); the model is not involved. It is a number match only: it does not know whether
// the row, the period or the units are the right ones, and says so. Pure: no I/O.
import { extractNumbers, isNonFigure, normalise, type Ledger, type NumToken, type Rec } from "./provenance.ts";
import { nearestHeader, sectionTitle } from "./documents/pages.ts";
import { oneLine } from "./feedback.ts";

/** Shown above the entries, identically every time. */
export const DISCLAIMER = "Sources · number match only (not row, period or units): confirm on the page";

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

const DASH_CELL = /^[—–−-]$/;

/** Where `raw` sits among the value cells after the label (a cell with a number, or a lone dash); undefined for rows that are not label | cell | cell. */
export function cellIndex(row: string, raw: string): { at: number; of: number } | undefined {
  const cells = row.split("|");
  if (cells.length < 3) return undefined;
  const numeric = cells.slice(1).filter((c) => DASH_CELL.test(c.trim()) || extractNumbers(normalise(c)).length > 0);
  const at = numeric.findIndex((c) => extractNumbers(normalise(c)).some((t) => t.raw === raw));
  return at < 0 || numeric.length < 2 ? undefined : { at: at + 1, of: numeric.length };
}

/** "1st of 2 cells"; for two figures of one row, "1st and 2nd of 2 cells". */
export function describePositions(figures: readonly SourceFigure[]): string | undefined {
  const ps = figures.map((f) => f.position).filter((p): p is { at: number; of: number } => p !== undefined).sort((a, b) => a.at - b.at);
  if (ps.length === 0) return undefined;
  const total = ps[0].of;
  return ps.every((p) => p.of === total) ? `${ps.map((p) => ORD(p.at)).join(" and ")} of ${total} cells` : ps.map((p) => `${ORD(p.at)} of ${p.of}`).join(", ");
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
const CELL_MAX = 40;
const LABEL_MAX = 44;
const CTX_MAX = 64;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where `raw` occurs in `text` as a whole number: not inside another one ("250" in "1,250" or "2,500" does not count). -1 if there is none. */
export function indexOfFigure(text: string, raw: string): number {
  return new RegExp(`(?<![\\d,.])${escapeRegExp(raw)}(?!\\d|[.,]\\d)`).exec(text)?.index ?? -1;
}

// the same character clean-up the figure checker applies, so a Unicode minus in the row still meets the figure's "-"
const cleanText = (s: string) => oneLine(s, 10_000).normalize("NFKC").replace(/−/g, "-");

/** `text` with each figure marked `[like this]` (the first whole-number occurrence of each). `seen` are the figures found, `first` where the first mark starts (-1 if none). */
function markIn(clean: string, figures: readonly string[]): { text: string; seen: string[]; missing: string[]; first: number } {
  const found: { at: number; raw: string }[] = [];
  const seen: string[] = [];
  const missing: string[] = [];
  for (const raw of figures) {
    const at = indexOfFigure(clean, raw);
    if (at < 0) {
      missing.push(raw);
      continue;
    }
    seen.push(raw);
    // two figures that are the same text on one row (or overlap) are marked once
    if (found.some((f) => at < f.at + f.raw.length && f.at < at + raw.length)) continue;
    found.push({ at, raw });
  }
  found.sort((a, b) => a.at - b.at);
  let text = "";
  let pos = 0;
  for (const f of found) {
    text += clean.slice(pos, f.at) + `[${f.raw}]`;
    pos = f.at + f.raw.length;
  }
  text += clean.slice(pos);
  return { text, seen, missing, first: found.length ? found[0].at : -1 };
}

/** A row that is prose or a single number (not label | number | number): marked and cut around the first mark so it is always visible. */
function markRow(row: string, figures: readonly string[]): string {
  const m = markIn(cleanText(row), figures);
  const from = m.first >= 0 ? Math.max(0, m.first - Math.floor(ROW_CHARS / 2)) : 0;
  const cut = oneLine((from > 0 ? "…" : "") + m.text.slice(from), ROW_CHARS);
  return cut + m.missing.map((x) => `   [${oneLine(x, 30)}]`).join("");
}

const cellsOf = (line: string) => line.split("|").map((c) => oneLine(c, CELL_MAX));

/** The units, from a units line that may also be the column-heading line ("(Millions) | 2022 | 2021"): the cell that says them. */
function unitsText(line: string | undefined): string | undefined {
  if (!line) return undefined;
  if (!line.includes("|")) return oneLine(line, CTX_MAX) || undefined;
  const cell = cellsOf(line).find((c) => /\b(?:millions|thousands|billions)\b/i.test(c));
  return oneLine(cell ?? cellsOf(line)[0], CTX_MAX) || undefined;
}

/** The period, from a period line that may also be the column-heading line ("Year ended December 31 | 2022 | 2021"): its first cell. */
function periodText(line: string | undefined): string | undefined {
  return line ? oneLine(cellsOf(line)[0], CTX_MAX) || undefined : undefined;
}

interface ShownRow {
  label: string;
  /** Prose or a single number: shown as one marked piece of text. */
  prose?: string;
  /** The cells after the label, as printed, and as shown (figures marked). */
  cells: string[];
  shown: string[];
  marked: boolean[];
  missing: string[];
  figures: SourceFigure[];
  units?: string;
  calcOnly: boolean;
}

/** The rows as they will be shown: rows with the same figures under different labels ("Total Company", "Worldwide") become one row. */
function shownRows(rows: readonly SourceRow[]): ShownRow[] {
  const out: (ShownRow & { key?: string; labels: string[] })[] = [];
  for (const x of rows) {
    // a lone currency sign is its own cell in some filings ($ | 4,835 | $ | 2,535): not a value cell
    const cells = cellsOf(x.row).filter((c, i) => i === 0 || !/^[$€£]$/.test(c));
    const tabular = cells.length >= 3;
    const vals = tabular ? cells.slice(1) : [];
    const label = [x.labelAbove ? `(? ${oneLine(x.labelAbove, 24)})` : "", tabular ? cells[0] : ""].filter(Boolean).join(" ");
    const key = tabular && vals.some((v) => /\d/.test(v)) ? `${vals.join("\u0000")}\u0001${x.units ?? ""}` : undefined;
    const same = key !== undefined ? out.find((o) => o.key === key) : undefined;
    if (same) {
      if (label && !same.labels.includes(label)) same.labels.push(label);
      for (const f of x.figures) if (!same.figures.some((g) => g.raw === f.raw)) same.figures.push(f);
      continue;
    }
    out.push({ key, labels: label ? [label] : [], label: "", cells: vals, shown: [], marked: [], missing: [], figures: [...x.figures], units: x.units, calcOnly: false, prose: tabular ? undefined : x.row });
  }
  for (const o of out) {
    o.label = oneLine(o.labels.join(" = "), LABEL_MAX);
    o.calcOnly = o.figures.every((f) => f.calcInput);
    if (o.prose !== undefined) continue;
    const left = new Set(o.figures.map((f) => f.raw));
    o.cells.forEach((c) => {
      const m = left.size ? markIn(cleanText(c), [...left]) : undefined;
      for (const s of m?.seen ?? []) left.delete(s);
      const hit = m !== undefined && m.seen.length > 0;
      o.shown.push(hit ? m.text : c);
      o.marked.push(hit);
    });
    o.missing = [...left];
  }
  return out;
}

/** Notes after a row: its own units when they differ from the entry's, and when its figures only went into a calculation. */
function rowNotes(r: ShownRow): string {
  const notes = [r.units ? oneLine(r.units, 40) : "", r.calcOnly ? "used in a calculation" : ""].filter(Boolean);
  return notes.length ? "   " + notes.join("  ·  ") : "";
}

// Terminal hyperlinks (OSC 8): the page reference becomes clickable where the terminal supports them.
const OSC_OPEN = "\u001b]8;;";
const OSC_END = "\u001b\\";
function linked(text: string, url: string | undefined): string {
  return url && !/[\u0000-\u001f\u007f]/.test(url) ? `${OSC_OPEN}${url}${OSC_END}${text}${OSC_OPEN}${OSC_END}` : text;
}

export interface FormatOptions {
  /** A link for a file and page, shown on the page reference; undefined for none. */
  link?: (file: string, page: number | undefined) => string | undefined;
}

/** The lines to show (plain text, except the optional page links; the CLI makes them dim). Empty when there is nothing to show. */
export function formatSources(r: SourcesResult, options: FormatOptions = {}): string[] {
  if (r.entries.length === 0 && r.many.length === 0) return [];
  const out = [DISCLAIMER];
  for (const e of r.entries) {
    const page = e.page !== undefined ? linked(`p.${e.page}`, options.link?.(e.file, e.page)) + (e.printed && e.printed !== String(e.page) ? ` (printed ${oneLine(e.printed, 8)})` : "") : "";
    out.push("  " + [oneLine(e.file, 60), page, e.title ? oneLine(e.title, 70) : ""].filter(Boolean).join("  "));
    out.push(...entryRows(e));
    if (e.moreRows) out.push(`    and ${e.moreRows} more row${e.moreRows === 1 ? "" : "s"}`);
  }
  for (const m of r.many) out.push(`  ${oneLine(m.figure, 30)} appears on ${m.pages} pages; not listed`);
  if (r.moreEntries > 0) out.push(`  and ${r.moreEntries} more page${r.moreEntries === 1 ? "" : "s"}`);
  return out;
}

/** The context line, the column headings and the rows of one entry. Rows whose number of cells matches the headings line up under them. */
function entryRows(e: SourceEntry): string[] {
  const rows = shownRows(e.rows);
  const tabular = rows.filter((x) => x.prose === undefined);
  const n = tabular[0]?.cells.length ?? 0;
  // the heading line may start with a label cell ("(Millions) | 2022 | 2021") or not ("2022 | 2021"): the cell count decides
  const headCells = e.columns ? cellsOf(e.columns).map((h) => oneLine(h, 14)) : [];
  const heads = headCells.length - 1 === n ? headCells.slice(1) : headCells.length === n && headCells[0] !== "" ? headCells : [];
  const useHeads = n > 0 && heads.length === n;
  const aligned = tabular.filter((x) => x.cells.length === n);
  const ctx = [...new Set([unitsText(e.units), periodText(e.period)].filter((x): x is string => !!x))].join("  ·  ");

  const disp = (x: ShownRow) => x.shown.map((c, i) => (x.marked[i] ? c : ` ${c} `));
  const headDisp = useHeads ? heads.map((h) => ` ${h} `) : [];
  const widths = Array.from({ length: n }, (_, j) => Math.max(...aligned.map((x) => disp(x)[j].length), headDisp[j]?.length ?? 0));
  const cell = (s: string, j: number) => s.padStart(widths[j]);

  let labelW = Math.max(0, ...aligned.map((x) => x.label.length));
  const lines: string[] = [];
  const ctxInline = ctx !== "" && useHeads && ctx.length <= Math.max(labelW, 34);
  if (ctxInline) labelW = Math.max(labelW, ctx.length);
  if (ctxInline) lines.push(`    ${ctx.padEnd(labelW)}  ${headDisp.map(cell).join(" ")}`.trimEnd());
  else {
    if (ctx) lines.push(`    ${ctx}`);
    if (useHeads) lines.push(`    ${"".padEnd(labelW)}  ${headDisp.map(cell).join(" ")}`.trimEnd());
    else if (e.columns) lines.push(`    columns: ${cellsOf(e.columns).filter(Boolean).join("   ").slice(0, 70)}`);
  }

  // where the figure sits among the row's cells, said only when the headings are not lined up above it
  const position = (x: ShownRow) => {
    const p = useHeads ? undefined : describePositions(x.figures);
    return p ? `   ${p}` : "";
  };
  for (const x of rows) {
    const missing = x.missing.map((m) => `   [${oneLine(m, 30)}]`).join("");
    if (x.prose !== undefined) lines.push("    " + markRow(x.prose, x.figures.map((f) => f.raw)) + rowNotes(x));
    else if (x.cells.length === n) lines.push(`    ${x.label.padEnd(labelW)}  ${disp(x).map(cell).join(" ")}`.trimEnd() + missing + position(x) + rowNotes(x));
    else {
      lines.push(`    ${[x.label, ...x.shown].filter(Boolean).join("  ")}${missing}${position(x)}${rowNotes(x)}`);
    }
  }
  return lines;
}

/** A compact record of what was shown, for the audit log. */
export function sourcesForAudit(r: SourcesResult): { file: string; page?: number; printed?: string; rows: string[] }[] {
  return r.entries.map((e) => ({ file: e.file, page: e.page, printed: e.printed, rows: e.rows.map((x) => oneLine(x.row, 120)) }));
}
