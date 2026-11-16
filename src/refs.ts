// Inline references: a short mark `[S1]` right after each figure of the answer that was read from a page, and the numbered
// list at the end (src/sources.ts). The harness makes both; the model is not involved and never sees them, and the stored
// conversation keeps the model's own text. A figure gets a mark exactly when the list would hold its place (placesOf), and
// the list is built from the same lines (RefNumbers.seen), so a mark points at an entry. Pure: no I/O.
import { extractNumbers, maskLabels, normalise, type Ledger, type NumToken } from "./provenance.ts";
import { DEFAULT_SOURCE_LIMITS, indexOfFigure, placesOf } from "./sources.ts";

/** The reference numbers of one question: a place gets the next number the first time a figure of it is marked. */
export class RefNumbers {
  /** The places in number order: `order[0]` is [S1]. */
  readonly order: string[] = [];
  /** Every number of the lines marked so far: the figures the list under the answer is built from, so it matches the marks. */
  readonly seen: NumToken[] = [];
  constructor(private readonly max = DEFAULT_SOURCE_LIMITS.entries) {}
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
  }
}

/** A closing markdown mark right behind a figure (`**$5,818**`) stays next to it: the reference goes after it. */
const CLOSERS = new Set(["*", "_", "`"]);

/**
 * `line` (one line of the answer, already safe for the terminal) with `[S1]` after each figure read from a page. `style`
 * dresses the mark (dim in the CLI). A figure is skipped, never guessed, when it cannot be found in the line as written
 * or is followed by a letter or digit ("3x").
 */
export function markLine(line: string, ledger: Ledger, refs: RefNumbers, style: (mark: string) => string = (m) => m): string {
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
    const found = placesOf(t, ledger);
    if (!found || found.keys.length > DEFAULT_SOURCE_LIMITS.pagesPerFigure) continue;
    let at = cursor;
    while (CLOSERS.has(line[at] ?? "")) at++;
    if (/[\p{L}\p{N}]/u.test(line[at] ?? "")) continue;
    const numbers = found.keys.map((k) => refs.numberOf(k)).filter((n): n is number => n !== undefined);
    if (numbers.length) marks.push({ at, text: style(numbers.map((n) => `[S${n}]`).join("")) });
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
