// Splitting one page of text into parts the model can read within the per-result limit, without cutting a table row,
// and finding the header lines (units, years) that a later part needs in order to be read against the right column.
// Pure: no I/O.

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
