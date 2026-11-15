// Splitting one page of text into parts the model can read within the per-result limit, without cutting a table row,
// and finding the header lines (units, years) that a later part needs in order to be read against the right column.
// Pure: no I/O.
import { tokenize } from "./search.ts";

/** Characters of page text per part. Below the guard's per-result cap, which also has to hold the header and footer. */
export const PART_CHARS = 4000;

// "(in millions, ...)", "(Dollars in millions)", "(MILLIONS, EXCEPT PER SHARE DATA)", "December 31 (Millions, ...)"
const UNITS = /\b(?:in|dollars in|amounts in)\s+(?:millions|thousands|billions)\b|\((?:in\s+)?(?:millions|thousands|billions)\b/i;
const YEAR_CELL = /^(?:19|20)\d\d$/;

/** The page's units line and its column-year line (each only if found), in page order. */
export function carriedHeader(lines: string[]): string[] {
  const units = lines.find((l) => UNITS.test(l));
  const years = lines.find((l) => l.split("|").filter((c) => YEAR_CELL.test(c.trim())).length >= 2);
  return [units, years].filter((l, i, all): l is string => l !== undefined && all.indexOf(l) === i);
}

const PERIOD = /\b(?:as of|ended|for the (?:fiscal )?(?:year|quarter|period)|months ended)\b/i;
// A column heading cell: a year, "Fiscal 2023", "FY2023", or a date such as "Jan 28, 2023" / "January 28, 2023".
const COLUMN_CELL = /^(?:(?:fiscal|fy)\s*)?(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s*)?(?:19|20)\d\d$/i;
const PERIOD_MAX_CHARS = 110; // a heading, not a sentence of prose
// A period HEADING starts with the period phrase ("As of December 31,", "Year ended ...", "Three Months Ended ..."); a row label that merely mentions one ("... as of December 31, 2022 and 2021,") does not.
const PERIOD_START = /^\W*(?:consolidated\s+)?(?:as of\b|at\s+\w+\s+\d|for the (?:fiscal )?(?:year|quarter|period|three|six|nine|twelve)\b|(?:fiscal )?(?:years?|quarters?|periods?)\s+ended\b|(?:three|six|nine|twelve|\d+)\s+(?:months?|weeks?)\s+ended\b)/i;

const NAVIGATION = /^(?:table of contents|index)$/i;

/**
 * A short name for what a page is ("AMAZON.COM, INC. / CONSOLIDATED BALANCE SHEETS"): the last two heading lines above
 * the first table row; for a page with no table, its first two heading lines. Units, period and navigation lines are
 * not headings. Undefined when there is none.
 */
export function sectionTitle(lines: readonly string[]): string | undefined {
  const firstRow = lines.findIndex((l) => l.includes("|"));
  const head = lines.slice(0, firstRow < 0 ? 6 : Math.min(firstRow, 8)).map((l) => l.trim());
  const isHeading = (l: string) => /[A-Za-z]{3}/.test(l) && l.length <= 100 && !NAVIGATION.test(l) && !UNITS.test(l) && !PERIOD.test(l);
  const heads = head.filter(isHeading);
  const chosen = firstRow < 0 ? heads.slice(0, 2) : heads.slice(-2);
  return chosen.length ? chosen.join(" / ") : undefined;
}

/** The units, column-year and period lines that apply to a row: for each, the nearest matching line ABOVE the row. */
export interface RowHeader {
  units?: string;
  columns?: string;
  period?: string;
}

const HEADING_WORD = /\b(?:year|years|quarter|quarters|period|months?|fiscal)\b/i;

/**
 * A data row: after the label, a cell holds a number that is not a column heading. "Employees | 2015 | 2018" is a data
 * row (a label that is not a heading phrase) while "(in millions) | 2022 | 2021" and "Year ended Dec 31 | 2022 | 2021" are headings.
 */
function isDataRow(line: string): boolean {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 2) return false;
  const label = cells[0];
  const headingLabel = !/[A-Za-z]{2}/.test(label) || UNITS.test(label) || PERIOD.test(label) || HEADING_WORD.test(label);
  return !headingLabel || cells.slice(1).some((c) => /\d/.test(c) && !COLUMN_CELL.test(c));
}

/** Looks upward from `rowNo` (an index into `lines`) for the nearest units line, year-column line and period line. Anything not found is left out. */
export function nearestHeader(lines: readonly string[], rowNo: number): RowHeader {
  const out: RowHeader = {};
  for (let i = Math.min(rowNo, lines.length) - 1; i >= 0; i--) {
    const l = lines[i];
    const dataRow = l.includes("|") && isDataRow(l); // a row of figures is never a heading, whatever words its label holds
    if (out.units === undefined && !dataRow && UNITS.test(l)) out.units = l.trim();
    if (out.columns === undefined && !dataRow && l.split("|").filter((c) => COLUMN_CELL.test(c.trim())).length >= 2) out.columns = l.trim();
    if (out.period === undefined && !dataRow && l.length <= PERIOD_MAX_CHARS && PERIOD_START.test(l)) out.period = l.trim();
    if (out.units !== undefined && out.columns !== undefined && out.period !== undefined) break;
  }
  return out;
}

