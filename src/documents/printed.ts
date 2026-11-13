// The page number PRINTED on a page, which can differ from its position in the file (a filing's cover and contents
// come first, so printed page 54 may be the file's page 68). Analysts cite the printed number; a PDF viewer needs the
// file's number; the harness shows both. Detection is deliberately cautious: a number is reported only when the page
// prints one AND it agrees with the filing's own numbering, otherwise nothing is shown. Pure: no I/O.

const EDGE_LINES = 3; // look at this many non-empty lines at the foot and at the head of a page
const MIN_PAGES = 5; // the numbering must be seen on at least this many pages
const LEAD = 1.5; // and be clearly ahead of the next most common numbering

/** Bare page numbers among the last and first few lines of a page: "54" or "Page 54". A table row (with `|`) is never one. */
export function printedCandidates(page: string): number[] {
  const lines = page.split("\n").map((l) => l.trim()).filter(Boolean);
  const at = new Set<number>(); // line positions, so a short page does not count one line from both ends
  for (let i = 0; i < Math.min(EDGE_LINES, lines.length); i++) at.add(i).add(lines.length - 1 - i);
  const out: number[] = [];
  for (const i of [...at].sort((a, b) => b - a)) {
    const m = /^(?:page\s+)?(\d{1,4})$/i.exec(lines[i]);
    if (m && Number(m[1]) >= 1) out.push(Number(m[1]));
  }
  return out;
}

/**
 * The printed page number of every page, by position (index 0 is the file's first page); undefined where none is
 * shown. A page gets a label only if one of its candidates agrees with the filing's most common offset (file page
 * minus printed number), which must cover at least MIN_PAGES pages and be clearly ahead of the runner-up. Pages that
 * restart the numbering (an appendix, exhibits) or print a stray number get none.
 */
export function printedLabels(pages: readonly string[]): (string | undefined)[] {
  const perPage = pages.map(printedCandidates);
  const counts = new Map<number, number>();
  perPage.forEach((cands, i) => {
    for (const offset of new Set(cands.map((c) => i + 1 - c))) counts.set(offset, (counts.get(offset) ?? 0) + 1);
  });
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  if (!best || best[1] < MIN_PAGES || best[1] < LEAD * second) return pages.map(() => undefined);
  return perPage.map((cands, i) => {
    const c = cands.find((x) => i + 1 - x === best[0]);
    return c === undefined ? undefined : String(c);
  });
}

const memo = new WeakMap<readonly string[], (string | undefined)[]>();

/** The printed page number of the file's page `page` (counting from 1), computed once per document. */
export function printedLabelOf(pages: readonly string[], page: number): string | undefined {
  let labels = memo.get(pages);
  if (!labels) {
    labels = printedLabels(pages);
    memo.set(pages, labels);
  }
  return labels[page - 1];
}
