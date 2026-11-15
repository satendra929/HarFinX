// Typed rows from the primary statements of an annual or quarterly report: for each statement page the units line, the column
// headings (a year, with the span it belongs to: "Three months ended June 30, 2023") and every table row as a label plus one
// value per column. Pure: no I/O. Built on the page texts the PDF reader already produces and on the outline's page ranges.
//
// What it will not do: scale a value (the printed number is kept, the units line is carried beside it, so the figure the model
// later states is the figure the page prints), guess a column (a row whose cell count is not the column count is marked
// misaligned and never served), or fix a number. It drops output when unsure; it never invents it.
import { pageLines, nearestHeader } from "./pages.ts";
import { outlineOf, type Outline } from "./outline.ts";

export type StatementId = "Balance sheet" | "Income statement" | "Cash flow statement";
export const STATEMENT_IDS: readonly StatementId[] = ["Balance sheet", "Income statement", "Cash flow statement"];

export interface Column {
  index: number;
  /** The span and the period as printed: "Three months ended June 30, 2023" or "December 31, 2022". */
  heading: string;
  /** The four-digit year in the heading. */
  year?: string;
}

export interface Row {
  label: string;
  /** The nearest label-only line above the row ("Earnings per share:"), when there is one. */
  context?: string;
  /** The row as the page prints it. */
  text: string;
  /** Index into the page's lines (`pageLines`), so the ledger and the References can find the row. */
  line: number;
  /** One printed cell per column. */
  cells: string[];
  /** The cells as numbers in text form ("-8958", "3.10"), or null where a cell is not a figure. Never scaled. */
  values: (string | null)[];
  /** The number of cells equals the number of columns. Only aligned rows are served. */
  aligned: boolean;
}

export interface StatementPage {
  id: StatementId;
  page: number;
  /** The page's lines, as `read_page` counts them. */
  lines: string[];
  /** The units line as printed ("(in millions, except per share data)"), if found. */
  units?: string;
  /** The period line as printed ("Year ended December 31,"), if found. */
  period?: string;
  columns: Column[];
  rows: Row[];
}

const YEAR = /(?:19|20)\d\d/;
// A column heading cell: a year, "Fiscal 2023", "FY2023", or a date such as "Jan 28, 2023" / "December 31, 2022".
const COLUMN_CELL = /^(?:(?:fiscal|fy)\s*)?(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s*)?(?:19|20)\d\d$/i;
const SPAN = /\b(?:ended|months?|weeks?|year|years|quarter|as of|fiscal|period)\b/i;
const NUM = /^\$?\s*(\()?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(\))?\s*(?:\(\d{1,2}\))?$/;

/** A printed cell as a number in text form: "(8,958)" is "-8958", "$12.35" is "12.35", a lone dash is "0"; anything else is null. */
export function parseCell(raw: string): string | null {
  const t = raw.trim();
  if (/^[—–-]$/.test(t)) return "0";
  const m = NUM.exec(t);
  if (!m) return null;
  if (!!m[1] !== !!m[3]) return null; // an unbalanced bracket is not a figure
  return (m[1] ? "-" : "") + m[2].replace(/,/g, "");
}

const cellsOf = (line: string): string[] => line.split("|").map((c) => c.trim());

/** A table row of figures under a label (not a row of column headings such as "(in millions)  |  2022  |  2021"). */
function isDataLine(line: string): boolean {
  if (!line.includes("|")) return false;
  const [label, ...rest] = cellsOf(line);
  if (!/[A-Za-z]{3}/.test(label)) return false;
  const filled = rest.filter((c) => c !== "");
  return filled.some((c) => parseCell(c) !== null) && !filled.every((c) => COLUMN_CELL.test(c));
}