/** Characters of page text a passage may hold (hit lines always whole, context added while it fits). */
export const PASSAGE_CHARS = 1500;
export const PASSAGE_CONTEXT = 3; // lines above and below a hit
const PASSAGE_WINDOWS = 3;
const FIND_CHARS = 200;

/** The search terms of a `find` text (the search tokeniser: lower case, stop words dropped, light stemming). Empty means "no usable words". */
export function findTerms(find: string): string[] {
  return [...new Set(tokenize(find.slice(0, FIND_CHARS)))];
}

/**
 * The lines of a page around the words in `find`. A line scores the number of distinct terms it holds; the best-scoring
 * lines are the hits, and the best score must reach half of the terms (rounded up), else there is no match. Hit lines come
 * first and whole; context is then added outward, one line each side at a time, while the text stays within PASSAGE_CHARS.
 * Windows are inclusive [first, last] line indexes in page order, at most three. Undefined when nothing matches.
 */
export function passage(lines: readonly string[], find: string, chars = PASSAGE_CHARS): { windows: [number, number][]; more: boolean } | undefined {
  const terms = findTerms(find);
  if (terms.length === 0) return undefined;
  const scores = lines.map((l) => {
    const toks = new Set(tokenize(l));
    return terms.filter((t) => toks.has(t)).length;
  });
  const best = Math.max(0, ...scores);
  if (best === 0 || best < Math.ceil(terms.length / 2)) return undefined;
  const hits = scores.flatMap((s, i) => (s === best ? [i] : []));

  const chosen = new Set<number>();
  let size = 0;
  const take = (i: number, force = false) => {
    if (chosen.has(i) || i < 0 || i >= lines.length) return false;
    if (!force && size + lines[i].length + 1 > chars) return false;
    chosen.add(i);
    size += lines[i].length + 1;
    return true;
  };
  let shown = 0;
  for (const h of hits) {
    if (chosen.has(h)) continue;
    if (shown >= PASSAGE_WINDOWS) break;
    if (take(h, chosen.size === 0)) shown++;
  }
  const picked = [...chosen];
  for (let d = 1; d <= PASSAGE_CONTEXT; d++) {
    for (const h of picked) {
      take(h - d);
      take(h + d);
    }
  }
  const sorted = [...chosen].sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (const i of sorted) {
    const last = windows[windows.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else windows.push([i, i]);
  }
  return { windows, more: hits.some((h) => !chosen.has(h)) };
}

/** Cuts a line longer than `max` at spaces (or hard, if it has none). */
function cutLong(line: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const at = rest.lastIndexOf(" ", max);
    const cut = at > max / 2 ? at : max;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** The page's lines exactly as `splitPage` counts them (long lines cut), so a part's first line is at a known index in this list. */
export function pageLines(text: string, max = PART_CHARS): string[] {
  return text.split("\n").flatMap((l) => cutLong(l, max));
}

/** Page text to parts of at most `max` characters, split only between lines. An empty page gives no parts. */
export function splitPage(text: string, max = PART_CHARS): string[] {
  if (text.trim() === "") return [];
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length) parts.push(current.join("\n"));
    current = [];
    size = 0;
  };
  for (const line of pageLines(text, max)) {
    if (current.length && size + line.length + 1 > max) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return parts;
}

/** Text added after a table row whose first cell is already a figure: the PDF text layer held no label for it. No digits. */
export const NO_LABEL_MARK = "  [no label in the file]";
const FIGURE_CELL = /^[(\-–—$€£¥]*\d[\d,.]*\)?%?$|^[—–-]$/;

/**
 * A table row with no label: at least two cells, the first (the label's place) already a figure, every non-empty cell a
 * figure or a dash, and not a row of column headings ("2022 | 2021") or a row led by a year.
 */
export function isUnlabeledRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 2 || !FIGURE_CELL.test(cells[0]) || COLUMN_CELL.test(cells[0])) return false;
  const filled = cells.filter((c) => c !== "");
  return filled.every((c) => FIGURE_CELL.test(c)) && filled.some((c) => /\d/.test(c));
}

/** The lines as the model should see them: unlabeled rows carry the mark. The line count never changes. Display only: the ledger gets the unmarked lines. */
export function markUnlabeled(lines: readonly string[]): string[] {
  return lines.map((l) => (isUnlabeledRow(l) ? l + NO_LABEL_MARK : l));
}
