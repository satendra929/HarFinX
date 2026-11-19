// Inline references: a short mark `[S1]` right after each figure of the answer that was read from a page, and the numbered
// list at the end (src/sources.ts). The harness makes both; the model is not involved and never sees them, and the stored
// conversation keeps the model's own text. A figure gets a mark exactly when the list would hold its place (placesOf), and
// the list is built from the same lines (RefNumbers.seen), so a mark points at an entry. Pure: no I/O.
import { extractNumbers, maskLabels, normalise, type Ledger, type NumToken } from "./provenance.ts";
import { DEFAULT_SOURCE_LIMITS, indexOfFigure } from "./sources.ts";
import { citeFigure, type Cited } from "./cite.ts";

/** What was decided for one figure of the answer, kept so the list under the answer is built from the same decisions as the marks. */
export interface Decision {
  token: NumToken;
  cited: Cited;
  /** The reference numbers given to the figure's mark (the entry of a calculation first), none when it was not marked. */
  numbers: number[];
  /** Why a figure that should have a mark has none. */
  note?: string;
}

/** The reference numbers of one question: a place gets the next number the first time a figure of it is marked. */
export class RefNumbers {
  /** The places in number order: `order[0]` is [S1]. */
  readonly order: string[] = [];
  /** Every number of the lines marked so far: the figures the list under the answer is built from, so it matches the marks. */
  readonly seen: NumToken[] = [];
  /** One decision for every figure of the marked lines that is not exempt. */
  readonly decisions: Decision[] = [];
  constructor(private readonly max = DEFAULT_SOURCE_LIMITS.entries) {}
  /** Numbers for all the keys together (a calculation and the places of its operands), or none: a mark never points at an entry that is missing. */
  reserve(keys: readonly string[]): number[] | undefined {
    const fresh = new Set(keys.filter((k) => !this.order.includes(k)));
    if (this.order.length + fresh.size > this.max) return undefined;
    return keys.map((k) => this.numberOf(k)).filter((n): n is number => n !== undefined);
  }
  /** The number of a place; a new place takes the next one while there is room, else none. */
  numberOf(key: string): number | undefined {
    const at = this.order.indexOf(key);
    if (at >= 0) return at + 1;
    if (this.order.length >= this.max) return undefined;
    this.order.push(key);
    return this.order.length;
  }
  reset(): void {
    this.order.length = 0;
    this.seen.length = 0;
    this.decisions.length = 0;
  }
}

/** A closing markdown mark right behind a figure (`**$5,818**`) stays next to it: the reference goes after it. */
const CLOSERS = new Set(["*", "_", "`"]);

/**
 * `line` (one line of the answer, already safe for the terminal) with `[S1]` after each figure read from a page. `style`
 * dresses the mark (dim in the CLI). A figure is skipped, never guessed, when it cannot be found in the line as written
 * or is followed by a letter or digit ("3x").
 */
export function markLine(line: string, ledger: Ledger, refs: RefNumbers, style: (mark: string) => string = (m) => m, question?: string): string {
  const tokens = extractNumbers(normalise(line));
  if (tokens.length === 0) return line;
  refs.seen.push(...tokens);
  // normalise() shifts positions (it blanks labels to one space), so the figures are looked for in a copy of the line
  // whose labels are blanked to the same length, one token after the other
  const masked = maskLabels(line);
  const marks: { at: number; text: string }[] = [];
  let cursor = 0;
  for (const t of tokens) {
    const from = indexOfFigure(masked, t.raw, cursor);
    if (from < 0) continue;
    cursor = from + t.raw.length;
    const cited = citeFigure(t, ledger, { sentence: line, question });
    if (cited.kind === "exempt") continue;
    const decision: Decision = { token: t, cited, numbers: [] };
    refs.decisions.push(decision);
    if (cited.kind !== "quote" && cited.kind !== "calc") continue;
    if (cited.kind === "quote" && cited.keys.length > DEFAULT_SOURCE_LIMITS.pagesPerFigure) {
      decision.note = `on ${cited.keys.length} pages`;
      continue;
    }
    let at = cursor;
    while (CLOSERS.has(line[at] ?? "")) at++;
    if (/[\p{L}\p{N}]/u.test(line[at] ?? "")) continue;
    let numbers: number[];
    if (cited.kind === "calc") {
      // a calculation takes its operands' places with it, or the figure is left unmarked
      const all = refs.reserve(cited.keys);
      if (!all) {
        decision.note = "over the entry limit";
        continue;
      }
      numbers = all.slice(0, 1);
    } else numbers = cited.keys.map((k) => refs.numberOf(k)).filter((n): n is number => n !== undefined);
    decision.numbers = numbers;
    if (numbers.length) marks.push({ at, text: style(numbers.map((n) => `[${n}]`).join("")) });
  }
  let out = line;
  for (const m of marks.reverse()) out = out.slice(0, m.at) + m.text + out.slice(m.at);
  return out;
}

/**
 * The answer as it streams: finished lines come out marked, the unfinished tail waits (a figure may still be growing).
 * Tools run only between replies, so what the ledger holds cannot change while a line waits.
 */
export class LineMarker {
  private buf = "";
  /** `mark` gets one whole line; `plain` gets a tail that was cut off. Both make the text safe for the terminal. */
  constructor(
    private readonly mark: (line: string) => string,
    private readonly plain: (text: string) => string,
  ) {}
  /** What to print for a new piece of the answer: every line it finished, marked. */
  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      out += this.mark(this.buf.slice(0, i)) + "\n";
      this.buf = this.buf.slice(i + 1);
    }
    return out;
  }
  /** The waiting tail: marked when the reply ended (it is a whole line), plain when the text was cut off or interrupted. */
  flush(replyEnded: boolean): string {
    const tail = this.buf;
    this.buf = "";
    return tail === "" ? "" : replyEnded ? this.mark(tail) : this.plain(tail);
  }
}