/** The columns of a page: the year cells of the heading line, each with the spans printed above it. */
function columnsOf(lines: readonly string[], yearLine: number): Column[] {
  const first = cellsOf(lines[yearLine]);
  const years = first.filter((c) => COLUMN_CELL.test(c));
  const n = years.length;
  const spans: string[][] = years.map(() => []);
  // "June 30,  |  2023  |  2022" or "Year ended December 31  |  2022  |  2021": the first cell belongs to every column.
  if (first[0] && !COLUMN_CELL.test(first[0]) && first[0].length <= 60 && (SPAN.test(first[0]) || /^[A-Za-z]{3,9}\.?\s+\d{1,2},?$/.test(first[0]))) spans.forEach((sp) => sp.push(first[0]));
  // Up to four lines above, nearest first: "Three months ended | Six months ended", "June 30, | June 30,".
  for (let i = yearLine - 1; i >= Math.max(0, yearLine - 4); i--) {
    const cells = cellsOf(lines[i]).filter((c) => c !== "");
    if (cells.length === 0 || cells.length > n || n % cells.length !== 0) continue;
    if (!cells.some((c) => SPAN.test(c) || /\d{1,2},?$/.test(c))) continue;
    if (cells.some((c) => c.length > 60)) continue;
    const per = n / cells.length;
    cells.forEach((c, j) => {
      for (let k = 0; k < per; k++) spans[j * per + k].unshift(c);
    });
  }
  return years.map((y, index) => ({ index, heading: [...spans[index], y].join(" ").replace(/\s+/g, " ").trim(), year: YEAR.exec(y)?.[0] ?? YEAR.exec(spans[index].join(" "))?.[0] }));
}

/** The rows below the heading line: a label, then one cell per column. Label-only lines become the context of the rows after them. */
function rowsOf(lines: readonly string[], from: number, nColumns: number): Row[] {
  const rows: Row[] = [];
  let context: string | undefined;
  for (let i = from; i < lines.length; i++) {
    const text = lines[i];
    if (!text.includes("|")) {
      const t = text.trim();
      context = /[A-Za-z]{3}/.test(t) && t.length <= 100 ? t : undefined;
      continue;
    }
    const cells = cellsOf(text);
    const label = cells[0];
    // The text layer sometimes puts a currency sign in a cell of its own or after the number ("$  |  4,258 $  |  3,655").
    const rest = cells.slice(1).filter((c) => !/^[$€£¥]$/.test(c)).map((c) => c.replace(/\s*[$€£¥]$/, ""));
    if (!/[A-Za-z]{3}/.test(label)) continue; // a row with no label is never served
    if (rest.every((c) => c === "" || COLUMN_CELL.test(c))) continue; // another heading line
    const values = rest.map(parseCell);
    if (values.every((v) => v === null)) {
      context = label.length <= 100 ? label : undefined; // "Assets |" style
      continue;
    }
    rows.push({ label, ...(context ? { context } : {}), text, line: i, cells: rest, values, aligned: nColumns > 0 && rest.length === nColumns });
  }
  return rows;
}

export function statementPage(id: StatementId, page: number, text: string, carried?: Column[]): StatementPage {
  const lines = pageLines(text);
  const firstRow = Math.max(0, lines.findIndex(isDataLine));
  const head = nearestHeader(lines, firstRow);
  // The heading line: the first line above the first data row with two or more year or date cells. (nearestHeader reads
  // "June 30,  |  2023  |  2022" as a data row, so the statements find their own.)
  const yearLine = lines.findIndex((l, i) => i < firstRow && cellsOf(l).filter((c) => COLUMN_CELL.test(c)).length >= 2);
  let columns = yearLine >= 0 ? columnsOf(lines, yearLine) : [];
  if (columns.length === 0 && carried) columns = carried; // a continuation page prints no heading
  const from = yearLine >= 0 ? yearLine + 1 : firstRow;
  const units = head.units === undefined ? undefined : cellsOf(head.units)[0];
  return { id, page, lines, ...(units ? { units } : {}), ...(head.period ? { period: head.period } : {}), columns, rows: rowsOf(lines, from, columns.length) };
}

/** Every page of the three primary statements the outline found, in page order. */
export function extractStatements(pages: readonly string[], outline: Outline = outlineOf(pages)): StatementPage[] {
  const out: StatementPage[] = [];
  const seen = new Set<string>();
  for (const e of outline.entries) {
    if (e.kind !== "statement" || !(STATEMENT_IDS as readonly string[]).includes(e.id)) continue;
    let carried: Column[] | undefined;
    for (let p = e.from; p <= (e.to ?? e.from) && p <= pages.length; p++) {
      if (seen.has(`${e.id}#${p}`)) continue;
      seen.add(`${e.id}#${p}`);
      const sp = statementPage(e.id as StatementId, p, pages[p - 1], carried);
      if (sp.columns.length > 0) carried = sp.columns;
      out.push(sp);
    }
  }
  return out.sort((a, b) => a.page - b.page);
}
