// Two warn-only checks on figures the harness can place in a table row (see the Ledger's row locations):
//  - period: the question names exactly one year, and a figure of the answer sits under a column headed with a different
//    year while the named year is another column of the same heading;
//  - units: the printed inputs of one calculation come from pages whose units lines name different scales
//    (shares in thousands against dollars in millions).
// Silence is the default: each rule needs one clear place for the figure, a heading line whose cell count equals the row's,
// and says nothing otherwise. A finding is worded as a fact about the page, never as an error. Pure: no I/O.
import { extractNumbers, normalise, type Ledger, type NumToken } from "./provenance.ts";
import { nearestHeader } from "./documents/pages.ts";
import { cellIndex, placesOf } from "./sources.ts";

export interface Finding {
  kind: "period" | "units";
  /** The figure as the source prints it. */
  figure: string;
  detail: string;
}

const YEAR = /(?<!\d)(?:19|20)\d\d(?!\d)/g;
// A question about a change, a comparison or a span uses more than one period on purpose.
const TWO_PERIODS = /\b(?:chang\w*|grow\w*|grew|compar\w*|versus|vs\.?|trend\w*|prior|previous|last year|year[- ]over[- ]year|yoy|from|between|since|declin\w*|increas\w*|decreas\w*|improv\w*|deteriorat\w*|worsen\w*|expand\w*|contract\w*|rising|falling|better|worse|higher|lower|cagr|average)\b/i;
const COLUMN_CELL = /^(?:(?:fiscal|fy)\s*)?(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s*)?(?:19|20)\d\d$/i;

/** The one year a question names, or undefined when it names none, several, or asks about a change or comparison. */
export function questionYear(question: string): string | undefined {
  const years = [...new Set(question.match(YEAR) ?? [])];
  return years.length === 1 && !TWO_PERIODS.test(question) ? years[0] : undefined;
}

/** The years of a heading line's year cells, in order. */
function headingYears(line: string): string[] {
  return line.split("|").map((c) => c.trim()).filter((c) => COLUMN_CELL.test(c)).map((c) => c.match(YEAR)?.[0] ?? "");
}

/** The one row a figure was read at, or undefined when it was read at several places. */
function onePlace(t: NumToken, ledger: Ledger) {
  const p = placesOf(t, ledger);
  if (!p || p.keys.length !== 1) return undefined;
  const lines = new Set(p.recs.map((r) => r.where.lineNo ?? r.where.row));
  return lines.size === 1 ? p.recs[0] : undefined;
}

/** Figures of the answer that sit under a column of another year than the one the question names. */
export function periodFindings(question: string, figures: readonly NumToken[], ledger: Ledger): Finding[] {
  const year = questionYear(question);
  if (!year) return [];
  const out: Finding[] = [];
  const done = new Set<string>();
  for (const t of figures) {
    const rec = onePlace(t, ledger);
    const w = rec?.where;
    if (!rec || !w || w.lineNo === undefined || !w.pageLines || done.has(rec.raw)) continue;
    const columns = nearestHeader(w.pageLines, w.lineNo).columns;
    const pos = cellIndex(w.row, rec.raw);
    if (!columns || !pos) continue;
    const years = headingYears(columns);
    if (years.length !== pos.of || !years.includes(year)) continue;
    const under = years[pos.at - 1];
    if (under && under !== year) {
      done.add(rec.raw);
      out.push({ kind: "period", figure: rec.raw, detail: `${rec.raw} is printed under the ${under} column; the question names ${year}` });
    }
  }
  return out;
}

const SCALE = /\b(billions|millions|thousands)\b/i;

/** Inputs of one calculation whose places say different units (scales). */
export function unitsFindings(inputs: readonly NumToken[], ledger: Ledger): Finding[] {
  const scales = new Map<string, string>(); // scale word -> the first figure under it
  for (const t of inputs) {
    if (t.percent) continue;
    const rec = onePlace(t, ledger);
    const w = rec?.where;
    if (!rec || !w || w.lineNo === undefined || !w.pageLines) continue;
    const units = nearestHeader(w.pageLines, w.lineNo).units;
    const scale = units && SCALE.exec(units)?.[1].toLowerCase();
    if (scale && !scales.has(scale)) scales.set(scale, rec.raw);
  }
  if (scales.size < 2) return [];
  const parts = [...scales].map(([scale, fig]) => `${fig} is stated in ${scale}`);
  return [{ kind: "units", figure: [...scales.values()][0], detail: `inputs of one calculation come from pages with different units: ${parts.join("; ")}` }];
}

/** Both checks. Never throws for odd input: a failure inside is the caller's to catch and log. */
export function periodUnitsCheck(question: string, figures: readonly NumToken[], inputs: readonly NumToken[], ledger: Ledger): Finding[] {
  return [...periodFindings(question, figures, ledger), ...unitsFindings(inputs, ledger)];
}

/** The tokens of printed numbers (the calculator's literals). */
export const tokensOf = (literals: readonly string[]): NumToken[] => literals.flatMap((l) => extractNumbers(normalise(l)));
